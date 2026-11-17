import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M3 delivery proof, over the REAL app config (vite.config.ts): drive the
 * /sessions API over HTTP, restart the dev server, and check that every
 * session comes back intact — ids, titles, messages, forks.
 */

interface TestSession {
  id: string
  title: string
  createdAt: number
  forkedFrom?: string
  messages: { role: 'user' | 'assistant'; text: string; at: number }[]
}

let server: ViteDevServer | undefined
let home = ''
const prevEnv = process.env.NYW_HOME

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-persistence-'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env.NYW_HOME
  else process.env.NYW_HOME = prevEnv
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function boot(): Promise<string> {
  process.env.NYW_HOME = home
  server = await createViteServer({
    configFile: join(import.meta.dirname, '../../vite.config.ts'),
    server: { port: 0, strictPort: false },
  })
  await server.listen()
  const port = (server.httpServer?.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

async function stop(): Promise<void> {
  await server?.close()
  server = undefined
}

async function api(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return { status: res.status, body: await res.json() }
}

it(
  'création → échange → fork → redémarrage : sessions intactes',
  { timeout: 120_000 },
  async () => {
    const a = await boot()

    // État initial : vide.
    const empty = await api(a, '/sessions')
    expect(empty.status).toBe(200)
    expect(empty.body.sessions).toEqual([])

    // Création avec titre (trim appliqué).
    const created = await api(a, '/sessions', { method: 'POST', body: JSON.stringify({ title: ' Rapport Q3 ' }) })
    expect(created.status).toBe(201)
    expect(created.body.title).toBe('Rapport Q3')
    const id: string = created.body.id
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/)

    // Sans titre : repli numéroté côté serveur.
    const second = await api(a, '/sessions', { method: 'POST', body: '{}' })
    expect(second.status).toBe(201)
    expect(second.body.title).toBe('Session 2')

    // Échange journalisé (user puis assistant).
    const ask = await api(a, `/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'user.message', text: 'Présente le projet' }),
    })
    expect(ask.status).toBe(201)
    const answer = await api(a, `/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'assistant.message', text: 'NyWorkflow orchestre des dossiers numérotés.' }),
    })
    expect(answer.status).toBe(201)

    // Refus prévisibles : type hors périmètre, id invalide, id inconnu.
    const badType = await api(a, `/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'tool.call', tool: 'x' }),
    })
    expect(badType.status).toBe(400)
    const badPath = await api(a, '/sessions/..%2Fetc/events', {
      method: 'POST',
      body: JSON.stringify({ type: 'user.message', text: 'x' }),
    })
    expect(badPath.status).toBe(404)
    const unknown = await api(a, '/sessions/2026-11-17-zzzz/events', {
      method: 'POST',
      body: JSON.stringify({ type: 'user.message', text: 'x' }),
    })
    expect(unknown.status).toBe(404)

    // Fork : copie du journal, titre suffixé, provenance enregistrée.
    const forked = await api(a, `/sessions/${id}/fork`, { method: 'POST' })
    expect(forked.status).toBe(201)
    expect(forked.body.forkedFrom).toBe(id)
    expect(forked.body.title).toBe('Rapport Q3 (fork)')

    const before: TestSession[] = (await api(a, '/sessions')).body.sessions
    expect(before).toHaveLength(3)

    // ==== Redémarrage du serveur ====
    await stop()
    const b = await boot()

    const after: TestSession[] = (await api(b, '/sessions')).body.sessions
    expect(after).toEqual(before) // ordre, titres, messages, fork : tout est revenu

    // Le journal du fork contient l'historique hérité.
    const forkEntry = after.find((s) => s.forkedFrom !== undefined) as TestSession
    const source = after.find((s) => s.id === forkEntry.forkedFrom) as TestSession
    expect(forkEntry.messages).toEqual(source.messages)
    expect(after.find((s) => s.title === 'Rapport Q3')?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  },
)
