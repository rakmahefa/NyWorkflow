/**
 * /workspaces HTTP API — the agentic ICM surface (M11 rewrite, M12
 * workspace-folders + parallel tools + background shells, M14 layout).
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET  /workspaces                        → { workspaces: [{ name, summary?, folder? }] }
 *   POST /workspaces {name}                 → scaffold a fresh workspace → 201
 *                                             (the complete ICM tree inside
 *                                             its hidden .workspace/)
 *   POST /workspaces {name, path}           → register an EXISTING disk folder
 *                                             (M12) — M14: the hidden .workspace/
 *                                             ICM tree is created INSIDE it
 *                                             (idempotent, never overwrites)
 *   GET  /workspaces/browse?path=…          → M12: folder browser (dirs only, read-only)
 *   GET  /workspaces/locate?name=…          → M17: find a folder BY NAME on the
 *                                             server's disk (bounded BFS from
 *                                             home + the registry) — the bridge
 *                                             of the native directory picker:
 *                                             the picker gives the folder's
 *                                             name, locate gives its path
 *   GET  /workspaces/:name/icm              → { name, tree, contexts, system } —
 *                                             the ICM loaded toward the model
 *   GET  /workspaces/:name/file?path=…      → { path, content, bytes } — read-only
 *                                             preview, same scope guard as the tools
 *   POST /workspaces/:name/tool             → execute agent tool call(s) for a
 *                                             session (body: { sessionId, tool, args })
 *   POST /workspaces/:name/tool/decision    → resolve a paused call (M5 pattern):
 *                                             { sessionId, decision: approve|refuse }
 *
 * M14 ground rules (pilot-driven, after the first uploaded logs):
 *   - the session folder (the workspace root) is the pilot's project; the
 *     agent's ICM lives in the HIDDEN .workspace/ inside it, and its
 *     profiling logs in .logs/<sessionId>/ — both skip the ICM tree walk;
 *   - every tool call, result and decision lands BOTH in the global
 *     activity log (<home>/.logs/activity.jsonl) AND in the session's own
 *     trio inside its folder (the pilot zips and uploads that).
 *
 * M13 ground rules:
 *   - the session's SECURITY LEVEL (from its journal) is the gate:
 *     'no-tools' → every call is an executed refusal (tools_disabled),
 *     'accept'   → dangerous calls (write, shell) run without approval,
 *     'ask'      → the approval pause of M11/M12;
 *
 * M12 ground rules:
 *   - a workspace is a NAME resolved to a root: a sub-folder of the registry
 *     (classic scaffold) OR an external folder registered in the manifest
 *     `workspaces.json` at the registry root — reloaded by mtime, like the
 *     cookies and accounts manifests of the gateway;
 *   - parallel tool calls are legal: tool.call/tool.result events carry a
 *     `callId`, a new call is refused (409) only while a DANGEROUS call
 *     (write, shell) is still open — the approval gate stays one-at-a-time;
 *   - background shells run detached in the handler's job registry, after
 *     the same human approval as any shell call.
 *
 * The journal stays the truth: tool.call is journaled on arrival,
 * tool.result on completion, so a dangerous call paused for a human
 * survives restarts by derivation.
 */
import { existsSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, dirname, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildIcmSystemPrompt, ensureIcmTree, ICM_DIR, loadIcm, scaffoldAgenticWorkspace } from '@nyworkflow/core'
import { checkToolCall, executeToolCall, isDangerous, refusedByUser, toolsDisabledRefusal, ShellJobRegistry } from '@nyworkflow/tools'
import type { ToolCall, ToolOutcome, ToolRefusal } from '@nyworkflow/tools'
import { resolveInScope } from '@nyworkflow/tools'
import { appendEvent, deriveSession, isSessionId, journalPath, pendingToolCalls, readEvents } from '@nyworkflow/session'
import type { SessionEvent } from '@nyworkflow/session'
import { sessionProfiler, type Profiler } from './logs.ts'
import { refuseCrossOrigin } from './originGuard.ts'

/** M18 — the call's TITLE and TARGET, extracted from its args: the
 * activity log (and the engine view) become self-sufficient — reading a
 * tool.call line tells WHAT was called on WHICH path, without
 * cross-referencing model.jsonl by callId. */
