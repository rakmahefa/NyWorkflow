/**
 * /workspaces HTTP API — the ICM engine, server-side (M4).
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET  /workspaces                        → { workspaces: WorkspaceSummaryDto[] }
 *   GET  /workspaces/:name                  → WorkspaceDetailDto (contracts + runs)
 *   POST /workspaces/:name/runs             → create a run (body: { subject })
 *   GET  /workspaces/:name/runs/:id         → { id, title, state, tools, outputs }
 *   POST /workspaces/:name/runs/:id/advance → execute the next stage
 *                                             (body: { model, tools? }) → { state, outputs }
 *   POST /workspaces/:name/runs/:id/approval → resolve a paused tool call
 *                                             (body: { decision }) → { state, outputs } (M5)
 *   GET  /workspaces/:name/file?path=…      → { path, content, bytes } (M6) —
 *                                             read-only preview of a workspace
 *                                             file, same scope guard as the tools
 *
 * A run is a session journal: session.created carries the workspace name,
 * the subject is the first user.message, and stage events land in the same
 * append-only file — so run state survives restarts by derivation, like
 * everything else. The browser never touches the filesystem. With tools
 * (M5), advance may return state 'approval': the UI (or curl) decides via
 * /approval, which resumes the stage server-side. RunDto.outputs (M6) lists
 * the files each stage wrote, derived from the journal — the workflow view
 * previews their CURRENT disk content through /file (the filesystem is the
 * orchestrator: a human may have edited them since).
 */
import { existsSync } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createRun, parseWorkspace, runStateFromEvents, stageModelFromEvents } from '@nyworkflow/core'
import type { RunState, StageLlm, Workspace } from '@nyworkflow/core'
import { resolveInScope } from '@nyworkflow/tools'
import {
  appendEvent,
  deriveSession,
  isSessionId,
  journalPath,
  newSessionId,
  readEvents,
} from '@nyworkflow/session'
import type { DerivedSession, SessionEvent } from '@nyworkflow/session'

/** One workspace as listed — parsed, or the reason it is not. */
export interface WorkspaceSummaryDto {
  name: string
  stages?: { stage: string; title: string }[]
  error?: string
}

/** The detail view: the map, the contracts, and this workspace's runs. */
export interface WorkspaceDetailDto {
  name: string
  map: string
  stages: Workspace['stages']
  runs: RunDto[]
}

/** A run of a workspace, as shown in listings. */
export interface RunDto {
  id: string
  title: string
  createdAt: number
  state: RunState
  /** Tool calls of the run, paired with their outcome (M5). */
  tools: { tool: string; args: unknown; at: number; ok?: boolean; summary?: string }[]
  /** Files written by each stage, derived from the journal, first-write order (M6). */
  outputs: { stage: string; files: string[] }[]
}

export interface WorkspacesHandlerOptions {
  /** Folder containing one sub-folder per workspace. */
  dir: string
  /** NyWorkflow home (journals under home/sessions). */
  home: string
  /** Model client used to execute stages (server-side, injected). */
  llm: StageLlm
}

const BODY_LIMIT = 1_000_000
const SUBJECT_MAX = 10_000
const MODEL_MAX = 200
/** Preview bound — same figure as the write tool cap (chars). (M6) */
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

/** Workspace folder names, validated on the raw (still-encoded) segment. */
function isWorkspaceName(value: string): boolean {
  return NAME_RE.test(value) && value !== '.' && value !== '..'
}

