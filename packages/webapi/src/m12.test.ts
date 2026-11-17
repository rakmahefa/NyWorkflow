import { describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createWebApiServer } from './server.ts'
import type { WebApiConfig } from './config.ts'
import { FrameDecoder } from './frames.ts'
import { DEFAULT_MODEL_TABLE, listModelInfo } from './models.ts'
import { startMockGemini, textFrame, type MockGemini, type MockGeminiOptions } from './mock-gemini.ts'

// M12 — la chaîne de la réflexion : les thoughts de l'interface Gemini
// (candidate[37][0][0]) deviennent des événements thought, traversent le
// provider, et sortent en delta.reasoning_content (dialecte OpenAI/DeepSeek)
// ou en parts thought:true (dialecte Google). Plus modelInfo : les
// métadonnées d'affichage des modèles sur GET /.

const COOKIES = 'SAPISID=test-sapisid; HSID=h1'

interface Ctx {
  base: string
  mock: MockGemini
  server: Server
}

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

const deltasOf = (lines: string[], key: string): string =>
  lines
    .filter((l) => l.startsWith('data: {'))
    .map((l) => JSON.parse(l.slice(6)))
    .map((c) => c.choices?.[0]?.delta?.[key] ?? '')
    .join('')

describe('frames — thoughts (M12)', () => {
  it('décode la réflexion du candidat porteur du texte (candidate[37][0][0])', () => {
    const line = textFrame('La réponse', 'Je réfléchis…') + '\n'
    const events = new FrameDecoder().feed(line)
    expect(events).toContainEqual({ type: 'text', text: 'La réponse' })
    expect(events).toContainEqual({ type: 'thought', text: 'Je réfléchis…' })
  })

  it('sans réflexion : aucun événement thought', () => {
    const events = new FrameDecoder().feed(textFrame('ok') + '\n')
    expect(events.some((e) => e.type === 'thought')).toBe(false)
  })
})

