import { describe, expect, it } from 'vitest'
import http, { type Server } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProxyEnv, shouldBypass, maskCredentials, upstreamFetch, loadTlsCa } from './proxy.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const CA_PEM = readFileSync(path.join(here, 'fixtures/ca.pem'), 'utf8')
const SERVER_CERT = readFileSync(path.join(here, 'fixtures/server-cert.pem'), 'utf8')
const SERVER_KEY = readFileSync(path.join(here, 'fixtures/server-key.pem'), 'utf8')

interface MockProxy {
  url: URL
  port: number
  connectHits: string[]
  requests: string[]
  close(): Promise<void>
}

/** Proxy HTTP de test : CONNECT (tunnel TCP brut) + URI absolue (http). */
async function startMockProxy(): Promise<MockProxy> {
  const connectHits: string[] = []
  const requests: string[] = []
  const sockets = new Set<net.Socket | Duplex>()
  const server: Server = http.createServer((req, res) => {
    // Requête http classique à travers le proxy : URI absolue.
    requests.push(`${req.method} ${req.url}`)
    if ((req.url ?? '').includes('/interdit')) {
      res.writeHead(403)
      res.end('refusé par le proxy')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`via-proxy:${req.method}:${req.url}`)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('connect', (req, clientSocket, head) => {
    connectHits.push(req.url ?? '?')
    sockets.add(clientSocket)
    clientSocket.on('close', () => sockets.delete(clientSocket))
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => clientSocket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    port,
    connectHits,
    requests,
    close: () => {
      // Les tunnels détachés (CONNECT) ne sont pas toujours détruits par
      // closeAllConnections : la maquette suit ses sockets et les rend elle-même.
      for (const s of sockets) s.destroy()
      return new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

/** Cible https de test (certificat signé par la CA de test). */
async function startTlsTarget(): Promise<{ port: number; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = []
  const server = https.createServer({ cert: SERVER_CERT, key: SERVER_KEY }, (req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if ((req.url ?? '').includes('flux')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partie-1 ')
      setTimeout(() => {
        res.write('partie-2')
        res.end()
      }, 30)
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`tls-ok:${req.method}:${req.url}:corps=${body}`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

describe('parseProxyEnv', () => {
  it('aucune variable : pas de proxy', () => {
    expect(parseProxyEnv({}).proxy).toBeUndefined()
  })

  it('NYW_WEBAPI_PROXY gagne sur HTTPS_PROXY', () => {
    const env = parseProxyEnv({ NYW_WEBAPI_PROXY: 'http://pw:8080', HTTPS_PROXY: 'http://hs:8443', HTTP_PROXY: 'http://hp:3128' })
    expect(env.proxy?.hostname).toBe('pw')
    expect(env.proxy?.port).toBe('8080')
  })

  it('cascade HTTPS_PROXY > HTTP_PROXY > ALL_PROXY (minuscules incluses)', () => {
    expect(parseProxyEnv({ HTTPS_PROXY: 'http://a:1' }).proxy?.hostname).toBe('a')
    expect(parseProxyEnv({ https_proxy: 'http://b:1' }).proxy?.hostname).toBe('b')
    expect(parseProxyEnv({ HTTP_PROXY: 'http://c:1' }).proxy?.hostname).toBe('c')
    expect(parseProxyEnv({ ALL_PROXY: 'http://d:1' }).proxy?.hostname).toBe('d')
  })

  it('URL invalide : ignorée sans exception', () => {
    expect(parseProxyEnv({ HTTPS_PROXY: '::::pas-une-url' }).proxy).toBeUndefined()
  })

  it('NO_PROXY parsé en liste', () => {
    expect(parseProxyEnv({ NO_PROXY: 'localhost, .google.com ,  ' }).noProxy).toEqual(['localhost', '.google.com'])
  })
})

describe('shouldBypass', () => {
  it('étoile = tout contourner', () => {
    expect(shouldBypass(new URL('https://gemini.google.com'), ['*'])).toBe(true)
  })

  it('correspondance exacte et suffixe de domaine', () => {
    expect(shouldBypass(new URL('https://localhost:8081'), ['localhost'])).toBe(true)
    expect(shouldBypass(new URL('https://gemini.google.com'), ['.google.com'])).toBe(true)
    expect(shouldBypass(new URL('https://google.com'), ['.google.com'])).toBe(true)
    expect(shouldBypass(new URL('https://evilgoogle.com'), ['.google.com'])).toBe(false)
    expect(shouldBypass(new URL('https://example.fr'), ['google.com'])).toBe(false)
  })
})

describe('maskCredentials', () => {
  it('masque user:pass, laisse le reste intact', () => {
    expect(maskCredentials(new URL('http://user:secret@proxy:3128'))).toBe('http://***@proxy:3128/')
    expect(maskCredentials(new URL('http://proxy:3128'))).toBe('http://proxy:3128/')
  })
})

describe('loadTlsCa', () => {
  it('chemin de fichier PEM → contenu', () => {
    const loaded = loadTlsCa(path.join(here, 'fixtures/ca.pem'))
    expect(loaded).toContain('-----BEGIN CERTIFICATE-----')
  })

  it('chaîne PEM inline → telle quelle ; vide/absent → undefined', () => {
    expect(loadTlsCa('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----')).toContain('BEGIN')
    expect(loadTlsCa(undefined)).toBeUndefined()
    expect(loadTlsCa('   ')).toBeUndefined()
    expect(loadTlsCa('/chemin/inexistant.pem')).toBeUndefined()
  })
})

describe('upstreamFetch — sans proxy', () => {
  it('fetch natif : statut, corps, flux', async () => {
    const res = await upstreamFetch('data:text/plain,ok', {}, {})
    // data: URL — fetch natif le gère, preuve du passage direct.
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('upstreamFetch — cible http à travers le proxy', () => {
  it('URI absolue, en-têtes et corps transportés', async () => {
    const proxy = await startMockProxy()
    try {
      const res = await upstreamFetch(
        `http://cible-http.example/chemin?q=1`,
        { method: 'POST', headers: { 'x-test': 'oui' }, body: 'corps-test' },
        { proxy: proxy.url },
      )
      expect(proxy.requests).toEqual(['POST http://cible-http.example/chemin?q=1'])
      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('via-proxy:POST:http://cible-http.example/chemin?q=1')
    } finally {
      await proxy.close()
    }
  })

  it('erreur HTTP du proxy : statut visible, pas d’exception', async () => {
    const proxy = await startMockProxy()
    try {
      const res = await upstreamFetch(`http://x.example/interdit`, {}, { proxy: proxy.url })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(await res.text()).toContain('refusé')
    } finally {
      await proxy.close()
    }
  })
})

describe('upstreamFetch — cible https à travers CONNECT + TLS', () => {
  it('tunnel, handshake TLS (CA de test), requête et réponse', async () => {
    const proxy = await startMockProxy()
    const target = await startTlsTarget()
    try {
      const res = await upstreamFetch(
        `https://localhost:${target.port}/api/essai`,
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'bonjour' },
        { proxy: proxy.url, tlsCa: CA_PEM },
      )
      expect(proxy.connectHits).toEqual([`localhost:${target.port}`])
      expect(target.hits).toEqual(['POST /api/essai'])
      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('tls-ok:POST:/api/essai:corps=bonjour')
    } finally {
      await target.close()
      await proxy.close()
    }
  })

  it('réponse en deux temps : le flux traverse le tunnel par morceaux', async () => {
    const proxy = await startMockProxy()
    const target = await startTlsTarget()
    try {
      const res = await upstreamFetch(`https://localhost:${target.port}/flux`, {}, { proxy: proxy.url, tlsCa: CA_PEM })
      expect(res.ok).toBe(true)
      const morceaux: string[] = []
      const decoder = new TextDecoder()
      for await (const chunk of res.body) morceaux.push(decoder.decode(chunk, { stream: true }))
      expect(morceaux.length).toBeGreaterThanOrEqual(2)
      expect(morceaux.join('')).toBe('partie-1 partie-2')
    } finally {
      await target.close()
      await proxy.close()
    }
  })

  it('CA absente : le handshake échoue proprement (erreur réseau)', async () => {
    const proxy = await startMockProxy()
    const target = await startTlsTarget()
    try {
      await expect(
        upstreamFetch(`https://localhost:${target.port}/api/x`, {}, { proxy: proxy.url }),
      ).rejects.toThrow()
    } finally {
      await target.close()
      await proxy.close()
    }
  })
})

describe('upstreamFetch — NO_PROXY', () => {
  it('hôte contourné : fetch natif (aucune requête au proxy)', async () => {
    const proxy = await startMockProxy()
    try {
      // data: n'est ni http ni https — le bypass laisse fetch natif agir.
      const res = await upstreamFetch('data:text/plain,direct', {}, { proxy: proxy.url, noProxy: ['*'] })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('direct')
      expect(proxy.requests).toEqual([])
      expect(proxy.connectHits).toEqual([])
    } finally {
      await proxy.close()
    }
  })
})
