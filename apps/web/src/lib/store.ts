import type { ChatMsg, RequestTrace, Role, SessionInfo } from './types'

/**
 * In-memory session store — the UI's single state (M3, agentic M11, M12:
 * thinking streams, request traces, rename). Hydrated from the /sessions
 * journals at boot (server mode), or grown locally (memory fallback when
 * the API is unreachable). Snapshot-based: every mutation rebuilds an
 * immutable snapshot, so React's useSyncExternalStore re-renders exactly
 * once per change.
 *
 * Rows are chat messages AND tool rows (role 'tool'): the agent's calls
 * live in the same stream as the conversation — journaled server-side as
 * tool.call / tool.result, replayed here in order. Request traces (M12)
 * are browser-side only: the panel states it after a reload.
 */
export interface StoreSnapshot {
  sessions: readonly SessionInfo[]
  messages: readonly ChatMsg[]
  /** M12 — model requests of the live agent loops, per session. */
  traces: readonly RequestTrace[]
}

export class SessionStore {
  private sessions: SessionInfo[] = []
  private messages: ChatMsg[] = []
  private traces: RequestTrace[] = []
  private snapshot: StoreSnapshot = { sessions: [], messages: [], traces: [] }
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = (): StoreSnapshot => this.snapshot

  private commit(): void {
    this.snapshot = { sessions: [...this.sessions], messages: [...this.messages], traces: [...this.traces] }
    for (const fn of this.listeners) fn()
  }

  listSessions(): readonly SessionInfo[] {
    return this.snapshot.sessions
  }

  findSessionById(id: string): SessionInfo | undefined {
    return this.snapshot.sessions.find((s) => s.id === id)
  }

  createSession(title?: string, workspace?: string): SessionInfo {
    const fallback = `Session ${this.sessions.length + 1}`
    const clean = title?.trim().slice(0, 60)
    const session: SessionInfo = { id: uid(), title: clean || fallback, createdAt: Date.now(), ...(workspace !== undefined ? { workspace } : {}) }
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

  /** M11 — removes a session and its rows (the journal dies server-side). */
  removeSession(id: string): boolean {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.messages = this.messages.filter((m) => m.sessionId !== id)
    this.traces = this.traces.filter((t) => t.sessionId !== id)
    const hit = before !== this.sessions.length
    if (hit) this.commit()
    return hit
  }

  /** M12 — renames a session (the journal has the server-side truth). */
  renameSession(id: string, title: string): boolean {
    let hit = false
    this.sessions = this.sessions.map((s) => {
      if (s.id !== id) return s
      hit = true
      return { ...s, title }
    })
    if (hit) this.commit()
    return hit
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

  /** M11 — one agent tool call, journaled server-side; ok undefined until resolved. */
  appendToolCall(sessionId: string, tool: string, args: unknown): ChatMsg {
    const msg: ChatMsg = { id: uid(), sessionId, role: 'tool', text: '', at: Date.now(), tool, args }
    this.messages.push(msg)
    this.commit()
    return msg
  }

  /** M11 — settles a tool row with its outcome (execution or refusal). */
  resolveToolCall(rowId: string, outcome: { ok: boolean; summary: string; data?: unknown }): boolean {
    let hit = false
    this.messages = this.messages.map((m) => {
      if (m.id !== rowId) return m
      hit = true
      return { ...m, ok: outcome.ok, summary: outcome.summary, ...(outcome.ok && outcome.data !== undefined ? { data: outcome.data } : {}) }
    })
    if (hit) this.commit()
    return hit
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

  /** M12 — grows a message's thinking (live reasoning, display-only). */
  appendThinking(id: string, delta: string): boolean {
    let hit = false
    this.messages = this.messages.map((m) => {
      if (m.id !== id) return m
      hit = true
      return { ...m, thinking: (m.thinking ?? '') + delta }
    })
    if (hit) this.commit()
    return hit
  }

  /** M12 — records one model request of the live agent loop. */
  appendTrace(trace: RequestTrace): void {
    this.traces.push(trace)
    this.commit()
  }

  /** M12 — settles a trace (duration, outcome, received chars). */
  settleTrace(id: string, patch: Partial<Pick<RequestTrace, 'ms' | 'outcome' | 'error' | 'thinkingChars' | 'textChars'>>): boolean {
    let hit = false
    this.traces = this.traces.map((t) => {
      if (t.id !== id) return t
      hit = true
      return { ...t, ...patch }
    })
    if (hit) this.commit()
    return hit
  }

  listTraces(sessionId: string): readonly RequestTrace[] {
    return this.snapshot.traces.filter((t) => t.sessionId === sessionId)
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

  /** Copies a session's settled rows (chat + tool history) into another — fork. */
  copyMessages(fromId: string, toId: string): number {
    const source = this.messages.filter(
      (m) => m.sessionId === fromId && !m.streaming && ((m.role === 'user' || m.role === 'assistant') ? m.text.trim() !== '' : m.ok !== undefined),
    )
    if (source.length === 0) return 0
    this.messages.push(
      ...source.map((m) => ({ ...m, id: uid(), sessionId: toId })),
    )
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