export function createWorkspacesHandler(
  options: WorkspacesHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { dir, home, llm } = options
  const sessionsDir = join(home, 'sessions')
  /** Sessions currently executing a stage — double advance gets a clear 409. */
  const busy = new Set<string>()

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

  /** Parses one workspace, or explains why it cannot. */
  async function load(name: string): Promise<Workspace> {
    if (!isWorkspaceName(name) || !existsSync(join(dir, name))) throw notFound('workspace inconnu')
    try {
      return await parseWorkspace(join(dir, name))
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err))
    }
  }

  /** All journals, derived, oldest first — unreadable journals are skipped. */
  async function readJournals(): Promise<{ id: string; events: SessionEvent[] }[]> {
    const out: { id: string; events: SessionEvent[] }[] = []
    for (const name of await journalNames()) {
      const id = name.slice(0, -6)
      if (!isSessionId(id)) continue
      try {
        out.push({ id, events: await readEvents(journalPath(home, id)) })
      } catch (err) {
        console.warn(`[workspaces] journal illisible, ignoré : ${id}`, err instanceof Error ? err.message : err)
      }
    }
    return out
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
      try {
        const ws = await parseWorkspace(join(dir, name))
        out.push({ name, stages: ws.stages.map((s) => ({ stage: s.stage, title: s.title })) })
      } catch (err) {
        out.push({ name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }

  async function detail(name: string): Promise<WorkspaceDetailDto> {
    const ws = await load(name)
    const runs: RunDto[] = []
    for (const { id, events } of await readJournals()) {
      const d = deriveSession(events)
      if (d.workspace !== name) continue
      runs.push(toRunDto(id, d, runStateFromEvents(events, ws), outputsFromEvents(events)))
    }
    runs.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return { name, map: ws.map, stages: ws.stages, runs }
  }

  /** stage.output events → files per stage, in first-write order. (M6) */
  function outputsFromEvents(events: readonly SessionEvent[]): { stage: string; files: string[] }[] {
    const order: string[] = []
    const byStage = new Map<string, string[]>()
    for (const e of events) {
      if (e.type !== 'stage.output') continue
      let files = byStage.get(e.stage)
      if (files === undefined) {
        files = []
        byStage.set(e.stage, files)
        order.push(e.stage)
      }
      for (const f of e.files) if (!files.includes(f)) files.push(f)
    }
    return order.map((stage) => ({ stage, files: byStage.get(stage) as string[] }))
  }

  /** DerivedSession + state → the DTO the UI consumes. */
  function toRunDto(id: string, d: DerivedSession, state: RunState, outputs: { stage: string; files: string[] }[]): RunDto {
    return {
      id,
      title: d.title,
      createdAt: toMs(d.createdAt),
      state,
      tools: d.tools.map((t) => ({ tool: t.tool, args: t.args, at: toMs(t.at), ok: t.ok, summary: t.summary })),
      outputs,
    }
  }

  async function createRunSession(req: IncomingMessage, name: string): Promise<RunDto> {
    await load(name) // the workspace must parse before any run exists
    const body = await readJson(req)
    const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
    if (subject === '') throw badRequest('sujet non vide attendu')
    if (subject.length > SUBJECT_MAX) throw badRequest(`sujet trop long (max ${SUBJECT_MAX} caractères)`)

    const id = freshId()
    const title = subject.slice(0, 60)
    const at = nowIso()
    await appendEvent(journalPath(home, id), { type: 'session.created', at, title, workspace: name })
    await appendEvent(journalPath(home, id), { type: 'user.message', at: nowIso(), text: subject })
    return { id, title, createdAt: toMs(at), state: { status: 'idle' }, tools: [], outputs: [] }
  }

  async function runState(name: string, id: string): Promise<RunDto> {
    const ws = await load(name)
    const file = journalPath(home, id)
    try {
      await access(file)
    } catch {
      throw notFound('session inconnue')
    }
    const events = await readEvents(file)
    return toRunDto(id, deriveSession(events), runStateFromEvents(events, ws), outputsFromEvents(events))
  }

  /**
   * M6: read-only preview of one workspace file, for the human eye. Same
   * scope guard as the agent tools (lexical + realpath) — a request outside
   * the workspace root is refused with the guard's own French reason.
   */
  async function filePreview(name: string, rawPath: string | null): Promise<{ path: string; content: string; bytes: number }> {
    if (rawPath === null || rawPath.trim() === '') throw badRequest('paramètre « path » attendu (chemin relatif au workspace)')
    const ws = await load(name)
    const scope = await resolveInScope(ws.root, rawPath)
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

  async function advance(req: IncomingMessage, name: string, id: string): Promise<{ state: RunState; outputs: string[] }> {
    // Claim the slot synchronously, before any await: two concurrent
    // advances must not both pass the check (check-then-add race).
    if (busy.has(id)) throw new HttpError(409, 'une exécution est déjà en cours pour ce run')
    busy.add(id)
    try {
      const body = await readJson(req)
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') throw badRequest('model non vide attendu')
      if (model.length > MODEL_MAX) throw badRequest('model trop long')
      const tools = body.tools === true

      const ws = await load(name)
      const file = journalPath(home, id)
      try {
        await access(file)
      } catch {
        throw notFound('session inconnue')
      }
      const events = await readEvents(file)
      const priorState = runStateFromEvents(events, ws)
      if (priorState.status === 'approval') {
        throw new HttpError(409, `un appel d'outil « ${priorState.tool} » est en attente — approuvez-le ou refusez-le (POST /approval) avant d'avancer`)
      }
      const subject = events.find((e): e is Extract<SessionEvent, { type: 'user.message' }> => e.type === 'user.message')
      if (!subject) throw badRequest('run sans sujet — recréez-le avec un sujet')

      const outputs: string[] = []
      const run = createRun({
        workspace: ws,
        subject: subject.text,
        llm,
        model,
        tools,
        initialEvents: events,
        onEvent: async (event) => {
          await appendEvent(file, event)
          if (event.type === 'stage.output') outputs.push(...event.files)
        },
      })
      const state = await run.advance()
      return { state, outputs }
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(500, err instanceof Error ? err.message : String(err))
    } finally {
      busy.delete(id)
    }
  }

  /** M5: resolves a paused tool call (approve executes it, refuse journals the refusal), then resumes the stage. */
  async function approval(req: IncomingMessage, name: string, id: string): Promise<{ state: RunState; outputs: string[] }> {
    if (busy.has(id)) throw new HttpError(409, 'une exécution est déjà en cours pour ce run')
    busy.add(id)
    try {
      const body = await readJson(req)
      const decision = body.decision === 'approve' ? 'approve' : body.decision === 'refuse' ? 'refuse' : ''
      if (decision === '') throw badRequest('decision : "approve" ou "refuse" attendu')

      const ws = await load(name)
      const file = journalPath(home, id)
      try {
        await access(file)
      } catch {
        throw notFound('session inconnue')
      }
      const events = await readEvents(file)
      const state = runStateFromEvents(events, ws)
      if (state.status !== 'approval') {
        throw new HttpError(409, 'aucun appel d\'outil en attente pour ce run — avancez d\'abord')
      }
      const subject = events.find((e): e is Extract<SessionEvent, { type: 'user.message' }> => e.type === 'user.message')
      if (!subject) throw badRequest('run sans sujet — recréez-le avec un sujet')
      const model = stageModelFromEvents(events, state.stage)
      if (!model) throw badRequest('modèle absent du journal pour cette étape — relancez advance avec un modèle')

      const outputs: string[] = []
      const run = createRun({
        workspace: ws,
        subject: subject.text,
        llm,
        model,
        tools: true,
        initialEvents: events,
        onEvent: async (event) => {
          await appendEvent(file, event)
          if (event.type === 'stage.output') outputs.push(...event.files)
        },
      })
      const newState = await run.resolve(decision)
      return { state: newState, outputs }
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(500, err instanceof Error ? err.message : String(err))
    } finally {
      busy.delete(id)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const query = rawUrl.includes('?') ? new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1)) : null
    const url = rawUrl.split('?')[0] || '/'

    if (url === '/' || url === '') {
      if (method === 'GET') return send(res, 200, { workspaces: await list() })
      throw notFound('route inconnue')
    }

    const parts = url.replace(/^\//, '').split('/')
    const name = parts[0] ?? ''

    if (parts.length === 1) {
      if (method === 'GET') return send(res, 200, await detail(name))
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && parts[1] === 'file') {
      if (method === 'GET') return send(res, 200, await filePreview(name, query?.get('path') ?? null))
      throw notFound('route inconnue')
    }
    if (parts.length === 2 && parts[1] === 'runs') {
      if (method === 'POST') return send(res, 201, await createRunSession(req, name))
      throw notFound('route inconnue')
    }
    if (parts.length === 3 && parts[1] === 'runs' && isSessionId(parts[2] ?? '')) {
      const id = parts[2] as string
      if (method === 'GET') return send(res, 200, await runState(name, id))
      throw notFound('route inconnue')
    }
    if (parts.length === 4 && parts[1] === 'runs' && isSessionId(parts[2] ?? '') && parts[3] === 'advance') {
      if (method === 'POST') {
        const id = parts[2] as string
        return send(res, 200, await advance(req, name, id))
      }
    }
    if (parts.length === 4 && parts[1] === 'runs' && isSessionId(parts[2] ?? '') && parts[3] === 'approval') {
      if (method === 'POST') {
        const id = parts[2] as string
        return send(res, 200, await approval(req, name, id))
      }
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
