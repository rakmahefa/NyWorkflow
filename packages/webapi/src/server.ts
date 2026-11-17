/**
 * Serveur HTTP de la passerelle — OpenAI-compatible ET Google-style, écrit sur
 * node:http nu : zéro dépendance runtime. Surface (M10 — tout est additif,
 * les champs M8/M9 ne bougent jamais) :
 *
 *   GET  /                                — état + diagnostic (cookies, bl, modèles)
 *   GET  /v1/models                       — liste des modèles (OpenAI)
 *   POST /v1/chat/completions             — chat (stream SSE ou complet) + `tools` (M10)
 *   GET  /v1beta/models                   — liste des modèles (Google)
 *   GET  /v1beta/models/{name}            — un modèle (Google)
 *   POST /v1beta/models/{model}:generateContent        — chat (Google)
 *   POST /v1beta/models/{model}:streamGenerateContent  — stream : ?alt=sse → SSE, sinon tableau JSON
 *   POST /v1beta/chat/completions         — M11 : le dialecte OpenAI servi sous le
 *                                            namespace v1beta (l'app parle v1beta de base)
 *
 * Le dialecte OpenAI est donc disponible sous les DEUX namespaces — la liste
 * est une donnée (OPENAI_CHAT_PATHS), le jour du v2 s'ajoute un chemin sans
 * toucher au moteur. Boucle 127.0.0.1 par défaut ; pas de clé API ni CORS
 * tant que ce n'est pas un milestone (l'UI passe par le proxy same-origin
 * /api du serveur web). Un échec amont en streaming = chunk `finish_reason:
 * "error"` + [DONE] — jamais un « stop » déguisé (le consommateur doit voir
 * l'échec). En v1beta, l’équivalent est un événement `error` Google en fin de
 * flux.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createGeminiProvider, type Provider, type ProviderChatEvent } from './provider.ts'
import { GeminiError } from './gemini.ts'
import { TurnJournal, DEFAULT_JOURNAL_CAPACITY, type TurnRecord } from './journal.ts'
import { messagesToPrompt, usage, type ChatMessage } from './convert.ts'
import { ToolStreamSplitter, normalizeTools, parseToolChoice, toolsPreamble, openAiArguments, ToolValidationError, type ParsedToolCall, type ToolStreamEvent } from './tools.ts'
import {
  v1betaModelInfo,
  parseGenerateRequest,
  buildGenerateResponse,
  generateTextChunk,
  generateThoughtChunk,
  generateCallChunk,
  generateFinalChunk,
  callToText,
} from './v1beta.ts'
import { listModelInfo } from './models.ts'
import type { WebApiConfig } from './config.ts'
import { WEBAPI_VERSION } from './version.ts'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const SSE_PING_MS = 15_000
/**
 * Chemins servant le dialecte OpenAI — le namespace est une DONNÉE (M11) :
 * v1beta rejoint v1 (l'app consomme v1beta par défaut), v2 s'ajoutera ici
 * le jour venu, sans toucher au moteur.
 */
const OPENAI_CHAT_PATHS = new Set(['/v1/chat/completions', '/v1beta/chat/completions'])

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Construit le provider Gemini depuis la config de la passerelle (avec journal amont).
 * M13 — onTurn : chaque tour amont (réussi ou non) part aussi vers le engine
 * log de l'app, quand l'app en fournit un. */
