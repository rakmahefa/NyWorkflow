/**
 * @nyworkflow/core — the ICM (Interpretable Context Methodology) package.
 *
 * Pivot M11: the phase-1 engine (numbered stages, contracts, runs) is
 * gone — sessions are the only surface, and a session IS its context.
 * This package now carries what "loading the ICM into the model" means:
 *
 *   - walkTree / renderTree — the free folder tree, capped and honest;
 *   - loadIcm — the tree + every CONTEXT.md (root first);
 *   - buildIcmSystemPrompt — the system prompt of an agentic session;
 *   - scaffoldAgenticWorkspace — the default modern agentic tree every
 *     new workspace is born with (charter + inbox/notes/research/outputs).
 *
 * Pure Node, no dependency: no model, no network — trivially testable.
 */

// ICM loading and prompt assembly (M11). Node-side only: the browser
// receives the assembled prompt through the /workspaces API.
// Re-exports carry explicit .ts extensions: the package is loaded by
// plain Node (type stripping) through the bundled vite config, where
// extensionless ESM imports do not resolve.
export {
  buildIcmSystemPrompt,
  loadIcm,
  renderTree,
  walkTree,
  workspaceName,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_FILES,
  TREE_MAX_DEPTH,
  TREE_MAX_ENTRIES,
  TREE_SKIP_DIRS,
} from './icm.ts'
export type { IcmFile, IcmWorkspace, TreeEntry } from './icm.ts'
export { SCAFFOLD_FOLDERS, scaffoldAgenticWorkspace, scaffoldContext } from './scaffold.ts'
