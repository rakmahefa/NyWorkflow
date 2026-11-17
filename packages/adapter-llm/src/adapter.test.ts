import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterError, createWeb2ApiClient } from './adapter'
import type { ChatStreamEvent } from './index'

interface TestServer {
  baseUrl: string
  close(): Promise<void>
  requests: { method: string; url: string; body: string }[]
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<TestServer> {
  const requests: TestServer['requests'] = []
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body })
        handler(req, res, body)
      })
    } else {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: '' })
      handler(req, res, '')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requests,
      })
    })
  })
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function sse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
}

const sseChunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const live: TestServer[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.close()))
})
const track = (s: TestServer): TestServer => {
  live.push(s)
  return s
}

/** Collects every event of a chatStream. */
async function collectEvents(source: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

/** Joins the text deltas of collected events. */
const textOf = (events: readonly ChatStreamEvent[]): string =>
  events.filter((e): e is Extract<ChatStreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('')

describe('createWeb2ApiClient — v1beta par défaut (M11)', () => {
  it('apiVersion : v1beta par défaut, exposé par le client', async () => {
    const s = track(await startServer(() => {}))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(client.apiVersion).toBe('v1beta')
  })

  it('apiVersion configurable (v1 aujourd’hui, v2 demain)', async () => {
    const s = track(
      await startServer((req, res) => {
        if (req.url === '/v2/models') return json(res, 200, { data: [{ id: 'gemini-3' }] })
        json(res, 404, {})
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl, apiVersion: 'v2' })
    expect(await client.listModels()).toEqual(['gemini-3'])
    expect(s.requests[0]?.url).toBe('/v2/models')
  })

  it('listModels : forme Google sur /v1beta/models (préfixe models/ retiré)', async () => {
    const s = track(
      await startServer((req, res) => {
        expect(req.url).toBe('/v1beta/models')
        json(res, 200, {
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-pro' },
          ],
        })
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
  })

  it('listModels : retombe sur /v1/models (forme OpenAI) quand v1beta est absent', async () => {
    const s = track(
      await startServer((req, res) => {
        if (req.url === '/v1beta/models') return json(res, 404, { error: 'not found' })
        if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] })
        json(res, 404, {})
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['gpt-x', 'gpt-y'])
    expect(s.requests.map((r) => r.url)).toEqual(['/v1beta/models', '/v1/models'])
  })

  it('listModels : tolère une liste à la racine (tableau)', async () => {
    const s = track(
      await startServer((req, res) => {
        json(res, 200, [{ id: 'a' }, { name: 'models/b' }])
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['a', 'b'])
  })

  it('signale une passerelle injoignable (port fermé)', async () => {
    const client = createWeb2ApiClient({ baseUrl: 'http://127.0.0.1:1' })
    await expect(client.listModels()).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('remonte une erreur HTTP avec le statut', async () => {
    const s = track(
      await startServer((req, res) => {
        json(res, 500, { error: { message: 'boom' } })
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await expect(client.listModels()).rejects.toMatchObject({ kind: 'http', status: 500 })
  })
})

describe('createWeb2ApiClient — chatStream (flux de texte)', () => {
  it('POST sur /v1beta/chat/completions par défaut, événements texte + finish', async () => {
    const s = track(
      await startServer((req, res) => {
        expect(req.url).toBe('/v1beta/chat/completions')
        sse(res)
        res.write(sseChunk({}))
        res.write(sseChunk({ content: 'Bon' }))
        res.write(sseChunk({ content: 'jour' }))
        res.write(sseChunk({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'm', messages: [{ role: 'user', content: 'salut' }] }))
    expect(textOf(events)).toBe('Bonjour')
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
  })

  it('retombe sur message.content quand delta est absent', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, message: { content: "D'un bloc" } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'm', messages: [] }))
    expect(textOf(events)).toBe("D'un bloc")
  })

  it('HTTP non-200 → AdapterError http avec statut', async () => {
    const s = track(
      await startServer((_req, res) => {
        json(res, 400, { error: { message: 'Unknown model: x' } })
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await expect(
      collectEvents(client.chatStream({ model: 'x', messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toMatchObject({ kind: 'http', status: 400 })
  })

  it('chunk d’erreur amont → AdapterError, jamais un stop déguisé', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ content: 'partiel' }))
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'error' }], error: { message: 'Cookies expirés' } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await expect(
      collectEvents(client.chatStream({ model: 'm', messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toMatchObject({ kind: 'http', message: expect.stringContaining('Cookies expirés') })
  })

  it('signal déjà interrompu : aucune requête', async () => {
    const s = track(await startServer(() => {}))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const controller = new AbortController()
    controller.abort()
    const events = await collectEvents(
      client.chatStream({ model: 'm', messages: [], signal: controller.signal }),
    )
    expect(events).toEqual([])
    expect(s.requests).toHaveLength(0)
  })
})

describe('createWeb2ApiClient — tool_calls (M11)', () => {
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'read',
        description: 'Lire un fichier',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ]

  it('les tools passent dans la requête (tool_choice auto par défaut)', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ content: 'ok' }, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await collectEvents(client.chatStream({ model: 'm', messages: [], tools }))
    const sent = JSON.parse(s.requests[0]?.body ?? '{}') as { tools?: unknown; tool_choice?: unknown }
    expect(sent.tools).toEqual(tools)
    expect(sent.tool_choice).toBe('auto')
  })

  it('sans tools : ni tools ni tool_choice dans le corps', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ content: 'ok' }, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await collectEvents(client.chatStream({ model: 'm', messages: [] }))
    const sent = JSON.parse(s.requests[0]?.body ?? '{}') as { tools?: unknown; tool_choice?: unknown }
    expect(sent.tools).toBeUndefined()
    expect(sent.tool_choice).toBeUndefined()
  })

  it('un appel d’outil en un chunk (forme passerelle) → événement tool_calls + finish', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(
          sseChunk({
            tool_calls: [
              {
                index: 0,
                id: 'call-abc',
                type: 'function',
                function: { name: 'read', arguments: '{"path":"CONTEXT.md"}' },
              },
            ],
          }),
        )
        res.write(sseChunk({}, 'tool_calls'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'm', messages: [], tools }))
    expect(events).toContainEqual({
      type: 'tool_calls',
      calls: [{ id: 'call-abc', type: 'function', function: { name: 'read', arguments: '{"path":"CONTEXT.md"}' } }],
    })
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  it('arguments fragmentés sur plusieurs chunks (forme OpenAI) → réassemblés dans l’ordre', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"a' } }] }))
        res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: '.md","content":"h' } }] }))
        res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: 'ello"}' } }] }))
        res.write(sseChunk({}, 'tool_calls'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'm', messages: [], tools }))
    const call = events.find((e): e is Extract<ChatStreamEvent, { type: 'tool_calls' }> => e.type === 'tool_calls')
    expect(call?.calls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'write', arguments: '{"path":"a.md","content":"hello"}' } },
    ])
  })

  it('plusieurs appels (index distincts) → réassemblés par index, texte autour préservé', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ content: 'Je lis puis je cherche.' }))
        res.write(sseChunk({ tool_calls: [{ index: 1, id: 'call-b', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.md"}' } }] }))
        res.write(sseChunk({ tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read', arguments: '{}' } }] }))
        res.write(sseChunk({}, 'tool_calls'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'm', messages: [], tools }))
    expect(textOf(events)).toBe('Je lis puis je cherche.')
    const call = events.find((e): e is Extract<ChatStreamEvent, { type: 'tool_calls' }> => e.type === 'tool_calls')
    expect(call?.calls.map((c) => c.id)).toEqual(['call-a', 'call-b']) // ordre par index
  })

  it('les messages role:"tool" passent tels quels dans le corps (round-trip)', async () => {
    const s = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ content: 'fini' }, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    await collectEvents(
      client.chatStream({
        model: 'm',
        messages: [
          { role: 'user', content: 'lis' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
          { role: 'tool', content: '{"ok":true,"result":{"content":"carte"}}', tool_call_id: 'call-1' },
        ],
        tools,
      }),
    )
    const sent = JSON.parse(s.requests[0]?.body ?? '{}') as { messages?: { role: string; tool_call_id?: string }[] }
    expect(sent.messages?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(sent.messages?.[2]?.tool_call_id).toBe('call-1')
  })
})

describe('createWeb2ApiClient — thinking (M12)', () => {
  it('delta.reasoning_content → événements thinking, avant le texte', async () => {
    const server = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ reasoning_content: 'Je pense' }))
        res.write(sseChunk({ reasoning_content: ' donc je réponds.' }))
        res.write(sseChunk({ content: 'Réponse' }))
        res.write(sseChunk({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: server.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'q' }] }))
    const thinking = events.filter((e): e is Extract<ChatStreamEvent, { type: 'thinking' }> => e.type === 'thinking').map((e) => e.delta).join('')
    expect(thinking).toBe('Je pense donc je réponds.')
    expect(textOf(events)).toBe('Réponse')
    expect(events[0]?.type).toBe('thinking') // la réflexion précède le texte
  })

  it('thinking + tool_calls ensemble : les deux canaux préservés', async () => {
    const server = track(
      await startServer((_req, res) => {
        sse(res)
        res.write(sseChunk({ reasoning_content: 'Voyons.' }))
        res.write(
          sseChunk({
            tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"CONTEXT.md"}' } }],
          }),
        )
        res.write(sseChunk({}, 'tool_calls'))
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: server.baseUrl })
    const events = await collectEvents(client.chatStream({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'q' }] }))
    expect(events.some((e) => e.type === 'thinking')).toBe(true)
    const calls = events.find((e) => e.type === 'tool_calls')
    expect(calls).toMatchObject({ type: 'tool_calls', calls: [{ function: { name: 'read' } }] })
  })
})
