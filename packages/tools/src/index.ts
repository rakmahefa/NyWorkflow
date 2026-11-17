/**
 * @nyworkflow/tools — the agent's hands, and their leash.
 *
 * Seven tools (M5: read, write, ls, glob — M11: mkdir, shell, websearch),
 * one permission that matters: every path stays inside the workspace root
 * (lexical + realpath guard). `write` and `shell` are dangerous: execution
 * pauses until a human approves through the UI. `mkdir` is free — the
 * model shapes its own tree. `websearch` returns cleaned web content
 * (scripts, nav, headers and attributes stripped; semantic tags kept).
 * Every call and outcome is journaled by the caller as tool.call /
 * tool.result events — refusals included, never silent.
 *
 * Pure Node, no core import (core depends on this package, never the
 * other way around). Re-exports carry explicit .ts extensions: the
 * package is loaded by plain Node (type stripping) through the bundled
 * vite config, where extensionless ESM imports do not resolve.
 */
export { resolveInScope } from './scope.ts'
export type { ScopeRefusal, ScopeResolution } from './scope.ts'
export {
  SHELL_BIN,
  SHELL_TIMEOUT_MS,
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
export {
  checkWebUrl,
  cleanHtml,
  decodeEntities,
  parseDuckDuckGoLite,
  runWebsearch,
  WEB_PAGE_MAX,
} from './websearch.ts'
export type { FetchLike } from './websearch.ts'
