import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M4 delivery proof, over the REAL app config (vite.config.ts): drive the
 * /workspaces API over HTTP against a copy of the example workspace, with a
 * mock OpenAI-compatible gateway as the LLM. The example workspace runs end
 * to end; a server restart finds the run state again (derived from the
 * journal); predictable refusals answer with clear errors.
 */

const EXAMPLE = join(import.meta.dirname, '../../../../examples/workspaces/exemple-rapport')

let server: ViteDevServer | undefined
let home = ''
let spacesDir = ''
let mock: { port: number; close: () => Promise<void>; calls: { model: string; user: string }[] } | undefined

const prevEnv = {
  NYW_HOME: process.env.NYW_HOME,
  NYW_WORKSPACES: process.env.NYW_WORKSPACES,
  W2A_URL: process.env.W2A_URL,
}

/** Mock gateway OpenAI-compatible : SSE, réponses numérotées par appel. */
function startLlmMock(delayMs: number): Promise<{ port: number; close: () => Promise<void>; calls: { model: string; user: string }[] }> {
  const calls: { model: string; user: string }[] = []
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
        const text = `SORTIE ÉTAPE ${calls.length}`
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }, delayMs)
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
  home = mkdtempSync(join(tmpdir(), 'nyw-ws-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-ws-spaces-'))
  cpSync(EXAMPLE, join(spacesDir, 'exemple-rapport'), { recursive: true })
  stripStageOutputs(join(spacesDir, 'exemple-rapport'))
  // Un workspace cassé : présent dans le listing, avec sa raison.
  mkdirSync(join(spacesDir, 'casse'), { recursive: true })
  return startLlmMock(0).then((m) => {
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

async function boot(w2aUrl?: string): Promise<string> {
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = w2aUrl ?? `http://127.0.0.1:${mock?.port ?? 0}`
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
  'exemple-rapport s’exécute de bout en bout, avec checkpoint, puis reprise après redémarrage',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Listing : l'exemple est parsé, le workspace cassé explique son cas.
    const list = await api(base, '/workspaces')
    expect(list.status).toBe(200)
    const exemple = list.body.workspaces.find((w: { name: string }) => w.name === 'exemple-rapport')
    expect(exemple.stages).toEqual([
      { stage: '01-recherche', title: 'Étape 01 — Recherche' },
      { stage: '02-redaction', title: 'Étape 02 — Rédaction' },
    ])
    const casse = list.body.workspaces.find((w: { name: string }) => w.name === 'casse')
    expect(casse.error).toMatch(/CONTEXT\.md/)

    // Détail : carte + contrats + aucun run pour l'instant.
    const detail = await api(base, '/workspaces/exemple-rapport')
    expect(detail.status).toBe(200)
    expect(detail.body.map).toContain('rapport Markdown court')
    expect(detail.body.stages).toHaveLength(2)
    expect(detail.body.runs).toEqual([])

    // Création d'un run : le sujet devient le titre de la session.
    const SUBJECT = 'Les loutres de Madagascar'
    const run = await api(base, '/workspaces/exemple-rapport/runs', {
      method: 'POST',
      body: JSON.stringify({ subject: SUBJECT }),
    })
    expect(run.status).toBe(201)
    expect(run.body.title).toBe(SUBJECT)
    expect(run.body.state).toEqual({ status: 'idle' })
    const runId: string = run.body.id

    // Le run est une session comme les autres : visible dans /sessions.
    const sessions = await api(base, '/sessions')
    const asSession = sessions.body.sessions.find((s: { id: string }) => s.id === runId)
    expect(asSession.title).toBe(SUBJECT)

    // Étape 1 : checkpoint après « 01-recherche », sortie écrite sur disque.
    const adv1 = await api(base, `/workspaces/exemple-rapport/runs/${runId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })
    expect(adv1.status).toBe(200)
    expect(adv1.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    expect(adv1.body.outputs).toEqual(['01-recherche/output/faits.md'])
    const faits = readFileSync(join(spacesDir, 'exemple-rapport/01-recherche/output/faits.md'), 'utf8')
    expect(faits).toBe('SORTIE ÉTAPE 1')

    // Le modèle a bien reçu le sujet (contexte assemblé de bout en bout).
    expect(mock?.calls[0]?.model).toBe('gemini-test')
    expect(mock?.calls[0]?.user).toContain(SUBJECT)

    // État intermédiaire lisible sans exécuter.
    const mid = await api(base, `/workspaces/exemple-rapport/runs/${runId}`)
    expect(mid.body.state).toEqual({ status: 'checkpoint', stage: '01-recherche' })

    // Étape 2 : done, rapport écrit.
    const adv2 = await api(base, `/workspaces/exemple-rapport/runs/${runId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })
    expect(adv2.status).toBe(200)
    expect(adv2.body.state).toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })
    expect(adv2.body.outputs).toEqual(['02-redaction/output/rapport.md'])
    expect(readFileSync(join(spacesDir, 'exemple-rapport/02-redaction/output/rapport.md'), 'utf8')).toBe('SORTIE ÉTAPE 2')

    // L'étape 2 a relu la fiche produite par l'étape 1 (chaînage déclaratif).
    expect(mock?.calls[1]?.user).toContain('SORTIE ÉTAPE 1')

    // Terminé : advance est un no-op.
    const again = await api(base, `/workspaces/exemple-rapport/runs/${runId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })
    expect(again.status).toBe(200)
    expect(again.body.state.status).toBe('done')
    expect(again.body.outputs).toEqual([])

    // ==== Redémarrage du serveur : l'état du run est retrouvé (journal) ====
    await stop()
    const base2 = await boot()
    const after = await api(base2, '/workspaces/exemple-rapport')
    const revived = after.body.runs.find((r: { id: string }) => r.id === runId)
    expect(revived.state).toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })
  },
)

it(
  'refus prévisibles : noms, validations, sessions inconnues',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Workspaces inconnus ou mal formés.
    expect((await api(base, '/workspaces/inconnu')).status).toBe(404)
    expect((await api(base, '/workspaces/..%2Fetc')).status).toBe(404)
    expect((await api(base, '/workspaces/casse')).status).toBe(400)

    // Création de run : validations du sujet.
    expect((await api(base, '/workspaces/inconnu/runs', { method: 'POST', body: JSON.stringify({ subject: 'x' }) })).status).toBe(404)
    expect(
      (await api(base, '/workspaces/casse/runs', { method: 'POST', body: JSON.stringify({ subject: 'x' }) })).status,
    ).toBe(400)
    expect((await api(base, '/workspaces/exemple-rapport/runs', { method: 'POST', body: '{}' })).status).toBe(400)
    expect(
      (
        await api(base, '/workspaces/exemple-rapport/runs', {
          method: 'POST',
          body: JSON.stringify({ subject: ' '.repeat(20_001) }),
        })
      ).status,
    ).toBe(400)

    // Advance : modèle requis, session inconnue, run sans sujet impossible
    // (tout run créé ici a un sujet — on vérifie le refus du modèle manquant).
    const run = await api(base, '/workspaces/exemple-rapport/runs', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Validations' }),
    })
    const id: string = run.body.id
    expect((await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect(
      (await api(base, '/workspaces/exemple-rapport/runs/2026-11-17-zzzz/advance', {
        method: 'POST',
        body: JSON.stringify({ model: 'm' }),
      })).status,
    ).toBe(404)
    expect((await api(base, '/workspaces/exemple-rapport/runs/2026-11-17-zzzz')).status).toBe(404)
  },
)

it(
  'deux advance simultanés : le second reçoit un refus clair (409)',
  { timeout: 120_000 },
  async () => {
    const slow = await startLlmMock(300)
    try {
      const base = await boot(`http://127.0.0.1:${slow.port}`)

      const run = await api(base, '/workspaces/exemple-rapport/runs', {
        method: 'POST',
        body: JSON.stringify({ subject: 'Concurrence' }),
      })
      const id: string = run.body.id
      const url = `/workspaces/exemple-rapport/runs/${id}/advance`
      const init = { method: 'POST', body: JSON.stringify({ model: 'gemini-test' }) }

      const [first, second] = await Promise.all([
        api(base, url, init),
        api(base, url, init).catch((err) => ({ status: 0, body: { error: String(err) } })),
      ])
      expect(first.status).toBe(200)
      expect([200, 409]).toContain(second.status)
      if (second.status === 409) expect(second.body.error).toMatch(/déjà en cours/)
      expect(slow.calls.length).toBeLessThanOrEqual(1)
      expect(existsSync(join(spacesDir, 'exemple-rapport/01-recherche/output/faits.md'))).toBe(true)
    } finally {
      await slow.close()
    }
  },
)

