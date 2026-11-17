/**
 * @nyworkflow/session — append-only session journal.
 *
 * A session is a JSONL file: one typed event per line, never rewritten.
 * The model history is always re-derived from this log; nothing else is a
 * source of truth. Implementation lands in M3 — these types are the frozen
 * contract.
 */

/** Every fact of a session, in order. */
export type SessionEvent =
  | { type: 'session.created'; at: string; workspace?: string }
  | { type: 'user.message'; at: string; text: string }
  | { type: 'assistant.message'; at: string; text: string }
  | { type: 'tool.call'; at: string; tool: string; args: unknown }
  | { type: 'tool.result'; at: string; ok: boolean; summary: string }
  | { type: 'stage.started'; at: string; stage: string }
  | { type: 'stage.output'; at: string; stage: string; files: string[] }
  | { type: 'run.completed'; at: string; stages: string[] }

/** Session metadata (the events live in the JSONL file). */
export interface Session {
  /** Stable id, e.g. "2026-11-17-a1b2". */
  id: string
  /** Path of the JSONL journal, relative to the project root. */
  file: string
  /** ICM workspace root, when the session runs a workflow. */
  workspace?: string
}
