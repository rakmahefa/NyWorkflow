/**
 * @nyworkflow/adapter-llm — the single model boundary.
 *
 * Speaks the OpenAI-compatible chat protocol, under the **v1beta**
 * namespace by default (M11 — the pilot's call): `/v1beta/chat/completions`
 * and `/v1beta/models`. The version is a client option, so the day a v2
 * ships it is a one-line change (or a different W2A target answering v1).
 * The fallback chain tries the configured version first, then the other
 * known one — a plain OpenAI server (W2A_URL) keeps working.
 *
 * M11 also brings the agentic half: standard `tools` declarations are
 * forwarded, `delta.tool_calls` chunks are reassembled in order, and tool
 * results travel back as `role: "tool"` messages — the modern standard
 * tool_call, end to end.
 */
import type { ChatMessage, ChatOptions, ChatStreamEvent, LlmAdapter, ToolDeclaration, ToolCallRequest } from './index'
import { ThinkingSplitter } from './thinking.ts'

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
  /**
   * API namespace used for every call — 'v1beta' by default (M11), 'v1' or
   * 'v2' when the day comes. Served by the webapi gateway; any other
   * OpenAI-compatible server works through the fallback chain.
   */
  apiVersion?: string
  /** Timeout for model listing, ms. Default 5000. */
  listTimeoutMs?: number
}

export const DEFAULT_API_VERSION = 'v1beta'
/** Known namespaces, tried in this order for model listing (config first). */
const KNOWN_VERSIONS = ['v1beta', 'v1']

const DEFAULT_LIST_TIMEOUT = 5000

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function httpError(res: Response, body: string): AdapterError {
  return new AdapterError('http', `HTTP ${res.status} — ${body.slice(0, 120) || res.statusText}`, res.status)
}

/** One accumulated tool call, keyed by its stream index. */
interface AccCall {
  index: number
  id: string
  name: string
  args: string
}

