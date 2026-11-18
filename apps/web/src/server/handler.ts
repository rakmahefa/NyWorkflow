/**
 * /sessions HTTP API — thin adapter over @nyworkflow/session.
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET    /sessions              → { sessions: SessionDto[] }  (oldest first)
 *   POST   /sessions              → create (body: { title?, workspace, security? })
 *                                     M14: workspace OBLIGATORY — the session
 *                                     folder is selected, its .workspace/ ICM
 *                                     tree ensured, its .logs/ prepared
 *   DELETE /sessions/:id          → delete the journal (M11)
 *   POST   /sessions/:id/events   → append a chat event (user|assistant message)
 *   POST   /sessions/:id/fork     → fork the journal
 *   POST   /sessions/:id/rename   → rename (M12)
 *   POST   /sessions/:id/security → M13: change the security level live
 *   POST   /sessions/:id/turn     → M13: journal a completed agent turn
 *                                     (turn.completed — durable traces)
 *   POST   /sessions/:id/response → M16: log one round's MODEL RESPONSE
 *                                     to model.jsonl — thinking titled,
 *                                     text, tool_calls titled, protocol
 *                                     compliance, ICM prompt size
 *
 * M14 — every session-scoped record (lifecycle, chat, turns) lands BOTH
 * in the global trio (<home>/.logs) AND in the session's own trio inside
 * its folder (<sessionFolder>/.logs/<sessionId>/) — the pilot zips and
 * uploads that folder to refine the harness.
 *
 * Chat events here — tool.call / tool.result events land in the SAME
 * journal through /workspaces (M11): the agent's tools are journaled by
 * the server that executes them, so a session's journal stays the single
 * source of truth for chat AND tool activity. The DTO therefore carries
 * the raw events, in order — the browser derives messages, tool rows and
 * model history from them (the journal IS the protocol).
 */
import { existsSync } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ensureIcmTree } from '@nyworkflow/core'
import {
  appendEvent,
  asSecurityLevel,
  deleteJournal,
  deriveSession,
  forkJournal,
  isSessionId,
  journalPath,
  newSessionId,
  readEvents,
} from '@nyworkflow/session'
import type { DerivedSession, SecurityLevel, SessionEvent } from '@nyworkflow/session'
import { dropSessionProfiler, sessionProfiler, type Profiler } from './logs.ts'
import { resolveWorkspaceRoot, workspaceExists } from './workspaces.ts'

/** Workspace folder names, same rule as the /workspaces API. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** What the UI consumes: the derived header + the raw, ordered events. */
export interface SessionDto {
  id: string
  title: string
  createdAt: number
  forkedFrom?: string
  /** ICM workspace the session is bound to (M11: every session has one). */
  workspace?: string
  /** M13 — effective security level ('ask' by default). */
  security: SecurityLevel
  /** Raw journal events, in order — messages, tool calls, everything. */
  events: SessionEvent[]
  messages: { role: 'user' | 'assistant'; text: string; at: number }[]
}

export interface SessionsHandlerOptions {
  /** Workspaces folder — validates the workspace at creation time. */
  workspacesDir?: string
  /** M13 — profiling logs (session lifecycle + completed turns). */
  profiler?: Profiler
}

const BODY_LIMIT = 1_000_000
const TEXT_MAX = 100_000

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
const toMs = (iso: string): number => Date.parse(iso) || 0

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

