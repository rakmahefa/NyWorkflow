import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkToolCall, executeToolCall, isDangerous, ShellJobRegistry, JOB_MAX_PER_WORKSPACE } from './index'
import type { ToolCall, ToolRuntime } from './index'

// M12 — shell en arrière-plan (à la Claude) : spawn détaché après
// approbation, jobId rendu immédiatement, suivi par shell_output, arrêt
// par shell_kill. Bornes : 16 jobs vivants par workspace, 10 minutes,
// 64 Kio par flux. Les deux nouveaux outils sont libres : ils ne touchent
// que les processus que l'agent lui-même a lancés.

const roots: string[] = []
let registrySeq = 0

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), `nyw-jobs-${registrySeq++}-`))
  roots.push(dir)
  writeFileSync(join(dir, 'CONTEXT.md'), '# Carte\n', 'utf8')
  return dir
}

function runtime(root: string, jobs: ShellJobRegistry): ToolRuntime {
  return { workspace: 'ws-test', jobs }
}

const bgShell = (command: string): ToolCall => ({ tool: 'shell', args: { command, background: true } })
const outputOf = (jobId: string): ToolCall => ({ tool: 'shell_output', args: { jobId } })
const killOf = (jobId: string): ToolCall => ({ tool: 'shell_kill', args: { jobId } })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('validation (M12)', () => {
  it('shell_output et shell_kill sont des outils connus et libres', async () => {
    const root = sandbox()
    expect(isDangerous('shell_output')).toBe(false)
    expect(isDangerous('shell_kill')).toBe(false)
    for (const call of [outputOf('j1'), killOf('j1')]) {
      const check = await checkToolCall(root, call)
      expect(check.ok).toBe(true)
      expect(check.approval).toBe(false)
    }
  })

  it('shell_output sans jobId → invalid_args', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, { tool: 'shell_output', args: {} }, false)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('invalid_args')
  })

  it('background non booléen → invalid_args', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, { tool: 'shell', args: { command: 'ls', background: 'oui' } }, false, runtime(root, new ShellJobRegistry()))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('invalid_args')
  })

  it('sans registre : arrière-plan et suivi refusés honnêtement', async () => {
    const root = sandbox()
    const bg = await executeToolCall(root, bgShell('sleep 1'), true)
    expect(bg.ok).toBe(false)
    if (!bg.ok) expect(bg.summary).toContain('arrière-plan indisponible')

    const out = await executeToolCall(root, outputOf('job-x'), false)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.summary).toContain('shell_output')
  })
})

describe('shell en arrière-plan (M12)', () => {
  it('rend un jobId immédiatement, sans attendre la commande', async () => {
    const root = sandbox()
    const jobs = new ShellJobRegistry()
    const started = Date.now()
    const out = await executeToolCall(root, bgShell('sleep 2 && echo fini'), true, runtime(root, jobs))
    expect(Date.now() - started).toBeLessThan(1000) // pas attendu les 2 s
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { jobId: string; background: boolean }
      expect(data.background).toBe(true)
      expect(data.jobId).toMatch(/^job-/)
      // Le job vit encore.
      const live = jobs.output('ws-test', data.jobId)
      expect(live.ok).toBe(true)
      if (live.ok) expect(live.job.running).toBe(true)
      jobs.killAll()
    }
  })

  it('shell_output suit la sortie, puis le code de sortie', async () => {
    const root = sandbox()
    const jobs = new ShellJobRegistry()
    const spawn = await executeToolCall(root, bgShell('echo coucou-bg'), true, runtime(root, jobs))
    expect(spawn.ok).toBe(true)
    if (!spawn.ok) return
    const { jobId } = spawn.data as { jobId: string }

    await sleep(400) // laisse la commande finir
    const out = await executeToolCall(root, outputOf(jobId), false, runtime(root, jobs))
    expect(out.ok).toBe(true)
    if (out.ok) {
      const snap = out.data as { stdout: string; exitCode: number | null; running: boolean }
      expect(snap.stdout).toContain('coucou-bg')
      expect(snap.running).toBe(false)
      expect(snap.exitCode).toBe(0)
    }
  })

  it('shell_kill arrête un job vivant ; tuer un job fini reste ok', async () => {
    const root = sandbox()
    const jobs = new ShellJobRegistry()
    const spawn = await executeToolCall(root, bgShell('sleep 30'), true, runtime(root, jobs))
    expect(spawn.ok).toBe(true)
    if (!spawn.ok) return
    const { jobId } = spawn.data as { jobId: string }

    const kill = await executeToolCall(root, killOf(jobId), false, runtime(root, jobs))
    expect(kill.ok).toBe(true)
    if (kill.ok) {
      const snap = kill.data as { killed: boolean; running: boolean }
      expect(snap.killed).toBe(true)
      expect(snap.running).toBe(false)
    }

    const again = await executeToolCall(root, killOf(jobId), false, runtime(root, jobs))
    expect(again.ok).toBe(true) // idempotent, honnête
  })

  it('jobId inconnu ou d’un autre workspace → refus clair (redémarrage compris)', async () => {
    const root = sandbox()
    const jobs = new ShellJobRegistry()
    const unknown = await executeToolCall(root, outputOf('job-nulle-part'), false, runtime(root, jobs))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.summary).toContain('processus inconnu')

    // Un job d'un autre workspace n'est pas visible ici (même registre).
    const spawn = jobs.spawn('autre-ws', root, 'sleep 1')
    expect(spawn.ok).toBe(true)
    if (spawn.ok) {
      const stolen = await executeToolCall(root, outputOf(spawn.job.jobId), false, runtime(root, jobs))
      expect(stolen.ok).toBe(false)
      if (!stolen.ok) expect(stolen.summary).toContain("n'appartient pas")
    }
    jobs.killAll()
  })

  it('plafond de jobs vivants par workspace', () => {
    const root = sandbox()
    const jobs = new ShellJobRegistry()
    for (let i = 0; i < JOB_MAX_PER_WORKSPACE; i++) {
      expect(jobs.spawn('ws-test', root, `sleep 5 #${i}`).ok).toBe(true)
    }
    const full = jobs.spawn('ws-test', root, 'sleep 5')
    expect(full.ok).toBe(false)
    if (!full.ok) expect(full.summary).toContain('trop de processus')
    // Un autre workspace n'est pas pénalisé.
    expect(jobs.spawn('ws-autre', root, 'sleep 1').ok).toBe(true)
    jobs.killAll()
  })
})
