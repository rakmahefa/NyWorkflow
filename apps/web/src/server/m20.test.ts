import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M20 — deux corrections pilotées par les logs réels de la session
 * 2026-11-18-ebbe :
 *
 * 1. LA COURSE DU 409, ACTE II. M18 avait distingué « en cours
 *    d'exécution » (les frères parallèles passent) de « en attente d'un
 *    humain » (seul bloquant). Mais la fenêtre RESTANTE — entre
 *    l'appendEvent du journal (l'entrée dangereuse devient visible) et
 *    l'inscription du callId dans executingDangerous — restait lisible
 *    par les gardes des frères : round 5 de la session, sept appels
 *    parallèles sous « accept », un write mort avec « un appel d'outil
 *    dangereux est déjà en attente » pendant qu'un frère se trouvait
 *    exactement dans cette fenêtre. M20 inscrit le callId AVANT
 *    l'appendEvent : dès que l'entrée est visible, elle est déjà « en
 *    cours ». La tempête ci-dessous rejoue le round réel à grande
 *    échelle : 12 writes + 3 shells parallèles, zéro 409 toléré.
 *
 * 2. LE MENTOR JOURNALISÉ. Le champ `feedback` de l'observation (le
 *    rappel de protocole renvoyé au modèle, quand il existe) doit
 *    atterrir dans model.jsonl — le journal garde les deux sens du fil,
 *    corrections comprises. Additif : une observation sans feedback ne
 *    gagne pas le champ (les clients d'avant M20 restent valides).
 */

let server: ViteDevServer | undefined
let home = ''
let spaces = ''
const prevEnv = { NYW_HOME: process.env.NYW_HOME, NYW_WORKSPACES: process.env.NYW_WORKSPACES }

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-m20-'))
  spaces = mkdtempSync(join(tmpdir(), 'nyw-m20-ws-'))
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spaces
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(spaces, { recursive: true, force: true })
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
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  return { status: res.status, body: await res.json() }
}

/** Creates a workspace + a session bound to it, at the given security level. */
async function sessionAt(base: string, security: string, wsName: string): Promise<string> {
  const ws = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: wsName }) })
  expect(ws.status).toBe(201)
  const created = await api(base, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'M20', workspace: wsName, security }),
  })
  expect(created.status).toBe(201)
  return created.body.id as string
}

it(
  '« accept » : la tempête parallèle — 15 appels dangereux simultanés, zéro 409',
  { timeout: 60_000 },
  async () => {
    const base = await boot()
    const id = await sessionAt(base, 'accept', 'storm-accept')

    // Le round 5 réel, généralisé : des writes ET des shells, tout en
    // parallèle, chacun passant par la fenêtre appendEvent→exécution.
    const calls = [
      ...Array.from({ length: 12 }, (_, i) => ({
        tool: 'write',
        args: { path: `outputs/storm-${i}.md`, content: `frère ${i}`, title: `Écrire storm-${i}` },
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        tool: 'shell',
        args: { command: `sleep 0.2 && echo storm-${i}`, title: `La commande lente ${i}` },
      })),
    ]
    const results = await Promise.all(
      calls.map((c) =>
        api(base, '/workspaces/storm-accept/tool', {
          method: 'POST',
          body: JSON.stringify({ sessionId: id, ...c }),
        }),
      ),
    )

    // Aucun frère n'est perdu : 15/15 exécutés, aucun 409.
    const lost = results.filter((r) => r.status !== 200 || r.body.status !== 'executed')
    expect(lost, JSON.stringify(lost.map((l) => l.body))).toEqual([])
    expect(results.every((r) => r.body.outcome.ok === true)).toBe(true)

    // Le journal est cohérent : autant de results que de calls, rien d'ouvert.
    const listed = ((await api(base, '/sessions')).body.sessions as any[]).find((s) => s.id === id)
    const types = listed.events.map((e: any) => e.type)
    expect(types.filter((t: string) => t === 'tool.call').length).toBe(15)
    expect(types.filter((t: string) => t === 'tool.result').length).toBe(15)
  },
)

it(
  '« ask » : la porte humaine reste strictement une à la fois (le contrat M12/M18 est intact)',
  { timeout: 60_000 },
  async () => {
    const base = await boot()
    const id = await sessionAt(base, 'ask', 'storm-ask')

    const shell = await api(base, '/workspaces/storm-ask/tool', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, tool: 'shell', args: { command: 'echo attente', title: 'Attendre' } }),
    })
    expect(shell.status).toBe(200)
    expect(shell.body.status).toBe('pending')

    const write = await api(base, '/workspaces/storm-ask/tool', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, tool: 'write', args: { path: 'a.md', content: 'x', title: 'Pendant' } }),
    })
    expect(write.status).toBe(409)
    expect(write.body.error).toContain('déjà en attente')

    const decision = await api(base, '/workspaces/storm-ask/tool/decision', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, decision: 'refuse' }),
    })
    expect(decision.status).toBe(200)
  },
)

it(
  'le mentor : le champ feedback de l’observation atterrit dans model.jsonl (additif)',
  { timeout: 60_000 },
  async () => {
    const base = await boot()
    const id = await sessionAt(base, 'accept', 'mentor-log')

    // Une observation AVEC feedback : le rappel du mentor est journalisé.
    const posted = await api(base, `/sessions/${id}/observation`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.6-flash@think=4',
        round: 3,
        fedToRound: 4,
        ms: 120,
        feedback: '[HARNESS — protocole, round 3]\n- Ta réponse doit S’OUVRIR par un bloc <thinking> titré.',
        results: [
          { tool: 'ls', title: 'Lister la racine', ok: true, result: '{"path":".","entries":[]}' },
          { tool: 'read', title: '', ok: false, error: 'refusé — chemin attendu' },
        ],
      }),
    })
    expect(posted.status).toBe(201)

    // Sans feedback : le champ n'apparaît pas (client d'avant M20).
    const bare = await api(base, `/sessions/${id}/observation`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.6-flash@think=4',
        round: 4,
        fedToRound: 5,
        ms: 30,
        results: [{ tool: 'ls', title: 'Lister', ok: true, result: '{"path":"."}' }],
      }),
    })
    expect(bare.status).toBe(201)

    // Le model.jsonl DE LA SESSION porte le feedback, mot pour mot.
    const logs = await api(base, `/sessions/${id}/logs`)
    expect(logs.status).toBe(200)
    const model = logs.body.files.find((f: any) => f.name === 'model.jsonl')
    expect(model).toBeDefined()
    const tail = await api(base, `/sessions/${id}/logs/model.jsonl?tail=10`)
    const lines = (tail.body.tail as string).split('\n').filter((l) => l.trim() !== '')
    const withFeedback = lines.map((l) => JSON.parse(l)).find((r) => r.kind === 'model.observation' && r.feedback !== undefined)
    expect(withFeedback).toBeDefined()
    expect(withFeedback.round).toBe(3)
    expect(withFeedback.feedback).toContain('[HARNESS — protocole, round 3]')
    expect(withFeedback.okCalls).toBe(1)
    expect(withFeedback.errCalls).toBe(1)
    const without = lines.map((l) => JSON.parse(l)).find((r) => r.kind === 'model.observation' && r.round === 4)
    expect(without.feedback).toBeUndefined()
  },
)
