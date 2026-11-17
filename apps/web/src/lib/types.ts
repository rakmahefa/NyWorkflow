/** Roles a message can take. System messages are UI/command feedback; tool rows carry the agent's calls. */
export type Role = 'user' | 'assistant' | 'system' | 'tool'

import type { SecurityLevel } from '@nyworkflow/session'

export type { SecurityLevel }

/** A session as shown in the sidebar. */
export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  /** ICM workspace the session is bound to (M11: every session has one). */
  workspace?: string
  /** M13 — effective security level of the session's tools. */
  security?: SecurityLevel
}

/** One chat row: a message, or an agent tool call with its outcome. */
export interface ChatMsg {
  id: string
  sessionId: string
  role: Role
  text: string
  at: number
  /** True while the assistant reply is still streaming. */
  streaming?: boolean
  /** M12 — the model's thinking, streamed live; display-only, never journaled. */
  thinking?: string
  /** Tool rows (role === 'tool'): the call and, once resolved, its outcome. */
  tool?: string
  args?: unknown
  /** Undefined while the call is paused for a human approval. */
  ok?: boolean
  summary?: string
  /** The exact payload fed back to the model (read content, search results…). */
  data?: unknown
}

/** Un tour amont tel que journalisé par la passerelle (M8). */
export interface TurnRecordDto {
  at: string
  model: string
  ok: boolean
  attempts: number
  ms: number
  account?: number
  error?: { kind: string; message: string; status?: number }
}

/** M12 — one model request of the agent loop, tracked live (not journaled:
 * these live in the browser; tool history survives via the journal). */
export interface RequestTrace {
  id: string
  sessionId: string
  at: number
  /** Model id actually requested (think suffix included). */
  model: string
  /** 0–4, or null when the model's default applies. */
  thinkLevel: number | null
  /** Round within the turn (1 = the first request). */
  round: number
  /** Messages sent, tool declarations sent. */
  messages: number
  tools: number
  /** ms until the stream produced its last event. */
  ms: number
  /** 'ok' | 'tool_calls' | 'error' | 'stopped'. */
  outcome: 'ok' | 'tool_calls' | 'error' | 'stopped'
  /** Error message, when outcome = 'error'. */
  error?: string
  /** Characters of thinking and text received. */
  thinkingChars: number
  textChars: number
}
