import { describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWebApiServer } from './server.ts'
import type { WebApiConfig } from './config.ts'
import { startMockGemini, parseStreamBody, type MockGemini, type MockGeminiOptions } from './mock-gemini.ts'

const COOKIES = 'SAPISID=test-sapisid; HSID=h1'

interface Ctx {
  base: string
  mock: MockGemini
  server: Server
}

/** Monte la maquette Gemini + la passerelle complète (serveur HTTP réel, port éphémère). */
async function withServer(mockOptions: MockGeminiOptions | undefined, fn: (ctx: Ctx) => Promise<void>, overrides: Partial<WebApiConfig> = {}): Promise<void> {
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
    ...overrides,
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

  it('diagnostic M8 : comptes, proxy, journal amont après un tour', async () => {
    await withServer(undefined, async ({ base }) => {
      // Un tour réel (contre la maquette) pour alimenter le journal.
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(chatBody),
      })
      await readSse(res)

      const { body } = await getJson(base, '/')
      const gw = body.gateway
      expect(gw.cookieFile).toBe('(NYW_WEBAPI_COOKIES)') // libellé env quand les cookies bruts gagnent
      expect(gw.rawCookies).toBe(true)
      expect(gw.accounts).toEqual([{ file: '(NYW_WEBAPI_COOKIES)', cookies: true }])
      expect(gw.activeAccount).toBe(0)
      expect(gw.proxy).toBeNull()
      expect(gw.recent).toHaveLength(1)
      expect(gw.recent[0]).toMatchObject({ ok: true, model: 'gemini-3.6-flash', attempts: 1 })
      expect(typeof gw.recent[0].ms).toBe('number')
      expect(typeof gw.recent[0].at).toBe('string')
    })
  })

  it('diagnostic M9 : sessions /u/N par compte, expiration et stats d’utilisation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nyw-srv-m9-'))
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      writeFileSync(path.join(dir, 'a-perso.json'), JSON.stringify([
        { name: 'SAPISID', value: 'perso', domain: '.google.com', expirationDate: nowSec + 12 * 86_400 },
      ]))
      // b-pro : cookies déjà expirés (date passée) — distinguable d’un compte absent.
      writeFileSync(path.join(dir, 'b-pro.json'), JSON.stringify([
        { name: 'SAPISID', value: 'pro', domain: '.google.com', expirationDate: nowSec - 3 * 86_400 },
      ]))
      writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [
        { file: 'a-perso.json', authUser: 0, label: 'Perso' },
        { file: 'b-pro.json', authUser: 1, label: 'Pro' },
      ] }))

      // 401 sur le compte a → rotation vers b… qui est expiré : échec typé.
      await withServer(
        { streamPlan: [{ kind: 'status', status: 401 }, { kind: 'status', status: 401 }] },
        async ({ base }) => {
          // Un tour (échec) alimente le journal → stats visibles.
          const res = await fetch(base + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify(chatBody),
          })
          await readSse(res) // se termine en finish_reason error — jamais déguisé

          const { body } = await getJson(base, '/')
          const gw = body.gateway
          // Sessions /u/N par compte.
          expect(gw.accounts.map((a: { authUser?: number }) => a.authUser)).toEqual([0, 1])
          expect(gw.accounts.map((a: { label?: string }) => a.label)).toEqual(['Perso', 'Pro'])
          // Expiration : future pour Perso, passée pour Pro.
          expect(gw.accounts[0].expiresAt).toBeGreaterThan(nowSec)
          expect(gw.accounts[1].cookies).toBe(false)
          expect(gw.accounts[1].expiresAt).toBeLessThan(nowSec)
          // La session effective du compte ACTIF.
          expect(gw.authUser).toBe(1)
          // Stats : le tour a échoué sur le compte final (b) — échec compté.
          expect(gw.accountUsage).toEqual([
            { account: 1, turns: 1, ok: 0, failed: 1, totalMs: expect.any(Number), lastAt: expect.any(String) },
          ])
        },
        { cookieFile: dir, rawCookies: undefined },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

// ------------------------------------------------------------------ M10 : tools

const TOOL_BLOCK = '{{tool {"name": "get_weather", "arguments": {"city": "Paris"}} }}'
/** Snapshots cumulatifs : le bloc est COUPÉ entre les deux frames — comme en vrai. */
const TOOL_SNAPSHOTS = ['Voici.\n{{tool {"na', `Voici.\n${TOOL_BLOCK}`]