export function createSessionsHandler(
  home: string,
  options: SessionsHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const sessionsDir = join(home, 'sessions')
  const workspacesDir = options.workspacesDir ?? ''
  const profiler = options.profiler

  /** A free journal id (retries on the unlikely collision). */
  function freshId(): string {
    for (let i = 0; i < 8; i++) {
      const id = newSessionId()
      if (!existsSync(journalPath(home, id))) return id
    }
    throw new Error('aucun id libre trouvé')
  }

  async function journalNames(): Promise<string[]> {
    try {
      return (await readdir(sessionsDir)).filter((n) => n.endsWith('.jsonl'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  function toDto(id: string, d: DerivedSession, events: SessionEvent[]): SessionDto {
    return {
      id,
      title: d.title,
      createdAt: toMs(d.createdAt),
      forkedFrom: d.forkedFrom,
      workspace: d.workspace,
      security: d.security,
      events,
      messages: d.messages.map((m) => ({ role: m.role, text: m.text, at: toMs(m.at) })),
    }
  }

  /** All journals, derived, oldest first. Unreadable journals are skipped. */
  async function list(): Promise<SessionDto[]> {
    const out: SessionDto[] = []
    for (const name of await journalNames()) {
      const id = name.slice(0, -6)
      if (!isSessionId(id)) continue
      try {
        const events = await readEvents(journalPath(home, id))
        out.push(toDto(id, deriveSession(events), events))
      } catch (err) {
        console.warn(`[sessions] journal illisible, ignoré : ${id}`, err instanceof Error ? err.message : err)
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return out
  }

  /** Validates a workspace name against the registry + manifest (M11, M12). */
  async function checkWorkspace(name: unknown): Promise<string> {
    if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
      throw badRequest('nom de workspace invalide')
    }
    if (workspacesDir !== '' && !(await workspaceExists(workspacesDir, name))) {
      throw badRequest(`workspace inconnu : ${name}`)
    }
    return name
  }

  /** M14 — the per-session profiler inside the session's folder, when its
   * workspace root resolves; undefined otherwise (never fatal). */
  async function perSession(workspace: string | undefined, sessionId: string): Promise<Profiler | undefined> {
    if (workspace === undefined || workspacesDir === '') return undefined
    try {
      const root = await resolveWorkspaceRoot(workspacesDir, workspace)
      return root === undefined ? undefined : sessionProfiler(root, sessionId)
    } catch {
      return undefined
    }
  }

  async function create(req: IncomingMessage): Promise<SessionDto> {
    const body = await readJson(req)
    const given = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : ''
    // M14 — the session folder is MANDATORY: a session without a folder is
    // no longer possible (the ICM and the logs live in that folder).
    if (body.workspace === undefined || body.workspace === null || body.workspace === '') {
      throw badRequest('workspace obligatoire — sélectionnez le dossier de la session')
    }
    const workspace = await checkWorkspace(body.workspace)
    const security = asSecurityLevel(body.security) ?? 'ask'
    const fallback = `Session ${(await journalNames()).length + 1}`
    const title = given || fallback
    const id = freshId()
    const at = nowIso()

    // M14 — the session folder carries its ICM: the complete .workspace/
    // tree is created inside when absent, kept as-is when present (a second
    // session on the same folder continues the living memory). A folder
    // that cannot carry it is refused honestly.
    let wsRoot: string | undefined
    if (workspacesDir !== '') {
      wsRoot = await resolveWorkspaceRoot(workspacesDir, workspace)
    }
    let icm: 'created' | 'present' | 'upgraded' = 'present'
    if (wsRoot !== undefined) {
      try {
        icm = await ensureIcmTree(wsRoot)
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err))
      }
    }

    await appendEvent(journalPath(home, id), {
      type: 'session.created',
      at,
      title,
      workspace,
      ...(security !== 'ask' ? { security } : {}),
    })
    profiler?.session({ kind: 'session.created', sessionId: id, title, workspace, security })
    profiler?.activity({ kind: 'icm.tree', sessionId: id, workspace, status: icm, dir: '.workspace' })
    const sp = await perSession(workspace, id)
    sp?.engine({ kind: 'session.open', sessionId: id, workspace, security, icm, folder: wsRoot })
    sp?.session({ kind: 'session.created', sessionId: id, title, workspace, security })
    sp?.activity({ kind: 'icm.tree', sessionId: id, workspace, status: icm, dir: '.workspace' })
    return {
      id,
      title,
      createdAt: toMs(at),
      security,
      events: [],
      messages: [],
      workspace,
    }
  }

  async function appendChatEvent(req: IncomingMessage, id: string): Promise<void> {
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const body = await readJson(req)
    let kind: 'user.message' | 'assistant.message'
    if (body.type === 'user.message') kind = 'user.message'
    else if (body.type === 'assistant.message') kind = 'assistant.message'
    else throw badRequest('type : user.message ou assistant.message attendu')
    const text = body.text
    if (typeof text !== 'string' || text.length === 0) throw badRequest('texte non vide attendu')
    if (text.length > TEXT_MAX) throw badRequest(`texte trop long (max ${TEXT_MAX} caractères)`)
    await appendEvent(file, { type: kind, at: nowIso(), text } as SessionEvent)
    profiler?.session({ kind, sessionId: id, chars: text.length })
    const d = deriveSession(await readEvents(file))
    ;(await perSession(d.workspace, id))?.session({ kind, sessionId: id, chars: text.length })
  }

  /** M13 — change the security level live: one session.security event, the
   * last one wins in derivation. */
  async function changeSecurity(req: IncomingMessage, id: string): Promise<SessionDto> {
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const body = await readJson(req)
    const level = asSecurityLevel(body.level)
    if (level === undefined) throw badRequest('level : "ask", "accept" ou "no-tools" attendu')
    await appendEvent(file, { type: 'session.security', at: nowIso(), level })
    const events = await readEvents(file)
    const d = deriveSession(events)
    profiler?.session({ kind: 'session.security', sessionId: id, level })
    ;(await perSession(d.workspace, id))?.session({ kind: 'session.security', sessionId: id, level })
    return toDto(id, d, events)
  }

  /** M13 — journal a completed agent turn (turn.completed): the durable
   * trace of the browser loop — model, rounds, duration, outcome. */
  async function completeTurn(req: IncomingMessage, id: string): Promise<void> {
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const body = await readJson(req)
    const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim().slice(0, 100) : ''
    if (model === '') throw badRequest('model non vide attendu')
    const outcome = body.outcome === 'ok' ? 'ok' : body.outcome === 'error' ? 'error' : body.outcome === 'stopped' ? 'stopped' : ''
    if (outcome === '') throw badRequest('outcome : "ok", "error" ou "stopped" attendu')
    const int = (v: unknown, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0
    const thinkLevel =
      body.thinkLevel === null || body.thinkLevel === undefined ? null : typeof body.thinkLevel === 'number' ? int(body.thinkLevel, 4) : null
    await appendEvent(file, {
      type: 'turn.completed',
      at: nowIso(),
      model,
      ...(thinkLevel !== null ? { thinkLevel } : {}),
      rounds: int(body.rounds, 99),
      ms: int(body.ms, 3_600_000),
      outcome,
      toolCalls: int(body.toolCalls, 500),
      ...(typeof body.messages === 'number' ? { messages: int(body.messages, 1000) } : {}),
      ...(typeof body.tools === 'number' ? { tools: int(body.tools, 50) } : {}),
      thinkingChars: int(body.thinkingChars, 10_000_000),
      textChars: int(body.textChars, 10_000_000),
      ...(typeof body.error === 'string' && body.error !== '' ? { error: body.error.slice(0, 300) } : {}),
    })
    profiler?.activity({
      kind: 'turn.completed',
      sessionId: id,
      model,
      thinkLevel,
      rounds: int(body.rounds, 99),
      ms: int(body.ms, 3_600_000),
      outcome,
      toolCalls: int(body.toolCalls, 500),
      thinkingChars: int(body.thinkingChars, 10_000_000),
      textChars: int(body.textChars, 10_000_000),
    })
    // M14 — the session's own trio: the turn is its engine view too.
    const dTurn = deriveSession(await readEvents(file))
    const spTurn = await perSession(dTurn.workspace, id)
    spTurn?.engine({
      kind: 'turn.completed',
      sessionId: id,
      model,
      thinkLevel,
      rounds: int(body.rounds, 99),
      ms: int(body.ms, 3_600_000),
      outcome,
      toolCalls: int(body.toolCalls, 500),
    })
    spTurn?.activity({
      kind: 'turn.completed',
      sessionId: id,
      model,
      thinkLevel,
      rounds: int(body.rounds, 99),
      ms: int(body.ms, 3_600_000),
      outcome,
      toolCalls: int(body.toolCalls, 500),
      thinkingChars: int(body.thinkingChars, 10_000_000),
      textChars: int(body.textChars, 10_000_000),
    })
  }

  /**
   * M16 — one round's MODEL RESPONSE, logged to model.jsonl (the 4th
   * profiling log): what the model ACTUALLY said — thinking (titled),
   * text, tool_calls (titled) — plus the protocol compliance, computed
   * HERE (the server is the truth, not the browser). The pilot uploads
   * these logs to check whether the three-step protocol is followed in
   * real life: thinking first? titles filled? group coherent?
   */
  async function modelResponse(req: IncomingMessage, id: string): Promise<void> {
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const body = await readJson(req)
    const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim().slice(0, 100) : ''
    if (model === '') throw badRequest('model non vide attendu')
    const int = (v: unknown, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0
    const round = int(body.round, 999)
    const outcome = body.outcome === 'ok' ? 'ok' : body.outcome === 'tool_calls' ? 'tool_calls' : body.outcome === 'stopped' ? 'stopped' : body.outcome === 'error' ? 'error' : ''
    if (outcome === '') throw badRequest('outcome : "ok", "tool_calls", "stopped" ou "error" attendu')
    const str = (v: unknown, max: number): string => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max)}… (tronqué à ${max} caractères)` : v) : '')
    // Titles: capped in count and length — they are the compliance signal.
    const thinkingTitles = (Array.isArray(body.thinkingTitles) ? body.thinkingTitles : [])
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .slice(0, 20)
      .map((t) => t.trim().slice(0, 120))
    // Tool calls: the group as the model made it (tool, title, args).
    const toolCalls = (Array.isArray(body.toolCalls) ? body.toolCalls : [])
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && !Array.isArray(c))
      .slice(0, 50)
      .map((c) => ({
        tool: typeof c.tool === 'string' ? c.tool.slice(0, 40) : 'unknown',
        title: typeof c.title === 'string' ? c.title.trim().slice(0, 60) : '',
        args: str(JSON.stringify(c.args ?? {}), 4096),
      }))
    const thinkingChars = int(body.thinkingChars, 10_000_000)
    const textChars = int(body.textChars, 10_000_000)
    const firstEvent = body.firstEvent === 'thinking' ? 'thinking' : body.firstEvent === 'text' ? 'text' : body.firstEvent === 'tool_calls' ? 'tool_calls' : 'none'
    // Protocol compliance — the automatic check the pilot used to do by eye.
    const protocol = {
      thinkingFirst: firstEvent === 'thinking',
      thinkingTitled: thinkingTitles.length > 0,
      toolCalls: toolCalls.length,
      toolCallsTitled: toolCalls.filter((c) => c.title !== '').length,
    }
    const record = {
      kind: 'model.response',
      sessionId: id,
      model,
      round,
      outcome,
      ms: int(body.ms, 3_600_000),
      systemChars: int(body.systemChars, 10_000_000),
      messages: int(body.messages, 1000),
      thinkingChars,
      textChars,
      firstEvent,
      thinkingTitles,
      thinking: str(body.thinking, 32_768),
      text: str(body.text, 32_768),
      toolCalls,
      protocol,
      ...(typeof body.error === 'string' && body.error !== '' ? { error: body.error.slice(0, 300) } : {}),
    }
    profiler?.model(record)
    // M16 — the session's own quartet: the response is its model view too.
    const d = deriveSession(await readEvents(file))
    const sp = await perSession(d.workspace, id)
    sp?.model({ ...record, ...(d.workspace !== undefined ? { workspace: d.workspace } : {}) })
  }

  /** Fork d'un journal (M12). */
  async function fork(id: string): Promise<SessionDto> {
    try {
      await access(journalPath(home, id))
    } catch {
      throw notFound('session inconnue')
    }
    const forkId = freshId()
    await forkJournal(home, id, forkId)
    const events = await readEvents(journalPath(home, forkId))
    const d = deriveSession(events)
    profiler?.session({ kind: 'session.forked', sessionId: forkId, from: id, workspace: d.workspace })
    // M14 — the fork opens its OWN trio in the session folder.
    const spFork = await perSession(d.workspace, forkId)
    spFork?.engine({ kind: 'session.open', sessionId: forkId, forkedFrom: id, workspace: d.workspace, security: d.security })
    spFork?.session({ kind: 'session.forked', sessionId: forkId, from: id, workspace: d.workspace })
    return toDto(forkId, d, events)
  }

  /** M11 — deletes a journal (its messages and tool history with it). The
   * session's .logs folder inside its workspace STAYS: it is the durable
   * story the pilot zips and uploads. */
  async function remove(id: string): Promise<void> {
    try {
      await access(journalPath(home, id))
    } catch {
      throw notFound('session inconnue')
    }
    const d = deriveSession(await readEvents(journalPath(home, id)))
    profiler?.session({ kind: 'session.deleted', sessionId: id })
    const sp = await perSession(d.workspace, id)
    sp?.session({ kind: 'session.deleted', sessionId: id })
    if (d.workspace !== undefined && workspacesDir !== '') {
      const root = await resolveWorkspaceRoot(workspacesDir, d.workspace).catch(() => undefined)
      if (root !== undefined) dropSessionProfiler(root, id)
    }
    await deleteJournal(home, id)
  }

  /** M12 — renames a session (append-only: the session.renamed event wins in derivation). */
  async function rename(req: IncomingMessage, id: string): Promise<SessionDto> {
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const body = await readJson(req)
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : ''
    if (title === '') throw badRequest('titre non vide attendu')
    await appendEvent(file, { type: 'session.renamed', at: nowIso(), title })
    const events = await readEvents(file)
    const d = deriveSession(events)
    profiler?.session({ kind: 'session.renamed', sessionId: id, title })
    ;(await perSession(d.workspace, id))?.session({ kind: 'session.renamed', sessionId: id, title })
    return toDto(id, d, events)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = (req.url ?? '/').split('?')[0] || '/'

    if (url === '/' || url === '') {
      if (method === 'GET') return send(res, 200, { sessions: await list() })
      if (method === 'POST') return send(res, 201, await create(req))
      throw notFound('route inconnue')
    }

    const parts = url.replace(/^\//, '').split('/')
    // NB: mounted under /sessions — the prefix is already stripped here, so
    // "/sessions/:id" arrives as "/:id" (1 segment), "/sessions/:id/events"
    // as "/:id/events" (2 segments).
    if (parts.length === 1 && isSessionId(parts[0] ?? '')) {
      const id = parts[0] as string
      if (method === 'DELETE') {
        await remove(id)
        return send(res, 200, { ok: true })
      }
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && isSessionId(parts[0] ?? '')) {
      const id = parts[0] as string
      if (parts[1] === 'events' && method === 'POST') {
        await appendChatEvent(req, id)
        return send(res, 201, { ok: true })
      }
      if (parts[1] === 'fork' && method === 'POST') {
        return send(res, 201, await fork(id))
      }
      if (parts[1] === 'rename' && method === 'POST') {
        return send(res, 200, await rename(req, id))
      }
      if (parts[1] === 'security' && method === 'POST') {
        return send(res, 200, await changeSecurity(req, id))
      }
      if (parts[1] === 'turn' && method === 'POST') {
        await completeTurn(req, id)
        return send(res, 201, { ok: true })
      }
      if (parts[1] === 'response' && method === 'POST') {
        await modelResponse(req, id)
        return send(res, 201, { ok: true })
      }
      if (parts[1] === 'delete' && method === 'POST') {
        await remove(id)
        return send(res, 200, { ok: true })
      }
      if (method === 'DELETE') {
        await remove(id)
        return send(res, 200, { ok: true })
      }
    }
    throw notFound('route inconnue')
  }

  return function sessionsApi(req, res): void {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error('[sessions] erreur interne', err)
      return send(res, 500, { error: 'Erreur interne du serveur de sessions' })
    })
  }
}
