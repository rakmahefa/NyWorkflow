/**
 * The tools the agent may call inside a workspace (M5: read, write, ls,
 * glob — M11: mkdir, shell, websearch — M12: shell_output, shell_kill and
 * the background flag on shell). The workspace stays the perimeter: every
 * file path is checked against its root (scope.ts). `write` and `shell` are
 * dangerous — the engine pauses for a human approval before they run.
 * `mkdir` is deliberately free: the pilot wants the model to shape its own
 * tree. `websearch` is read-only on the web and returns cleaned content
 * (websearch.ts). A background shell (M12) runs detached after approval —
 * followed with shell_output, stopped with shell_kill (both free: they
 * only touch jobs the agent itself started).
 *
 * Caps keep a runaway model honest: read 32 KiB, write 128 KiB, ls/glob
 * 500 entries, glob depth 8, shell 30 s + 16 KiB per stream (foreground),
 * background shell 10 min + 64 KiB per stream + 16 jobs per workspace,
 * websearch 8 results / 64 KiB of cleaned page, at most one PENDING
 * DANGEROUS call at a time (parallel safe calls are fine, M12).
 *
 * Outcomes are plain data (French summaries, journaled as-is); the tools
 * never throw for expected refusals, only for programmer errors.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { resolveInScope } from './scope.ts'
import type { ScopeResolution } from './scope.ts'
import { runWebsearch } from './websearch.ts'
import type { ShellJobRegistry } from './shelljobs.ts'

export type ToolName =
  | 'read'
  | 'write'
  | 'ls'
  | 'glob'
  | 'mkdir'
  | 'shell'
  | 'websearch'
  | 'shell_output'
  | 'shell_kill'
  | 'no_tool'
export const TOOL_NAMES: readonly ToolName[] = [
  'read',
  'write',
  'ls',
  'glob',
  'mkdir',
  'shell',
  'websearch',
  'shell_output',
  'shell_kill',
  'no_tool',
]

/** A tool call as the model expresses it (validated here, journaled verbatim). */
export interface ToolCall {
  tool: ToolName
  args: Record<string, unknown>
}

export type ToolRefusalCode =
  | 'unknown_tool'
  | 'invalid_args'
  | 'out_of_scope'
  | 'approval_required'
  | 'refused_by_user'
  | 'tools_disabled'
  | 'io_error'

export interface ToolOk {
  ok: true
  /** One-line French summary — what tool.result journals. */
  summary: string
  /** Exact payload fed back to the model — journaled as tool.result data. */
  data: unknown
}

export interface ToolRefusal {
  ok: false
  code: ToolRefusalCode
  summary: string
}

export type ToolOutcome = ToolOk | ToolRefusal

/** Pre-execution check: can this call run at all, and does it need a human? */
export interface ToolCheck {
  /** false: refused before any pause (unknown tool, bad args, out of scope). */
  ok: boolean
  refusal?: ToolRefusal
  /** true (write only): a human must approve before execution. */
  approval: boolean
}

const READ_MAX = 32_768
const WRITE_MAX = 131_072
const LIST_MAX = 500
const GLOB_DEPTH = 8
const PATTERN_MAX = 256
const SHELL_CMD_MAX = 4_000
export const SHELL_TIMEOUT_MS = 30_000
const SHELL_STREAM_MAX = 16_384

/** The shell used by the `shell` tool — overridable, bash by default (Linux). */
export const SHELL_BIN = process.env.NYW_SHELL && process.env.NYW_SHELL.trim() !== '' ? process.env.NYW_SHELL.trim() : 'bash'

const refusal = (code: ToolRefusalCode, summary: string): ToolRefusal => ({ ok: false, code, summary })

const argString = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined

/** Display path of a call, for summaries and refusal lines. */
export function displayPath(call: ToolCall): string {
  const p = argString(call.args, 'path')
  if (p !== undefined) return p
  const pattern = argString(call.args, 'pattern')
  if (pattern !== undefined) return pattern
  const command = argString(call.args, 'command')
  if (command !== undefined) return command.slice(0, 80)
  const query = argString(call.args, 'query') ?? argString(call.args, 'url')
  if (query !== undefined) return query
  return JSON.stringify(call.args)
}

