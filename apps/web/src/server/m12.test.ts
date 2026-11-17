import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M12 delivery proof, over the REAL app config: workspace folders of the
 * user's disk registered as-is (manifest), the folder browser, inline
 * rename, callId-paired parallel tool calls (safe ones concurrent, the
 * dangerous gate one-at-a-time) and background shells through the API.
 */

let server: ViteDevServer | undefined
let home = ''
let spacesDir = ''
let diskDir = '' // the user's own folders (outside the registry)

const prevEnv = {
  NYW_HOME: process.env.NYW_HOME,
  NYW_WORKSPACES: process.env.NYW_WORKSPACES,
  W2A_URL: process.env.W2A_URL,
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-m12-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-m12-spaces-'))
  diskDir = mkdtempSync(join(tmpdir(), 'nyw-m12-disk-'))
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = ''
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(spacesDir, { recursive: true, force: true })
  rmSync(diskDir, { recursive: true, force: true })
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
  'dossier existant du disque enregistré tel quel (manifeste) → session liée → outils dessus',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Le dossier de l'utilisateur, AVANT toute inscription : fichiers à lui.
    const myDocs = join(diskDir, 'mes-documents')
    mkdirSync(myDocs, { recursive: true })
    writeFileSync(join(myDocs, 'CONTEXT.md'), '# Mes documents personnels\n', 'utf8')
    mkdirSync(join(myDocs, 'projets'))
    writeFileSync(join(myDocs, 'projets', 'notes.txt'), 'mes notes\n', 'utf8')

    // Enregistrement — aucun scaffold, l'arbre reste celui de l'utilisateur.
    const reg = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'mes-documents', path: myDocs }) })
    expect(reg.status).toBe(201)
    expect(reg.body.folder).toBe(true)
    expect(reg.body.tree).toContain('projets/')
    expect(existsSync(join(myDocs, 'inbox'))).toBe(false) // RIEN n'a été créé dedans

    // Le manifeste vit à côté du registre, en donnée.
    const manifest = JSON.parse(readFileSync(join(spacesDir, 'workspaces.json'), 'utf8'))
    expect(manifest.workspaces).toEqual([{ name: 'mes-documents', path: myDocs }])

    // Listé avec le badge dossier + le résumé de son CONTEXT.md.
    const list = await api(base, '/workspaces')
    const mine = list.body.workspaces.find((w: { name: string }) => w.name === 'mes-documents')
    expect(mine).toMatchObject({ name: 'mes-documents', folder: true, summary: 'Mes documents personnels' })

    // Une session liée s'y crée (checkWorkspace passe par le manifeste).
    const session = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Mes docs', workspace: 'mes-documents' }) })
    expect(session.status).toBe(201)
    expect(session.body.workspace).toBe('mes-documents')

    // L'ICM charge l'arbre de l'utilisateur, read y lit SES fichiers.
    const icm = await api(base, '/workspaces/mes-documents/icm')
    expect(icm.body.system).toContain('Mes documents personnels')
    const read = await toolCall(base, 'mes-documents', session.body.id, 'read', { path: 'projets/notes.txt' })
    expect(read.status).toBe(200)
    expect(read.body.outcome.data.content).toContain('mes notes')

    // Le double enregistrement est refusé, le chemin relatif aussi.
    const dup = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'mes-documents', path: myDocs }) })
    expect(dup.status).toBe(400)
    const rel = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'autre', path: 'pas/absolu' }) })
    expect(rel.status).toBe(400)
    const missing = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'fantome', path: '/ne/existe/pas' }) })
    expect(missing.status).toBe(400)
  },
)

it(
  'navigateur de dossiers : répertoires seuls, départ au home, parent, erreurs honnêtes',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    mkdirSync(join(diskDir, 'a-dir'), { recursive: true })
    writeFileSync(join(diskDir, 'un-fichier.txt'), '', 'utf8')

    const root = await api(base, '/workspaces/browse')
    expect(root.status).toBe(200)
    expect(root.body.path).toBe(homedir())
    expect(root.body.home).toBe(homedir())
    expect(Array.isArray(root.body.dirs)).toBe(true)

    const here = await api(base, `/workspaces/browse?path=${encodeURIComponent(diskDir)}`)
    expect(here.status).toBe(200)
    expect(here.body.parent).toBe(join(diskDir, '..').replace(/\/\.\.$/, '') || null)
    const names = here.body.dirs.map((d: { name: string }) => d.name)
    expect(names).toContain('a-dir')
    expect(names).not.toContain('un-fichier.txt') // fichiers jamais listés

    const gone = await api(base, `/workspaces/browse?path=${encodeURIComponent('/ne/existe/pas')}`)
    expect(gone.status).toBe(400)
    const rel = await api(base, '/workspaces/browse?path=relatif')
    expect(rel.status).toBe(400)
  },
)