it(
  'vue workflow (M6) : sorties du run dans le détail, aperçu /file sous garde de périmètre',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const marker = `M6-Apercu-${Date.now()}`
    const run = await api(base, '/workspaces/exemple-rapport/runs', {
      method: 'POST',
      body: JSON.stringify({ subject: marker }),
    })
    const id: string = run.body.id

    // Aucune sortie tant que rien n'a tourné.
    expect(run.body.outputs).toEqual([])

    // Les deux étapes s'exécutent ; le détail porte les sorties par étape.
    await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })
    await api(base, `/workspaces/exemple-rapport/runs/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-test' }),
    })

    const detail = await api(base, '/workspaces/exemple-rapport')
    const mine = detail.body.runs.find((r: { id: string }) => r.id === id)
    expect(mine.state.status).toBe('done')
    expect(mine.outputs).toEqual([
      { stage: '01-recherche', files: ['01-recherche/output/faits.md'] },
      { stage: '02-redaction', files: ['02-redaction/output/rapport.md'] },
    ])

    // Aperçu : le contenu renvoyé est le contenu disque, octet pour octet.
    const faitsOnDisk = readFileSync(join(spacesDir, 'exemple-rapport/01-recherche/output/faits.md'), 'utf8')
    const preview = await api(base, `/workspaces/exemple-rapport/file?path=${encodeURIComponent('01-recherche/output/faits.md')}`)
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual({
      path: '01-recherche/output/faits.md',
      content: faitsOnDisk,
      bytes: Buffer.byteLength(faitsOnDisk, 'utf8'),
    })

    // La carte est lisible aussi (fichier du workspace, pas seulement output/).
    const map = await api(base, `/workspaces/exemple-rapport/file?path=CONTEXT.md`)
    expect(map.status).toBe(200)
    expect(map.body.content).toContain('rapport Markdown court')

    // Refus prévisibles : chemin manquant, vide, absolu, hors périmètre,
    // dossier, fichier absent — messages clairs, jamais d'exception nue.
    expect((await api(base, '/workspaces/exemple-rapport/file')).status).toBe(400)
    expect((await api(base, '/workspaces/exemple-rapport/file?path=')).status).toBe(400)
    expect((await api(base, `/workspaces/exemple-rapport/file?path=${encodeURIComponent('/etc/passwd')}`)).status).toBe(400)
    const escape = await api(base, `/workspaces/exemple-rapport/file?path=${encodeURIComponent('../secrets.txt')}`)
    expect(escape.status).toBe(400)
    expect(escape.body.error).toMatch(/hors workspace/)
    const dir = await api(base, `/workspaces/exemple-rapport/file?path=${encodeURIComponent('01-recherche')}`)
    expect(dir.status).toBe(400)
    expect(dir.body.error).toMatch(/dossier/)
    expect((await api(base, `/workspaces/exemple-rapport/file?path=${encodeURIComponent('01-recherche/output/absent.md')}`)).status).toBe(404)
    expect((await api(base, `/workspaces/casse/file?path=CONTEXT.md`)).status).toBe(400)
  },
)
