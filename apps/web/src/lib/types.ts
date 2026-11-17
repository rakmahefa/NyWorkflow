/** Roles a message can take. System messages are UI/command feedback. */
export type Role = 'user' | 'assistant' | 'system'

/** A session as shown in the sidebar. */
export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  /** ICM workspace name, when this session runs a workflow. (M5) */
  workspace?: string
}

/** One chat message, part of a session. */
export interface ChatMsg {
  id: string
  sessionId: string
  role: Role
  text: string
  at: number
  /** True while the assistant reply is still streaming. */
  streaming?: boolean
}
