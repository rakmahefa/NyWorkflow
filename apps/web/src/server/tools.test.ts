import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M11 delivery proof, over the REAL app config (vite.config.ts): the
 * agentic /workspaces API — scaffold, ICM loading, tool calls with the
 * session journal as the truth, and the human decision that resumes a
 * dangerous call. No mock gateway needed: the model loop lives in the
 * browser; here we prove the server side it leans on.
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
  home = mkdtempSync(join(tmpdir(), 'nyw-ws-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-ws-spaces-'))
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = '' // pas de passerelle à démarrer pour ces tests
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

const decide = (base: string, ws: string, sessionId: string, decision: 'approve' | 'refuse') =>
  api(base, `/workspaces/${ws}/tool/decision`, { method: 'POST', body: JSON.stringify({ sessionId, decision }) })

it(
  'scaffold → ICM → session → outils auto → write en approbation → décision → journal',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Liste initialement vide.
    const empty = await api(base, '/workspaces')
    expect(empty.status).toBe(200)
    expect(empty.body.workspaces).toEqual([])

    // Scaffold d'un workspace agentique — l'ICM complet naît DANS .workspace/ (M14).
    const created = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'loutres' }) })
    expect(created.status).toBe(201)
    expect(created.body.name).toBe('loutres')
    expect(created.body.tree).toContain('.workspace/')
    expect(created.body.tree).toContain('CONTEXT.md')
    expect(created.body.tree).toContain('inbox/')
    expect(created.body.tree).toContain('outputs/')
    expect(existsSync(join(spacesDir, 'loutres', '.workspace', 'CONTEXT.md'))).toBe(true)

    // Un scaffold refusé sur un nom existant — jamais d'écrasement.
    const dupe = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'loutres' }) })
    expect(dupe.status).toBe(400)
    expect(dupe.body.error).toContain('existe déjà')

    // Le listing porte le résumé (premier titre de la charte .workspace/CONTEXT.md).
    const list = await api(base, '/workspaces')
    expect(list.body.workspaces).toEqual([{ name: 'loutres', summary: 'loutres — ICM du workspace' }])

    // L'ICM : arbre + charte + prompt système assemblé. Le scaffold complet
    // (M14) porte 7 CONTEXT.md dans .workspace/ (racine + 6 dossiers à rôle).
    const icm = await api(base, '/workspaces/loutres/icm')
    expect(icm.status).toBe(200)
    expect(icm.body.system).toContain('harness NyWorkflow')
    expect(icm.body.system).toContain('# loutres — ICM du workspace')
    expect(icm.body.system).toContain('ICM chargé — arbre du workspace')
    expect(icm.body.system).toContain('.workspace/')
    expect(icm.body.contexts).toHaveLength(9) // M16 : + harness/ et tools/ charters

    // Création d'une session liée au workspace (via /sessions).
    const session = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Agent loutres', workspace: 'loutres' }) })
    expect(session.status).toBe(201)
    expect(session.body.workspace).toBe('loutres')
    const sid: string = session.body.id

    // Un read auto-exécuté, journalisé avec son résultat — la charte est
    // dans .workspace/ (M14), le modèle y accède comme à tout le dossier.
    const read = await toolCall(base, 'loutres', sid, 'read', { path: '.workspace/CONTEXT.md' })
    expect(read.status).toBe(200)
    expect(read.body.status).toBe('executed')
    expect(read.body.outcome.ok).toBe(true)
    expect(JSON.stringify(read.body.outcome.data)).toContain('ICM du workspace')

    // Un mkdir auto-exécuté : le modèle façonne son arbre.
    const mk = await toolCall(base, 'loutres', sid, 'mkdir', { path: 'notes/2026-11' })
    expect(mk.body.status).toBe('executed')
    expect(mk.body.outcome.ok).toBe(true)
    expect(existsSync(join(spacesDir, 'loutres', 'notes', '2026-11'))).toBe(true)

    // Un read hors périmètre : refusé ET journalisé (jamais silencieux).
    const escape = await toolCall(base, 'loutres', sid, 'read', { path: '../../secret.md' })
    expect(escape.body.status).toBe('executed')
    expect(escape.body.outcome.ok).toBe(false)

    // Un write : DANGEREUX → pending, sans tool.result au journal.
    const write = await toolCall(base, 'loutres', sid, 'write', { path: 'outputs/rapport.md', content: 'RAPPORT' })
    expect(write.status).toBe(200)
    expect(write.body.status).toBe('pending')

    // Tant que c'est en attente : ni autre appel, ni double décision.
    const concurrent = await toolCall(base, 'loutres', sid, 'ls', { path: '.' })
    expect(concurrent.status).toBe(409)
    const early = await decide(base, 'loutres', sid, 'refuse')
    expect(early.status).toBe(200) // la première décision passe

    // Refus → l'appel est clos côté journal, rien n'est écrit.
    expect(early.body.outcome.ok).toBe(false)
    expect(early.body.outcome.summary).toContain('refusé par l\'utilisateur')
    expect(existsSync(join(spacesDir, 'loutres', 'outputs', 'rapport.md'))).toBe(false)

    // Une décision sans attente → 409 clair.
    const none = await decide(base, 'loutres', sid, 'approve')
    expect(none.status).toBe(409)

    // Un write approuvé : écrit sur disque, journalisé avec ses données.
    const write2 = await toolCall(base, 'loutres', sid, 'write', { path: 'outputs/rapport.md', content: 'RAPPORT APPROUVE' })
    expect(write2.body.status).toBe('pending')
    const approved = await decide(base, 'loutres', sid, 'approve')
    expect(approved.body.outcome.ok).toBe(true)
    expect(readFileSync(join(spacesDir, 'loutres', 'outputs', 'rapport.md'), 'utf8')).toBe('RAPPORT APPROUVE')

    // shell : dangereux aussi → approbation, cwd = racine du workspace.
    const sh = await toolCall(base, 'loutres', sid, 'shell', { command: 'basename "$(pwd)"' })
    expect(sh.body.status).toBe('pending')
    const shDone = await decide(base, 'loutres', sid, 'approve')
    expect(shDone.body.outcome.ok).toBe(true)
    expect(shDone.body.outcome.data.stdout.trim()).toBe('loutres')

    // Le journal est la vérité : la session dérivée porte TOUT l'historique.
    const sessions = await api(base, '/sessions')
    const mine = sessions.body.sessions.find((s: any) => s.id === sid)
    expect(mine.events.filter((e: any) => e.type === 'tool.call').map((e: any) => e.tool)).toEqual([
      'read',
      'mkdir',
      'read',
      'write',
      'write',
      'shell',
    ])
    // Chaque appel a son résultat — aucun en attente.
    const results = mine.events.filter((e: any) => e.type === 'tool.result')
    expect(results).toHaveLength(6)

    // L'ICM reflète l'arbre grandi du workspace (mkdir + write visibles).
    const icm2 = await api(base, '/workspaces/loutres/icm')
    expect(icm2.body.tree).toContain('2026-11/')
    expect(icm2.body.tree).toContain('rapport.md')

    await server?.close()
    server = undefined
  },
)