/** The dangerous tools (M11): writing files and running commands need a human approval. */
export function isDangerous(tool: string): boolean {
  return tool === 'write' || tool === 'shell'
}

/**
 * M13 — the refusal a 'no-tools' session answers to every tool call: an
 * executed refusal (journaled, fed back to the model), not an HTTP error —
 * the model sees tools are off and adapts.
 */
export function toolsDisabledRefusal(tool: string): ToolRefusal {
  return refusal(
    'tools_disabled',
    `« ${tool} » refusé — outils désactivés pour cette session (niveau de sécurité « aucun outil »)`,
  )
}

function outOfScope(tool: ToolName, raw: string, scope: ScopeResolution): ToolRefusal {
  return refusal('out_of_scope', `refusé (hors périmètre) : ${tool} « ${raw} » — ${scope.reason ?? 'chemin refusé'}`)
}

/** Runtime context of an execution (M12): the background job registry of
 * the running server, when there is one. */
export interface ToolRuntime {
  /** Workspace name the call runs for (job labels). */
  workspace?: string
  /** Background shell jobs — omit and background shell/shell_output refuse honestly. */
  jobs?: ShellJobRegistry
}

/** Validates a call WITHOUT executing it: known tool, well-formed args,
 * path inside the workspace. `approval` says whether a human must sign
 * before runTool may run.
 */
export async function checkToolCall(root: string, call: ToolCall): Promise<ToolCheck> {
  if (!TOOL_NAMES.includes(call.tool)) {
    return { ok: false, approval: false, refusal: refusal('unknown_tool', `outil inconnu « ${call.tool} »`) }
  }

  const args = call.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, approval: false, refusal: refusal('invalid_args', `arguments invalides pour « ${call.tool} » : objet attendu`) }
  }

  // Args validation per tool (glob's pattern is syntax-checked here too).
  if (call.tool === 'read' || call.tool === 'write' || call.tool === 'ls' || call.tool === 'mkdir') {
    const path = argString(args, 'path') ?? (call.tool === 'ls' ? '.' : undefined)
    if (path === undefined || path.trim() === '') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', `« ${call.tool} » attend un chemin (path) non vide`) }
    }
  }
  if (call.tool === 'mkdir') {
    const path = (argString(args, 'path') ?? '').trim()
    if (path === '' || path === '.') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« mkdir » attend un chemin (path) non vide') }
    }
  }
  if (call.tool === 'shell') {
    const command = argString(args, 'command')
    if (command === undefined || command.trim() === '') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« shell » attend une commande (command) non vide') }
    }
    if (command.length > SHELL_CMD_MAX) {
      return { ok: false, approval: false, refusal: refusal('invalid_args', `commande trop longue pour « shell » (max ${SHELL_CMD_MAX} caractères)`) }
    }
    if (args.background !== undefined && typeof args.background !== 'boolean') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« shell » : background attend un booléen (true = détaché)') }
    }
  }
  if (call.tool === 'shell_output' || call.tool === 'shell_kill') {
    const jobId = argString(args, 'jobId')
    if (jobId === undefined || jobId.trim() === '') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', `« ${call.tool} » attend un identifiant de processus (jobId) non vide`) }
    }
  }
  if (call.tool === 'websearch') {
    const query = argString(args, 'query')
    const url = argString(args, 'url')
    if (query === undefined && url === undefined) {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« websearch » attend query (recherche) ou url (page à lire)') }
    }
    if (query !== undefined && url !== undefined) {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« websearch » : query OU url, pas les deux') }
    }
  }
  // M21 — no_tool : le garde-fou du contrat d'appels. Arguments libres
  // (title + reason), AUCUN chemin : l'appel ne touche rien, il signe la
  // réponse finale en prose du tour.
  if (call.tool === 'no_tool') {
    const reason = argString(args, 'reason')
    if (reason !== undefined && reason.length > 200) {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« no_tool » : reason trop long (max 200 caractères)') }
    }
  }
  if (call.tool === 'write') {
    if (typeof args.content !== 'string') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', '« write » attend un contenu (content) textuel') }
    }
    if (args.content.length > WRITE_MAX) {
      return {
        ok: false,
        approval: false,
        refusal: refusal('invalid_args', `contenu trop long pour « write » (max ${WRITE_MAX} caractères)`),
      }
    }
  }
  if (call.tool === 'glob') {
    const pattern = argString(args, 'pattern')
    if (pattern === undefined || pattern.trim() === '' || pattern.length > PATTERN_MAX) {
      return {
        ok: false,
        approval: false,
        refusal: refusal('invalid_args', `« glob » attend un motif (pattern) non vide (max ${PATTERN_MAX} caractères)`),
      }
    }
    if (globRegex(pattern) === null) {
      return { ok: false, approval: false, refusal: refusal('invalid_args', `motif glob invalide : « ${pattern} »`) }
    }
  }

  // Scope: read/write/ls/mkdir carry a path; glob walks the root itself;
  // shell runs with the root as cwd (approval is its leash); websearch
  // touches no workspace path at all.
  if (call.tool === 'read' || call.tool === 'write' || call.tool === 'ls' || call.tool === 'mkdir') {
    const raw = argString(args, 'path') ?? '.'
    const scope = await resolveInScope(root, raw)
    if (!scope.ok) return { ok: false, approval: false, refusal: outOfScope(call.tool, raw, scope) }
  }

  return { ok: true, approval: isDangerous(call.tool) }
}

