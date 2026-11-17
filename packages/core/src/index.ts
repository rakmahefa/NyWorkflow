/**
 * @nyworkflow/core — ICM engine.
 *
 * A workflow is a folder of numbered stages. Each stage carries a
 * CONTEXT.md contract (Inputs / Process / Outputs). The filesystem is the
 * orchestrator: numbering is the order, folders are scopes, files are state.
 * Implementation lands in M4 — these types are the frozen contract.
 */

/** A file (or section) a stage must load before running. */
export interface InputRef {
  /** Path relative to the workspace root. */
  source: string
  /** Section heading inside the file, or "full". */
  scope: string
}

/** The contract parsed from a stage's CONTEXT.md. */
export interface StageContract {
  /** Folder name, e.g. "01-recherche". */
  stage: string
  /** First heading of the CONTEXT.md. */
  title: string
  /** What to load before running. */
  inputs: InputRef[]
  /** Plain-language steps. */
  process: string[]
  /** Artifacts expected in the stage's output/. */
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
