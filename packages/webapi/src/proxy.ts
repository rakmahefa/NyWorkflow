/**
 * Proxy sortant — la pièce qui manquait pour les réseaux d'entreprise.
 *
 * Sources de configuration (la première gagne) :
 *   NYW_WEBAPI_PROXY  >  HTTPS_PROXY/https_proxy  >  HTTP_PROXY/http_proxy
 *   >  ALL_PROXY/all_proxy   (+ NO_PROXY/no_proxy : liste à ignorer)
 *
 * Zéro dépendance : les cibles http passent par le proxy en URI absolue, les
 * cibles https par un tunnel CONNECT + TLS maison (node:tls). NYW_WEBAPI_TLS_CA
 * ajoute un CA (fichier PEM ou chaîne inline) — indispensable derrière un
 * proxy qui rechiffre (MITM d'entreprise).
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'

export interface ProxyEnv {
  proxy?: URL
  noProxy: string[]
}

/** Lit la config proxy de l'environnement — NYW_WEBAPI_PROXY gagne sur tout. */
export function parseProxyEnv(env: Record<string, string | undefined> = process.env): ProxyEnv {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  const raw =
    env.NYW_WEBAPI_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim() ||
    ''
  if (raw.length === 0) return { noProxy }
  try {
    return { proxy: new URL(raw), noProxy }
  } catch {
    return { noProxy }
  }
}

/** NO_PROXY : « * » = tout ; sinon domaine nu ou n'importe quel sous-domaine. */
export function shouldBypass(target: URL, noProxy: string[]): boolean {
  if (noProxy.includes('*')) return true
  const host = target.hostname.toLowerCase()
  return noProxy.some((raw) => {
    const entry = raw.replace(/^\./, '')
    return host === entry || host.endsWith(`.${entry}`)
  })
}

/** URL de proxy pour le diagnostic — identifiants masqués, jamais exposés. */
export function maskCredentials(url: URL): string {
  if (url.username === '' && url.password === '') return url.toString()
  const masked = new URL(url.toString())
  masked.username = '***'
  masked.password = ''
  return masked.toString()
}

export interface UpstreamResponse {
  ok: boolean
  status: number
  body: AsyncIterable<Uint8Array>
  text(): Promise<string>
}

export interface UpstreamInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface UpstreamOptions {
  proxy?: URL
  noProxy?: string[]
  /** CA additionnel (PEM) pour le TLS au travers d'un proxy qui rechiffre. */
  tlsCa?: string
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (proxy.username === '' && proxy.password === '') return {}
  const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  return { 'proxy-authorization': `Basic ${token}` }
}

function toUpstreamResponse(res: http.IncomingMessage): UpstreamResponse {
  return {
    ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
    status: res.statusCode ?? 0,
    body: res as unknown as AsyncIterable<Uint8Array>,
    text: () =>
      new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = []
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
        res.on('error', reject)
      }),
  }
}

/** Ouvre un tunnel CONNECT à travers le proxy → socket brut vers la cible. */
function connectThroughProxy(proxy: URL, host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...proxyAuthorization(proxy) },
      ...(signal ? { signal } : {}),
    })
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`le proxy a refusé le tunnel CONNECT (HTTP ${res.statusCode ?? '?'})`))
        return
      }
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

/** https à travers le tunnel : CONNECT → TLS → requête sur le socket sécurisé. */
async function tunneledFetch(target: URL, init: UpstreamInit, proxy: URL, tlsCa?: string): Promise<UpstreamResponse> {
  const port = target.port ? Number(target.port) : 443
  const socket = await connectThroughProxy(proxy, target.hostname, port, init.signal)
  const secure = tls.connect({
    socket,
    servername: target.hostname,
    ...(tlsCa ? { ca: tlsCa } : {}),
  })
  // Capturer tôt : une erreur de handshake ne doit jamais rester non écoutée.
  secure.on('error', () => {
    /* propagée à la requête via le socket */
  })
  const teardown = (): void => {
    // Le tunnel est jetable : la réponse close → on rend les sockets, sinon
    // chaque requête laisse un tunnel ouvert derrière elle.
    secure.destroy()
    socket.destroy()
  }
  return new Promise<UpstreamResponse>((resolve, reject) => {
    const req = https.request(
      {
        // PAS d'option agent : createConnection n'est honorée que si agent
        // reste indéfini (agent: false crée un agent qui la contourne).
        createConnection: () => secure,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { ...init.headers, host: target.host },
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        // Jetable : dès que le message est consommé (end) ou clos, on rend
        // les sockets — chaque requête laisse sinon un tunnel ouvert derrière
        // elle (la propagation TLS close_notify à travers les pipes du proxy
        // n'est pas garantie).
        res.on('end', teardown)
        res.on('close', teardown)
        resolve(toUpstreamResponse(res))
      },
    )
    req.on('error', (err) => {
      teardown()
      reject(err)
    })
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** http à travers le proxy : URI absolue, pas de tunnel. */
function plainFetchViaProxy(target: URL, init: UpstreamInit, proxy: URL): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: proxy.port ? Number(proxy.port) : 80,
        method: init.method ?? 'GET',
        path: target.href,
        headers: { ...init.headers, host: target.host, ...proxyAuthorization(proxy) },
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => resolve(toUpstreamResponse(res)),
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/**
 * Fetch amont unifié : proxy si configuré (et non contourné), fetch natif
 * sinon. Même forme de réponse dans les trois cas.
 */
export async function upstreamFetch(url: string, init: UpstreamInit, options: UpstreamOptions = {}): Promise<UpstreamResponse> {
  const target = new URL(url)
  if (options.proxy !== undefined && !shouldBypass(target, options.noProxy ?? [])) {
    const proxy = options.proxy
    if (target.protocol === 'https:') return tunneledFetch(target, init, proxy, options.tlsCa)
    return plainFetchViaProxy(target, init, proxy)
  }
  const res = await fetch(target, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
  })
  return {
    ok: res.ok,
    status: res.status,
    body: (res.body ?? emptyBody()) as AsyncIterable<Uint8Array>,
    text: () => res.text(),
  }
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* () {
    /* corps vide */
  })()
}

/** Charge NYW_WEBAPI_TLS_CA : chemin de fichier PEM ou chaîne PEM inline. */
export function loadTlsCa(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (value.includes('-----BEGIN')) return value
  try {
    return readFileSync(value, 'utf8')
  } catch {
    return undefined
  }
}
