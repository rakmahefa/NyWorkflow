/**
 * @nyworkflow/tools — tools the agent may call, plus guards.
 *
 * Scope rule: every path stays inside the workspace root; anything outside
 * is refused and logged. Implementation lands in M5 — these types are the
 * frozen contract.
 */

/** How a tool call is allowed to proceed. */
export type Permission = 'auto' | 'ask' | 'deny'

/** A tool exposed to the model. */
export interface Tool {
  /** "read" | "write" | "ls" | "glob" | "shell". */
  name: string
  description: string
  permission: Permission
}

/** One call requested by the model. */
export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

/** Outcome of a call — the summary goes into the session journal. */
export interface ToolResult {
  ok: boolean
  summary: string
}
