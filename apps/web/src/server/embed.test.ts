import { describe, expect, it } from 'vitest'
import net from 'node:net'
import { startMockGemini } from '@nyworkflow/webapi/src/mock-gemini.ts'
import { startEmbeddedGateway } from './embed.ts'

/** Port libre éphémère : on en réserve un, on le libère, on le réutilise. */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Serveur qui occupe un port (simule une passerelle externe déjà lancée). */
async function occupyPort(port: number): Promise<net.Server> {
  const srv = net.createServer()
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', resolve))
  return srv
}

describe('startEmbeddedGateway — règles d\'engagement', () => {
  it('sous Vitest sans option : pas d\'intégration (reason tests)', async () => {
    const gw = await startEmbeddedGateway({ env: { VITEST: '1' } })
    expect(gw.embedded).toBe(false)
    expect(gw.reason).toBe('tests')
    await gw.close()
  })

  it('NYW_WEBAPI_EMBED=0 : désactivée explicitement', async () => {
    const gw = await startEmbeddedGateway({ embedGateway: true, env: { NYW_WEBAPI_EMBED: '0' } })
    expect(gw.embedded).toBe(false)
    expect(gw.reason).toBe('disabled')
  })

  it('W2A_URL défini : cible externe respectée (pas d\'intégration)', async () => {
    const gw = await startEmbeddedGateway({ embedGateway: true, env: { W2A_URL: 'http://127.0.0.1:9801' } })
    expect(gw.embedded).toBe(false)
    expect(gw.reason).toBe('external-target')
  })

  it('port occupé : une passerelle externe est utilisée telle quelle', async () => {
    const port = await freePort()
    const blocker = await occupyPort(port)
    try {
      const gw = await startEmbeddedGateway({
        embedGateway: true,
        env: { NYW_WEBAPI_PORT: String(port), NYW_WEBAPI_EMBED: '1' },
      })
      expect(gw.embedded).toBe(false)
      expect(gw.reason).toBe('busy')
      await gw.close()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('cas nominal : passerelle intégrée qui répond en OpenAI-compatible (maquette amont)', async () => {
    const port = await freePort()
    const mock = await startMockGemini()
    const gw = await startEmbeddedGateway({
      embedGateway: true,
      env: {
        NYW_WEBAPI_PORT: String(port),
        NYW_WEBAPI_EMBED: '1',
        NYW_WEBAPI_GEMINI_BASE_URL: mock.baseUrl,
        NYW_WEBAPI_RETRY_ATTEMPTS: '1',
      },
    })
    expect(gw.embedded).toBe(true)
    try {
      // GET / : diagnostic (statut, modèles, cookies absents — sans réseau).
      const root = await fetch(`http://127.0.0.1:${port}/`)
      expect(root.status).toBe(200)
      const body = (await root.json()) as { status: string; provider: string; gateway: { cookies: boolean } }
      expect(body.status).toBe('ok')
      expect(body.provider).toBe('gemini')
      expect(body.gateway.cookies).toBe(false) // pas de cookies dans l'env du test

      // GET /v1/models : la table data-driven, sans réseau.
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`)
      expect(models.status).toBe(200)
      const list = (await models.json()) as { data: { id: string }[] }
      expect(list.data.length).toBeGreaterThanOrEqual(8)

      // POST /v1/chat/completions en streaming : la chaîne complète intégrée,
      // de l'API publique jusqu'à la maquette Gemini — réelle, pas simulée.
      const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'salut' }], stream: true }),
      })
      expect(chat.status).toBe(200)
      expect(String(chat.headers.get('content-type'))).toContain('text/event-stream')
      const lines: string[] = []
      let buf = ''
      const decoder = new TextDecoder()
      for await (const chunk of chat.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          nl = buf.indexOf('\n')
          if (line.startsWith('data:')) lines.push(line.slice(5).trim())
          if (line === 'data: [DONE]') break
        }
      }
      expect(lines.at(-1)).toBe('[DONE]')
      const text = lines
        .slice(0, -1)
        .map((l) => JSON.parse(l) as { choices?: { delta?: { content?: string } }[] })
        .map((c) => c.choices?.[0]?.delta?.content ?? '')
        .join('')
      expect(text).toBe('Bonjour, le monde')
    } finally {
      await gw.close()
      await mock.close()
    }
  })
})
