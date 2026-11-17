/** Roles a message can take. System messages are UI/command feedback; tool rows carry the agent's calls. */
export type Role = 'user' | 'assistant' | 'system' | 'tool'

/** A session as shown in the sidebar. */
export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  /** ICM workspace the session is bound to (M11: every new session has one). */
  workspace?: string
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
