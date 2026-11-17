/**
 * Maquette HTTP de l'interface web Gemini — le pendant testable de
 * gemini.google.com. Sert :
 *
 *   GET  /app            → HTML contenant les jetons de page (SNlM0e, qKIAYe,
 *                          Ylro7b) ET le bl à découvrir ; le jeton `at` change
 *                          à chaque GET — un refresh se voit dans les requêtes.
 *   POST …/StreamGenerate → flux de frames wrb.fr, scriptable par test
 *                          (statuts successifs, snapshots, frames brutes,
 *                          blocages, délais).
 *
 * Enregistre chaque requête : headers, corps, fermeture de connexion — les
 * tests prouvent le protocole (SAPISIDHASH, f.req, at) sans aucun réseau.
 */
import http, { type Server } from 'node:http'

export interface MockStreamStep {
  /** 200 : diffuser des frames. Autre statut : échec HTTP sec. */
  kind: 'ok' | 'status'
  status?: number
  /** Snapshots texte complets — un par frame wrb.fr (deltas reconstruits par le client). */
  snapshots?: string[]
  /** M12 — snapshots de réflexion, parallèles aux snapshots (même longueur recommandée). */
  thoughts?: string[]
  /** Lignes brutes envoyées telles quelles (cas exotiques : inner invalide, métadonnées). */
  rawLines?: string[]
  /** Délai entre les écritures, ms. */
  delayMs?: number
  /** Ne termine jamais la réponse (test d'annulation). */
  hang?: boolean
}

export interface MockGeminiOptions {
  /** Réponses successives du POST StreamGenerate ; au-delà, la dernière est rejouée. */
  streamPlan?: MockStreamStep[]
  /** Statut du GET /app (défaut 200). */
  pageStatus?: number
  /** HTML de page personnalisé (défaut : page standard, at tournant). */
  pageHtml?: string
}

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
  at: number
  /** La connexion client a été coupée avant la fin de la réponse. */
  closed: boolean
}

export interface MockGemini {
  baseUrl: string
  port: number
  requests: RecordedRequest[]
  pageHits(): number
  streamPosts(): RecordedRequest[]
  close(): Promise<void>
}

export const STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'

export const DISCOVERED_BL = 'boq_assistant-bard-web-server_20261101.07_p3'

/** Frame wrb.fr portant un snapshot texte (inner[4] candidats) — avec la
 * réflexion du candidat à [37][0][0] quand elle est donnée (M12). */
export function textFrame(snapshot: string, thought?: string): string {
  const candidate: unknown[] = ['c', [snapshot]]
  if (thought !== undefined) {
    // [37] = [[thought]] — la case où vit la réflexion (vérité amont).
    candidate[37] = [[thought]]
  }
  const inner = JSON.stringify([null, ['tok'], 'padding'.repeat(12), [], [candidate], [], [], []])
  return JSON.stringify([['wrb.fr', [62, 0], inner], ['di', 72]])
}

function defaultPageHtml(hit: number): string {
  return (
    '<!DOCTYPE html><html><head><script>' +
    `"SNlM0e":"at-${hit}","qKIAYe":"push-${hit}","Ylro7b":"pctx-${hit}",` +
    `"cf.b2l":"${DISCOVERED_BL}",other:"data"` +
    '</script></head><body></body></html>'
  )
}

export async function startMockGemini(options: MockGeminiOptions = {}): Promise<MockGemini> {
  const requests: RecordedRequest[] = []
  const plan = options.streamPlan ?? [{ kind: 'ok', snapshots: ['Bonjour, ', 'Bonjour, le monde'] }]
  let pageHits = 0

  const server: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const record: RecordedRequest = {
        method: req.method ?? '?',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: Date.now(),
        closed: false,
      }
      requests.push(record)

      if (req.method === 'GET' && (req.url === '/app' || req.url?.startsWith('/u/') === true && req.url.endsWith('/app'))) {
        pageHits++
        const status = options.pageStatus ?? 200
        if (status !== 200) {
          res.writeHead(status)
          res.end('page error')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(options.pageHtml ?? defaultPageHtml(pageHits))
        return
      }

      if (req.method === 'POST' && (req.url ?? '').includes('StreamGenerate')) {
        const step = plan[Math.min(requests.filter((r) => r.method === 'POST').length - 1, plan.length - 1)] ?? plan[plan.length - 1]
        if (!step) {
          res.writeHead(500)
          res.end()
          return
        }
        if (step.kind === 'status') {
          res.writeHead(step.status ?? 500)
          res.end('upstream error')
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        // « close » sur la RÉPONSE (pas la requête) : req.on('close') se déclenche
        // dès que le corps est consommé — pas quand la connexion tombe.
        res.on('close', () => {
          record.closed = !res.writableEnded
        })
        void (async () => {
          try {
            res.write(")]}'\n")
            const lines =
              step.rawLines ??
              (step.snapshots ?? []).map((text, i) => textFrame(text, step.thoughts?.[i]))
            for (const line of lines) {
              if (step.delayMs && step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs))
              if (record.closed) return
              res.write(line + '\n')
            }
            if (step.hang) return // la réponse reste ouverte — test d'annulation
            res.end()
          } catch {
            // client parti au milieu d’une écriture — rien à faire
          }
        })()
        return
      }

      res.writeHead(404)
      res.end('not found')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    pageHits: () => pageHits,
    streamPosts: () => requests.filter((r) => r.method === 'POST'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Décode un corps POST urlencodé → { f.req parsé, at? } — l'outil de lecture des tests. */
export function parseStreamBody(body: string): { freq: unknown[]; inner: unknown[]; at?: string } {
  const params = new URLSearchParams(body)
  const freqRaw = params.get('f.req')
  if (freqRaw === null) throw new Error('f.req absent du corps')
  const freq = JSON.parse(freqRaw) as unknown[]
  const inner = JSON.parse(String(freq[1])) as unknown[]
  const at = params.get('at') ?? undefined
  return { freq, inner, at }
}
