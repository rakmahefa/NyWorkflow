import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterError, createWeb2ApiClient } from './adapter'

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

const live: TestServer[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.close()))
})
const track = (s: TestServer): TestServer => {
  live.push(s)
  return s
}

/** Collects all tokens from an async iterable OR a raw iterator (mid-abort test). */
async function collect(source: AsyncIterable<string> | AsyncIterator<string>): Promise<string[]> {
  const out: string[] = []
  const asIterable = source as AsyncIterable<string>
  const iter: AsyncIterator<string> =
    typeof asIterable[Symbol.asyncIterator] === 'function'
      ? asIterable[Symbol.asyncIterator]()
      : (source as AsyncIterator<string>)
  for (;;) {
    const r = await iter.next()
    if (r.done) break
    out.push(r.value)
  }
  return out
}

describe('createWeb2ApiClient — listModels', () => {
  it('renvoie les ids depuis /v1/models', async () => {
    const s = track(
      await startServer((req, res) => {
        if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }] })
        json(res, 404, {})
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(s.requests.map((r) => r.url)).toEqual(['/v1/models'])
  })

  it('retombe sur /v1beta/models quand /v1/models répond 404', async () => {
    const s = track(
      await startServer((req, res) => {
        if (req.url === '/v1beta/models') return json(res, 200, { data: [{ id: 'gemini-2.5-pro' }] })
        json(res, 404, {})
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['gemini-2.5-pro'])
    expect(s.requests.map((r) => r.url)).toEqual(['/v1/models', '/v1beta/models'])
  })

  it('signale une passerelle injoignable (port fermé)', async () => {
    const client = createWeb2ApiClient({ baseUrl: 'http://127.0.0.1:9' })
    try {
      await client.listModels()
      expect.unreachable('listModels devait rejeter')
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError)
      const err = e as AdapterError
      expect(err.kind).toBe('unreachable')
      expect(err.message).toContain('127.0.0.1:9')
    }
  })

  it('remonte une erreur HTTP avec le statut', async () => {
    const s = track(await startServer((req, res) => json(res, 500, { error: 'boom' })))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    try {
      await client.listModels()
      expect.unreachable('listModels devait rejeter')
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError)
      const err = e as AdapterError
      expect(err.kind).toBe('http')
      expect(err.status).toBe(500)
      expect(err.message).toContain('HTTP 500')
    }
  })

  it('rejette une réponse inattendue (bad-shape)', async () => {
    const s = track(await startServer((req, res) => json(res, 200, { foo: 1 })))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    try {
      await client.listModels()
      expect.unreachable('listModels devait rejeter')
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError)
      expect((e as AdapterError).kind).toBe('bad-shape')
    }
  })

  it('accepte une liste à la racine (tableau)', async () => {
    const s = track(await startServer((req, res) => json(res, 200, [{ id: 'a' }, { id: 'b' }])))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await client.listModels()).toEqual(['a', 'b'])
  })
})

describe('createWeb2ApiClient — chatStream', () => {
  it('streame les tokens delta, ignore les chunks vides et les lignes parasites', async () => {
    const s = track(
      await startServer((req, res) => {
        sse(res)
        res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n')
        res.write(': keep-alive\nevent: x\n\n')
        res.write('data: {"choices":[{"delta":{"content":"Bon') // ligne coupée en deux writes
        setTimeout(() => {
          if (res.destroyed) return
          res.write('jour"}}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        }, 30)
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    // Un seul token : la ligne coupée en deux writes est réassemblée en un événement.
    expect(await collect(client.chatStream({ model: 'm', messages: [] }))).toEqual(['Bonjour'])
    expect(s.requests[0]?.body).toContain('"stream":true')
  })

  it('retombe sur message.content quand delta est absent', async () => {
    const s = track(
      await startServer((req, res) => {
        sse(res)
        res.write('data: {"choices":[{"message":{"content":"Sal"}}]}\n\n')
        res.write('data: {"choices":[{"message":{"content":"ut"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      }),
    )
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    expect(await collect(client.chatStream({ model: 'm', messages: [] }))).toEqual(['Sal', 'ut'])
  })

  it('HTTP non-200 → AdapterError http avec statut', async () => {
    const s = track(await startServer((req, res) => json(res, 404, { error: 'nope' })))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    try {
      await collect(client.chatStream({ model: 'm', messages: [] }))
      expect.unreachable('chatStream devait rejeter')
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError)
      const err = e as AdapterError
      expect(err.kind).toBe('http')
      expect(err.status).toBe(404)
    }
  })

  it('signal déjà interrompu : aucune requête, aucun token', async () => {
    const s = track(await startServer((req, res) => json(res, 404, {})))
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    const controller = new AbortController()
    controller.abort()
    expect(await collect(client.chatStream({ model: 'm', messages: [], signal: controller.signal }))).toEqual([])
    expect(s.requests).toEqual([])
  })

  it('interruption en cours de flux : seul le premier token est rendu', async () => {
    const s = track(
      await startServer((req, res) => {
        sse(res)
        res.write('data: {"choices":[{"delta":{"content":"un"}}]}\n\n')
        setTimeout(() => {
          if (res.destroyed) return
          res.write('data: {"choices":[{"delta":{"content":"deux"}}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        }, 250)
      }),
    )
    const controller = new AbortController()
    const client = createWeb2ApiClient({ baseUrl: s.baseUrl })
    // Un générateur async est aussi un itérateur ; l'interface publique n'expose que l'itérable.
    const iterator = client.chatStream({ model: 'm', messages: [], signal: controller.signal }) as unknown as AsyncIterator<string>
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe('un')
    controller.abort()
    const rest = await collect(iterator)
    expect(rest).toEqual([])
  })
})