const TOOLS_BODY = {
  model: 'gemini-3.6-flash',
  messages: [{ role: 'user', content: 'Météo à Paris ?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Météo d’une ville',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ],
}

describe('POST /v1/chat/completions — tools (M10)', () => {
  it('complétion : bloc décodé en tool_calls OpenAI, finish_reason "tool_calls"', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: TOOL_SNAPSHOTS }] }, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, stream: false })
      expect(status).toBe(200)
      expect(body.object).toBe('chat.completion')
      const msg = body.choices[0].message
      expect(msg.role).toBe('assistant')
      expect(msg.content).toBe('Voici.\n') // le texte AVANT le bloc reste du contenu
      expect(msg.tool_calls).toHaveLength(1)
      expect(msg.tool_calls[0].id).toMatch(/^call-/)
      expect(msg.tool_calls[0].type).toBe('function')
      expect(msg.tool_calls[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
      expect(body.choices[0].finish_reason).toBe('tool_calls')
      expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens)
    })
  })

  it('streaming : bloc coupé entre deux snapshots → delta.tool_calls + finish "tool_calls" + [DONE]', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: TOOL_SNAPSHOTS, delayMs: 5 }] }, async ({ base }) => {
      const res = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ ...TOOLS_BODY, stream: true }),
      })
      expect(res.status).toBe(200)
      const data = (await readSse(res)).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
      expect(data.at(-1)).toBe('[DONE]')
      expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: null }] })
      const text = chunks.map((c: any) => c.choices[0]?.delta?.content ?? '').join('')
      expect(text).toBe('Voici.\n')
      const callChunks = chunks.filter((c: any) => Array.isArray(c.choices[0]?.delta?.tool_calls))
      expect(callChunks).toHaveLength(1)
      const tc = callChunks[0].choices[0].delta.tool_calls[0]
      expect(tc.index).toBe(0)
      expect(tc.id).toMatch(/^call-/)
      expect(tc.type).toBe('function')
      expect(tc.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
      expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] })
    })
  })

  it('le préambule d’outils part bien amont, APRÈS l’historique (f.req)', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, stream: false })
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      const prompt = String((inner[0] as unknown[])[0])
      expect(prompt).toContain('Météo à Paris ?')
      expect(prompt.indexOf('Météo à Paris ?')).toBeLessThan(prompt.indexOf('[Tool calling]'))
      expect(prompt).toContain('- get_weather: Météo d’une ville')
      expect(prompt).toContain('Never invent tool results')
    })
  })

  it('tool_choice "none" : pas de préambule, la réponse reste du texte brut', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tool_choice: 'none', stream: false })
      expect(status).toBe(200)
      expect(body.choices[0].message.content).toBe('Bonjour, le monde')
      expect(body.choices[0].message.tool_calls).toBeUndefined()
      expect(body.choices[0].finish_reason).toBe('stop')
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      expect(String((inner[0] as unknown[])[0])).not.toContain('[Tool calling]')
    })
  })

  it('tool_choice forcé : l’injonction part amont', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tool_choice: { type: 'function', function: { name: 'get_weather' } }, stream: false })
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      expect(String((inner[0] as unknown[])[0])).toContain('MUST call the tool "get_weather"')
    })
  })

  it('round-trip : tool_calls assistant + message tool partent dans le prompt amont', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      await postJson(base, '/v1/chat/completions', {
        ...TOOLS_BODY,
        stream: false,
        messages: [
          { role: 'user', content: 'Météo ?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '{"temp":12}' },
          { role: 'user', content: 'Merci, résume' },
        ],
      })
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      const prompt = String((inner[0] as unknown[])[0])
      expect(prompt).toContain('{{tool {"name":"get_weather","arguments":{"city":"Paris"}} }}')
      expect(prompt).toContain('[Tool result]: {"temp":12}')
      expect(prompt).toContain('Merci, résume')
    })
  })

  it('sans bloc dans la réponse : texte simple, finish "stop" (pas de tool_call fantôme)', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, stream: false })
      expect(status).toBe(200)
      expect(body.choices[0].message.content).toBe('Bonjour, le monde')
      expect(body.choices[0].message.tool_calls).toBeUndefined()
      expect(body.choices[0].finish_reason).toBe('stop')
    })
  })

  it('tools ou tool_choice malformés → 400 au message clair', async () => {
    await withServer(undefined, async ({ base }) => {
      const a = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tools: 'banane', stream: false })
      expect(a.status).toBe(400)
      expect(a.body.error.message).toMatch(/tools/)
      const b = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tools: [{ type: 'function', function: {} }], stream: false })
      expect(b.status).toBe(400)
      expect(b.body.error.message).toMatch(/function\.name/)
      const c = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tool_choice: 'banana', stream: false })
      expect(c.status).toBe(400)
      expect(c.body.error.message).toMatch(/tool_choice/)
      const d = await postJson(base, '/v1/chat/completions', { ...TOOLS_BODY, tools: [{ function: { name: 'f' } }, { function: { name: 'f' } }], stream: false })
      expect(d.status).toBe(400)
      expect(d.body.error.message).toMatch(/dupliqué/)
    })
  })

  it('la surface v1 ne bouge pas : sans tools, la réponse est exactement celle d’avant', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1/chat/completions', { model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'Bonjour' }], stream: false })
      expect(status).toBe(200)
      expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'Bonjour, le monde' })
      expect(body.choices[0].finish_reason).toBe('stop')
    })
  })
})