function toolCallMeta(args: unknown): { title?: string; target?: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  const a = args as Record<string, unknown>
  const meta: { title?: string; target?: string } = {}
  if (typeof a.title === 'string' && a.title.trim() !== '') meta.title = a.title.trim().slice(0, 60)
  for (const key of ['path', 'pattern', 'command', 'query', 'url', 'jobId']) {
    const v = a[key]
    if (typeof v === 'string' && v !== '') {
      meta.target = v.slice(0, 200)
      break
    }
  }
  return meta
}

/** One workspace as listed. */
export interface WorkspaceSummaryDto {
  name: string
  /** First heading of the root CONTEXT.md, when there is one. */
  summary?: string
  /** M12 — external registration: the folder is outside the registry. */
  folder?: boolean
}

/** The ICM as the browser consumes it (system prompt pre-assembled server-side). */
export interface IcmDto {
  name: string
  tree: string
  contexts: { path: string; content: string }[]
  /** The system prompt of an agentic session in this workspace. */
  system: string
}

/** What POST /tool answers. */
export type ToolRunDto =
  | { status: 'executed'; callId: string; outcome: ToolOutcome }
  /** A dangerous call (write, shell) is paused — decide via /tool/decision. */
  | { status: 'pending'; callId: string; call: { tool: string; args: unknown } }

/** One entry of the folder browser (M12). */
export interface BrowseDir {
  name: string
  path: string
}

/** GET /workspaces/locate?name=… (M17) — the native picker's bridge. */
export interface LocateDto {
  /** The searched folder name (the picker's basename). */
  name: string
  /** Absolute paths of matching folders, shallowest first. */
  candidates: string[]
  /** True when the walk hit a cap before covering everything. */
  truncated: boolean
  /** Directories actually visited — the honest cost of the search. */
  scanned: number
  /** Where the search started (home + the workspaces registry). */
  roots: string[]
}

export interface BrowseDto {
  /** The folder being listed. */
  path: string
  /** Parent folder, null at the filesystem root. */
  parent: string | null
  /** Sub-directories, alphabetical, bounded. */
  dirs: BrowseDir[]
  /** True when the listing was cut by the cap. */
  truncated: boolean
  /** The user's home (the browser's starting point). */
  home: string
}

export interface WorkspacesHandlerOptions {
  /** Folder containing one sub-folder per workspace. */
  dir: string
  /** NyWorkflow home (journals under home/sessions). */
  home: string
  /** M13 — profiling logs (tool activity, workspace ops, engine requests). */
  profiler?: Profiler
}

const BODY_LIMIT = 2_000_000
/** Preview bound — same figure as the write tool cap (chars). */
const PREVIEW_MAX = 131_072
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Folder browser caps (M12). */
const BROWSE_MAX = 500
/** Manifest file name, at the registry root. */
const MANIFEST_FILE = 'workspaces.json'
/** Locate caps (M17) — a bounded, honest walk, never a full-disk scan. */
const LOCATE_MAX_DEPTH = 5
const LOCATE_MAX_DIRS = 4000
const LOCATE_MAX_CANDIDATES = 20
/** Heavy or noisy folders the locate walk never enters. */
const LOCATE_SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.npm',
  '.pnpm-store',
  'Library',
  'AppData',
])

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const badRequest = (message: string) => new HttpError(400, message)
const notFound = (message: string) => new HttpError(404, message)

const nowIso = (): string => new Date().toISOString()
const newCallId = (): string => randomUUID().slice(0, 8)

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'corps trop volumineux'))
        return // stop storing; drain until end
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => reject(err))
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw badRequest('corps JSON invalide')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('objet JSON attendu')
  }
  return parsed as Record<string, unknown>
}

/** Workspace folder names, validated on the raw (still-encoded) segment. */
function isWorkspaceName(value: string): boolean {
  return NAME_RE.test(value) && value !== '.' && value !== '..'
}

/** The manifest of external registrations (M12) — data, reloaded by mtime. */
interface Manifest {
  workspaces: { name: string; path: string }[]
}

interface ManifestState {
  mtimeMs: number
  manifest: Manifest
}

/** Manifest cache, per registry folder (mtime-keyed, like the gateway's cookies). */
const manifestCache = new Map<string, ManifestState>()

