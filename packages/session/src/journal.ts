/**
 * Journal primitives — append-only JSONL, one file per session.
 *
 * Node-side only: the browser reaches these files through the web server's
 * /sessions API, never directly. A journal is never rewritten; forks are
 * byte-exact copies plus one session.forked event.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionEvent } from './index'

/** Date-based id: YYYY-MM-DD + 4 hex chars, e.g. "2026-11-17-a1b2". */
export function newSessionId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 4)}`
}

const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{4,8}$/

/** Strict id check — the HTTP layer uses it to reject path tricks. */
export function isSessionId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** Journal file of a session id under the NyWorkflow home. */
export function journalPath(home: string, id: string): string {
  return join(home, 'sessions', `${id}.jsonl`)
}

function assertEvent(event: SessionEvent): void {
  if (typeof event.type !== 'string') throw new TypeError('event.type: string expected')
  if (typeof event.at !== 'string') throw new TypeError('event.at: ISO string expected')
}

/** Appends one event as a single JSONL line. Never rewrites existing lines. */
export async function appendEvent(file: string, event: SessionEvent): Promise<void> {
  assertEvent(event)
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8')
}

/** Reads a journal back as events. ENOENT propagates to the caller. */
export async function readEvents(file: string): Promise<SessionEvent[]> {
  return parseJournal(await readFile(file, 'utf8'))
}

/**
 * Pure JSONL parsing. A trailing line without its '\n' is a torn write
 * (crash mid-append) and is dropped; a complete but unreadable line, or one
 * without a type, is corruption and throws.
 */
export function parseJournal(raw: string): SessionEvent[] {
  // The last split element is '' when the file is properly terminated,
  // and a partial line when a write was torn — either way, not an event.
  const complete = raw.split('\n').slice(0, -1)
  const events: SessionEvent[] = []
  for (const line of complete) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`Journal corrompu : ligne illisible — ${JSON.stringify(line.slice(0, 60))}`)
    }
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      throw new Error(`Journal corrompu : ligne sans type — ${JSON.stringify(line.slice(0, 60))}`)
    }
    events.push(parsed as SessionEvent)
  }
  return events
}

/**
 * Forks a journal: byte-exact copy of the source, then one session.forked
 * event appended to the copy. The source is never touched.
 */
export async function forkJournal(home: string, fromId: string, newId: string): Promise<void> {
  const source = journalPath(home, fromId)
  const target = journalPath(home, newId)
  await copyFile(source, target) // ENOENT propagates (unknown source id)
  await appendEvent(target, { type: 'session.forked', at: new Date().toISOString(), from: fromId })
}