/** Executes a checked, non-dangerous call (or an approved write/shell). */
async function runTool(root: string, call: ToolCall, runtime?: ToolRuntime): Promise<ToolOutcome> {
  switch (call.tool) {
    case 'read':
      return runRead(root, call.args)
    case 'write':
      return runWrite(root, call.args)
    case 'ls':
      return runLs(root, call.args)
    case 'glob':
      return runGlob(root, call.args)
    case 'mkdir':
      return runMkdir(root, call.args)
    case 'shell':
      return runShell(root, call.args, runtime)
    case 'websearch':
      return runWebsearch(call.args)
    case 'shell_output':
    case 'shell_kill':
      return runJobTool(call, runtime)
    case 'no_tool':
      return runNoTool(call.args)
  }
}

/** M21 — no_tool : le pivot du contrat d'appels. Le modèle qui n'a besoin
 * d'aucun outil émet QUAND MÊME son unique tool_call no_tool : la boucle
 * garde un format constant (thinking → tool_calls), le journal garde la
 * trace du choix, et le compte annoncé « PLAN: no_tool » vérifie. */
function runNoTool(args: Record<string, unknown>): Promise<ToolOutcome> {
  const reason = argString(args, 'reason')
  return Promise.resolve({
    ok: true,
    summary: reason !== undefined && reason.trim() !== '' ? `no_tool — ${reason.trim()}` : 'no_tool — aucun outil ce tour, réponse finale en prose',
    data: { noTool: true, reason: reason ?? '' },
  })
}

/** shell_output / shell_kill — free tools over the agent's own jobs (M12). */
function runJobTool(call: ToolCall, runtime?: ToolRuntime): Promise<ToolOutcome> {
  const jobId = (argString(call.args, 'jobId') ?? '').trim()
  if (runtime?.jobs === undefined || runtime.workspace === undefined) {
    return Promise.resolve(refusal('io_error', `« ${call.tool} » indisponible ici — aucun registre de processus d'arrière-plan`))
  }
  const res = call.tool === 'shell_output' ? runtime.jobs.output(runtime.workspace, jobId) : runtime.jobs.kill(runtime.workspace, jobId)
  if (!res.ok) return Promise.resolve(refusal('io_error', res.summary))
  const j = res.job
  const state = j.running ? 'en cours' : j.killed ? 'tué' : j.timedOut ? 'délai 10 min dépassé' : `code ${j.exitCode ?? 'signal'}`
  return Promise.resolve({
    ok: true,
    summary: `${call.tool} « ${jobId} » — ${state}, stdout ${j.stdout.length} caractères`,
    data: j,
  })
}

