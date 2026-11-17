import type { ChatMsg, Role, SessionInfo } from './types'

/**
 * In-memory session store — the UI's single state (M3).
 * Hydrated from the /sessions journal at boot (server mode), or grown
 * locally (memory fallback when the API is unreachable).
 * Snapshot-based: every mutation rebuilds an immutable snapshot, so
 * React's useSyncExternalStore re-renders exactly once per change.
 */
export interface StoreSnapshot {
  sessions: readonly SessionInfo[]
  messages: readonly ChatMsg[]
}

export class SessionStore {
  private sessions: SessionInfo[] = []
  private messages: ChatMsg[] = []
  private snapshot: StoreSnapshot = { sessions: [], messages: [] }
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): StoreSnapshot => this.snapshot

  private commit(): void {
    this.snapshot = { sessions: [...this.sessions], messages: [...this.messages] }
    for (const fn of this.listeners) fn()
  }

  listSessions(): readonly SessionInfo[] {
    return this.snapshot.sessions
  }

  findSessionById(id: string): SessionInfo | undefined {
    return this.snapshot.sessions.find((s) => s.id === id)
  }

  createSession(title?: string): SessionInfo {
    const fallback = `Session ${this.sessions.length + 1}`
    const clean = title?.trim().slice(0, 60)
    const session: SessionInfo = { id: uid(), title: clean || fallback, createdAt: Date.now() }
    this.sessions.push(session)
    this.commit()
    return session
  }

  /** Registers a session created elsewhere (server response). */
  addSession(session: SessionInfo): SessionInfo {
    this.sessions.push({ ...session })
    this.commit()
    return session
  }

  /** Replaces the whole state — boot hydration from the journals. */
  ingest(sessions: readonly SessionInfo[], messages: readonly ChatMsg[]): void {
    this.sessions = [...sessions]
    this.messages = [...messages]
    this.commit()
  }

  appendMessage(sessionId: string, role: Role, text: string): ChatMsg {
    const msg: ChatMsg = { id: uid(), sessionId, role, text, at: Date.now() }
    this.messages.push(msg)
    this.commit()
    return msg
  }

  /** Grows a message's text (used while streaming). No-op if the id is gone. */
  appendText(id: string, delta: string): boolean {
    let hit = false
    this.messages = this.messages.map((m) => {
      if (m.id !== id) return m
      hit = true
      return { ...m, text: m.text + delta }
    })
    if (hit) this.commit()
    return hit
  }

  setStreaming(id: string, streaming: boolean): void {
    this.messages = this.messages.map((m) => (m.id === id ? { ...m, streaming } : m))
    this.commit()
  }

  listMessages(sessionId: string): readonly ChatMsg[] {
    return this.snapshot.messages.filter((m) => m.sessionId === sessionId)
  }

  /** Removes one session's messages. Returns how many were removed. */
  clearMessages(sessionId: string): number {
    const before = this.messages.length
    this.messages = this.messages.filter((m) => m.sessionId !== sessionId)
    const removed = before - this.messages.length
    if (removed > 0) this.commit()
    return removed
  }

  /** Copies a session's settled chat (user/assistant) into another — fork. */
  copyMessages(fromId: string, toId: string): number {
    const source = this.messages.filter(
      (m) =>
        m.sessionId === fromId &&
        (m.role === 'user' || m.role === 'assistant') &&
        !m.streaming &&
        m.text.trim() !== '',
    )
    if (source.length === 0) return 0
    this.messages.push(...source.map((m) => ({ id: uid(), sessionId: toId, role: m.role, text: m.text, at: m.at })))
    this.commit()
    return source.length
  }

  /** Deletes a single message (an empty placeholder after a failed stream). */
  removeMessage(id: string): boolean {
    const before = this.messages.length
    this.messages = this.messages.filter((m) => m.id !== id)
    const hit = before !== this.messages.length
    if (hit) this.commit()
    return hit
  }
}

function uid(): string {
  return crypto.randomUUID().slice(0, 8)
}
