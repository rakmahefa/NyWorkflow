import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M13 delivery proof, over the REAL app config: the security level rules
 * the tools (ask pauses, accept executes, no-tools refuses), it changes
 * live through POST /security, the browser loop's turns land in the
 * journal (turn.completed), and the profiling trio grows under .logs/
 * (engine HTTP trace, session lifecycle, tool activity) — exposed
 * read-only through /logs.
 */

let server: ViteDevServer | undefined
let home = ''
let spacesDir = ''

const prevEnv = {
  NYW_HOME: process.env.NYW_HOME,
  NYW_WORKSPACES: process.env.NYW_WORKSPACES,
  W2A_URL: process.env.W2A_URL,
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-m13-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-m13-spaces-'))
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = ''
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(spacesDir, { recursive: true, force: true })
  for (const key of Object.keys(prevEnv) as (keyof typeof prevEnv)[]) {
    if (prevEnv[key] === undefined) delete process.env[key]
    else process.env[key] = prevEnv[key]
  }
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function boot(): Promise<string> {
  server = await createViteServer({
    configFile: join(import.meta.dirname, '../../vite.config.ts'),
    server: { port: 0, strictPort: false },
  })
  await server.listen()
  const port = (server.httpServer?.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

async function api(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  let body: any = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

const toolCall = (base: string, ws: string, sessionId: string, tool: string, args: unknown) =>
  api(base, `/workspaces/${ws}/tool`, { method: 'POST', body: JSON.stringify({ sessionId, tool, args }) })

const setSecurity = (base: string, sessionId: string, level: string) =>
  api(base, `/sessions/${sessionId}/security`, { method: 'POST', body: JSON.stringify({ level }) })

it(
  'sécurité ask → accept → no-tools : la porte suit le journal, en direct',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Workspace scaffoldé (arbre complet M13) + session liée, niveau ask.
    const ws = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'secu' }) })
    expect(ws.status).toBe(201)
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Sécurité', workspace: 'secu', security: 'ask' }),
    })
    expect(session.status).toBe(201)
    expect(session.body.security).toBe('ask')
    const sid: string = session.body.id

    // ask : un write dangereux se MET EN PAUSE (carte d'approbation).
    const w1 = await toolCall(base, 'secu', sid, 'write', { path: 'outputs/x.md', content: 'un' })
    expect(w1.status).toBe(200)
    expect(w1.body.status).toBe('pending')
    // On le résout (refus) pour débloquer la porte.
    const refuse = await api(base, '/workspaces/secu/tool/decision', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sid, decision: 'refuse' }),
    })
    expect(refuse.body.status).toBe('executed')
    expect(refuse.body.outcome.ok).toBe(false)

    // accept : le même write s'exécute DIRECTEMENT, sans décision.
    const bump = await setSecurity(base, sid, 'accept')
    expect(bump.status).toBe(200)
    expect(bump.body.security).toBe('accept')
    const w2 = await toolCall(base, 'secu', sid, 'write', { path: 'outputs/x.md', content: 'deux' })
    expect(w2.body.status).toBe('executed')
    expect(w2.body.outcome.ok).toBe(true)
    expect(readFileSync(join(spacesDir, 'secu', 'outputs', 'x.md'), 'utf8')).toBe('deux')

    // Un shell part aussi sans approbation, arrière-plan compris.
    const sh = await toolCall(base, 'secu', sid, 'shell', { command: 'echo coucou' })
    expect(sh.body.status).toBe('executed')
    expect(sh.body.outcome.ok).toBe(true)

    // no-tools : TOUT est refusé, refus exécutable journalisé (tools_disabled) —
    // même un read inoffensif, même après re-dérivation du journal.
    const off = await setSecurity(base, sid, 'no-tools')
    expect(off.body.security).toBe('no-tools')
    const r1 = await toolCall(base, 'secu', sid, 'read', { path: '.workspace/CONTEXT.md' })
    expect(r1.body.status).toBe('executed')
    expect(r1.body.outcome.ok).toBe(false)
    expect(r1.body.outcome.code).toBe('tools_disabled')
    const w3 = await toolCall(base, 'secu', sid, 'write', { path: 'outputs/y.md', content: 'jamais' })
    expect(w3.body.outcome.code).toBe('tools_disabled')
    expect(existsSync(join(spacesDir, 'secu', 'outputs', 'y.md'))).toBe(false)

    // Retour à ask : la porte se rouvre (write → pending à nouveau).
    await setSecurity(base, sid, 'ask')
    const w4 = await toolCall(base, 'secu', sid, 'write', { path: 'outputs/y.md', content: 'ok' })
    expect(w4.body.status).toBe('pending')

    // Le journal raconte tout : les changements de niveau + les refus tools_disabled.
    const listed = await api(base, '/sessions')
    const mine = listed.body.sessions.find((s: any) => s.id === sid)
    expect(mine.security).toBe('ask') // dernier changement
    const kinds = mine.events.map((e: any) => e.type)
    expect(kinds).toContain('session.security')
    const disabled = mine.events.filter((e: any) => e.type === 'tool.result' && e.summary.includes('aucun outil'))
    expect(disabled.length).toBeGreaterThanOrEqual(2) // read + write refusés sous no-tools
  },
)

