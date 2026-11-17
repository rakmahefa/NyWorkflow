import { describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createWebApiServer } from './server.ts'
import type { WebApiConfig } from './config.ts'
import { startMockGemini, type MockGemini, type MockGeminiOptions } from './mock-gemini.ts'

const COOKIES = 'SAPISID=test-sapisid; HSID=h1'

interface Ctx {
  base: string
  mock: MockGemini
  server: Server
}

/** Monte la maquette Gemini + la passerelle complète (serveur HTTP réel, port éphémère). */
async function withServer(mockOptions: MockGeminiOptions | undefined, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const mock = await startMockGemini(mockOptions)
  const config: WebApiConfig = {
    host: '127.0.0.1',
    port: 0,
    cookieFile: '',
    rawCookies: COOKIES,
    defaultModel: 'gemini-3.6-flash',
    baseUrl: mock.baseUrl,
    retryAttempts: 1,
    retryDelayMs: 1,
    timeoutMs: 5_000,
  }
  const server = createWebApiServer(config)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await fn({ base: `http://127.0.0.1:${port}`, mock, server })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await mock.close()
  }
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

/** Lit un flux SSE jusqu’à la fin (ou [DONE]) et retourne les lignes data:. */
async function readSse(res: Response): Promise<string[]> {
  const lines: string[] = []
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (line.length > 0) lines.push(line)
      if (line === 'data: [DONE]') return lines
    }
  }
  return lines
}

const chatBody = { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'Bonjour' }], stream: true }

describe('GET / — état et diagnostic', () => {
  it('status ok, provider gemini, modèles, état de la passerelle', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await getJson(base, '/')
      expect(status).toBe(200)
      expect(body.status).toBe('ok')
      expect(body.provider).toBe('gemini')
      expect(body.defaultModel).toBe('gemini-3.6-flash')
      expect(body.models).toHaveLength(8)
      expect(body.gateway.cookies).toBe(true)
      expect(body.gateway.bl).toBeNull() // pas encore découvert — aucune requête réseau
      expect(typeof body.version).toBe('string')
    })
  })

  it('normalise les slashs de fin (détail de proxy)', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status } = await getJson(base, '/v1/models/')
      expect(status).toBe(200)
    })
  })
})

describe('GET /v1/models', () => {
  it('liste au format OpenAI', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await getJson(base, '/v1/models')
      expect(status).toBe(200)
      expect(body.object).toBe('list')
      expect(body.data[0]).toMatchObject({ id: 'gemini-3.6-flash', object: 'model', owned_by: 'google' })
      expect(body.data).toHaveLength(8)
    })
  })
})

describe('POST /v1/chat/completions — streaming', () => {
  it('séquence SSE exacte : ouverture, deltas, stop, [DONE]', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(chatBody),
      })
      expect(res.status).toBe(200)
      expect(String(res.headers.get('content-type'))).toContain('text/event-stream')
      const data = (await readSse(res)).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())

      const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
      expect(data.at(-1)).toBe('[DONE]')
      expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: null }] })
      const content = chunks.map((c: any) => c.choices[0]?.delta?.content ?? '').join('')
      expect(content).toBe('Bonjour, le monde')
      expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: 'stop' }] })
      expect(chunks.every((c: any) => c.model === 'gemini-3.6-flash')).toBe(true)

      // La requête amont a bien traversé client Gemini → maquette.
      expect(mock.streamPosts()).toHaveLength(1)
    })
  })

  it('échec amont = chunk finish_reason "error" + message, jamais un stop déguisé', async () => {
    const badLine = JSON.stringify([['wrb.fr', [62, 0], '{échec amont BardErrorInfo [401]'], ['di', 72]])
    await withServer({ streamPlan: [{ kind: 'ok', rawLines: [badLine] }] }, async ({ base }) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatBody),
      })
      const data = (await readSse(res)).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
      expect(data.at(-1)).toBe('[DONE]')
      const finishes = chunks.map((c: any) => c.choices[0]?.finish_reason)
      expect(finishes).not.toContain('stop')
      const errorChunk = chunks.find((c: any) => c.choices[0]?.finish_reason === 'error')
      expect(errorChunk?.error?.message).toMatch(/Cookies/)
      expect(errorChunk?.error?.code).toBe('upstream_error')
    })
  })

  it('la déconnexion du client interrompt la requête amont', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: ['premier'], delayMs: 80, hang: true }] }, async ({ base, mock }) => {
      const controller = new AbortController()
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatBody),
        signal: controller.signal,
      })
      const reader = res.body!.getReader()
      await reader.read() // le flux SSE est parti
      // On attend que la requête amont soit réellement en vol avant de couper.
      const inFlight = Date.now() + 3_000
      while (Date.now() < inFlight && mock.streamPosts().length === 0) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(mock.streamPosts().length).toBe(1)
      controller.abort()
      // La maquette voit la connexion tomber (annulation propagée à l’amont).
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        if (mock.streamPosts()[0]?.closed) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(mock.streamPosts()[0]?.closed).toBe(true)
    })
  })
})

describe('POST /v1/chat/completions — complétion', () => {
  it('réponse complète au format OpenAI avec usage', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...chatBody, stream: false })
      expect(status).toBe(200)
      expect(body.object).toBe('chat.completion')
      expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Bonjour, le monde' })
      expect(body.choices[0].finish_reason).toBe('stop')
      expect(body.usage.total_tokens).toBeGreaterThan(0)
      expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens)
    })
  })

  it('échec amont → 502 avec message', async () => {
    await withServer({ streamPlan: [{ kind: 'status', status: 500 }] }, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...chatBody, stream: false })
      expect(status).toBe(502)
      expect(body.error.message).toMatch(/500/)
    })
  })

  it('modèle absent de la requête → modèle par défaut appliqué', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { messages: [{ role: 'user', content: 'salut' }], stream: false })
      expect(status).toBe(200)
      expect(body.model).toBe('gemini-3.6-flash')
    })
  })
})

describe('validation et erreurs HTTP', () => {
  it('modèle inconnu → 400 Unknown model (jamais de repli silencieux)', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...chatBody, model: 'gpt-9' })
      expect(status).toBe(400)
      expect(body.error.message).toBe('Unknown model: gpt-9')
    })
  })

  it('modèle connu avec suffixe @think= accepté', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status } = await postJson(base, '/v1/chat/completions', { ...chatBody, model: 'gemini-3.1-pro@think=2', stream: false })
      expect(status).toBe(200)
    })
  })

  it('prompt vide → 400', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { model: 'gemini-3.6-flash', messages: [] })
      expect(status).toBe(400)
      expect(body.error.message).toBe('empty prompt')
    })
  })

  it('JSON invalide → 400', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe('corps JSON invalide')
    })
  })

  it('corps trop volumineux → 413', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(5 * 1024 * 1024),
      })
      expect(res.status).toBe(413)
    })
  })

  it('chemin inconnu → 404 JSON', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await getJson(base, '/v1/responses')
      expect(status).toBe(404)
      expect(body.error).toBe('not found')
    })
  })

  it('méthode inadaptée → 405', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/v1/chat/completions') // GET sur un POST-only
      expect(res.status).toBe(405)
      const res2 = await fetch(base + '/v1/models', { method: 'POST' })
      expect(res2.status).toBe(405)
    })
  })
})
