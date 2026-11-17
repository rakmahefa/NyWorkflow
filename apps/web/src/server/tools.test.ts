import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M5 delivery proof, over the REAL app config (vite.config.ts): tools and
 * permissions through the /workspaces API, with a mock OpenAI-compatible
 * gateway scripted to emit tool requests. The milestone sentence is proven
 * here end to end: an out-of-scope tool call is REFUSED and JOURNALED;
 * a scoped write pauses for approval, the /approval endpoint resumes the
 * stage — and the approval state survives a server restart (derived from
 * the journal).
 */

const EXAMPLE = join(import.meta.dirname, '../../../../examples/workspaces/exemple-rapport')

let server: ViteDevServer | undefined
let home = ''
let spacesDir = ''
let mock:
  | { port: number; close: () => Promise<void>; calls: { model: string; user: string }[] }
  | undefined

const prevEnv = {
  NYW_HOME: process.env.NYW_HOME,
  NYW_WORKSPACES: process.env.NYW_WORKSPACES,
  W2A_URL: process.env.W2A_URL,
}

/**
 * Mock gateway OpenAI-compatible, scripted per run: the subject carries a
 * unique marker (DEMOOUTILS, REFUSOUTILS…), and every model call of that
 * run walks a fixed script — read CONTEXT.md, out-of-scope read, scoped
 * write (pause), then the final artifact. Tests run sequentially, so a
 * single "current run" cursor is safe.
 */
function startLlmMock(): Promise<{ port: number; close: () => Promise<void>; calls: { model: string; user: string }[] }> {
  const calls: { model: string; user: string }[] = []
  const REQ_READ = JSON.stringify({ tool: 'read', args: { path: 'CONTEXT.md' } })
  const REQ_OOS = JSON.stringify({ tool: 'read', args: { path: '../../secret.txt' } })
  // One write target per run: tests share the workspace copy, so an
  // approved write of one test must never leak into another's assertions.
  const script = (marker: string, artifact: string): string[] => [
    REQ_READ,
    REQ_OOS,
    JSON.stringify({
      tool: 'write',
      args: { path: `01-recherche/output/notes-${marker}.md`, content: `DES NOTES ${marker}` },
    }),
    artifact,
  ]
  const SCRIPTS: Record<string, string[]> = {
    DEMOOUTILS: script('demo', 'FICHE AVEC NOTES'),
    REFUSOUTILS: script('refus', 'FICHE SANS NOTES'),
    RESTARTOUTILS: script('restart', 'FICHE AVEC NOTES'),
    VALOUTILS: script('val', 'FICHE SANS OUTIL'),
  }
  let currentMarker = ''
  let step = 0

  const srv = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1beta/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gemini-test' }] }))
      return
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8')
      })
      req.on('end', () => {
        let parsed: { model?: string; messages?: { role: string; content: string }[] } = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m?.role === 'user')?.content ?? ''
        calls.push({ model: parsed.model ?? '', user: lastUser })

        const seen = Object.keys(SCRIPTS).find((m) => lastUser.includes(m))
        if (seen) {
          currentMarker = seen
          step = 0
        }
        const script = SCRIPTS[currentMarker]
        const text = script ? (script[Math.min(step++, script.length - 1)] as string) : 'REPONSE GENERIQUE'

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as { port: number }).port,
        close: () => new Promise<void>((r) => srv.close(() => r())),
        calls,
      })
    })
  })
}