/** Reads (and caches by mtime) the external-registrations manifest of a registry. */
async function readManifest(dir: string): Promise<Manifest> {
  const file = join(dir, MANIFEST_FILE)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return { workspaces: [] } // no manifest yet — nothing registered
  }
  const cached = manifestCache.get(dir)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.manifest
  let manifest: Manifest = { workspaces: [] }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<Manifest>
    const list = Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    manifest = {
      workspaces: list.filter(
        (e): e is { name: string; path: string } =>
          e !== null && typeof e === 'object' && typeof e.name === 'string' && typeof e.path === 'string' && isWorkspaceName(e.name),
      ),
    }
  } catch {
    manifest = { workspaces: [] } // unreadable manifest: no external workspaces, never fatal
  }
  manifestCache.set(dir, { mtimeMs, manifest })
  return manifest
}

/** Writes the manifest (creating the registry folder if needed). */
async function writeManifest(dir: string, next: Manifest): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

/** True when the name resolves to a workspace — registry sub-folder or manifest
 * entry (M12): how /sessions validates a session's workspace binding. */
export async function workspaceExists(dir: string, name: string): Promise<boolean> {
  if (!isWorkspaceName(name)) return false
  if (existsSync(join(dir, name)) && statSync(join(dir, name)).isDirectory()) return true
  return (await readManifest(dir)).workspaces.some((w) => w.name === name)
}

/** Resolves a workspace name to its root folder — registry sub-folder first,
 * then the manifest entry (M12); undefined when it resolves to nothing.
 * Exported for the sessions handler (M14): per-session logs live in the
 * session folder, which only the workspaces registry knows how to reach. */
export async function resolveWorkspaceRoot(dir: string, name: string): Promise<string | undefined> {
  if (!isWorkspaceName(name)) return undefined
  const registryRoot = join(dir, name)
  if (existsSync(registryRoot) && statSync(registryRoot).isDirectory()) return registryRoot
  const entry = (await readManifest(dir)).workspaces.find((w) => w.name === name)
  if (entry !== undefined && existsSync(entry.path) && statSync(entry.path).isDirectory()) return entry.path
  return undefined
}