// ------------------------------------------------------------------ M10 : v1beta

describe('GET /v1beta/models (M10)', () => {
  it('liste au format Google', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await getJson(base, '/v1beta/models')
      expect(status).toBe(200)
      expect(body.models).toHaveLength(8)
      expect(body.models[0]).toEqual({
        name: 'models/gemini-3.6-flash',
        displayName: 'gemini-3.6-flash',
        description: 'Gemini served through the NyWorkflow webapi gateway',
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      })
    })
  })

  it('un modèle : 200 ; inconnu : 404 enveloppe Google', async () => {
    await withServer(undefined, async ({ base }) => {
      const ok = await getJson(base, '/v1beta/models/gemini-3.6-flash')
      expect(ok.status).toBe(200)
      expect(ok.body.name).toBe('models/gemini-3.6-flash')
      const ko = await getJson(base, '/v1beta/models/gpt-9')
      expect(ko.status).toBe(404)
      expect(ko.body.error).toEqual({ code: 404, message: 'models/gpt-9 is not found for API version v1beta', status: 'NOT_FOUND' })
    })
  })

  it('405 sur POST /v1beta/models', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status } = await postJson(base, '/v1beta/models', {})
      expect(status).toBe(405)
    })
  })
})

describe('POST /v1beta/models/{model}:generateContent (M10)', () => {
  it('réponse Google : candidates, parts, finishReason STOP, usageMetadata, modelVersion', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1beta/models/gemini-3.6-flash:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }],
      })
      expect(status).toBe(200)
      expect(body.candidates).toHaveLength(1)
      expect(body.candidates[0].content.role).toBe('model')
      expect(body.candidates[0].content.parts[0].text).toBe('Bonjour, le monde')
      expect(body.candidates[0].finishReason).toBe('STOP')
      expect(body.candidates[0].index).toBe(0)
      expect(body.modelVersion).toBe('gemini-3.6-flash')
      expect(body.usageMetadata.totalTokenCount).toBe(body.usageMetadata.promptTokenCount + body.usageMetadata.candidatesTokenCount)
    })
  })

  it('systemInstruction + rôles : le prompt amont porte les marqueurs de /v1', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      await postJson(base, '/v1beta/models/gemini-3.6-flash:generateContent', {
        systemInstruction: { parts: [{ text: 'Sois bref.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Bonjour' }] },
          { role: 'model', parts: [{ text: 'Salut' }] },
          { role: 'user', parts: [{ text: 'Résume' }] },
        ],
      })
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      const prompt = String((inner[0] as unknown[])[0])
      expect(prompt).toContain('[System instruction]: Sois bref.')
      expect(prompt).toContain('[Assistant]: Salut')
      expect(prompt).toContain('Résume')
    })
  })

  it('tools (functionDeclarations) : functionCall dans les parts de la réponse', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: TOOL_SNAPSHOTS }] }, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1beta/models/gemini-3.6-flash:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'Météo à Paris ?' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Météo', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] }],
      })
      expect(status).toBe(200)
      expect(body.candidates[0].content.parts).toEqual([
        { text: 'Voici.\n' },
        { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
      ])
      expect(body.candidates[0].finishReason).toBe('STOP')
    })
  })

  it('streamGenerateContent ?alt=sse : chunks SSE, chunk final avec finishReason + usage, PAS de [DONE]', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: TOOL_SNAPSHOTS }] }, async ({ base }) => {
      const res = await fetch(base + '/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Météo ?' }] }] }),
      })
      expect(res.status).toBe(200)
      expect(String(res.headers.get('content-type'))).toContain('text/event-stream')
      const lines = await readSse(res) // pas de [DONE] : lit jusqu'à la fin du flux
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      expect(data.length).toBeGreaterThanOrEqual(3)
      const chunks = data.map((d) => JSON.parse(d))
      expect(chunks[0].candidates[0].content.parts).toEqual([{ text: 'Voici.\n' }])
      expect(chunks[1].candidates[0].content.parts[0].functionCall).toEqual({ name: 'get_weather', args: { city: 'Paris' } })
      const final = chunks.at(-1)
      expect(final.candidates[0].finishReason).toBe('STOP')
      expect(final.usageMetadata.totalTokenCount).toBeGreaterThan(0)
      expect(final.modelVersion).toBe('gemini-3.6-flash')
      expect(data.at(-1)).not.toBe('[DONE]')
    })
  })

  it('streamGenerateContent sans alt : tableau JSON de chunks (comportement REST)', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1beta/models/gemini-3.6-flash:streamGenerateContent', {
        contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }],
      })
      expect(status).toBe(200)
      expect(Array.isArray(body)).toBe(true)
      expect(body.length).toBeGreaterThanOrEqual(2)
      expect(body[0].candidates[0].content.parts[0].text).toBe('Bonjour, ')
      expect(body.at(-1).candidates[0].finishReason).toBe('STOP')
      expect(body.at(-1).usageMetadata.totalTokenCount).toBeGreaterThan(0)
    })
  })

  it('échec amont → 502 enveloppe Google UNAVAILABLE', async () => {
    await withServer({ streamPlan: [{ kind: 'status', status: 500 }] }, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1beta/models/gemini-3.6-flash:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }],
      })
      expect(status).toBe(502)
      expect(body.error.status).toBe('UNAVAILABLE')
      expect(body.error.message).toMatch(/500/)
    })
  })

  it('erreurs claires : modèle inconnu 404, méthode inconnue 404, contents absent 400, JSON invalide 400', async () => {
    await withServer(undefined, async ({ base }) => {
      const ko = await postJson(base, '/v1beta/models/gpt-9:generateContent', { contents: [{ role: 'user', parts: [{ text: 'x' }] }] })
      expect(ko.status).toBe(404)
      expect(ko.body.error.status).toBe('NOT_FOUND')
      const method = await postJson(base, '/v1beta/models/gemini-3.6-flash:countTokens', { contents: [] })
      expect(method.status).toBe(404)
      expect(method.body.error.message).toMatch(/:countTokens/)
      const noContents = await postJson(base, '/v1beta/models/gemini-3.6-flash:generateContent', {})
      expect(noContents.status).toBe(400)
      expect(noContents.body.error.status).toBe('INVALID_ARGUMENT')
      const badJson = await fetch(base + '/v1beta/models/gemini-3.6-flash:generateContent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
      expect(badJson.status).toBe(400)
    })
  })

  it('405 : GET sur :generateContent', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/v1beta/models/gemini-3.6-flash:generateContent')
      expect(res.status).toBe(405)
    })
  })

  it('suffixe @think= accepté dans le chemin du modèle', async () => {
    await withServer(undefined, async ({ base }) => {
      const { status } = await postJson(base, '/v1beta/models/gemini-3.1-pro@think=2:generateContent', { contents: [{ role: 'user', parts: [{ text: 'ok' }] }] })
      expect(status).toBe(200)
    })
  })
})

