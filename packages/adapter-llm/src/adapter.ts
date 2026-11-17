import type { ChatOptions, LlmAdapter } from './index'

export type AdapterErrorKind = 'unreachable' | 'http' | 'bad-shape'

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind
  readonly status?: number

  constructor(kind: AdapterErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'AdapterError'
    this.kind = kind
    this.status = status
  }
}

export interface ClientOptions {
  /** Base URL of the OpenAI-compatible gateway, no trailing slash (e.g. "/api"). */
  baseUrl: string
  /** Timeout for model listing, ms. Default 5000. */
  listTimeoutMs?: number
}

const DEFAULT_LIST_TIMEOUT = 5000

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function httpError(res: Response, body: string): AdapterError {
  return new AdapterError('http', `HTTP ${res.status} — ${body.slice(0, 120) || res.statusText}`, res.status)
}

export function createWeb2ApiClient(options: ClientOptions): LlmAdapter {
  const base = options.baseUrl.replace(/\/+$/, '')
  const listTimeout = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT

  async function getJson(path: string, timeoutMs: number): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError') {
        throw new AdapterError('unreachable', `Passerelle injoignable (${base}) — délai dépassé`)
      }
      throw new AdapterError('unreachable', `Passerelle injoignable (${base})`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw httpError(res, body)
    }
    try {
      return (await res.json()) as unknown
    } catch {
      throw new AdapterError('bad-shape', `Réponse non-JSON sur ${path}`)
    }
  }

  /** One SSE line → 'done' | a token | null (ignore). */
  function handleLine(line: string): 'done' | string | null {
    if (!line.startsWith('data:')) return null
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return 'done'
    try {
      const obj = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[]
      }
      const choice = obj.choices?.[0]
      const content = choice?.delta?.content ?? choice?.message?.content
      return typeof content === 'string' && content.length > 0 ? content : null
    } catch {
      return null // ligne SSE illisible — on saute
    }
  }

  async function listModels(): Promise<string[]> {
    let raw: unknown
    try {
      raw = await getJson('/v1/models', listTimeout)
    } catch (err) {
      // web2api expose aussi les routes Google : /v1beta/models.
      if (err instanceof AdapterError && err.kind === 'http' && err.status === 404) {
        raw = await getJson('/v1beta/models', listTimeout)
      } else {
        throw err
      }
    }
    const list = raw as { data?: { id?: unknown }[] } | { id?: unknown }[]
    const entries = Array.isArray(list) ? list : (list.data ?? [])
    const models = entries
      .map((x) => (x as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    if (models.length === 0) throw new AdapterError('bad-shape', 'Aucun modèle dans la réponse')
    return models
  }

  async function* chatStream(chat: ChatOptions): AsyncIterable<string> {
    if (chat.signal?.aborted) return
    let res: Response
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: chat.model, messages: chat.messages, stream: true }),
        signal: chat.signal,
      })
    } catch (err) {
      if (chat.signal?.aborted) return
      throw new AdapterError('unreachable', `Passerelle injoignable (${base}) : ${errText(err)}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw httpError(res, body)
    }
    if (!res.body) throw new AdapterError('bad-shape', 'Flux absent dans la réponse')

    const body = res.body as unknown as AsyncIterable<Uint8Array>
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for await (const chunk of body) {
        if (chat.signal?.aborted) return
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          const out = handleLine(line)
          if (out === 'done') return
          if (out) yield out
        }
      }
      // Dernière ligne sans \n final
      if (buffer.trim()) {
        const out = handleLine(buffer.trim())
        if (out === 'done') return
        if (out) yield out
      }
    } catch (err) {
      if (chat.signal?.aborted) return
      throw new AdapterError('unreachable', `Flux interrompu : ${errText(err)}`)
    }
  }

  return { listModels, chatStream }
}