/** mkdir (M11) — the model shapes its own tree; recursive, low risk. */
async function runMkdir(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = (argString(args, 'path') ?? '').trim()
  const scope = await resolveInScope(root, raw)
  if (!scope.ok) return outOfScope('mkdir', raw, scope)
  try {
    await mkdir(scope.target as string, { recursive: true })
  } catch {
    return refusal('io_error', `mkdir refusé — création impossible : ${scope.rel}`)
  }
  return {
    ok: true,
    summary: `mkdir « ${scope.rel} » — dossier créé`,
    data: { path: scope.rel },
  }
}

/**
 * shell (M11, M12) — foreground: a command with the workspace root as
 * cwd, 30 s wall clock, 16 KiB per stream, command ≤ 4000 chars. A
 * timeout kills the child; the outcome says so. Background (M12):
 * `"background": true` spawns detached and returns the jobId at once —
 * the human approval happens BEFORE the spawn, like any shell call.
 */
function runShell(root: string, args: Record<string, unknown>, runtime?: ToolRuntime): Promise<ToolOutcome> {
  const command = (argString(args, 'command') ?? '').trim()
  if (command === '') return Promise.resolve(refusal('invalid_args', 'shell attend une commande (command) non vide'))
  if (args.background === true) {
    if (runtime?.jobs === undefined || runtime.workspace === undefined) {
      return Promise.resolve(refusal('io_error', 'shell en arrière-plan indisponible ici — aucun registre de processus'))
    }
    const spawned = runtime.jobs.spawn(runtime.workspace, root, command)
    if (!spawned.ok) return Promise.resolve(refusal('io_error', spawned.summary))
    return Promise.resolve({
      ok: true,
      summary: `shell (arrière-plan) « ${command.slice(0, 80)} » — démarré, jobId ${spawned.job.jobId} (shell_output pour suivre, shell_kill pour arrêter)`,
      data: { jobId: spawned.job.jobId, command, background: true, startedAt: spawned.job.startedAt },
    })
  }
  return new Promise<ToolOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(SHELL_BIN, ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve(refusal('io_error', `shell refusé — lancement impossible (${err instanceof Error ? err.message : String(err)})`))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const collect = (into: 'out' | 'err') => (chunk: Buffer): void => {
      if (into === 'out') stdout = (stdout + chunk.toString('utf8')).slice(0, SHELL_STREAM_MAX)
      else stderr = (stderr + chunk.toString('utf8')).slice(0, SHELL_STREAM_MAX)
    }
    child.stdout?.on('data', collect('out'))
    child.stderr?.on('data', collect('err'))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, SHELL_TIMEOUT_MS)
    const finish = (fn: () => ToolOutcome): void => {
      clearTimeout(timer)
      resolve(fn())
    }
    child.on('error', (err) => {
      finish(() => refusal('io_error', `shell refusé — ${err instanceof Error ? err.message : String(err)}`))
    })
    child.on('close', (code) => {
      const truncated = stdout.length >= SHELL_STREAM_MAX || stderr.length >= SHELL_STREAM_MAX
      const exitCode = code === null ? null : code
      finish(() => ({
        ok: true,
        summary:
          `shell « ${command.slice(0, 80)}${command.length > 80 ? '…' : ''} » — code ${exitCode ?? 'signal'}` +
          `${timedOut ? ' (délai 30 s dépassé, processus tué)' : ''}`,
        data: { command, exitCode, timedOut, truncated, stdout, stderr },
      }))
    })
  })
}