// --------------------------------------------------- M11 : dialecte OpenAI sous v1beta

describe('POST /v1beta/chat/completions — alias namespace (M11)', () => {
  it('streaming texte : même moteur que /v1, chunks identiques', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: ['Bon', 'Bonjour'] }] }, async ({ base }) => {
      const res = await fetch(base + '/v1beta/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'salut' }], stream: true }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const data = (await readSse(res)).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      expect(data.at(-1)).toBe('[DONE]')
      const text = data
        .slice(0, -1)
        .map((d) => JSON.parse(d))
        .map((c: any) => c.choices[0]?.delta?.content ?? '')
        .join('')
      expect(text).toBe('Bonjour')
    })
  })

  it('complétion avec tools : tool_calls décodés sous v1beta aussi', async () => {
    await withServer({ streamPlan: [{ kind: 'ok', snapshots: TOOL_SNAPSHOTS }] }, async ({ base }) => {
      const { status, body } = await postJson(base, '/v1beta/chat/completions', { ...TOOLS_BODY, stream: false })
      expect(status).toBe(200)
      expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
      expect(body.choices[0].finish_reason).toBe('tool_calls')
    })
  })

  it('les messages role:"tool" font le round-trip sous v1beta', async () => {
    await withServer(undefined, async ({ base, mock }) => {
      await postJson(base, '/v1beta/chat/completions', {
        model: 'gemini-3.6-flash',
        stream: false,
        messages: [
          { role: 'user', content: 'Météo ?' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true,"result":{"temp":12}}' },
        ],
        tools: TOOLS_BODY.tools,
      })
      const { inner } = parseStreamBody(mock.streamPosts()[0]!.body)
      const prompt = String((inner[0] as unknown[])[0])
      expect(prompt).toContain('[Tool result]: {"ok":true,"result":{"temp":12}}')
      expect(prompt).toContain('{{tool {"name":"get_weather","arguments":{"city":"Paris"}} }}')
    })
  })

  it('405 : GET sur /v1beta/chat/completions ; 404 : chemin v2 non encore servi', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/v1beta/chat/completions')
      expect(res.status).toBe(405)
      const v2 = await postJson(base, '/v2/chat/completions', chatBody)
      expect(v2.status).toBe(404)
    })
  })
})
