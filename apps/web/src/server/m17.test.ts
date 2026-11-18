import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M17 delivery proof, over the REAL app config:
 *
 *  - GET /sessions/:id/logs (+ /logs/:name?tail=) — the session's OWN
 *    quartet, inside its folder, READ from the UI's API: the pilot sees
 *    THIS session's model.jsonl (the model's responses) next to the
 *    session itself — the session logs were on disk only until now;
 *  - POST /sessions/:id/observation — the tool-group RESULTS that
 *    circulate back to the model land in model.jsonl (kind
 *    model.observation, global + per session): BOTH directions of the
 *    wire are journalled;
 *  - model.response with rawArgs + argsOk:false — a MALFORMED tool call
 *    stays VISIBLE (the raw string, the verdict) instead of collapsing
 *    into {}: the bad formats, not their absence;
 *  - GET /workspaces/locate — the native picker's bridge: a folder found
 *    BY NAME under the server's roots (bounded, honest), 400 on junk.
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
  home = mkdtempSync(join(tmpdir(), 'nyw-m17-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-m17-spaces-'))
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

/** Bounded polling: the log appends are fire-and-forget. */
async function untilIn(file: string, needle: string, tries = 40): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try {
      const raw = readFileSync(file, 'utf8')
      if (raw.includes(needle)) return raw
    } catch {
      // pas encore
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`« ${needle} » jamais apparu dans ${file}`)
}

it(
  'GET /sessions/:id/logs — le quatuor DE LA SESSION, lisible depuis l’UI, model.jsonl en tête',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const ws = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'sessionses' }) })
    expect(ws.status).toBe(201)
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Logs de session', workspace: 'sessionses' }),
    })
    expect(session.status).toBe(201)
    const sid: string = session.body.id

    // Une réponse du modèle — round 1 conforme.
    const ok1 = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 1,
        ms: 1500,
        outcome: 'ok',
        firstEvent: 'thinking',
        systemChars: 20_000,
        messages: 3,
        thinkingChars: 300,
        textChars: 120,
        thinkingTitles: ['Analyser'],
        thinking: '<thinking title="Analyser">…</thinking>',
        text: 'Voici la réponse du modèle.',
        toolCalls: [],
      }),
    })
    expect(ok1.status).toBe(201)

    // Le listing : le quatuor DE LA SESSION, dans SON dossier.
    await untilIn(join(spacesDir, 'sessionses', '.logs', sid, 'model.jsonl'), '"round":1')
    const list = await api(base, `/sessions/${sid}/logs`)
    expect(list.status).toBe(200)
    expect(list.body.dir).toBe(join(spacesDir, 'sessionses', '.logs', sid))
    expect(list.body.workspace).toBe('sessionses')
    expect(list.body.files.map((f: any) => f.name)).toEqual(['engine.jsonl', 'session.jsonl', 'activity.jsonl', 'model.jsonl'])
    const modelFile = (list.body.files as any[]).find((f) => f.name === 'model.jsonl')
    expect(modelFile.lines).toBeGreaterThan(0)

    // Le tail : la RÉPONSE DU MODÈLE de cette session, servie par l'API.
    const tail = await api(base, `/sessions/${sid}/logs/model.jsonl?tail=10`)
    expect(tail.status).toBe(200)
    expect(tail.body.dir).toBe(join(spacesDir, 'sessionses', '.logs', sid))
    expect(tail.body.tail).toContain('"model.response"')
    expect(tail.body.tail).toContain('Voici la réponse du modèle.')

    // Un journal inconnu est refusé honnêtement ; une session inconnue aussi.
    expect((await api(base, `/sessions/${sid}/logs/secret.jsonl`)).status).toBe(400)
    expect((await api(base, '/sessions/abcdefghij/logs')).status).toBe(404)

    // Le dossier du quatuor existe VRAIMENT dans le dossier de la session.
    expect(existsSync(join(spacesDir, 'sessionses', '.logs', sid, 'model.jsonl'))).toBe(true)
  },
)

