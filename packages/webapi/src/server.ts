/**
 * Serveur HTTP de la passerelle — OpenAI-compatible, écrit sur node:http nu :
 * zéro dépendance runtime. Surface v1 (ce qu'adapter-llm consomme, rien de plus) :
 *
 *   GET  /                     — état + diagnostic (cookies, bl, modèles)
 *   GET  /v1/models            — liste des modèles
 *   POST /v1/chat/completions  — chat (stream SSE ou réponse complète)
 *
 * Boucle 127.0.0.1 par défaut ; pas de clé API ni CORS tant que ce n'est pas
 * un milestone (l'UI passe par le proxy same-origin /api du serveur web).
 * Un échec amont en streaming = chunk `finish_reason: "error"` + [DONE] —
 * jamais un « stop » déguisé (le consommateur doit voir l'échec).
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createGeminiProvider, type Provider } from './provider.ts'
import { GeminiError } from './gemini.ts'
import { messagesToPrompt, usage } from './convert.ts'
import type { WebApiConfig } from './config.ts'
import { WEBAPI_VERSION } from './version.ts'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const SSE_PING_MS = 15_000

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Construit le provider Gemini depuis la config de la passerelle. */
export function webApiProviderFromConfig(config: WebApiConfig): Provider {
  return createGeminiProvider({
    baseUrl: config.baseUrl,
    cookieFile: config.cookieFile,
    rawCookies: config.rawCookies,
    defaultModel: config.defaultModel,
    modelsFile: config.modelsFile,
    bl: config.geminiBl,
    authUser: config.authUser,
    timeoutMs: config.timeoutMs,
    retryAttempts: config.retryAttempts,
    retryDelayMs: config.retryDelayMs,
  })
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
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

    if (path === '/' || path === '/v1/models' || path === '/v1/chat/completions') {
      const ok = (path === '/' && method === 'GET') || (path === '/v1/models' && method === 'GET') || (path === '/v1/chat/completions' && method === 'POST')
      if (!ok) return json(res, 405, { error: 'method not allowed' })
      if (path === '/') return root(res)
      if (path === '/v1/models') return models(res)
      return chat(req, res)
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
      gateway: { cookies: d.cookies, bl: d.bl },
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
    const prompt = messagesToPrompt(messages)
    if (prompt.trim().length === 0) return json(res, 400, { error: { message: 'empty prompt' } })

    const id = `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const created = Math.floor(Date.now() / 1000)
    if (payload.stream === true) return streamChat(res, { id, created, model, messages })
    return completeChat(res, { id, created, model, prompt, messages })
  }

  interface ChatCtx {
    id: string
    created: number
    model: string
    messages: unknown[]
    prompt?: string
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
      for await (const delta of provider.chatStream({ model: ctx.model, messages: ctx.messages as ProviderChatMessages, signal: controller.signal })) {
        if (!writable() || controller.signal.aborted) break
        res.write(chunk({ content: delta }, null))
      }
      if (controller.signal.aborted || !writable()) return
      res.write(chunk({}, 'stop'))
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
      const content = await provider.chatComplete({ model: ctx.model, messages: ctx.messages as ProviderChatMessages })
      json(res, 200, {
        id: ctx.id,
        object: 'chat.completion',
        created: ctx.created,
        model: ctx.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: usage(ctx.prompt ?? '', content),
      })
    } catch (err) {
      const message = err instanceof GeminiError ? err.message : `upstream error: ${errText(err)}`
      json(res, 502, { error: { message } })
    }
  }

  return server
}

type ProviderChatMessages = Parameters<Provider['chatStream']>[0]['messages']