/** Vide les output/ de la copie (les runs locaux laissent des sorties). */
function stripStageOutputs(wsRoot: string): void {
  for (const entry of readdirSync(wsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const outDir = join(wsRoot, entry.name, 'output')
    try {
      if (!statSync(outDir).isDirectory()) continue
    } catch {
      continue
    }
    for (const f of readdirSync(outDir)) {
      if (f !== '.gitkeep') rmSync(join(outDir, f), { recursive: true, force: true })
    }
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-tools-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-tools-spaces-'))
  cpSync(EXAMPLE, join(spacesDir, 'exemple-rapport'), { recursive: true })
  stripStageOutputs(join(spacesDir, 'exemple-rapport'))
  return startLlmMock().then((m) => {
    mock = m
  })
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(spacesDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return mock?.close()
})

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function boot(): Promise<string> {
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = `http://127.0.0.1:${mock?.port ?? 0}`
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

async function newRun(base: string, subject: string): Promise<string> {
  const run = await api(base, '/workspaces/exemple-rapport/runs', {
    method: 'POST',
    body: JSON.stringify({ subject }),
  })
  expect(run.status).toBe(201)
  return run.body.id as string
}

/** Reads a run journal as text (proofs live in the JSONL, not in memory). */
function journal(id: string): string {
  return readFileSync(join(home, 'sessions', `${id}.jsonl`), 'utf8')
}

it(
  'outils : read auto, hors périmètre refusé ET journalisé, write approuvé via /approval',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const SUBJECT = 'Démo outils M5 DEMOOUTILS — loutres de Madagascar'
    const id = await newRun(base, SUBJECT)

    // Étape 1 avec outils : le script maquette enchaîne read → read hors
    // périmètre → write (pause) → artifact après décision.
    const adv = await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test', tools: true }),
    })
    expect(adv.status).toBe(200)
    expect(adv.body.state).toEqual({
      status: 'approval',
      stage: '01-recherche',
      tool: 'write',
      args: { path: '01-recherche/output/notes-demo.md', content: 'DES NOTES demo' },
    })

    // Rien n'est écrit avant la décision.
    expect(existsSync(join(spacesDir, 'exemple-rapport/01-recherche/output/notes-demo.md'))).toBe(false)

    // Le journal contient déjà : started(model), read appelé+résolu,
    // read hors périmètre appelé+refusé, write appelé (en attente).
    const log = journal(id)
    expect(log).toContain('"type":"stage.started"')
    expect(log).toContain('"model":"gemini-test"')
    expect(log).toContain('"tool":"read","args":{"path":"CONTEXT.md"}')
    expect(log).toContain('hors périmètre')
    expect(log).toContain('"tool":"write"')

    // Advance pendant l'approbation : refus 409 explicite.
    const blocked = await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test', tools: true }),
    })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toMatch(/en attente/)

    // L'état du run expose l'activité d'outils (pour l'UI).
    const mid = await api(base, `/workspaces/exemple-rapport/runs/${id}`)
    expect(mid.body.state.status).toBe('approval')
    const tools = mid.body.tools as { tool: string; ok?: boolean; summary?: string }[]
    expect(tools).toHaveLength(3)
    expect(tools[0]).toMatchObject({ tool: 'read', ok: true })
    expect(tools[1]).toMatchObject({ tool: 'read', ok: false })
    expect(tools[1]?.summary).toMatch(/hors périmètre/)
    expect(tools[2]).toMatchObject({ tool: 'write' })
    expect(tools[2]?.ok).toBeUndefined() // en attente

    // Décision humaine : approbation → write exécuté, étape reprise.
    const approve = await api(base, `/workspaces/exemple-rapport/runs/${id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(approve.status).toBe(200)
    expect(approve.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    expect(approve.body.outputs).toEqual(['01-recherche/output/faits.md'])

    expect(readFileSync(join(spacesDir, 'exemple-rapport/01-recherche/output/notes-demo.md'), 'utf8')).toBe(
      'DES NOTES demo',
    )
    expect(readFileSync(join(spacesDir, 'exemple-rapport/01-recherche/output/faits.md'), 'utf8')).toBe(
      'FICHE AVEC NOTES',
    )

    // Le modèle a bien reçu le résultat du write approuvé.
    expect(mock?.calls.at(-1)?.user).toContain('"ok":true')
  },
)

it(
  'refus du write : le modèle est informé, rien n’est écrit, l’étape continue',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const id = await newRun(base, 'Refus outils M5 REFUSOUTILS')

    const adv = await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test', tools: true }),
    })
    expect(adv.body.state.status).toBe('approval')

    const refuse = await api(base, `/workspaces/exemple-rapport/runs/${id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'refuse' }),
    })
    expect(refuse.status).toBe(200)
    expect(refuse.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })

    expect(existsSync(join(spacesDir, 'exemple-rapport/01-recherche/output/notes-refus.md'))).toBe(false)
    // La fiche existe (le modèle a continué sans l'écriture refusée).
    expect(existsSync(join(spacesDir, 'exemple-rapport/01-recherche/output/faits.md'))).toBe(true)
    expect(journal(id)).toContain("refusé par l'utilisateur")
    expect(mock?.calls.at(-1)?.user).toContain('refusé par l\'utilisateur')
  },
)

it(
  'l’approbation survit à un redémarrage serveur (dérivée du journal)',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const id = await newRun(base, 'Restart outils M5 RESTARTOUTILS')
    const adv = await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test', tools: true }),
    })
    expect(adv.body.state.status).toBe('approval')

    // Redémarrage : le listing ET l'état du run retrouvent l'approbation,
    // avec l'appel en attente — et la décision passe après relance.
    await server?.close()
    server = undefined
    const base2 = await boot()

    const detail = await api(base2, '/workspaces/exemple-rapport')
    const revived = (detail.body.runs as { id: string; state: any }[]).find((r) => r.id === id)
    expect(revived?.state).toEqual({
      status: 'approval',
      stage: '01-recherche',
      tool: 'write',
      args: { path: '01-recherche/output/notes-restart.md', content: 'DES NOTES restart' },
    })

    const approve = await api(base2, `/workspaces/exemple-rapport/runs/${id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(approve.status).toBe(200)
    expect(approve.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    expect(readFileSync(join(spacesDir, 'exemple-rapport/01-recherche/output/notes-restart.md'), 'utf8')).toBe(
      'DES NOTES restart',
    )
  },
)

it(
  'validations : decision inconnue, approbation sans attente, advance sans model',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const id = await newRun(base, 'Validations outils M5 VALOUTILS')

    expect(
      (
        await api(base, `/workspaces/exemple-rapport/runs/${id}/approval`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'peut-etre' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await api(base, `/workspaces/exemple-rapport/runs/${id}/approval`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approve' }),
        })
      ).status,
    ).toBe(409)

    // Sans tools : comportement M4 — la maquette répond l'artefact du script.
    const adv = await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })
    expect(adv.status).toBe(200)
    expect(adv.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    expect(journal(id)).not.toContain('tool.call')
  },
)