it(
  'renommage : session.renamed au journal, titre dérivé, sessions liées intactes',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    const created = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Ancien nom' }) })
    const id = created.body.id

    const renamed = await api(base, `/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: '  Nouveau nom  ' }) })
    expect(renamed.status).toBe(200)
    expect(renamed.body.title).toBe('Nouveau nom')

    const list = await api(base, '/sessions')
    expect(list.body.sessions.find((s: { id: string }) => s.id === id).title).toBe('Nouveau nom')

    const empty = await api(base, `/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ title: '   ' }) })
    expect(empty.status).toBe(400)
    const unknown = await api(base, '/sessions/2026-11-17-zzzz/rename', { method: 'POST', body: JSON.stringify({ title: 'x' }) })
    expect(unknown.status).toBe(404)
  },
)

it(
  'appels parallèles sûrs : deux tool.call concurrents acceptés, appariés par callId',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'parallele' }) })
    const session = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Parallèle', workspace: 'parallele' }) })
    const id = session.body.id

    // Deux appels sûrs en vol EN MÊME TEMPS — aucun 409.
    const [a, b] = await Promise.all([
      toolCall(base, 'parallele', id, 'read', { path: 'CONTEXT.md' }),
      toolCall(base, 'parallele', id, 'ls', { path: '.' }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.callId).not.toBe(b.body.callId)

    // Le journal porte les callId, la dérivation apparie chaque résultat.
    const dto = (await api(base, '/sessions')).body.sessions.find((s: { id: string }) => s.id === id)
    const calls = dto.events.filter((e: { type: string }) => e.type === 'tool.call')
    const results = dto.events.filter((e: { type: string }) => e.type === 'tool.result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    expect(new Set(calls.map((c: { callId: string }) => c.callId)).size).toBe(2)

    // Un appel dangereux ouvert bloque le suivant — la porte reste une à la fois.
    const write = await toolCall(base, 'parallele', id, 'write', { path: 'outputs/x.md', content: 'x' })
    expect(write.status).toBe(200)
    expect(write.body.status).toBe('pending')
    const blocked = await toolCall(base, 'parallele', id, 'read', { path: 'CONTEXT.md' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toContain('dangereux')

    // La décision débloque, et le callId du résultat correspond à l'appel.
    const approved = await decide(base, 'parallele', id, 'approve')
    expect(approved.status).toBe(200)
    expect(approved.body.outcome.ok).toBe(true)
    const after = (await api(base, '/sessions')).body.sessions.find((s: { id: string }) => s.id === id)
    const writeResult = after.events.filter((e: { type: string }) => e.type === 'tool.result').find((e: { callId?: string }) => e.callId === write.body.callId)
    expect(writeResult).toBeDefined()
    expect(writeResult.ok).toBe(true)
    expect(existsSync(join(spacesDir, 'parallele', 'outputs', 'x.md'))).toBe(true)
  },
)

it(
  'shell en arrière-plan via l’API : approbation, jobId, suivi, arrêt',
  { timeout: 120_000 },
  async () => {
    const base = await boot()
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'bg-ws' }) })
    const session = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Arrière-plan', workspace: 'bg-ws' }) })
    const id = session.body.id

    // L'arrière-plan est un shell : approbation d'abord.
    const bg = await toolCall(base, 'bg-ws', id, 'shell', { command: 'sleep 8 && echo fini-bg', background: true })
    expect(bg.status).toBe(200)
    expect(bg.body.status).toBe('pending')

    const approved = await decide(base, 'bg-ws', id, 'approve')
    expect(approved.status).toBe(200)
    expect(approved.body.outcome.ok).toBe(true)
    const jobId = approved.body.outcome.data.jobId
    expect(jobId).toMatch(/^job-/)

    // Suivi (outil libre) : le job vit, stdout vide pour l'instant.
    const live = await toolCall(base, 'bg-ws', id, 'shell_output', { jobId })
    expect(live.body.outcome.ok).toBe(true)
    expect(live.body.outcome.data.running).toBe(true)

    // Un jobId inconnu est refusé honnêtement (redémarrage compris).
    const ghost = await toolCall(base, 'bg-ws', id, 'shell_output', { jobId: 'job-fantome' })
    expect(ghost.body.outcome.ok).toBe(false)
    expect(ghost.body.outcome.summary).toContain('processus inconnu')

    // Arrêt : l'outil libre tue le job, le suivant le dit fini.
    const kill = await toolCall(base, 'bg-ws', id, 'shell_kill', { jobId })
    expect(kill.body.outcome.ok).toBe(true)
    expect(kill.body.outcome.data.killed).toBe(true)
    const after = await toolCall(base, 'bg-ws', id, 'shell_output', { jobId })
    expect(after.body.outcome.data.running).toBe(false)
  },
)
