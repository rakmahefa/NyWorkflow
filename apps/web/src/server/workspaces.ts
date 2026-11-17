/**
 * /workspaces HTTP API — the ICM engine, server-side (M4).
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET  /workspaces                        → { workspaces: WorkspaceSummaryDto[] }
 *   GET  /workspaces/:name                  → WorkspaceDetailDto (contracts + runs)
 *   POST /workspaces/:name/runs             → create a run (body: { subject })
 *   GET  /workspaces/:name/runs/:id         → { id, title, state }
 *   POST /workspaces/:name/runs/:id/advance → execute the next stage
 *                                             (body: { model }) → { state, outputs }
 *
 * A run is a session journal: session.created carries the workspace name,
 * the subject is the first user.message, and stage events land in the same
 * append-only file — so run state survives restarts by derivation, like
 * everything else. The browser never touches the filesystem; the UI to
 * drive runs arrives in M6, the API is drivable by curl today.
 */
import { existsSync } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createRun, parseWorkspace, runStateFromEvents } from '@nyworkflow/core'
import type { RunState, StageLlm, Workspace } from '@nyworkflow/core'
import {
  appendEvent,
  deriveSession,
  isSessionId,
  journalPath,
  newSessionId,
  readEvents,
} from '@nyworkflow/session'
import type { SessionEvent } from '@nyworkflow/session'

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
      runs.push({ id, title: d.title, createdAt: toMs(d.createdAt), state: runStateFromEvents(events, ws) })
    }
    runs.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return { name, map: ws.map, stages: ws.stages, runs }
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
    return { id, title, createdAt: toMs(at), state: { status: 'idle' } }
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
    const d = deriveSession(events)
    return { id, title: d.title, createdAt: toMs(d.createdAt), state: runStateFromEvents(events, ws) }
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

      const ws = await load(name)
      const file = journalPath(home, id)
      try {
        await access(file)
      } catch {
        throw notFound('session inconnue')
      }
      const events = await readEvents(file)
      const subject = events.find((e): e is Extract<SessionEvent, { type: 'user.message' }> => e.type === 'user.message')
      if (!subject) throw badRequest('run sans sujet — recréez-le avec un sujet')

      const outputs: string[] = []
      const run = createRun({
        workspace: ws,
        subject: subject.text,
        llm,
        model,
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = (req.url ?? '/').split('?')[0] || '/'

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