describe('models — métadonnées d’affichage (M12)', () => {
  it('listModelInfo : libellés, familles, réflexion native, think par défaut', () => {
    const info = listModelInfo(DEFAULT_MODEL_TABLE)
    const byId = Object.fromEntries(info.map((m) => [m.id, m]))
    expect(byId['gemini-3.6-flash']).toEqual({ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', family: 'flash', thinking: false, defaultThink: 4 })
    expect(byId['gemini-3.5-flash-thinking']).toMatchObject({ family: 'thinking', thinking: true, defaultThink: 0 })
    expect(byId['gemini-3.5-flash-thinking-lite']).toMatchObject({ family: 'thinking', thinking: true })
    expect(byId['gemini-3.1-pro-enhanced']).toMatchObject({ family: 'pro', label: 'Gemini 3.1 Pro Enhanced' })
    expect(byId['gemini-auto']).toMatchObject({ family: 'auto' })
    expect(byId['gemini-flash-lite']).toMatchObject({ family: 'lite' })
  })

  it('un id inconnu de la table reste servi : libellé de repli, famille autre', () => {
    const [info] = listModelInfo({ 'mon-modele-x': { mode: 9, think: 2 } })
    expect(info?.label).toBe('Gemini Mon Modele X')
    expect(info?.family).toBe('autre')
    expect(info?.thinking).toBe(false)
  })

  it('GET / expose modelInfo (additif — models reste la liste d’ids)', async () => {
    await withServer(undefined, async ({ base }) => {
      const res = await fetch(base + '/')
      const body = (await res.json()) as { models: string[]; modelInfo: { id: string; label: string; thinking: boolean }[] }
      expect(body.models).toContain('gemini-3.6-flash')
      const flash = body.modelInfo.find((m) => m.id === 'gemini-3.6-flash')
      expect(flash?.label).toBe('Gemini 3.6 Flash')
      expect(body.modelInfo.some((m) => m.thinking)).toBe(true)
    })
  })
})

describe('POST /v1/chat/completions — la réflexion traverse (M12)', () => {
  it('streaming : thoughts → delta.reasoning_content avant le texte, texte intact', async () => {
    await withServer(
      {
        streamPlan: [
          {
            kind: 'ok',
            snapshots: ['Rép', 'Réponse finale'],
            thoughts: ['Je pen', 'Je pense donc je réponds.'],
          },
        ],
      },
      async ({ base }) => {
        const res = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'Bonjour' }], stream: true }),
        })
        const lines = await readSse(res)
        expect(deltasOf(lines, 'reasoning_content')).toBe('Je pense donc je réponds.')
        expect(deltasOf(lines, 'content')).toBe('Réponse finale')
      },
    )
  })

  it('complétion : message.reasoning_content quand il y en a, absent sinon', async () => {
    await withServer(
      {
        streamPlan: [
          { kind: 'ok', snapshots: ['Réponse'], thoughts: ['Un raisonnement.'] },
          { kind: 'ok', snapshots: ['Réponse'] },
        ],
      },
      async ({ base }) => {
        const withThought = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'q1' }] }),
        })
        const a = (await withThought.json()) as any
        expect(a.choices[0].message.content).toBe('Réponse')
        expect(a.choices[0].message.reasoning_content).toBe('Un raisonnement.')

        const without = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'q2' }] }),
        })
        const b = (await without.json()) as any
        expect(b.choices[0].message.content).toBe('Réponse')
        expect(b.choices[0].message.reasoning_content).toBeUndefined()
      },
    )
  })

  it('chemin tools : la réflexion ne traverse pas le splitter — tool_calls intacts', async () => {
    const block = '{{tool {"name": "read", "arguments": {"path": "CONTEXT.md"}} }}'
    await withServer(
      {
        streamPlan: [
          { kind: 'ok', snapshots: ['Je lis la carte. ', 'Je lis la carte. ' + block], thoughts: ['Voyons le contexte.'] },
        ],
      },
      async ({ base }) => {
        const res = await fetch(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-3.6-flash',
            messages: [{ role: 'user', content: 'Lis la carte' }],
            stream: true,
            tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
          }),
        })
        const lines = await readSse(res)
        expect(deltasOf(lines, 'reasoning_content')).toBe('Voyons le contexte.')
        expect(deltasOf(lines, 'content')).toBe('Je lis la carte. ') // le bloc d'appel n'est pas du texte
        const calls = lines
          .filter((l) => l.startsWith('data: {'))
          .map((l) => JSON.parse(l.slice(6)))
          .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
        expect(calls).toHaveLength(1)
        expect(calls[0].function.name).toBe('read')
      },
    )
  })
})

describe('v1beta — la réflexion en parts thought:true (M12)', () => {
  it('streamGenerateContent ?alt=sse : parts avec thought', async () => {
    await withServer(
      { streamPlan: [{ kind: 'ok', snapshots: ['Réponse'], thoughts: ['Un instant.'] }] },
      async ({ base }) => {
        const res = await fetch(base + '/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }] }),
        })
        const lines = await readSse(res)
        const parts = lines
          .filter((l) => l.startsWith('data: {'))
          .map((l) => JSON.parse(l.slice(6)))
          .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
        expect(parts).toContainEqual({ text: 'Un instant.', thought: true })
        expect(parts).toContainEqual({ text: 'Réponse' })
      },
    )
  })

  it('generateContent : la part thought précède le texte', async () => {
    await withServer(
      { streamPlan: [{ kind: 'ok', snapshots: ['Réponse'], thoughts: ['Hmm.'] }] },
      async ({ base }) => {
        const res = await fetch(base + '/v1beta/models/gemini-3.6-flash:generateContent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Bonjour' }] }] }),
        })
        const body = (await res.json()) as any
        const parts = body.candidates[0].content.parts
        expect(parts[0]).toEqual({ text: 'Hmm.', thought: true })
        expect(parts[1]).toEqual({ text: 'Réponse' })
      },
    )
  })
})
