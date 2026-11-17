/**
 * @nyworkflow/core — ICM engine.
 *
 * A workflow is a folder of numbered stages. Each stage carries a
 * CONTEXT.md contract (Entrées / Process / Sorties). The filesystem is the
 * orchestrator: numbering is the order, folders are scopes, files are state.
 *
 * M4 note: the types below are the frozen contract. Two additive fields
 * joined InputRef — `origin` (raw Source label) and `why` (raw Pourquoi
 * column) — old parsers are unaffected. The CONTEXT.md contract format is
 * frozen as v1 until v0.2.0 (see PLAN.md, end-of-M4 decision point).
 */

/** A file (or section) a stage must load before running. */
export interface InputRef {
  /**
   * Path relative to the workspace root, POSIX separators, or '' when the
   * input is not a file: the run subject (the question asked in the UI).
   */
  source: string
  /** 'full', or the raw Portion text used as guidance for the model. */
  scope: string
  /** Raw Source column of the contract table, e.g. "Utilisateur". (M4) */
  origin?: string
  /** Raw Pourquoi column of the contract table. (M4) */
  why?: string
}

/** The contract parsed from a stage's CONTEXT.md. */
export interface StageContract {
  /** Folder name, e.g. "01-recherche". */
  stage: string
  /** First heading of the CONTEXT.md (falls back to the folder name). */
  title: string
  /** What to load before running. */
  inputs: InputRef[]
  /** Plain-language steps. */
  process: string[]
  /** Artifacts expected in the stage's output/, stage-relative POSIX paths. */
  outputs: string[]
}

/** An ICM workspace: a root map plus its stages, in execution order. */
export interface Workspace {
  /** Absolute or cwd-relative path to the workspace folder. */
  root: string
  /** Raw content of the root CONTEXT.md (the map). */
  map: string
  /** Stages sorted by their number. */
  stages: StageContract[]
}

/** State of one workflow run. */
export type RunState =
  | { status: 'idle' }
  | { status: 'running'; stage: string }
  | { status: 'checkpoint'; stage: string }
  | { status: 'done'; stages: string[] }
  | { status: 'error'; stage: string; message: string }

// Engine (M4). Node-side only: the browser drives runs through the web
// server's /workspaces API, never directly. Re-exports carry explicit .ts
// extensions — the package is loaded by plain Node (type stripping) through
// the bundled vite config, where extensionless ESM imports do not resolve.
export { parseWorkspace } from './parse.ts'
export type { ParsedTableRow } from './parse.ts'
export { assembleStageMessages, workspaceName } from './prompt.ts'
export type { LoadedInput, StageChatMessage, StageLlm } from './prompt.ts'
export {
  createRun,
  loadStageInputs,
  runStage,
  runStateFromEvents,
} from './engine.ts'
export type {
  CreateRunOptions,
  RunStageOptions,
  RunStageResult,
  WorkflowRun,
} from './engine.ts'
