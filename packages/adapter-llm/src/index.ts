/**
 * @nyworkflow/adapter-llm — the single model boundary.
 *
 * Speaks the OpenAI-compatible chat protocol under the **v1beta**
 * namespace by default (M11) — v1/v2 remain one option away. Default
 * target: the integrated webapi gateway (@nyworkflow/webapi), reached
 * same-origin through the web server's `/api` proxy in the browser; any
 * OpenAI-compatible server can replace it via W2A_URL (fallback chain).
 *
 * The agentic half (M11): standard tool declarations in, reassembled
 * `tool_calls` out, `role: "tool"` results back in — the modern standard
 * tool_call, end to end.
 */

/** One tool call as expressed by the model (OpenAI shape). */
export interface ToolCallRequest {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant messages carrying the calls they made. */
  tool_calls?: ToolCallRequest[]
  /** Tool results: the id of the call they answer. */
  tool_call_id?: string
}

/** A function declaration, OpenAI shape (the gateway also tolerates flat Google-style). */
export interface ToolDeclaration {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface ChatOptions {
  /** Model id, as listed by listModels(). */
  model: string
  messages: ChatMessage[]
  /** M11: standard tool declarations, forwarded to the gateway. */
  tools?: readonly ToolDeclaration[]
  /** 'auto' (default), 'none', 'required'. */
  tool_choice?: 'auto' | 'none' | 'required'
  /** Cancels the stream; the iterator then ends. */
  signal?: AbortSignal
}

/** What chatStream yields: text deltas, reassembled tool calls, the finish. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCallRequest[] }
  | { type: 'finish'; reason: string }

export interface LlmAdapter {
  /** Model ids — parses OpenAI and Google list shapes, version fallback chain. */
  listModels(): Promise<string[]>
  /** POST /{apiVersion}/chat/completions (stream) → text / tool_calls / finish events. */
  chatStream(options: ChatOptions): AsyncIterable<ChatStreamEvent>
  /** The API namespace in use — 'v1beta' by default. */
  readonly apiVersion: string
}

// Re-exports carry explicit .ts extensions: the package is loaded by plain
// Node (type stripping) through the bundled vite config, where
// extensionless ESM imports do not resolve.
export { createWeb2ApiClient, AdapterError, DEFAULT_API_VERSION } from './adapter.ts'
export type { AdapterErrorKind, ClientOptions } from './adapter.ts'
