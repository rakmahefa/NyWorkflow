/**
 * /workspaces HTTP API — the agentic ICM surface (M11 rewrite).
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET  /workspaces                        → { workspaces: [{ name, summary? }] }
 *   POST /workspaces                        → scaffold a fresh agentic workspace
 *                                             (body: { name }) → 201 { name, tree }
 *   GET  /workspaces/:name/icm              → { name, tree, contexts, system } —
 *                                             the ICM loaded toward the model
 *   GET  /workspaces/:name/file?path=…      → { path, content, bytes } — read-only
 *                                             preview, same scope guard as the tools
 *   POST /workspaces/:name/tool             → execute one agent tool call for a
 *                                             session (body: { sessionId, tool, args })
 *   POST /workspaces/:name/tool/decision    → resolve a paused call (M5 pattern):
 *                                             { sessionId, decision: approve|refuse }
 *
 * The workflow engine of phase 1 (runs, stages, advance) is gone: sessions
 * are the only surface, and a session is agentic — the browser runs the
 * model loop (standard tool_calls through the gateway), and every tool
 * call lands HERE. The journal stays the truth: tool.call is journaled on
 * arrival, tool.result on completion, so a dangerous call paused for a
 * human survives restarts by derivation — exactly like the M5 runs did,
 * minus the engine.
 */
import { existsSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { buildIcmSystemPrompt, loadIcm, scaffoldAgenticWorkspace } from '@nyworkflow/core'
import { checkToolCall, executeToolCall, isDangerous, refusedByUser } from '@nyworkflow/tools'
import type { ToolCall, ToolOutcome } from '@nyworkflow/tools'
import { resolveInScope } from '@nyworkflow/tools'
import { appendEvent, deriveSession, isSessionId, journalPath, readEvents } from '@nyworkflow/session'
import type { SessionEvent } from '@nyworkflow/session'

/** One workspace as listed. */
export interface WorkspaceSummaryDto {
  name: string
  /** First heading of the root CONTEXT.md, when there is one. */
  summary?: string
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
  | { status: 'executed'; outcome: ToolOutcome }
  /** A dangerous call (write, shell) is paused — decide via /tool/decision. */
  | { status: 'pending'; call: { tool: string; args: unknown } }

export interface WorkspacesHandlerOptions {
  /** Folder containing one sub-folder per workspace. */
  dir: string
  /** NyWorkflow home (journals under home/sessions). */
  home: string
}

const BODY_LIMIT = 2_000_000
/** Preview bound — same figure as the write tool cap (chars). */
const PREVIEW_MAX = 131_072
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

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

export function createWorkspacesHandler(
  options: WorkspacesHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { dir, home } = options
  /** Sessions with a tool decision in flight — a second decision gets a 409. */
  const busy = new Set<string>()

  /** The workspace root, or 404. */
  function rootOf(name: string): string {
    if (!isWorkspaceName(name) || !existsSync(join(dir, name))) throw notFound('workspace inconnu')
    return join(dir, name)
  }

  /** First heading of the root CONTEXT.md (≤ 100 chars), if any. */
  async function summaryOf(root: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(root, 'CONTEXT.md'), 'utf8')
      const heading = raw
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('# '))
      if (heading === undefined) return undefined
      return heading.slice(2).trim().slice(0, 100)
    } catch {
      return undefined
    }
  }

  async function list(): Promise<WorkspaceSummaryDto[]> {
    let names: string[] = []
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const out: WorkspaceSummaryDto[] = []
    for (const name of names.sort()) {
      if (!isWorkspaceName(name)) continue
      const summary = await summaryOf(join(dir, name))
      out.push(summary === undefined ? { name } : { name, summary })
    }
    return out
  }

  /** POST /workspaces — scaffold a fresh agentic workspace (M11). */
  async function createWorkspace(req: IncomingMessage): Promise<{ name: string; tree: string }> {
    const body = await readJson(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name === '' || !isWorkspaceName(name)) throw badRequest('nom de workspace attendu (lettres, chiffres, . _ -, sans espace)')
    try {
      await scaffoldAgenticWorkspace(join(dir, name))
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err))
    }
    const icm = await loadIcm(join(dir, name))
    return { name, tree: icm.tree }
  }

  /** GET /workspaces/:name/icm — the ICM toward the model. */
  async function icmOf(name: string): Promise<IcmDto> {
    const root = rootOf(name)
    const icm = await loadIcm(root)
    return { name, tree: icm.tree, contexts: icm.contexts, system: buildIcmSystemPrompt(icm) }
  }

  /**
   * Read-only preview of one workspace file, for the human eye. Same
   * scope guard as the agent tools (lexical + realpath).
   */
  async function filePreview(name: string, rawPath: string | null): Promise<{ path: string; content: string; bytes: number }> {
    if (rawPath === null || rawPath.trim() === '') throw badRequest('paramètre « path » attendu (chemin relatif au workspace)')
    const root = rootOf(name)
    const scope = await resolveInScope(root, rawPath)
    if (!scope.ok) throw badRequest(`chemin refusé — ${scope.reason}`)
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

  /** Loads a session journal and checks it is bound to this workspace. */
  async function sessionJournal(name: string, sessionId: string): Promise<{ file: string; events: SessionEvent[] }> {
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
    return { file, events }
  }

  /** The last tool.call still waiting for its tool.result, if any. */
  function pendingCall(events: readonly SessionEvent[]): ToolCall | undefined {
    let open: ToolCall | undefined
    for (const e of events) {
      if (e.type === 'tool.call') open = { tool: e.tool as ToolCall['tool'], args: (e.args ?? {}) as Record<string, unknown> }
      else if (e.type === 'tool.result') open = undefined
    }
    return open
  }

  /**
   * POST /workspaces/:name/tool — journals the call, executes it, or pauses
   * it for a human when it is dangerous (write, shell). Refusals (unknown
   * tool, bad args, out of scope) are executed-and-journaled refusals: the
   * model sees the error and adjusts.
   */
  async function runTool(req: IncomingMessage, name: string): Promise<ToolRunDto> {
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const tool = typeof body.tool === 'string' ? body.tool : ''
    const args = body.args
    if (tool === '') throw badRequest('outil (tool) attendu')
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw badRequest('arguments (args) : objet attendu')

    const root = rootOf(name)
    const { file } = await sessionJournal(name, sessionId)
    if (busy.has(sessionId)) throw new HttpError(409, 'une décision d\'outil est déjà en cours pour cette session')
    if (pendingCall(await readEvents(file)) !== undefined) {
      throw new HttpError(409, 'un appel d\'outil est déjà en attente — décidez-le (POST /tool/decision) avant d\'en lancer un autre')
    }

    const call: ToolCall = { tool: tool as ToolCall['tool'], args: args as Record<string, unknown> }
    const check = await checkToolCall(root, call)
    await appendEvent(file, { type: 'tool.call', at: nowIso(), tool: call.tool, args: call.args })

    if (!check.ok) {
      const refusal = check.refusal as ToolOutcome
      await appendEvent(file, { type: 'tool.result', at: nowIso(), ok: false, summary: refusal.summary })
      return { status: 'executed', outcome: refusal }
    }
    if (check.approval) {
      // Dangerous (write, shell): the human decides — the journal keeps the
      // call open (no tool.result), the UI shows the approval card.
      return { status: 'pending', call: { tool: call.tool, args: call.args } }
    }
    const outcome = await executeToolCall(root, call, false)
    await appendEvent(file, {
      type: 'tool.result',
      at: nowIso(),
      ok: outcome.ok,
      summary: outcome.summary,
      ...(outcome.ok ? { data: outcome.data } : {}),
    })
    return { status: 'executed', outcome }
  }

  /** POST /workspaces/:name/tool/decision — resolve the paused call (M5 pattern). */
  async function decideTool(req: IncomingMessage, name: string): Promise<ToolRunDto> {
    const body = await readJson(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'refuse' ? 'refuse' : ''
    if (decision === '') throw badRequest('decision : "approve" ou "refuse" attendu')

    const root = rootOf(name)
    const { file, events } = await sessionJournal(name, sessionId)
    if (busy.has(sessionId)) throw new HttpError(409, 'une décision d\'outil est déjà en cours pour cette session')
    const call = pendingCall(events)
    if (call === undefined) throw new HttpError(409, 'aucun appel d\'outil en attente pour cette session')

    busy.add(sessionId)
    try {
      const outcome: ToolOutcome =
        decision === 'refuse' ? refusedByUser(call) : await executeToolCall(root, call, true)
      await appendEvent(file, {
        type: 'tool.result',
        at: nowIso(),
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.ok ? { data: outcome.data } : {}),
      })
      return { status: 'executed', outcome }
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

  return function workspacesApi(req, res): void {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error('[workspaces] erreur interne', err)
      return send(res, 500, { error: 'Erreur interne du serveur de workspaces' })
    })
  }
}