async function runRead(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = (argString(args, 'path') ?? '').trim()
  const scope = await resolveInScope(root, raw)
  if (!scope.ok) return outOfScope('read', raw, scope)
  let content: string
  try {
    content = await readFile(scope.target as string, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR' || code === 'EACCES') return refusal('io_error', `read refusé — ${code === 'EISDIR' ? 'c\'est un dossier' : 'accès refusé'} : ${scope.rel}`)
    return refusal('io_error', `read refusé — fichier introuvable : ${scope.rel}`)
  }
  const cut = content.length > READ_MAX
  const shown = cut ? `${content.slice(0, READ_MAX)}\n… (tronqué à ${READ_MAX} caractères)` : content
  return {
    ok: true,
    summary: `read « ${scope.rel} » — ${content.length} caractères${cut ? ' (tronqué)' : ''}`,
    data: { path: scope.rel, content: shown },
  }
}

async function runWrite(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = (argString(args, 'path') ?? '').trim()
  const content = args.content as string
  const scope = await resolveInScope(root, raw)
  if (!scope.ok) return outOfScope('write', raw, scope)
  try {
    await mkdir(dirname(scope.target as string), { recursive: true })
    await writeFile(scope.target as string, content, 'utf8')
  } catch {
    return refusal('io_error', `write refusé — écriture impossible : ${scope.rel}`)
  }
  return {
    ok: true,
    summary: `write « ${scope.rel} » — ${content.length} caractères écrits`,
    data: { path: scope.rel, bytes: content.length },
  }
}

async function runLs(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const given = argString(args, 'path')
  const raw = given !== undefined && given.trim() !== '' ? given.trim() : '.'
  const scope = await resolveInScope(root, raw)
  if (!scope.ok) return outOfScope('ls', raw, scope)
  let entries: Dirent[]
  try {
    entries = await readdir(scope.target as string, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') return refusal('io_error', `ls refusé — ce n'est pas un dossier : ${scope.rel}`)
    return refusal('io_error', `ls refusé — dossier introuvable : ${scope.rel}`)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const cut = entries.length > LIST_MAX
  const shown = entries.slice(0, LIST_MAX).map((e) => ({ name: e.name, dir: e.isDirectory() }))
  return {
    ok: true,
    summary: `ls « ${scope.rel} » — ${entries.length} entrées${cut ? ` (tronqué à ${LIST_MAX})` : ''}`,
    data: { path: scope.rel, entries: shown },
  }
}

/**
 * Glob patterns support `*` (one segment), `**` (any depth), `?` (one
 * char); everything else is literal — no character classes in v1.
 */
function globRegex(pattern: string): RegExp | null {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // '**/' — zero or more directory levels: matches root files too.
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i++
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${re}$`)
  } catch {
    return null
  }
}

async function runGlob(root: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = (argString(args, 'pattern') ?? '').trim()
  const re = globRegex(pattern)
  if (re === null) return refusal('invalid_args', `motif glob invalide : « ${pattern} »`)

  const realRoot = await resolveInScope(root, '.')
  const base = realRoot.target as string
  const matches: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (matches.length >= LIST_MAX || depth > GLOB_DEPTH) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable folder: not an error, just nothing to match
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (matches.length >= LIST_MAX) return
      const rel = relative(base, join(dir, e.name)).split(sep).join('/')
      if (re.test(rel)) matches.push(rel)
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(base, 0)
  return {
    ok: true,
    summary: `glob « ${pattern} » — ${matches.length} correspondance${matches.length > 1 ? 's' : ''}`,
    data: { pattern, matches },
  }
}

/**
 * Executes a tool call end to end: validate → scope-check → approval gate →
 * run. The engine calls this for non-dangerous tools (approved=true after
 * its own pause decision) and for approved writes; a direct call with
 * approved=false on a write returns the approval_required refusal instead
 * of writing. The runtime (M12) carries the background job registry.
 */
export async function executeToolCall(root: string, call: ToolCall, approved: boolean, runtime?: ToolRuntime): Promise<ToolOutcome> {
  const check = await checkToolCall(root, call)
  if (!check.ok) return check.refusal as ToolRefusal
  if (check.approval && !approved) {
    return refusal('approval_required', `${call.tool} « ${displayPath(call)} » en attente d'approbation`)
  }
  return runTool(root, call, runtime)
}

/** The outcome the engine journals when the human refuses a pending call. */
export function refusedByUser(call: ToolCall): ToolRefusal {
  return refusal('refused_by_user', `refusé par l'utilisateur : ${call.tool} « ${displayPath(call)} »`)
}
