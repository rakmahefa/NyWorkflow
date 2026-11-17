// Maquette gemini-web2api pour les tests e2e et la capture README :
// OpenAI-compatible, SSE inclus, sans aucune dépendance.
import { createServer } from 'node:http'

// Réponse « réelle » quand on demande une présentation du projet.
const FIXED_REPLY =
  "NyWorkflow orchestre des workflows IA à partir de dossiers numérotés (méthode ICM). Chaque étape lit son CONTEXT.md, appelle le modèle via la passerelle, puis écrit son résultat dans output/."

function replyBody(lastUser) {
  const t = String(lastUser ?? '').toLowerCase()
  if (t.includes('nyworkflow') || t.includes('présente') || t.includes('presente')) {
    return FIXED_REPLY
  }
  return String(lastUser ?? '').slice(0, 80)
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/**
 * Starts the mock gateway on 127.0.0.1:<port>.
 * GET /v1/models, GET /v1beta/models, POST /v1/chat/completions (SSE).
 */
export function startMockGateway(port) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'

    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1beta/models')) {
      json(res, 200, { data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }] })
      return
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let parsed = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        const model = typeof parsed.model === 'string' ? parsed.model : 'unknown'
        const lastUser = [...(parsed.messages ?? [])]
          .reverse()
          .find((m) => m?.role === 'user')?.content
        const text = `Réponse (maquette) [${model}] : ${replyBody(lastUser)}`

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const third = Math.ceil(text.length / 3)
        const chunks = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)]
        let i = 0
        const tick = () => {
          if (res.destroyed) return
          if (i >= chunks.length) {
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
          setTimeout(tick, 30)
        }
        tick()
      })
      return
    }

    json(res, 404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