export function webApiProviderFromConfig(config: WebApiConfig, onTurn?: (record: TurnRecord) => void): Provider {
  const journal = new TurnJournal(DEFAULT_JOURNAL_CAPACITY, onTurn)
  return createGeminiProvider(
    {
      baseUrl: config.baseUrl,
      cookieFile: config.cookieFile,
      rawCookies: config.rawCookies,
      accountsFile: config.accountsFile,
      defaultModel: config.defaultModel,
      modelsFile: config.modelsFile,
      bl: config.geminiBl,
      authUser: config.authUser,
      timeoutMs: config.timeoutMs,
      retryAttempts: config.retryAttempts,
      retryDelayMs: config.retryDelayMs,
      proxy: config.proxy,
      noProxy: config.noProxy,
      tlsCa: config.tlsCa,
    },
    journal,
  )
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Erreur au format Google (routes /v1beta) : { error: { code, message, status } }. */
function gerr(res: ServerResponse, status: number, message: string, code: string): void {
  json(res, status, { error: { code: status, message, status: code } })
}

class BodyTooLarge extends Error {}

/**
 * Lit le corps jusqu'à `limit` ; au-delà, rejette immédiatement mais CONTINUE
 * de consommer le surplus : le client peut finir son envoi et lire le 413 —
 * interrompre la socket en plein vol produirait un ECONNRESET côté client.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return // surplus jeté, pour ne pas bloquer l'émetteur
      size += chunk.length
      if (size > limit) {
        rejected = true
        reject(new BodyTooLarge())
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(parts).toString('utf8'))
    })
    req.on('error', (err) => {
      if (!rejected) reject(err)
    })
  })
}

interface ChatRequestBody {
  model?: unknown
  messages?: unknown
  stream?: unknown
  /** M10 — outils à la OpenAI : [{type:'function', function:{name, description, parameters}}]. */
  tools?: unknown
  /** M10 — 'auto' | 'none' | 'required' | {type:'function', function:{name}}. */
  tool_choice?: unknown
}

