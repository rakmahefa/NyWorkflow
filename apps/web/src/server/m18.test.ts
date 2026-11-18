import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest'
import { createServer as createViteServer } from 'vite'
import type { ViteDevServer } from 'vite'

/**
 * M18 — the « accept » parallel race, over the REAL app config: a dangerous
 * call EXECUTING server-side (auto-approved) must not block its siblings
 * of the same parallel round. Seen in the wild (logs.zip): a 240 ms shell
 * left five parallel writes stranded — one lost to an unfair 409 (« un
 * appel d'outil dangereux est déjà en attente ») while the shell was
 * simply RUNNING. The guard now distinguishes « executing » (an in-memory
 * set of callIds) from « waiting for a human » (the journal's open call),
 * and only the latter refuses new calls.
 */

let server: ViteDevServer | undefined
let home = ''
let spaces = ''
const prevEnv = { NYW_HOME: process.env.NYW_HOME, NYW_WORKSPACES: process.env.NYW_WORKSPACES }

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'nyw-race-'))
  spaces = mkdtempSync(join(tmpdir(), 'nyw-race-ws-'))
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
    body: JSON.stringify({ title: 'Parallèle', workspace: wsName, security }),
  })
  expect(created.status).toBe(201)
  return created.body.id as string
}

it(
  '« accept » : un dangereux en cours d’exécution ne bloque pas ses frères parallèles',
  { timeout: 60_000 },
  async () => {
    const base = await boot()
    const id = await sessionAt(base, 'accept', 'course-accept')

    // The round the browser really dispatches under « accept »: one shell
    // (dangerous, ~300 ms of execution) alongside a write — IN PARALLEL.
    // Before M18 the write could read the shell's open journal entry as
    // « waiting for a human » and die to an unfair 409.
    const shellP = api(base, '/workspaces/course-accept/tool', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: id,
        tool: 'shell',
        args: { command: 'sleep 0.3 && echo course', title: 'La commande lente' },
      }),
    })
    const writeP = api(base, '/workspaces/course-accept/tool', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: id,
        tool: 'write',
        args: { path: 'outputs/frere.md', content: 'frère du shell', title: 'Écrire à côté' },
      }),
    })
    const [shell, write] = await Promise.all([shellP, writeP])

    expect(shell.status).toBe(200)
    expect(shell.body.status).toBe('executed')
    expect(shell.body.outcome.ok).toBe(true)
    expect(write.status).toBe(200)
    expect(write.body.status).toBe('executed')
    expect(write.body.outcome.ok).toBe(true)

    // The journal closes both calls — nothing left pending.
    const listed = ((await api(base, '/sessions')).body.sessions as any[]).find((s) => s.id === id)
    const types = listed.events.map((e: any) => e.type)
    expect(types.filter((t: string) => t === 'tool.call').length).toBe(2)
    expect(types.filter((t: string) => t === 'tool.result').length).toBe(2)
  },
)

it(
  '« ask » : un dangereux en attente d’approbation refuse toujours les nouveaux appels',
  { timeout: 60_000 },
  async () => {
    const base = await boot()
    const id = await sessionAt(base, 'ask', 'course-ask')

    // A dangerous call under « ask »: journaled, waiting for the human.
    const shell = await api(base, '/workspaces/course-ask/tool', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: id,
        tool: 'shell',
        args: { command: 'echo en-attente', title: 'Attendre l’humain' },
      }),
    })
    expect(shell.status).toBe(200)
    expect(shell.body.status).toBe('pending')

    // While the decision hangs, a new call is STILL refused (the gate
    // stays strictly one-at-a-time — the M12 contract is intact).
    const write = await api(base, '/workspaces/course-ask/tool', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: id,
        tool: 'write',
        args: { path: 'outputs/interdit.md', content: 'x', title: 'Pendant l’attente' },
      }),
    })
    expect(write.status).toBe(409)
    expect(write.body.error).toContain('déjà en attente')

    // The pilot decides: the call executes, the session unblocks.
    const decision = await api(base, '/workspaces/course-ask/tool/decision', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, decision: 'approve' }),
    })
    expect(decision.status).toBe(200)
    expect(decision.body.outcome.ok).toBe(true)

    // After the decision, a SAFE call goes through right away (a write
    // would itself wait for approval under « ask » — the gate stays).
    const after = await api(base, '/workspaces/course-ask/tool', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: id,
        tool: 'ls',
        args: { path: '.', title: 'Après la décision' },
      }),
    })
    expect(after.status).toBe(200)
    expect(after.body.status).toBe('executed')
    expect(after.body.outcome.ok).toBe(true)
  },
)
