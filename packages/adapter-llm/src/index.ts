/**
 * @nyworkflow/adapter-llm — the single model boundary.
 *
 * Speaks the OpenAI-compatible protocol. Default target: gemini-web2api
 * (from the ny-gemini-acp repo) — that gateway owns all fragile Gemini
 * knowledge (cookies/OAuth, streaming internals). In the browser, the app
 * calls it same-origin through the web server's `/api` proxy.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** Model id, as listed by listModels(). */
  model: string
  messages: ChatMessage[]
  /** Cancels the stream; the iterator then ends. */
  signal?: AbortSignal
}

export interface LlmAdapter {
  /** GET /v1/models → ids (falls back to /v1beta/models on 404). */
  listModels(): Promise<string[]>
  /** POST /v1/chat/completions (stream: true) → token stream. */
  chatStream(options: ChatOptions): AsyncIterable<string>
}

// Re-exports carry explicit .ts extensions: the package is loaded by plain
// Node (type stripping) through the bundled vite config (the web server
// plugin imports the client for server-side stage execution), where
// extensionless ESM imports do not resolve.
export { createWeb2ApiClient, AdapterError } from './adapter.ts'
export type { AdapterErrorKind, ClientOptions } from './adapter.ts'
