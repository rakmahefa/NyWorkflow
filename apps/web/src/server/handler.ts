/**
 * /sessions HTTP API — thin adapter over @nyworkflow/session.
 *
 * Mounted by the Vite plugin (dev and preview), same origin as the UI:
 *   GET  /sessions              → { sessions: SessionDto[] }  (oldest first)
 *   POST /sessions              → create (body: { title? })
 *   POST /sessions/:id/events   → append a chat event (user|assistant message)
 *   POST /sessions/:id/fork     → fork the journal
 *
 * Chat events only for now — tool and stage events arrive with M4/M5,
 * through the same route.
 */
import { existsSync } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  appendEvent,
  deriveSession,
  forkJournal,
  isSessionId,
  journalPath,
  newSessionId,
  readEvents,
} from '@nyworkflow/session'
import type { DerivedSession, SessionEvent } from '@nyworkflow/session'

/** What the UI consumes (numbers, ready for the store). */
export interface SessionDto {
  id: string
  title: string
  createdAt: number
  forkedFrom?: string
  messages: { role: 'user' | 'assistant'; text: string; at: number }[]
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

export function createSessionsHandler(home: string): (req: IncomingMessage, res: ServerResponse) => void {
  const sessionsDir = join(home, 'sessions')

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

  function toDto(id: string, d: DerivedSession): SessionDto {
    return {
      id,
      title: d.title,
      createdAt: toMs(d.createdAt),
      forkedFrom: d.forkedFrom,
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
        out.push(toDto(id, deriveSession(await readEvents(journalPath(home, id)))))
      } catch (err) {
        console.warn(`[sessions] journal illisible, ignoré : ${id}`, err instanceof Error ? err.message : err)
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return out
  }

  async function create(req: IncomingMessage): Promise<SessionDto> {
    const body = await readJson(req)
    const given = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : ''
    const fallback = `Session ${(await journalNames()).length + 1}`
    const title = given || fallback
    const id = freshId()
    const at = nowIso()
    await appendEvent(journalPath(home, id), { type: 'session.created', at, title })
    return { id, title, createdAt: toMs(at), messages: [] }
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
  }

  async function fork(id: string): Promise<SessionDto> {
    try {
      await access(journalPath(home, id))
    } catch {
      throw notFound('session inconnue')
    }
    const forkId = freshId()
    await forkJournal(home, id, forkId)
    const d = deriveSession(await readEvents(journalPath(home, forkId)))
    return { id: forkId, title: d.title, createdAt: toMs(d.createdAt), forkedFrom: id, messages: [] }
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
    if (parts.length === 2 && isSessionId(parts[0] ?? '')) {
      const id = parts[0] as string
      if (parts[1] === 'events' && method === 'POST') {
        await appendChatEvent(req, id)
        return send(res, 201, { ok: true })
      }
      if (parts[1] === 'fork' && method === 'POST') {
        return send(res, 201, await fork(id))
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