it(
  'POST /turn journalise le tour terminé — trace durable dans le journal et le journal seul',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'tours' }) })
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Tours', workspace: 'tours' }),
    })
    const sid: string = session.body.id

    // Un tour complet : 3 rounds, 2 appels d'outils, 8,4 s, réflexion streamée.
    const turn = await api(base, `/sessions/${sid}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-2.5-flash@think=2',
        thinkLevel: 2,
        rounds: 3,
        ms: 8_400,
        outcome: 'ok',
        toolCalls: 2,
        messages: 9,
        tools: 9,
        thinkingChars: 1_200,
        textChars: 3_400,
      }),
    })
    expect(turn.status).toBe(201)

    const listed = await api(base, '/sessions')
    const mine = listed.body.sessions.find((s: any) => s.id === sid)
    const done = mine.events.filter((e: any) => e.type === 'turn.completed')
    expect(done).toHaveLength(1)
    expect(done[0].model).toBe('gemini-2.5-flash@think=2')
    expect(done[0].rounds).toBe(3)
    expect(done[0].toolCalls).toBe(2)
    // La dérivation n'en fait NI un message NI un appel d'outil.
    expect(mine.messages).toHaveLength(0)
    expect(mine.events.filter((e: any) => e.type === 'tool.call')).toHaveLength(0)

    // Les entrées invalides sont refusées proprement (400, jamais 500).
    const bad = await api(base, `/sessions/${sid}/turn`, {
      method: 'POST',
      body: JSON.stringify({ model: '', outcome: 'peut-etre', rounds: -3 }),
    })
    expect(bad.status).toBe(400)
  },
)

it(
  'logs de profilage : engine/session/activity sous .logs, exposés par /logs en lecture seule',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // De l'activité : workspace + session + événement + tour + outil.
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'logs-ws' }) })
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Profilage', workspace: 'logs-ws', security: 'accept' }),
    })
    const sid: string = session.body.id
    await api(base, `/sessions/${sid}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'user.message', text: 'salut les logs' }),
    })
    await toolCall(base, 'logs-ws', sid, 'write', { path: 'outputs/log.md', content: 'trace' })
    await api(base, `/sessions/${sid}/turn`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-2.5-flash', rounds: 1, ms: 900, outcome: 'ok', toolCalls: 1, thinkingChars: 0, textChars: 50 }),
    })

    // Le listing /logs : les quatre journaux (M16 : model.jsonl s'ajoute), le dossier, des lignes.
    const logs = await api(base, '/logs')
    expect(logs.status).toBe(200)
    expect(logs.body.dir).toContain('.logs')
    const names: string[] = logs.body.files.map((f: any) => f.name)
    expect(names).toEqual(['engine.jsonl', 'session.jsonl', 'activity.jsonl', 'model.jsonl'])
    const byName = Object.fromEntries(logs.body.files.map((f: any) => [f.name, f]))
    expect(byName['engine.jsonl'].lines).toBeGreaterThan(0) // requêtes HTTP tracées
    expect(byName['session.jsonl'].lines).toBeGreaterThanOrEqual(2) // created + message
    expect(byName['activity.jsonl'].lines).toBeGreaterThanOrEqual(3) // scaffold + write + tour

    // Les fichiers existent bel et bien, en JSONL daté (model.jsonl n'est
    // écrit qu'à la première réponse de modèle — prouvé dans m16.test.ts).
    for (const name of names.filter((n) => n !== 'model.jsonl')) {
      const raw = readFileSync(join(home, '.logs', name), 'utf8')
      for (const line of raw.split('\n').filter((l) => l.trim() !== '')) {
        expect(JSON.parse(line).at).toBeDefined()
      }
    }
    const sessionLog = readFileSync(join(home, '.logs', 'session.jsonl'), 'utf8')
    expect(sessionLog).toContain('"session.created"')
    const activityLog = readFileSync(join(home, '.logs', 'activity.jsonl'), 'utf8')
    expect(activityLog).toContain('"workspace.scaffolded"')
    expect(activityLog).toContain('"tool.call"')
    expect(activityLog).toContain('"turn.completed"')
    const engineLog = readFileSync(join(home, '.logs', 'engine.jsonl'), 'utf8')
    expect(engineLog).toContain('"kind":"http"')

    // La queue : les dernières lignes, plafonnées.
    const tail = await api(base, '/logs/activity.jsonl?tail=2')
    expect(tail.status).toBe(200)
    expect(tail.body.tail.split('\n')).toHaveLength(2)

    // Lecture seule : un nom hors des quatre journaux est refusé, le POST aussi.
    const nope = await api(base, '/logs/other.jsonl')
    expect(nope.status).toBe(404)
    const noWrite = await api(base, '/logs/engine.jsonl', { method: 'POST', body: '{}' })
    expect(noWrite.status).toBe(404)
  },
)
