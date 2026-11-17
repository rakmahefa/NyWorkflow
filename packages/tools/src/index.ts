/**
 * @nyworkflow/tools — the agent's hands, and their leash.
 *
 * Four tools (read, write, ls, glob), one permission that matters: every
 * path stays inside the workspace root (lexical + realpath guard). `write`
 * is dangerous: the engine pauses the stage until a human approves through
 * the UI. Every call and outcome is journaled by the caller (core) as
 * tool.call / tool.result events — refusals included, never silent.
 *
 * Pure Node, no core import (core depends on this package, never the
 * other way around). Re-exports carry explicit .ts extensions: the
 * package is loaded by plain Node (type stripping) through the bundled
 * vite config, where extensionless ESM imports do not resolve.
 */
export { resolveInScope } from './scope.ts'
export type { ScopeRefusal, ScopeResolution } from './scope.ts'
export {
  TOOL_NAMES,
  checkToolCall,
  displayPath,
  executeToolCall,
  isDangerous,
  refusedByUser,
} from './tools.ts'
export type {
  ToolCall,
  ToolCheck,
  ToolName,
  ToolOk,
  ToolOutcome,
  ToolRefusal,
  ToolRefusalCode,
} from './tools.ts'