it(
  'POST /sessions/:id/observation — les résultats qui CIRCULENT vers le modèle, journalisés des deux côtés',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const ws = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'obsdemo' }) })
    expect(ws.status).toBe(201)
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Observation', workspace: 'obsdemo' }),
    })
    const sid: string = session.body.id

    // Le groupe a tourné : deux lectures parallèles, une réussie, une refusée.
    const posted = await api(base, `/sessions/${sid}/observation`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 1,
        fedToRound: 2,
        ms: 830,
        results: [
          { tool: 'read', title: 'Lire la charte', ok: true, result: '# Charte\nLe contenu lu…' },
          { tool: 'read', title: 'Lire l’interdit', ok: false, error: 'chemin refusé — hors du workspace' },
        ],
      }),
    })
    expect(posted.status).toBe(201)

    // Global : kind model.observation, le groupe ENTIER, le format du protocole.
    const globalRaw = await untilIn(join(home, '.logs', 'model.jsonl'), '"model.observation"')
    const line = JSON.parse(globalRaw.split('\n').find((l) => l.includes('"model.observation"')) as string)
    expect(line.sessionId).toBe(sid)
    expect(line.round).toBe(1)
    expect(line.fedToRound).toBe(2)
    expect(line.calls).toBe(2)
    expect(line.ok).toBe(false) // une erreur dans le groupe — le journal le dit
    expect(line.results[0]).toMatchObject({ tool: 'read', title: 'Lire la charte', ok: true, result: '# Charte\nLe contenu lu…' })
    expect(line.results[1]).toMatchObject({ tool: 'read', ok: false, error: 'chemin refusé — hors du workspace' })

    // Par session : la même observation, dans le dossier de la session.
    const perRaw = await untilIn(join(spacesDir, 'obsdemo', '.logs', sid, 'model.jsonl'), '"model.observation"')
    const perLine = JSON.parse(perRaw.split('\n').find((l) => l.includes('"model.observation"')) as string)
    expect(perLine.workspace).toBe('obsdemo')
    expect(perLine.results).toHaveLength(2)

    // Sans résultats, l'endpoint refuse — une observation vide n'existe pas.
    const empty = await api(base, `/sessions/${sid}/observation`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-3.5-flash', round: 2, fedToRound: 3, ms: 1, results: [] }),
    })
    expect(empty.status).toBe(400)
  },
)

it(
  'model.response — un tool_call MAL FORMÉ reste visible : rawArgs + argsOk:false, protocol.argsOk:false',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'badformat' }) })
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Mauvais format', workspace: 'badformat' }),
    })
    const sid: string = session.body.id

    const posted = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 1,
        ms: 700,
        outcome: 'tool_calls',
        firstEvent: 'thinking',
        systemChars: 20_000,
        messages: 3,
        thinkingChars: 100,
        textChars: 0,
        thinkingTitles: ['Agir'],
        thinking: '<thinking title="Agir">…</thinking>',
        toolCalls: [
          { tool: 'read', title: 'Lire', args: {}, rawArgs: '{path: ".workspace/CONTEXT.md"', argsOk: false },
          { tool: 'ls', title: 'Lister', args: { path: '.' }, rawArgs: '{"path": "."}', argsOk: true },
        ],
      }),
    })
    expect(posted.status).toBe(201)

    const globalRaw = await untilIn(join(home, '.logs', 'model.jsonl'), 'rawArgs')
    const line = JSON.parse(globalRaw.split('\n').find((l) => l.includes('rawArgs')) as string)
    expect(line.kind).toBe('model.response')
    expect(line.sessionId).toBe(sid)
    const bad = line.toolCalls[0]
    expect(bad.tool).toBe('read')
    expect(bad.argsOk).toBe(false)
    expect(bad.rawArgs).toContain('{path: ".workspace/CONTEXT.md"') // LE mauvais format, byte pour byte
    expect(bad.args).toBe('{}') // …tandis que le parse a donné {} — l'écart est visible
    expect(line.protocol.argsOk).toBe(false) // au moins un appel mal formé
    expect(line.toolCalls[1].argsOk).toBe(true)

    // Sans rawArgs (ancien client), le défaut reste true — rétrocompatible.
    const legacy = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 2,
        ms: 300,
        outcome: 'ok',
        firstEvent: 'thinking',
        systemChars: 20_000,
        messages: 5,
        thinkingChars: 10,
        textChars: 20,
        thinkingTitles: ['Conclure'],
        toolCalls: [],
      }),
    })
    expect(legacy.status).toBe(201)
    await untilIn(join(home, '.logs', 'model.jsonl'), '"round":2')
    const lines = readFileSync(join(home, '.logs', 'model.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"model.response"'))
      .map((l) => JSON.parse(l))
    const last = lines.filter((l: any) => l.sessionId === sid).at(-1)
    expect((last as any).protocol.argsOk).toBe(true)
  },
)

it(
  'GET /workspaces/locate — le pont du sélecteur natif : un dossier trouvé PAR NOM, borné et honnête',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    // Le dossier du pilote, porté par une racine de recherche (le registre).
    const pickedName = `dossier-pilote-m17-${Date.now().toString(36)}`
    const pickedPath = join(spacesDir, pickedName)
    mkdirSync(pickedPath, { recursive: true })

    // Un candidat unique : c'est LUI — le chemin complet, prêt à enregistrer.
    const found = await api(base, `/workspaces/locate?name=${encodeURIComponent(pickedName)}`)
    expect(found.status).toBe(200)
    expect(found.body.name).toBe(pickedName)
    expect(found.body.candidates).toEqual([pickedPath])
    expect(found.body.scanned).toBeGreaterThan(0)
    expect(found.body.roots.length).toBeGreaterThan(0)

    // Aucun candidat pour un nom qui n'existe pas — zéro, pas d'erreur.
    const none = await api(base, `/workspaces/locate?name=${encodeURIComponent('ce-dossier-nexiste-pas-m17')}`)
    expect(none.status).toBe(200)
    expect(none.body.candidates).toEqual([])

    // Les entrées invalides sont refusées : chemin, vide.
    expect((await api(base, '/workspaces/locate?name=')).status).toBe(400)
    expect((await api(base, `/workspaces/locate?name=${encodeURIComponent('a/b')}`)).status).toBe(400)
  },
)