export function createWeb2ApiClient(options: ClientOptions): LlmAdapter {
  const base = options.baseUrl.replace(/\/+$/, '')
  const apiVersion = (options.apiVersion ?? DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, '') || DEFAULT_API_VERSION
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

  /**
   * Parses every model-list shape: OpenAI `{data:[{id}]}`, Google
   * `{models:[{name:"models/x"}]}` (the real /v1beta answer), and a bare
   * array of entries (legacy tolerance).
   */
  function parseModelList(raw: unknown): string[] {
    const obj = raw as { data?: unknown; models?: unknown }
    const entries = Array.isArray(raw) ? raw : Array.isArray(obj?.data) ? obj.data : Array.isArray(obj?.models) ? obj.models : []
    const ids: string[] = []
    for (const e of entries) {
      if (e === null || typeof e !== 'object') continue
      const rec = e as { id?: unknown; name?: unknown }
      let id = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : ''
      if (id.startsWith('models/')) id = id.slice('models/'.length)
      if (id.length > 0 && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  async function listModels(): Promise<string[]> {
    // The configured namespace first, then the other known one — an
    // external OpenAI server (W2A_URL) answers on v1, the gateway on both.
    const versions = [apiVersion, ...KNOWN_VERSIONS.filter((v) => v !== apiVersion)]
    let last404: unknown
    for (const v of versions) {
      let raw: unknown
      try {
        raw = await getJson(`/${v}/models`, listTimeout)
      } catch (err) {
        if (err instanceof AdapterError && err.kind === 'http' && err.status === 404) {
          last404 = err
          continue
        }
        throw err
      }
      const models = parseModelList(raw)
      if (models.length > 0) return models
      last404 = new AdapterError('bad-shape', `Aucun modèle dans la réponse de /${v}/models`)
    }
    if (last404 instanceof Error) throw last404
    throw new AdapterError('bad-shape', 'Aucun modèle dans la réponse')
  }

  /** One SSE line → parsed chunk or null (ignore). */
  function parseLine(line: string): Record<string, unknown> | null {
    if (!line.startsWith('data:')) return null
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return null
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed === null || typeof parsed !== 'object') return null
      return parsed as Record<string, unknown>
    } catch {
      return null // ligne SSE illisible — on saute
    }
  }

  function firstChoice(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    const choices = obj.choices
    if (!Array.isArray(choices) || choices.length === 0) return undefined
    const c = choices[0]
    return c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : undefined
  }

  async function* chatStream(chat: ChatOptions): AsyncIterable<ChatStreamEvent> {
    if (chat.signal?.aborted) return
    const body: Record<string, unknown> = {
      model: chat.model,
      messages: chat.messages,
      stream: true,
    }
    if (chat.tools !== undefined && chat.tools.length > 0) {
      body.tools = chat.tools
      body.tool_choice = chat.tool_choice ?? 'auto'
    }
    let res: Response
    try {
      res = await fetch(`${base}/${apiVersion}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: chat.signal,
      })
    } catch (err) {
      if (chat.signal?.aborted) return
      throw new AdapterError('unreachable', `Passerelle injoignable (${base}) : ${errText(err)}`)
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      throw httpError(res, raw)
    }
    if (!res.body) throw new AdapterError('bad-shape', 'Flux absent dans la réponse')

    const streamBody = res.body as unknown as AsyncIterable<Uint8Array>
    const decoder = new TextDecoder()
    let buffer = ''
    /** Tool calls being reassembled, keyed by stream index, in order. */
    const acc = new Map<number, AccCall>()
    /** True once a finish_reason was emitted — [DONE] then stays silent. */
    let finished = false
    /** M15 — the two-phase protocol parser over the content channel. */
    const think = new ThinkingSplitter()
    /** Drains the splitter at end of stream (held-back tail, unclosed block). */
    function* drainThink(): Generator<ChatStreamEvent> {
      for (const piece of think.finish()) {
        if (piece.kind === 'text') yield { type: 'text', delta: piece.delta }
        else yield { type: 'thinking', delta: piece.delta, ...(piece.title !== undefined ? { title: piece.title } : {}) }
      }
    }

    const feedAcc = (calls: unknown): void => {
      if (!Array.isArray(calls)) return
      for (const raw of calls) {
        if (raw === null || typeof raw !== 'object') continue
        const c = raw as Record<string, unknown>
        const fn = (c.function ?? {}) as Record<string, unknown>
        const index = typeof c.index === 'number' ? c.index : acc.size
        let slot = acc.get(index)
        if (slot === undefined) {
          slot = { index, id: typeof c.id === 'string' ? c.id : `call-${index}`, name: '', args: '' }
          acc.set(index, slot)
        }
        if (typeof c.id === 'string' && c.id.length > 0) slot.id = c.id
        if (typeof fn.name === 'string') slot.name += fn.name
        if (typeof fn.arguments === 'string') slot.args += fn.arguments
      }
    }

    const drainAcc = (): ToolCallRequest[] => {
      if (acc.size === 0) return []
      const calls = [...acc.values()]
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args === '' ? '{}' : c.args },
        }))
      acc.clear()
      return calls
    }

    /** Emits what one parsed chunk carries. */
    function* handleChunk(obj: Record<string, unknown>): Generator<ChatStreamEvent> {
      const choice = firstChoice(obj)
      if (choice !== undefined) {
        const delta = (choice.delta ?? {}) as Record<string, unknown>
        // delta.reasoning_content (M12, dialecte DeepSeek) : la réflexion du
        // modèle — affichage seul, jamais renvoyée dans l'historique. Sans
        // titre : elle continue le bloc en cours (le protocole M15 et le
        // canal natif coexistent).
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'thinking', delta: delta.reasoning_content }
        }
        // delta.content (stream) ou message.content (serveur non streamé).
        const content = typeof delta.content === 'string' ? delta.content : undefined
        const message = (choice.message ?? {}) as Record<string, unknown>
        const fallback = typeof message.content === 'string' ? message.content : ''
        const text = content ?? fallback
        if (text !== undefined && text.length > 0) {
          // M15 — le protocole deux temps : le contenu passe au splitter, qui
          // sépare les blocs <thinking title="…">…</thinking> (le dialogue
          // interne, titré) du travail visible. Modèle-agnostique : tout ce
          // qui n'est pas une balise valide reste du texte.
          for (const piece of think.push(text)) {
            if (piece.kind === 'text') yield { type: 'text', delta: piece.delta }
            else yield { type: 'thinking', delta: piece.delta, ...(piece.title !== undefined ? { title: piece.title } : {}) }
          }
        }
        feedAcc(delta.tool_calls)
        const finish = choice.finish_reason
        if (finish === 'tool_calls') {
          const calls = drainAcc()
          if (calls.length > 0) yield { type: 'tool_calls', calls }
        }
        if (typeof finish === 'string' && finish.length > 0) {
          finished = true
          yield { type: 'finish', reason: finish }
        }
      }
      if (obj.error !== undefined && obj.error !== null && typeof obj.error === 'object') {
        const message = (obj.error as { message?: unknown }).message
        throw new AdapterError('http', `Amont en échec : ${typeof message === 'string' ? message : 'erreur amont'}`)
      }
    }

    try {
      for await (const chunk of streamBody) {
        if (chat.signal?.aborted) return
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (line === 'data: [DONE]') {
            const calls = drainAcc() // defensive: calls without finish_reason
            yield* drainThink()
            if (calls.length > 0) yield { type: 'tool_calls', calls }
            if (!finished) yield { type: 'finish', reason: 'stop' }
            return
          }
          const parsed = parseLine(line)
          if (parsed === null) continue
          yield* handleChunk(parsed)
        }
      }
      // Dernière ligne sans \n final
      const tail = buffer.trim()
      if (tail !== '') {
        if (tail === 'data: [DONE]') {
          const calls = drainAcc()
          yield* drainThink()
          if (calls.length > 0) yield { type: 'tool_calls', calls }
          if (!finished) yield { type: 'finish', reason: 'stop' }
          return
        }
        const parsed = parseLine(tail)
        if (parsed !== null) yield* handleChunk(parsed)
      }
      const calls = drainAcc()
      yield* drainThink()
      if (calls.length > 0) yield { type: 'tool_calls', calls }
    } catch (err) {
      if (err instanceof AdapterError) throw err
      if (chat.signal?.aborted) return
      throw new AdapterError('unreachable', `Flux interrompu : ${errText(err)}`)
    }
  }

  return { listModels, chatStream, apiVersion }
}
