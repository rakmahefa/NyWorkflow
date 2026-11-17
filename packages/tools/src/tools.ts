/**
 * The four tools the agent may call inside a workspace (M5): read, write,
 * ls, glob. `shell` is deliberately absent — out of scope for v0.1.0
 * (MILESTONES.md keeps it optional on purpose).
 *
 * Caps keep a runaway model honest: read 32 KiB, write 128 KiB, ls/glob
 * 500 entries, glob depth 8, at most one pending call at a time. Every
 * path is checked against the workspace root (scope.ts); `write` is the
 * only dangerous tool and requires a human approval before it runs —
 * the engine pauses the stage until the UI decides.
 *
 * Outcomes are plain data (French summaries, journaled as-is); the tools
 * never throw for expected refusals, only for programmer errors.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { resolveInScope } from './scope.ts'
import type { ScopeResolution } from './scope.ts'

export type ToolName = 'read' | 'write' | 'ls' | 'glob'
export const TOOL_NAMES: readonly ToolName[] = ['read', 'write', 'ls', 'glob']

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

const refusal = (code: ToolRefusalCode, summary: string): ToolRefusal => ({ ok: false, code, summary })

const argString = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined

/** Display path of a call, for summaries and refusal lines. */
export function displayPath(call: ToolCall): string {
  const p = argString(call.args, 'path')
  if (p !== undefined) return p
  const pattern = argString(call.args, 'pattern')
  if (pattern !== undefined) return pattern
  return JSON.stringify(call.args)
}

/** The only dangerous tool (M5): writing needs a human approval. */
export function isDangerous(tool: string): boolean {
  return tool === 'write'
}

function outOfScope(tool: ToolName, raw: string, scope: ScopeResolution): ToolRefusal {
  return refusal('out_of_scope', `refusé (hors périmètre) : ${tool} « ${raw} » — ${scope.reason ?? 'chemin refusé'}`)
}

/**
 * Validates a call WITHOUT executing it: known tool, well-formed args,
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
  if (call.tool === 'read' || call.tool === 'write' || call.tool === 'ls') {
    const path = argString(args, 'path') ?? (call.tool === 'ls' ? '.' : undefined)
    if (path === undefined || path.trim() === '') {
      return { ok: false, approval: false, refusal: refusal('invalid_args', `« ${call.tool} » attend un chemin (path) non vide`) }
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

  // Scope: read/write/ls carry a path; glob walks the root itself.
  if (call.tool !== 'glob') {
    const raw = argString(args, 'path') ?? '.'
    const scope = await resolveInScope(root, raw)
    if (!scope.ok) return { ok: false, approval: false, refusal: outOfScope(call.tool, raw, scope) }
  }

  return { ok: true, approval: isDangerous(call.tool) }
}

/** Executes a checked, non-dangerous call (or an approved write). */
async function runTool(root: string, call: ToolCall): Promise<ToolOutcome> {
  switch (call.tool) {
    case 'read':
      return runRead(root, call.args)
    case 'write':
      return runWrite(root, call.args)
    case 'ls':
      return runLs(root, call.args)
    case 'glob':
      return runGlob(root, call.args)
  }
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
 * of writing.
 */
export async function executeToolCall(root: string, call: ToolCall, approved: boolean): Promise<ToolOutcome> {
  const check = await checkToolCall(root, call)
  if (!check.ok) return check.refusal as ToolRefusal
  if (check.approval && !approved) {
    return refusal('approval_required', `write « ${displayPath(call)} » en attente d'approbation`)
  }
  return runTool(root, call)
}

/** The outcome the engine journals when the human refuses a pending call. */
export function refusedByUser(call: ToolCall): ToolRefusal {
  return refusal('refused_by_user', `refusé par l'utilisateur : ${call.tool} « ${displayPath(call)} »`)
}