it(
  'garde-fous : workspace inconnu, session liée ailleurs, outil inconnu, chemins hostiles',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // ICM d'un workspace inconnu → 404.
    const missing = await api(base, '/workspaces/inconnu/icm')
    expect(missing.status).toBe(404)

    // Session sans workspace (M14) : refusée à la création — le dossier est
    // obligatoire, l'ICM et les logs vivent dedans.
    const free = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Libre' }) })
    expect(free.status).toBe(400)
    expect(free.body.error).toContain('workspace')

    // Session liée à un AUTRE workspace → outils refusés proprement.
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'autre' }) })
    const elsewhere = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Ailleurs', workspace: 'autre' }) })
    const sid2: string = elsewhere.body.id
    const unbound = await toolCall(base, 'loutres', sid2, 'ls', { path: '.' })
    expect(unbound.status).toBe(400)
    expect(unbound.body.error).toContain('liée au workspace')

    // Outil inconnu → refus exécuté et journalisé (le modèle apprend).
    const session = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'WS', workspace: 'loutres' }) })
    const bound: string = session.body.id
    const unknown = await toolCall(base, 'loutres', bound, 'rm-rf', {})
    expect(unknown.body.status).toBe('executed')
    expect(unknown.body.outcome.ok).toBe(false)
    expect(unknown.body.outcome.summary).toContain('outil inconnu')

    // Nom de workspace hostile refusé à la création.
    for (const bad of ['..', 'a/b', '  ', '.hidden-start']) {
      const res = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: bad }) })
      expect(res.status).toBe(400)
    }

    // SessionId invalide → 400, jamais une trace de chemin.
    const badId = await toolCall(base, 'loutres', '../../etc', 'ls', { path: '.' })
    expect(badId.status).toBe(400)

    // L'aperçu de fichier garde le même périmètre que les outils.
    const escape = await api(base, '/workspaces/loutres/file?path=../../../etc/passwd')
    expect(escape.status).toBe(400)
    const ok = await api(base, '/workspaces/loutres/file?path=.workspace/CONTEXT.md')
    expect(ok.status).toBe(200)
    expect(ok.body.content).toContain('ICM du workspace')
  },
)
