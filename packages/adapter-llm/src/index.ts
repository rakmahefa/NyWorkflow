/**
 * @nyworkflow/adapter-llm — the single model boundary.
 *
 * Speaks the OpenAI-compatible protocol. Default target: gemini-web2api
 * (from the ny-gemini-acp repo) at http://127.0.0.1:8081 — that gateway
 * owns all fragile Gemini knowledge (cookies/OAuth, streaming internals).
 * Implementation lands in M2 — this interface is the frozen contract.
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
  /** GET /v1/models → ids. */
  listModels(): Promise<string[]>
  /** POST /v1/chat/completions (stream: true) → token stream. */
  chatStream(options: ChatOptions): AsyncIterable<string>
}