export function createWorkspacesHandler(
  options: WorkspacesHandlerOptions,
): WorkspacesApi {
  const { dir, home } = options
  const profiler = options.profiler
  /** Sessions with a tool decision in flight — a second decision gets a 409. */
  const busy = new Set<string>()
  /** Background shell jobs of this server (M12). */
  const jobs = new ShellJobRegistry()

  /** The workspace root, or 404 — resolveWorkspaceRoot under the hood. */
  async function rootOf(name: string): Promise<string> {
    const root = await resolveWorkspaceRoot(dir, name)
    if (root === undefined) throw notFound('workspace inconnu')
    return root
  }

  /** First heading of the charter CONTEXT.md (≤ 100 chars), if any — the
   * M14 `.workspace/CONTEXT.md` first, the legacy root one otherwise. */
  async function summaryOf(root: string): Promise<string | undefined> {
    const candidates = [join(root, ICM_DIR, 'CONTEXT.md'), join(root, 'CONTEXT.md')]
    for (const file of candidates) {
      try {
        const raw = await readFile(file, 'utf8')
        const heading = raw
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('# '))
        if (heading === undefined) continue
        return heading.slice(2).trim().slice(0, 100)
      } catch {
        continue // absent/unreadable charter — try the next candidate
      }
    }
    return undefined
  }

  async function list(): Promise<WorkspaceSummaryDto[]> {
    let names: string[] = []
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const out: WorkspaceSummaryDto[] = []
    const seen = new Set<string>()
    for (const name of names.sort()) {
      if (!isWorkspaceName(name)) continue
      seen.add(name)
      const summary = await summaryOf(join(dir, name))
      out.push(summary === undefined ? { name } : { name, summary })
    }
    for (const entry of (await readManifest(dir)).workspaces) {
      if (seen.has(entry.name)) continue // the registry folder wins on conflict
      if (!existsSync(entry.path) || !statSync(entry.path).isDirectory()) continue // gone: not listed, never fatal
      seen.add(entry.name)
      const summary = await summaryOf(entry.path)
      out.push(summary === undefined ? { name: entry.name, folder: true } : { name: entry.name, summary, folder: true })
    }
    return out
  }

  /** POST /workspaces — scaffold (name) or register an existing folder (name+path, M12). */
  async function createWorkspace(req: IncomingMessage): Promise<{ name: string; tree: string; folder?: boolean }> {
    const body = await readJson(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (name === '' || !isWorkspaceName(name)) throw badRequest('nom de workspace attendu (lettres, chiffres, . _ -, sans espace)')

    if (path !== '') {
      // M12 — register the user's own folder; M14 — the hidden .workspace/
      // ICM tree is created INSIDE it (idempotent: an existing .workspace is
      // the agent's living memory and is never overwritten).
      if (!isAbsolute(path)) throw badRequest('chemin absolu attendu pour enregistrer un dossier existant')
      let stats
      try {
        stats = statSync(path)
      } catch {
        throw badRequest(`dossier introuvable : ${path}`)
      }
      if (!stats.isDirectory()) throw badRequest(`ce n'est pas un dossier : ${path}`)
      try {
        await access(path)
      } catch {
        throw badRequest(`dossier illisible : ${path}`)
      }
      if (existsSync(join(dir, name)) || (await readManifest(dir)).workspaces.some((w) => w.name === name)) {
        throw badRequest(`le workspace « ${name} » existe déjà`)
      }
      let icmStatus: 'created' | 'present' | 'upgraded'
      try {
        icmStatus = await ensureIcmTree(path)
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err))
      }
      const next = { workspaces: [...(await readManifest(dir)).workspaces, { name, path }] }
      await writeManifest(dir, next)
      profiler?.activity({ kind: 'workspace.registered', workspace: name, path })
      profiler?.activity({ kind: 'icm.tree', workspace: name, path, status: icmStatus, dir: '.workspace' })
      const icm = await loadIcm(path)
      return { name, tree: icm.tree, folder: true }
    }

    try {
      await scaffoldAgenticWorkspace(join(dir, name))
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err))
    }
    profiler?.activity({ kind: 'workspace.scaffolded', workspace: name, tree: 'complet (M14) — .workspace/' })
    const icm = await loadIcm(join(dir, name))
    return { name, tree: icm.tree }
  }

  /**
   * GET /workspaces/browse?path=… — the folder browser of the session
   * dialog (M12). Read-only, directories only, bounded, starts at home.
   */
  async function browse(rawPath: string | null): Promise<BrowseDto> {
    const target = rawPath !== null && rawPath.trim() !== '' ? rawPath.trim() : homedir()
    if (!isAbsolute(target)) throw badRequest('chemin absolu attendu')
    let entries
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw badRequest(`dossier introuvable : ${target}`)
      if (code === 'ENOTDIR') throw badRequest(`ce n'est pas un dossier : ${target}`)
      throw badRequest(`dossier illisible : ${target}`) // EACCES etc. — honnête, jamais 500
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const truncated = dirs.length > BROWSE_MAX
    const parent = dirname(target) === target ? null : dirname(target)
    return { path: target, parent, dirs: truncated ? dirs.slice(0, BROWSE_MAX) : dirs, truncated, home: homedir() }
  }

  /**
   * GET /workspaces/locate?name=… (M17) — the native picker's bridge. The
   * browser's `showDirectoryPicker()` gives a folder HANDLE whose only
   * server-usable piece is its NAME (the web platform hides the path, by
   * design). This bounded BFS — from the user's home AND the workspaces
   * registry, depth ≤ 5, heavy folders skipped, hard caps everywhere —
   * turns that name into candidate absolute paths. One candidate: the
   * dialog fills itself. Several: the pilot clicks the right one. Zero:
   * the honest error, the manual path stays.
   */
  async function locate(rawName: string | null): Promise<LocateDto> {
    const name = rawName?.trim() ?? ''
    if (name === '' || name.includes('/') || name.includes('\\') || name.length > 120) {
      throw badRequest('nom de dossier attendu (basname, sans séparateur)')
    }
    const started = Date.now()
    const roots = [...new Set([homedir(), dir])]
    const candidates: string[] = []
    const seen = new Set<string>()
    let scanned = 0
    let truncated = false
    // BFS, depth-bounded — the queue carries (path, depth).
    const queue: { path: string; depth: number }[] = roots.map((path) => ({ path, depth: 0 }))
    while (queue.length > 0) {
      if (scanned >= LOCATE_MAX_DIRS || candidates.length >= LOCATE_MAX_CANDIDATES) {
        truncated = true
        break
      }
      const current = queue.shift() as { path: string; depth: number }
      if (seen.has(current.path)) continue
      seen.add(current.path)
      let entries: Dirent[] = []
      try {
        entries = await readdir(current.path, { withFileTypes: true }) as Dirent[]
      } catch {
        continue // unreadable (EACCES…) — never fatal, just not scanned
      }
      scanned++
      for (const e of entries) {
        // Directories only — a symlinked folder is not isDirectory(), and
        // that is exactly what we want: no cycles, no surprises.
        if (!e.isDirectory()) continue
        const child = join(current.path, e.name)
        if (e.name === name && !seen.has(child)) {
          seen.add(child)
          candidates.push(child)
          if (candidates.length >= LOCATE_MAX_CANDIDATES) break
        }
        // Descend: hidden and heavy folders are skipped, depth is bounded.
        if (current.depth < LOCATE_MAX_DEPTH && !e.name.startsWith('.') && !LOCATE_SKIP.has(e.name)) {
          queue.push({ path: child, depth: current.depth + 1 })
        }
      }
    }
    // Shallowest first (the shortest path wins — usually THE folder).
    candidates.sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b))
    profiler?.activity({
      kind: 'folder.locate',
      name,
      candidates: candidates.length,
      truncated,
      scanned,
      ms: Date.now() - started,
    })
    return { name, candidates, truncated, scanned, roots }
  }

  /** GET /workspaces/:name/icm — the ICM toward the model. */
  async function icmOf(name: string): Promise<IcmDto> {
    const root = await rootOf(name)
    const icm = await loadIcm(root)
    return { name, tree: icm.tree, contexts: icm.contexts, system: buildIcmSystemPrompt(icm) }
  }

  /**
   * Read-only preview of one workspace file, for the human eye. Same
   * scope guard as the agent tools (lexical + realpath).
   */
  async function filePreview(name: string, rawPath: string | null): Promise<{ path: string; content: string; bytes: number }> {
    if (rawPath === null || rawPath.trim() === '') throw badRequest('paramètre « path » attendu (chemin relatif au workspace)')
    const root = await rootOf(name)
    const scope = await resolveInScope(root, rawPath)
    if (!scope.ok) throw badRequest(`chemin refusé — ${scope.reason}`)
    // Audit P2 — la taille est vérifiée AVANT la lecture : un fichier de 2 Go
    // dans le workspace ne passe plus par la mémoire avant son 413.
    try {
      const stats = statSync(scope.target as string)
      if (stats.size > PREVIEW_MAX * 4) {
        throw new HttpError(413, `fichier trop volumineux pour l'aperçu (max ${PREVIEW_MAX} caractères) — ${stats.size} octets`)
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EISDIR') throw badRequest('c\'est un dossier, pas un fichier')
      throw notFound('fichier introuvable dans le workspace')
    }
    let content: string
    try {
      content = await readFile(scope.target as string, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EISDIR') throw badRequest('c\'est un dossier, pas un fichier')
      throw notFound('fichier introuvable dans le workspace')
    }
    if (content.length > PREVIEW_MAX) {
      throw new HttpError(413, `fichier trop volumineux pour l'aperçu (max ${PREVIEW_MAX} caractères)`)
    }
    return { path: scope.rel as string, content, bytes: Buffer.byteLength(content, 'utf8') }
  }

  /** Loads a session journal, checks the binding, and returns the journal
   * with its DERIVED state — M13: the security level rides along. */
  async function sessionJournal(
    name: string,
    sessionId: string,
  ): Promise<{ file: string; events: SessionEvent[]; security: ReturnType<typeof deriveSession>['security'] }> {
    if (!isSessionId(sessionId)) throw badRequest('sessionId invalide')
    const file = journalPath(home, sessionId)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const events = await readEvents(file)
    const d = deriveSession(events)
    if (d.workspace !== name) {
      throw badRequest(`session liée au workspace « ${d.workspace ?? 'aucun'} » — pas à « ${name} »`)
    }
    return { file, events, security: d.security }
  }

  /**
   * M12 — the open DANGEROUS call of a journal, if any (write, shell):
   * those are the ones that wait for a human. Open safe calls may exist
   * while parallel calls execute — they are not a reason to refuse.
   */
  function pendingDangerous(events: readonly SessionEvent[]): ToolCall | undefined {
    return pendingToolCalls(events)
      .filter((t) => isDangerous(t.tool))
      .map((t) => ({ tool: t.tool as ToolCall['tool'], args: (t.args ?? {}) as Record<string, unknown> }))
      .at(0)
  }

  /**
   * M18 — dangerous callIds currently EXECUTING server-side (auto-approved
   * under « accept »). While a dangerous call runs, its journal entry stays
   * open (tool.call without tool.result yet): without this set, the 409
   * guard below read that window as « waiting for a human » and refused the
   * call's SIBLINGS of the same parallel round — seen in the wild, a 240 ms
   * shell blocking five parallel writes, one of them lost to an unfair 409.
   * In the set: in flight, siblings proceed. Not in the set: genuinely
   * waiting for a decision, new calls are refused.
   */
  const executingDangerous = new Set<string>()

  /** M18 — the ONE state that must block new calls: a dangerous call open
   * in the journal AND not executing (a human must decide it). */
  function waitingApproval(events: readonly SessionEvent[]): boolean {
    return pendingToolCalls(events).some((t) => isDangerous(t.tool) && t.callId !== undefined && !executingDangerous.has(t.callId))
  }

  /**
   * POST /workspaces/:name/tool — journals the call (callId M12), executes
   * it, or pauses it for a human when it is dangerous (write, shell —
   * background included). The session's SECURITY LEVEL (M13) rules first:
   * 'no-tools' refuses everything as an executed refusal, 'accept' skips
   * the approval. Refusals (unknown tool, bad args, out of scope) are
   * executed-and-journaled refusals: the model sees the error and
   * adjusts. Every call and result lands in the activity log.
   */
  async function runTool(req: IncomingMessage, name: string): Promise<ToolRunDto> {
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const tool = typeof body.tool === 'string' ? body.tool : ''
    const args = body.args
    if (tool === '') throw badRequest('outil (tool) attendu')
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw badRequest('arguments (args) : objet attendu')

    const root = await rootOf(name)
    const { file, security } = await sessionJournal(name, sessionId)
    // M14 — the session's own trio, inside its folder: every call and
    // result lands there too (the pilot zips and uploads that folder).
    const sp = sessionProfiler(root, sessionId)
    if (busy.has(sessionId)) throw new HttpError(409, 'une décision d\'outil est déjà en cours pour cette session')
    // M18 — only a dangerous call WAITING FOR A HUMAN blocks: one that is
    // executing (auto-approved) leaves its siblings of the same parallel
    // round through (the « accept » race, see executingDangerous).
    if (waitingApproval(await readEvents(file))) {
      throw new HttpError(409, 'un appel d\'outil dangereux est déjà en attente — décidez-le (POST /tool/decision) avant d\'en lancer un autre')
    }

    // M13 — tools off: an executed refusal, journaled and fed back. The
    // call is journaled FIRST (it really happened), the refusal right after.
    const call: ToolCall = { tool: tool as ToolCall['tool'], args: args as Record<string, unknown> }
    const callId = newCallId()
    const meta = toolCallMeta(call.args) // M18 — title + target in the logs
    if (security === 'no-tools') {
      await appendEvent(file, { type: 'tool.call', at: nowIso(), tool: call.tool, args: call.args, callId })
      profiler?.activity({ kind: 'tool.call', sessionId, workspace: name, tool: call.tool, callId, security, ...meta })
      sp.activity({ kind: 'tool.call', sessionId, workspace: name, tool: call.tool, callId, security, ...meta })
      const disabled = toolsDisabledRefusal(call.tool)
      await appendEvent(file, { type: 'tool.result', at: nowIso(), ok: false, summary: disabled.summary, callId })
      profiler?.activity({ kind: 'tool.result', sessionId, workspace: name, tool: call.tool, callId, ok: false, code: disabled.code, security, ...meta })
      sp.activity({ kind: 'tool.result', sessionId, workspace: name, tool: call.tool, callId, ok: false, code: disabled.code, security, ...meta })
      return { status: 'executed', callId, outcome: disabled }
    }

    // The check runs BEFORE the call is journaled: a crash here leaves no
    // open call behind (a pending dangerous call would block the session).
    const check = await checkToolCall(root, call)
    // M20 — the callId joins executingDangerous BEFORE the journal entry
    // lands. The M18 window (appendEvent resolved → set registration) was
    // still readable by the guards of the parallel siblings: between the
    // journal append and the .add, a sibling's waitingApproval saw the open
    // dangerous call as « waiting for a human » and died to an unfair 409 —
    // seen in the wild (2026-11-18-ebbe, round 5: seven parallel calls
    // under « accept », one write lost while a sibling sat exactly in that
    // window). Registered FIRST: once the entry is visible, it is already
    // « executing »; on any failure the finally removes the callId and the
    // journal keeps no orphan open call.
    const autoApproved = check.approval === true && security === 'accept'
    if (autoApproved) executingDangerous.add(callId)
    try {
      await appendEvent(file, { type: 'tool.call', at: nowIso(), tool: call.tool, args: call.args, callId })
      profiler?.activity({ kind: 'tool.call', sessionId, workspace: name, tool: call.tool, callId, security, ...meta })
      sp.activity({ kind: 'tool.call', sessionId, workspace: name, tool: call.tool, callId, security, ...meta })
      if (!check.ok) {
        const refusal = check.refusal as ToolRefusal
        await appendEvent(file, { type: 'tool.result', at: nowIso(), ok: false, summary: refusal.summary, callId })
        profiler?.activity({ kind: 'tool.result', sessionId, workspace: name, tool: call.tool, callId, ok: false, code: refusal.code, ...meta })
        sp.activity({ kind: 'tool.result', sessionId, workspace: name, tool: call.tool, callId, ok: false, code: refusal.code, ...meta })
        return { status: 'executed', callId, outcome: refusal }
      }
      if (check.approval && security === 'ask') {
        // Dangerous (write, shell — background or not): the human decides —
        // the journal keeps the call open (no tool.result), the UI shows the
        // approval card. autoApproved is false here by construction.
        return { status: 'pending', callId, call: { tool: call.tool, args: call.args } }
      }
      // 'accept' (M13): the dangerous call runs right away, approval
      // skipped — its callId is already registered as EXECUTING above.
      const started = Date.now()
      const outcome = await executeToolCall(root, call, check.approval, { workspace: name, jobs })
      await appendEvent(file, {
        type: 'tool.result',
        at: nowIso(),
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.ok ? { data: outcome.data } : {}),
        callId,
      })
      const ms = Date.now() - started
      profiler?.activity({
        kind: 'tool.result',
        sessionId,
        workspace: name,
        tool: call.tool,
        callId,
        ok: outcome.ok,
        code: outcome.ok ? undefined : outcome.code,
        security,
        ms,
        ...meta,
      })
      sp.activity({
        kind: 'tool.result',
        sessionId,
        workspace: name,
        tool: call.tool,
        callId,
        ok: outcome.ok,
        code: outcome.ok ? undefined : outcome.code,
        security,
        ms,
        ...meta,
      })
      sp.engine({ kind: 'tool.exec', sessionId, tool: call.tool, callId, ok: outcome.ok, ms, ...meta })
      return { status: 'executed', callId, outcome }
    } finally {
      if (autoApproved) executingDangerous.delete(callId)
    }
  }

  /** POST /workspaces/:name/tool/decision — resolve the paused call (M5 pattern). */
  async function decideTool(req: IncomingMessage, name: string): Promise<ToolRunDto> {
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'refuse' ? 'refuse' : ''
    if (decision === '') throw badRequest('decision : "approve" ou "refuse" attendu')

    const root = await rootOf(name)
    const { file, events } = await sessionJournal(name, sessionId)
    const sp = sessionProfiler(root, sessionId)
    if (busy.has(sessionId)) throw new HttpError(409, 'une décision d\'outil est déjà en cours pour cette session')
    const call = pendingDangerous(events)
    if (call === undefined) throw new HttpError(409, 'aucun appel d\'outil en attente pour cette session')
    const callId = pendingToolCalls(events).find((t) => isDangerous(t.tool))?.callId ?? ''
    const meta = toolCallMeta(call.args) // M18 — title + target in the logs

    busy.add(sessionId)
    try {
      const started = Date.now()
      const outcome: ToolOutcome =
        decision === 'refuse' ? refusedByUser(call) : await executeToolCall(root, call, true, { workspace: name, jobs })
      await appendEvent(file, {
        type: 'tool.result',
        at: nowIso(),
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.ok ? { data: outcome.data } : {}),
        ...(callId !== '' ? { callId } : {}),
      })
      profiler?.activity({
        kind: 'tool.decision',
        sessionId,
        workspace: name,
        decision,
        tool: call.tool,
        ...(callId !== '' ? { callId } : {}),
        ok: outcome.ok,
        ms: Date.now() - started,
        ...meta,
      })
      sp.activity({
        kind: 'tool.decision',
        sessionId,
        workspace: name,
        decision,
        tool: call.tool,
        ...(callId !== '' ? { callId } : {}),
        ok: outcome.ok,
        ms: Date.now() - started,
        ...meta,
      })
      sp.engine({ kind: 'tool.exec', sessionId, tool: call.tool, callId, ok: outcome.ok, ms: Date.now() - started, decision, ...meta })
      return { status: 'executed', callId, outcome }
    } finally {
      busy.delete(sessionId)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const query = rawUrl.includes('?') ? new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1)) : null
    const url = rawUrl.split('?')[0] || '/'

    if (url === '/' || url === '') {
      if (method === 'GET') return send(res, 200, { workspaces: await list() })
      if (method === 'POST') return send(res, 201, await createWorkspace(req))
      throw notFound('route inconnue')
    }

    const parts = url.replace(/^\//, '').split('/')
    const name = parts[0] ?? ''

    if (parts.length === 1 && parts[0] === 'browse') {
      if (method === 'GET') return send(res, 200, await browse(query?.get('path') ?? null))
      throw notFound('route inconnue')
    }
    if (parts.length === 1 && parts[0] === 'locate') {
      if (method === 'GET') return send(res, 200, await locate(query?.get('name') ?? null))
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && parts[1] === 'icm') {
      if (method === 'GET') return send(res, 200, await icmOf(name))
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && parts[1] === 'file') {
      if (method === 'GET') return send(res, 200, await filePreview(name, query?.get('path') ?? null))
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && parts[1] === 'tool') {
      if (method === 'POST') return send(res, 200, await runTool(req, name))
      throw notFound('route inconnue')
    }
    if (parts.length === 3 && parts[1] === 'tool' && parts[2] === 'decision') {
      if (method === 'POST') return send(res, 200, await decideTool(req, name))
      throw notFound('route inconnue')
    }
    throw notFound('route inconnue')
  }

  const workspacesApi = function workspacesApi(req: IncomingMessage, res: ServerResponse): void {
    // Audit S1 — les requêtes cross-origin d'un navigateur n'ont rien à
    // faire ici (drive-by CSRF : enregistrer un dossier, créer une session
    // « accept », lancer un shell).
    if (refuseCrossOrigin(req, res)) return
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error('[workspaces] erreur interne', err)
      return send(res, 500, { error: 'Erreur interne du serveur de workspaces' })
    })
  } as WorkspacesApi
  // Audit R1 — à l'arrêt du serveur, les jobs d'arrière-plan meurent AVEC
  // lui : plus aucun processus orphelin qui survit à Ctrl+C, son registre
  // perdu avec le processus.
  workspacesApi.close = (): void => {
    jobs.killAll()
  }
  return workspacesApi
}

/** Audit R1 — the workspaces handler owns the background shell jobs: the
 * plugin calls close() on server shutdown so no orphan process survives
 * the dev/preview server (a running build used to outlive Ctrl+C, its
 * registry lost with the process). */
type WorkspacesHandlerFn = (req: IncomingMessage, res: ServerResponse) => void
export interface WorkspacesApi extends WorkspacesHandlerFn {
  close(): void
}
