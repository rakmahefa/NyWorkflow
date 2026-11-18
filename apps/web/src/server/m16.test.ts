import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M16 delivery proof, over the REAL app config:
 *
 *  - POST /sessions/:id/response logs one round's MODEL RESPONSE to the
 *    4th profiling log (model.jsonl) — global home AND the session's own
 *    .logs/<sessionId>/ — with the protocol compliance computed SERVER
 *    side (thinking first? thinking titled? tool_calls titled?);
 *  - the base ICM now documents the harness (harness/) and the tools
 *    (tools/ + one rigorous fiche per tool), and the scaffold loads 9
 *    CONTEXT.md (cap raised to 12);
 *  - a pre-M16 .workspace/ is UPGRADED: missing base files added, the
 *    agent's living memory untouched.
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
  home = mkdtempSync(join(tmpdir(), 'nyw-m16-home-'))
  spacesDir = mkdtempSync(join(tmpdir(), 'nyw-m16-spaces-'))
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
  'model.jsonl : la réponse du modèle par round, conformité protocole calculée serveur, global + par session',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Workspace M16 (harness/ + tools/ dans le scaffold) + session liée.
    const ws = await api(base, '/workspaces', { method: 'POST', body: JSON.stringify({ name: 'modelog' }) })
    expect(ws.status).toBe(201)
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Log modèle', workspace: 'modelog' }),
    })
    expect(session.status).toBe(201)
    const sid: string = session.body.id

    // L'ICM M16+M19 : 10 contexts chargés, protocole trois temps + arsenal dans le prompt.
    const icm = await api(base, '/workspaces/modelog/icm')
    expect(icm.body.contexts).toHaveLength(10)
    expect(icm.body.system).toContain('Protocole de réponse — trois temps')
    expect(icm.body.system).toContain('Le temps de l’observation')
    expect(icm.body.system).toContain('Évalue tes moyens — l’arsenal')

    // Round conforme : thinking titré en premier, appels titrés.
    const ok1 = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 1,
        ms: 4200,
        outcome: 'tool_calls',
        firstEvent: 'thinking',
        systemChars: 21_500,
        messages: 6,
        thinkingChars: 521,
        textChars: 140,
        thinkingTitles: ['Comprendre la demande'],
        thinking: '<thinking title="Comprendre la demande">…</thinking>',
        text: 'Je lis la carte et le plan ensemble.',
        toolCalls: [
          { tool: 'read', title: 'Lire la charte', args: { path: '.workspace/CONTEXT.md' } },
          { tool: 'read', title: 'Lire le plan', args: { path: '.workspace/notes/plan.md' } },
        ],
      }),
    })
    expect(ok1.status).toBe(201)

    // Round NON conforme : prose d'abord, pas de titre, appel sans titre.
    const ok2 = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 2,
        ms: 900,
        outcome: 'tool_calls',
        firstEvent: 'text',
        systemChars: 21_500,
        messages: 10,
        thinkingChars: 0,
        textChars: 80,
        thinkingTitles: [],
        text: 'Je vais lire le fichier.',
        toolCalls: [{ tool: 'read', args: { path: 'a.md' } }],
      }),
    })
    expect(ok2.status).toBe(201)

    // Le journal GLOBAL du modèle porte les deux rounds.
    const globalModel = await untilIn(join(home, '.logs', 'model.jsonl'), '"round":2')
    const lines = globalModel.split('\n').filter((l) => l.includes('"model.response"'))
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] as string)
    expect(first.model).toBe('gemini-3.5-flash')
    expect(first.systemChars).toBe(21_500)
    expect(first.thinking).toContain('Comprendre la demande')
    expect(first.protocol).toEqual({ thinkingFirst: true, thinkingTitled: true, toolCalls: 2, toolCallsTitled: 2, argsOk: true })
    const second = JSON.parse(lines[1] as string)
    expect(second.protocol).toEqual({ thinkingFirst: false, thinkingTitled: false, toolCalls: 1, toolCallsTitled: 0, argsOk: true })
    expect(second.toolCalls[0].tool).toBe('read')
    expect(second.toolCalls[0].title).toBe('')

    // Le journal PAR SESSION, dans le dossier de la session, porte le round 1
    // avec le workspace en plus.
    const wsRoot = join(spacesDir, 'modelog')
    const perSession = await untilIn(join(wsRoot, '.logs', sid, 'model.jsonl'), '"round":1')
    const perLine = JSON.parse(perSession.split('\n').find((l) => l.includes('"model.response"')) as string)
    expect(perLine.workspace).toBe('modelog')
    expect(perLine.protocol.thinkingFirst).toBe(true)

    // La queue /logs sert le journal du modèle comme les autres.
    const tail = await api(base, '/logs/model.jsonl?tail=10')
    expect(tail.status).toBe(200)
    expect(tail.body.tail).toContain('model.response')

    // Validation honnête : model vide, outcome inconnu, session inconnue.
    const noModel = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({ model: '', round: 1, outcome: 'ok' }),
    })
    expect(noModel.status).toBe(400)
    const badOutcome = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm', round: 1, outcome: 'peut-etre' }),
    })
    expect(badOutcome.status).toBe(400)
    const unknown = await api(base, '/sessions/s-unknown/response', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', round: 1, outcome: 'ok' }),
    })
    expect(unknown.status).toBe(404)

    // Un round en échec est journalisé aussi (où le flux s'est arrêté).
    const failed = await api(base, `/sessions/${sid}/response`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'gemini-3.5-flash',
        round: 3,
        ms: 300,
        outcome: 'error',
        firstEvent: 'thinking',
        systemChars: 21_500,
        messages: 12,
        thinkingChars: 40,
        textChars: 0,
        thinkingTitles: ['Démarrage'],
        thinking: '…',
        text: '',
        toolCalls: [],
        error: 'flux coupé par l’amont',
      }),
    })
    expect(failed.status).toBe(201)
    const withError = await untilIn(join(home, '.logs', 'model.jsonl'), '"round":3')
    expect(withError).toContain('"error":"flux coupé par l’amont"')
  },
)