export function createWebApiServer(config: WebApiConfig, provider: Provider = webApiProviderFromConfig(config)): http.Server {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.writableEnded) json(res, 500, { error: { message: `erreur interne : ${errText(err)}` } })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://local').pathname
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
    const method = req.method ?? 'GET'

    if (path === '/' || path === '/v1/models' || OPENAI_CHAT_PATHS.has(path)) {
      const ok =
        (path === '/' && method === 'GET') ||
        (path === '/v1/models' && method === 'GET') ||
        (OPENAI_CHAT_PATHS.has(path) && method === 'POST')
      if (!ok) return json(res, 405, { error: 'method not allowed' })
      if (path === '/') return root(res)
      if (path === '/v1/models') return models(res)
      return chat(req, res)
    }
    if (path === '/v1beta/models' || path.startsWith('/v1beta/models/')) {
      return v1beta(req, res, path, method)
    }
    return json(res, 404, { error: 'not found' })
  }

  function root(res: ServerResponse): void {
    const d = provider.describe()
    json(res, 200, {
      status: 'ok',
      version: WEBAPI_VERSION,
      provider: provider.id,
      defaultModel: d.defaultModel,
      models: d.models,
      /** M12 — métadonnées d'affichage des modèles (libellé, famille, réflexion). */
      modelInfo: listModelInfo(d.modelTable),
      gateway: {
        cookies: d.cookies,
        bl: d.bl,
        cookieFile: d.cookieFile,
        rawCookies: d.rawCookies,
        accounts: d.accounts,
        activeAccount: d.activeAccount,
        /** M9 — session /u/N effective du compte actif (null = sans préfixe). */
        authUser: d.authUser,
        /** M9 — statistiques d'utilisation par compte (fenêtre du journal amont). */
        accountUsage: d.accountUsage,
        proxy: d.proxy,
        recent: d.recent,
      },
    })
  }

  function models(res: ServerResponse): void {
    const d = provider.describe()
    json(res, 200, {
      object: 'list',
      data: d.models.map((id) => ({ id, object: 'model', created: 1_700_000_000, owned_by: 'google' })),
    })
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: { message: `corps trop volumineux (max ${MAX_BODY_BYTES} octets)` } })
      return json(res, 400, { error: { message: 'corps illisible' } })
    }
    let payload: ChatRequestBody
    try {
      payload = JSON.parse(raw) as ChatRequestBody
    } catch {
      return json(res, 400, { error: { message: 'corps JSON invalide' } })
    }

    const described = provider.describe()
    const model = typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : described.defaultModel
    const known = described.models
    const base = model.split('@think=')[0] ?? model
    if (!known.includes(base)) return json(res, 400, { error: { message: `Unknown model: ${model}` } })

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    // M10 — outils client : normalisés une fois, rejetés proprement si malformés.
    let toolsActive = false
    if (payload.tools !== undefined) {
      try {
        const tools = normalizeTools(payload.tools)
        const choice = parseToolChoice(payload.tool_choice)
        toolsActive = tools.length > 0 && choice.kind !== 'none'
        if (toolsActive) {
          // La convention d'appel passe par le prompt — voir tools.ts.
          const preamble = toolsPreamble(tools, choice)
          const history = messagesToPrompt(messages)
          const mergedPrompt = [history, preamble].filter((s) => s.length > 0).join('\n\n')
          return dispatchChat(res, { id: '', created: 0, model, prompt: mergedPrompt, messages: [{ role: 'user', content: mergedPrompt }], toolsActive, stream: payload.stream === true })
        }
      } catch (err) {
        if (err instanceof ToolValidationError) return json(res, 400, { error: { message: err.message } })
        throw err
      }
    }
    const prompt = messagesToPrompt(messages)
    if (prompt.trim().length === 0) return json(res, 400, { error: { message: 'empty prompt' } })
    return dispatchChat(res, { id: '', created: 0, model, prompt, messages, toolsActive: false, stream: payload.stream === true })
  }

  interface ChatCtx {
    id: string
    created: number
    model: string
    messages: unknown[]
    prompt?: string
    toolsActive: boolean
    stream: boolean
  }

  /** Génère l’id/created communs puis route vers stream ou complétion. */
  function dispatchChat(res: ServerResponse, ctx: ChatCtx): void {
    const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const created = Math.floor(Date.now() / 1000)
    const full: ChatCtx = { ...ctx, id, created }
    if (full.stream) return void streamChat(res, full)
    return void completeChat(res, full)
  }

  async function streamChat(res: ServerResponse, ctx: ChatCtx): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
    }, SSE_PING_MS)
    const writable = () => !res.writableEnded && !res.destroyed
    const chunk = (delta: Record<string, unknown>, finish: string | null): string => {
      const payload = { id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.model, choices: [{ index: 0, delta, finish_reason: finish }] }
      return `data: ${JSON.stringify(payload)}\n\n`
    }
    try {
      if (writable()) res.write(chunk({}, null))
      let finishReason: 'stop' | 'tool_calls' = 'stop'
      if (!ctx.toolsActive) {
        // Chemin historique — le raisonnement (M12) passe en
        // delta.reasoning_content avant le texte, dialecte DeepSeek.
        for await (const ev of provider.chatStream({ model: ctx.model, messages: ctx.messages as ProviderChatMessages, signal: controller.signal })) {
          if (!writable() || controller.signal.aborted) break
          if (ev.kind === 'thought') res.write(chunk({ reasoning_content: ev.delta }, null))
          else res.write(chunk({ content: ev.delta }, null))
        }
      } else {
        // M10 — le texte traverse le splitter : blocs d'appel → delta.tool_calls.
        // M12 — la réflexion ne traverse JAMAIS le splitter (ce n'est pas du
        // texte d'appel) : elle part directement en reasoning_content.
        const splitter = new ToolStreamSplitter()
        let callIndex = 0
        let sawCall = false
        const emit = (out: ToolStreamEvent): void => {
          if (!writable() || controller.signal.aborted) return
          if (out.text.length > 0) res.write(chunk({ content: out.text }, null))
          for (const call of out.toolCalls) {
            sawCall = true
            res.write(
              chunk(
                {
                  tool_calls: [
                    { index: callIndex++, id: `call-${randomUUID().replaceAll('-', '').slice(0, 12)}`, type: 'function', function: { name: call.name, arguments: openAiArguments(call) } },
                  ],
                },
                null,
              ),
            )
          }
        }
        for await (const ev of provider.chatStream({ model: ctx.model, messages: ctx.messages as ProviderChatMessages, signal: controller.signal })) {
          if (!writable() || controller.signal.aborted) break
          if (ev.kind === 'thought') {
            res.write(chunk({ reasoning_content: ev.delta }, null))
            continue
          }
          emit(splitter.push(ev.delta))
        }
        if (controller.signal.aborted || !writable()) return
        emit(splitter.finish())
        finishReason = sawCall ? 'tool_calls' : 'stop'
      }
      if (controller.signal.aborted || !writable()) return
      res.write(chunk({}, finishReason))
      res.write('data: [DONE]\n\n')
    } catch (err) {
      if (!writable()) return
      // L'échec amont est visible : finish_reason "error" + objet error, puis [DONE].
      const message = err instanceof GeminiError ? err.message : `upstream error: ${errText(err)}`
      const payload = {
        id: ctx.id,
        object: 'chat.completion.chunk',
        created: ctx.created,
        model: ctx.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        error: { message, code: 'upstream_error' },
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      res.write('data: [DONE]\n\n')
    } finally {
      clearInterval(ping)
      res.end()
    }
  }

  async function completeChat(res: ServerResponse, ctx: ChatCtx): Promise<void> {
    try {
      if (!ctx.toolsActive) {
        // Chemin historique — M12 : le raisonnement rejoint la réponse en
        // message.reasoning_content quand il existe (additif).
        const { text: content, reasoning } = await provider.chatComplete({ model: ctx.model, messages: ctx.messages as ProviderChatMessages })
        return json(res, 200, {
          id: ctx.id,
          object: 'chat.completion',
          created: ctx.created,
          model: ctx.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content, ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}) },
              finish_reason: 'stop',
            },
          ],
          usage: usage(ctx.prompt ?? '', content),
        })
      }
      // M10 — collecte via le splitter : texte + appels d'outils.
      const turn = await collectTurn(ctx.model, ctx.messages as ChatMessage[])
      if (turn.calls.length === 0) {
        return json(res, 200, {
          id: ctx.id,
          object: 'chat.completion',
          created: ctx.created,
          model: ctx.model,
          choices: [{ index: 0, message: { role: 'assistant', content: turn.text }, finish_reason: 'stop' }],
          usage: usage(ctx.prompt ?? '', turn.text),
        })
      }
      const completion = turn.text + turn.calls.map((c) => openAiArguments(c)).join('')
      return json(res, 200, {
        id: ctx.id,
        object: 'chat.completion',
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: turn.text.length > 0 ? turn.text : null,
              tool_calls: turn.calls.map((call, i) => ({
                index: i,
                id: `call-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
                type: 'function',
                function: { name: call.name, arguments: openAiArguments(call) },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: usage(ctx.prompt ?? '', completion),
      })
    } catch (err) {
      const message = err instanceof GeminiError ? err.message : `upstream error: ${errText(err)}`
      json(res, 502, { error: { message } })
    }
  }

  /** Un tour complet collecté à travers le splitter — texte, appels, réflexion (M12). */
  interface TurnCollect {
    text: string
    calls: ParsedToolCall[]
    events: ToolStreamEvent[]
    thought: string
  }

  async function collectTurn(model: string, messages: ChatMessage[]): Promise<TurnCollect> {
    const splitter = new ToolStreamSplitter()
    const events: ToolStreamEvent[] = []
    let text = ''
    let thought = ''
    const calls: ParsedToolCall[] = []
    for await (const ev of provider.chatStream({ model, messages })) {
      if (ev.kind === 'thought') {
        thought += ev.delta
        continue
      }
      const out = splitter.push(ev.delta)
      if (out.text.length > 0 || out.toolCalls.length > 0) {
        events.push(out)
        text += out.text
        calls.push(...out.toolCalls)
      }
    }
    const tail = splitter.finish()
    if (tail.text.length > 0 || tail.toolCalls.length > 0) {
      events.push(tail)
      text += tail.text
      calls.push(...tail.toolCalls)
    }
    return { text, calls, events, thought }
  }

  // ------------------------------------------------------------------ v1beta (M10)

  /** Routes Google-style — erreurs à l'enveloppe Google, comportements fidèles. */
  async function v1beta(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
    if (path === '/v1beta/models') {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const d = provider.describe()
      return json(res, 200, { models: d.models.map(v1betaModelInfo) })
    }
    // /v1beta/models/<segment> — segment éventuellement percent-encodé (`%3A`, `%40`).
    let segment: string
    try {
      segment = decodeURIComponent(path.slice('/v1beta/models/'.length))
    } catch {
      return gerr(res, 400, 'Invalid percent-encoding in model path', 'INVALID_ARGUMENT')
    }
    const colon = segment.indexOf(':')
    const rawName = colon >= 0 ? segment.slice(0, colon) : segment
    const action = colon >= 0 ? segment.slice(colon + 1) : ''
    const name = rawName.replace(/^models\//, '')

    if (action.length === 0) {
      if (method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const d = provider.describe()
      if (!d.models.includes(name)) return gerr(res, 404, `models/${name} is not found for API version v1beta`, 'NOT_FOUND')
      return json(res, 200, v1betaModelInfo(name))
    }
    if (action !== 'generateContent' && action !== 'streamGenerateContent') {
      return gerr(res, 404, `Unknown method :${action} for models/${name}`, 'NOT_FOUND')
    }
    if (method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    return generateContentRoute(req, res, name, action === 'streamGenerateContent')
  }

  async function generateContentRoute(req: IncomingMessage, res: ServerResponse, model: string, streaming: boolean): Promise<void> {
    let raw: string
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLarge) return gerr(res, 413, `Request body exceeds the limit (${MAX_BODY_BYTES} bytes)`, 'RESOURCE_EXHAUSTED')
      return gerr(res, 400, 'Unreadable request body', 'INVALID_ARGUMENT')
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return gerr(res, 400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT')
    }
    const described = provider.describe()
    const base = model.split('@think=')[0] ?? model
    if (model.length === 0 || !described.models.includes(base)) {
      return gerr(res, 404, `models/${model} is not found for API version v1beta`, 'NOT_FOUND')
    }
    let normalized: ReturnType<typeof parseGenerateRequest>
    try {
      normalized = parseGenerateRequest(payload)
    } catch (err) {
      return gerr(res, 400, err instanceof Error ? err.message : 'Invalid request payload', 'INVALID_ARGUMENT')
    }
    if (normalized.prompt.trim().length === 0) {
      return gerr(res, 400, 'Request must contain at least one content part with text (contents).', 'INVALID_ARGUMENT')
    }
    const messages: ChatMessage[] = [{ role: 'user', content: normalized.prompt }]
    const upstreamError = (err: unknown): { code: number; message: string; status: string } => {
      const message = err instanceof GeminiError ? err.message : `upstream error: ${errText(err)}`
      return { code: 502, message, status: 'UNAVAILABLE' }
    }

    if (!streaming) {
      try {
        const turn = await collectTurn(model, messages)
        return json(res, 200, buildGenerateResponse(model, turn.text, turn.calls, normalized.prompt, turn.thought))
      } catch (err) {
        const e = upstreamError(err)
        return gerr(res, e.code, e.message, e.status)
      }
    }
    // Streaming : ?alt=sse → SSE (comme le SDK Google), sinon tableau JSON (REST).
    const sse = new URL(req.url ?? '/', 'http://local').searchParams.get('alt') === 'sse'
    if (!sse) {
      try {
        const turn = await collectTurn(model, messages)
        const chunks: unknown[] = []
        if (turn.thought.length > 0) chunks.push(generateThoughtChunk(turn.thought))
        for (const ev of turn.events) {
          if (ev.text.length > 0) chunks.push(generateTextChunk(ev.text))
          for (const call of ev.toolCalls) chunks.push(generateCallChunk(call))
        }
        const completion = turn.text + turn.calls.map(callToText).join('')
        chunks.push(generateFinalChunk(model, normalized.prompt, completion))
        return json(res, 200, chunks)
      } catch (err) {
        const e = upstreamError(err)
        return gerr(res, e.code, e.message, e.status)
      }
    }
    // SSE Google : data: {chunk}\n\n par événement, chunk final avec finishReason
    // et usageMetadata — pas de [DONE] (Google n'en a pas). Un échec amont =
    // un événement error Google en fin de flux — jamais un STOP déguisé.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n')
    }, SSE_PING_MS)
    const writable = () => !res.writableEnded && !res.destroyed
    const send = (data: unknown): void => {
      if (writable() && !controller.signal.aborted) res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    try {
      const splitter = new ToolStreamSplitter()
      let completion = ''
      for await (const ev of provider.chatStream({ model, messages, signal: controller.signal })) {
        if (!writable() || controller.signal.aborted) break
        if (ev.kind === 'thought') {
          send(generateThoughtChunk(ev.delta))
          continue
        }
        const out = splitter.push(ev.delta)
        if (out.text.length > 0) {
          completion += out.text
          send(generateTextChunk(out.text))
        }
        for (const call of out.toolCalls) {
          completion += callToText(call)
          send(generateCallChunk(call))
        }
      }
      if (controller.signal.aborted || !writable()) return
      const tail = splitter.finish()
      if (tail.text.length > 0) {
        completion += tail.text
        send(generateTextChunk(tail.text))
      }
      for (const call of tail.toolCalls) {
        completion += callToText(call)
        send(generateCallChunk(call))
      }
      send(generateFinalChunk(model, normalized.prompt, completion))
    } catch (err) {
      if (writable()) send({ error: upstreamError(err) })
    } finally {
      clearInterval(ping)
      res.end()
    }
  }

  return server
}

type ProviderChatMessages = Parameters<Provider['chatStream']>[0]['messages']
