/**
 * @nyworkflow/session — append-only session journal.
 *
 * A session is a JSONL file: one typed event per line, never rewritten.
 * The model history is always re-derived from this log; nothing else is a
 * source of truth.
 *
 * M3 note: two additive fields joined the original frozen contract —
 * `title` on session.created (titles survive restarts) and the
 * session.forked event (fork provenance). Old journals stay readable.
 *
 * M4 note: one more additive field on DerivedSession — `workspace`, read
 * from session.created, so /workspaces can list the runs of a workspace.
 * The stage.started / stage.output / run.completed events (declared since
 * the original contract) are now written by the core engine.
 *
 * M5 note: two additive fields join the frozen contract — `data` on
 * tool.result (the exact payload fed back to the model, so a paused run
 * replays its conversation byte-faithfully after a restart) and `model` on
 * stage.started (the model that ran the stage, so an approval can resume
 * without asking again). Old journals stay readable.
 */

/** Every fact of a session, in order. */
export type SessionEvent =
  | { type: 'session.created'; at: string; title?: string; workspace?: string }
  | { type: 'session.forked'; at: string; from: string }
  | { type: 'user.message'; at: string; text: string }
  | { type: 'assistant.message'; at: string; text: string }
  | { type: 'tool.call'; at: string; tool: string; args: unknown }
  | { type: 'tool.result'; at: string; ok: boolean; summary: string; data?: unknown }
  | { type: 'stage.started'; at: string; stage: string; model?: string }
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

// Journal primitives and derivation (M3). Node-side only: the browser
// reaches them through the web server's /sessions API, never directly.
// Re-exports carry explicit .ts extensions: the package is loaded by
// plain Node (type stripping) through the bundled vite config, where
// extensionless ESM imports do not resolve.
export {
  appendEvent,
  deleteJournal,
  forkJournal,
  isSessionId,
  journalPath,
  newSessionId,
  parseJournal,
  readEvents,
} from './journal.ts'
export { deriveSession } from './derive.ts'
export type { DerivedMessage, DerivedSession, DerivedToolCall } from './derive.ts'