it(
  'upgrade : un .workspace/ d’avant M16 reçoit harness/ + tools/ sans toucher à la mémoire vivante',
  { timeout: 120_000 },
  async () => {
    const base = await boot()

    // Un dossier du disque avec un .workspace/ d’avant M16 (pas de harness/, ni tools/).
    const pilotDir = mkdtempSync(join(tmpdir(), 'nyw-m16-pilot-'))
    mkdirSync(join(pilotDir, '.workspace', 'notes'), { recursive: true })
    writeFileSync(join(pilotDir, '.workspace', 'CONTEXT.md'), '# Charte VIVANTE écrite par l’agent')
    writeFileSync(join(pilotDir, '.workspace', 'notes', 'plan.md'), '# MON plan, pas un template')
    writeFileSync(join(pilotDir, 'projet.md'), 'le projet du pilote')

    const reg = await api(base, '/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'ancien', path: pilotDir }),
    })
    expect(reg.status).toBe(201)
    const session = await api(base, '/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Ancien workspace', workspace: 'ancien' }),
    })
    expect(session.status).toBe(201)

    // La mémoire vivante est INTACTE, et la base M16 est là — dans le
    // dossier EXTERNE enregistré (le vrai root du workspace au manifeste).
    expect(readFileSync(join(pilotDir, '.workspace', 'CONTEXT.md'), 'utf8')).toBe('# Charte VIVANTE écrite par l’agent')
    expect(readFileSync(join(pilotDir, '.workspace', 'notes', 'plan.md'), 'utf8')).toBe('# MON plan, pas un template')
    expect(existsSync(join(pilotDir, '.workspace', 'harness', 'CONTEXT.md'))).toBe(true)
    expect(existsSync(join(pilotDir, '.workspace', 'harness', 'ENGINE.md'))).toBe(true)
    expect(existsSync(join(pilotDir, '.workspace', 'tools', 'CONTEXT.md'))).toBe(true)
    for (const fiche of ['read.md', 'write.md', 'ls.md', 'glob.md', 'mkdir.md', 'shell.md', 'websearch.md', 'shell_output.md', 'shell_kill.md']) {
      expect(existsSync(join(pilotDir, '.workspace', 'tools', fiche)), fiche).toBe(true)
    }
    // Les fichiers du pilote sont intacts.
    expect(readFileSync(join(pilotDir, 'projet.md'), 'utf8')).toBe('le projet du pilote')
    rmSync(pilotDir, { recursive: true, force: true })
  },
)
