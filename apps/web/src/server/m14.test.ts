import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M14 delivery proof, over the REAL app config — the pilot's adjustments
 * after the first uploaded logs:
 *   - the session folder is MANDATORY (no workspace-less session, ever);
 *   - every session folder carries the COMPLETE ICM tree in its hidden
 *     .workspace/ (created at session creation, kept when already there);
 *   - every session has its own profiling trio in .logs/<sessionId>/
 *     INSIDE its folder (lifecycle, chat, turns, tool activity);
 *   - the system prompt tells the model it runs in the NyWorkflow harness
 *     with real tools — the end of « le modèle est confus ».
 */

let server: ViteDevServer | undefined
let home = ''
let spacesDir = ''
let diskDir = ''

const prevEnv = {
  NYW_HOME: process.env.NYW_HOME,
  NYW_WORKSPACES: process.env.NYW_WORKSPACES,
  W2A_URL: process.env.W2A_URL,
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-m14-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-m14-spaces-'))
  diskDir = mkdtempSync(join(tmpdir(), 'nyw-m14-disk-'))
  process.env.NYW_HOME = home
  process.env.NYW_WORKSPACES = spacesDir
  process.env.W2A_URL = ''
})

afterAll(() => {
  for (const d of [home, spacesDir, diskDir]) rmSync(d, { recursive: true, force: true })
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

/** The profiling writes are fire-and-forget — poll until the line lands. */
async function untilIn(file: string, needle: string, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      if (readFileSync(file, 'utf8').includes(needle)) return
    } catch {
      // not there YET — keep polling
    }
    if (Date.now() > deadline) throw new Error(`« ${needle} » jamais apparu dans ${file}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

it(
  'dossier de session OBLIGATOIRE + .workspace/ complet créé dedans + mémoire conservée',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Sans workspace : refus net — plus jamais de session orpheline.
    const orphan = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Orpheline' }) })
    expect(orphan.status).toBe(400)
    expect(orphan.body.error).toContain('obligatoire')
    // Workspace inconnu : refus tout aussi net.
    const ghost = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'X', workspace: 'fantome' }) })
    expect(ghost.status).toBe(400)

    // Avec un workspace : la session naît, et le dossier porte l'ICM complet.
    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'projet-pilote' }) })
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Mon projet', workspace: 'projet-pilote', security: 'accept' }),
    })
    expect(session.status).toBe(201)
    const sid: string = session.body.id

    // Le .workspace/ du scaffold (créé à la création du workspace) est là,
    // complet — 14 fichiers, 6 dossiers à rôle.
    const wsRoot = join(spacesDir, 'projet-pilote')
    for (const rel of [
      'CONTEXT.md',
      'inbox/CONTEXT.md',
      'notes/plan.md',
      'notes/tasks.md',
      'notes/journal.md',
      'notes/decisions.md',
      'research/sources.md',
      'memory/core.md',
      'memory/lessons.md',
      'outputs/CONTEXT.md',
      'archive/CONTEXT.md',
    ]) {
      expect(existsSync(join(wsRoot, '.workspace', rel)), rel).toBe(true)
    }

    // L'agent travaille : son plan devient le sien.
    writeFileSync(join(wsRoot, '.workspace', 'notes', 'plan.md'), '# MON plan vivant')
    // Une SECONDE session sur le même dossier continue la mémoire vivante.
    const second = await api(base, '/sessions', { method: 'POST', body: JSON.stringify({ title: 'Suite', workspace: 'projet-pilote' }) })
    expect(second.status).toBe(201)
    expect(readFileSync(join(wsRoot, '.workspace', 'notes', 'plan.md'), 'utf8')).toBe('# MON plan vivant')

    // L'ICM du dossier : charte .workspace + arbre, et le prompt harness.
    const icm = await api(base, '/workspaces/projet-pilote/icm')
    expect(icm.body.system).toContain('harness NyWorkflow')
    expect(icm.body.system).toContain('pas un chatbot')
    expect(icm.body.system).toContain('Agir = appeler un outil')
    expect(icm.body.system).toContain('.workspace/')
    expect(icm.body.system).toContain('ne les relis pas')
    expect(icm.body.contexts.length).toBe(7)
  },
)

it(
  'dossier du disque enregistré : .workspace/ naît DEDANS, fichiers du pilote intacts',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    const myProject = join(diskDir, 'mon-projet')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(myProject, 'src'), { recursive: true })
    writeFileSync(join(myProject, 'src', 'main.py'), 'print("salut")\n', 'utf8')

    const reg = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'mon-projet', path: myProject }) })
    expect(reg.status).toBe(201)
    expect(existsSync(join(myProject, '.workspace', 'CONTEXT.md'))).toBe(true)
    expect(existsSync(join(myProject, '.workspace', 'memory', 'core.md'))).toBe(true)
    expect(readFileSync(join(myProject, 'src', 'main.py'), 'utf8')).toBe('print("salut")\n') // intact

    // L'arbre vu du modèle : l'ICM caché + le projet visible.
    expect(reg.body.tree).toContain('.workspace/')
    expect(reg.body.tree).toContain('src/')
  },
)

it(
  'logs par session : le trio .logs/<sessionId>/ DANS le dossier de la session',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'logs-m14' }) })
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Profilage M14', workspace: 'logs-m14', security: 'accept' }),
    })
    const sid: string = session.body.id

    // Du vécu : un message, un outil, un tour.
    await api(base, `/sessions/${sid}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'user.message', text: 'bonjour les logs' }),
    })
    await toolCall(base, 'logs-m14', sid, 'read', { path: '.workspace/CONTEXT.md' })
    await toolCall(base, 'logs-m14', sid, 'write', { path: '.workspace/notes/journal.md', content: 'entrée' })
    await api(base, `/sessions/${sid}/turn`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-2.5-flash', rounds: 2, ms: 4_200, outcome: 'ok', toolCalls: 2, thinkingChars: 0, textChars: 120 }),
    })

    // Le trio par session, DANS le dossier du workspace. Les écritures de
    // profilage sont fire-and-forget : on attend que la dernière ligne
    // (turn.completed) soit bien posée avant de lire.
    const logsRoot = join(spacesDir, 'logs-m14', '.logs', sid)
    await untilIn(join(logsRoot, 'activity.jsonl'), '"turn.completed"')
    await untilIn(join(logsRoot, 'engine.jsonl'), '"turn.completed"')
    expect(existsSync(logsRoot)).toBe(true)
    const engine = readFileSync(join(logsRoot, 'engine.jsonl'), 'utf8')
    const sessionLog = readFileSync(join(logsRoot, 'session.jsonl'), 'utf8')
    const activity = readFileSync(join(logsRoot, 'activity.jsonl'), 'utf8')

    // Chaque fichier porte sa part de l'histoire, en JSONL daté.
    expect(sessionLog).toContain('"session.created"')
    expect(sessionLog).toContain('"user.message"')
    expect(activity).toContain('"tool.call"')
    expect(activity).toContain('"tool.result"')
    expect(activity).toContain('"turn.completed"')
    expect(engine).toContain('"session.open"')
    expect(engine).toContain('"turn.completed"')
    for (const line of `${engine}\n${sessionLog}\n${activity}`.split('\n').filter((l: string) => l.trim() !== '')) {
      expect(JSON.parse(line).at).toBeDefined()
    }

    // Le trio GLOBAL existe toujours (vue engine) — même histoire, autre endroit.
    expect(readFileSync(join(home, '.logs', 'session.jsonl'), 'utf8')).toContain('"session.created"')
    expect(readFileSync(join(home, '.logs', 'activity.jsonl'), 'utf8')).toContain('"tool.call"')

    // Supprimer la session garde son .logs : c'est l'histoire durable.
    const gone = await api(base, `/sessions/${sid}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect(existsSync(join(spacesDir, 'logs-m14', '.logs', sid, 'activity.jsonl'))).toBe(true)
  },
)
