/**
 * Background shell jobs (M12) — Claude-style: an approved command may run
 * detached while the agent goes on working. `shell {"command",
 * "background": true}` spawns the process and returns a jobId at once;
 * `shell_output {"jobId"}` polls what it printed; `shell_kill {"jobId"}`
 * stops it.
 *
 * The registry is in-memory and per workspaces-handler instance: jobs do
 * not survive a restart, and that is stated honestly (unknown jobId →
 * "processus inconnu"). Caps keep a runaway agent honest: 16 live jobs
 * per workspace, 10 minutes wall clock per job (then SIGKILL), 64 KiB
 * per stream. Children are unref'd so the dev server can still close.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { SHELL_BIN } from './tools.ts'

/** Wall clock a background job may not exceed (ms) — then SIGKILL. */
export const JOB_MAX_LIFETIME_MS = 10 * 60 * 1000
/** Max captured bytes per stream (stdout, stderr) per job. */
export const JOB_STREAM_MAX = 65_536
/** Max live jobs per workspace root. */
export const JOB_MAX_PER_WORKSPACE = 16

export interface ShellJobSnapshot {
  jobId: string
  command: string
  workspace: string
  startedAt: number
  /** null while running; number (or 'signal' as string upstream) at exit. */
  exitCode: number | null
  running: boolean
  killed: boolean
  timedOut: boolean
  truncated: boolean
  stdout: string
  stderr: string
}

interface ShellJob extends ShellJobSnapshot {
  child: ChildProcess
}

const refusal = (summary: string): { ok: false; summary: string } => ({ ok: false, summary })

let jobSeq = 0
const nextJobId = (): string => `job-${Date.now().toString(36)}-${(jobSeq++).toString(36)}`

/** Registry of background shell jobs — one per workspaces handler. */
export class ShellJobRegistry {
  private readonly jobs = new Map<string, ShellJob>()

  /** Spawns a detached job for a workspace root. Resolves with the jobId. */
  spawn(workspace: string, root: string, command: string): { ok: true; job: ShellJobSnapshot } | { ok: false; summary: string } {
    const live = [...this.jobs.values()].filter((j) => j.workspace === workspace && j.running)
    if (live.length >= JOB_MAX_PER_WORKSPACE) {
      return refusal(`trop de processus en arrière-plan pour « ${workspace} » (max ${JOB_MAX_PER_WORKSPACE}) — arrête-en un (shell_kill) avant d'en lancer un autre`)
    }
    let child: ChildProcess
    try {
      child = spawn(SHELL_BIN, ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return refusal(`lancement impossible (${err instanceof Error ? err.message : String(err)})`)
    }
    const jobId = nextJobId()
    const job: ShellJob = {
      jobId,
      command,
      workspace,
      startedAt: Date.now(),
      exitCode: null,
      running: true,
      killed: false,
      timedOut: false,
      truncated: false,
      stdout: '',
      stderr: '',
      child,
    }
    const collect = (into: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      const next = (job[into] + chunk.toString('utf8')).slice(0, JOB_STREAM_MAX)
      if (next.length >= JOB_STREAM_MAX) job.truncated = true
      job[into] = next
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    // The timer is unref'd: an idle background job must not hold the dev
    // server open; it still SIGKILLs at the cap while the process lives.
    const timer = setTimeout(() => {
      if (job.running) {
        job.timedOut = true
        job.child.kill('SIGKILL')
      }
    }, JOB_MAX_LIFETIME_MS)
    timer.unref?.()
    child.on('error', () => {
      job.running = false
      job.exitCode = null
    })
    child.on('close', (code) => {
      job.running = false
      job.exitCode = code === null ? null : code
    })
    child.unref()
    this.jobs.set(jobId, job)
    this.evict(workspace)
    return { ok: true, job: this.snapshot(job) }
  }

  /** Current output of a job — running or finished. */
  output(workspace: string, jobId: string): { ok: true; job: ShellJobSnapshot } | { ok: false; summary: string } {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      return refusal(`processus inconnu « ${jobId} » — un redémarrage du serveur efface les jobs d'arrière-plan`)
    }
    if (job.workspace !== workspace) {
      return refusal(`le processus « ${jobId} » n'appartient pas à ce workspace`)
    }
    return { ok: true, job: this.snapshot(job) }
  }

  /** Kills a job. Killing an already-finished job is honest, not an error. */
  kill(workspace: string, jobId: string): { ok: true; job: ShellJobSnapshot } | { ok: false; summary: string } {
    const job = this.jobs.get(jobId)
    if (job === undefined) {
      return refusal(`processus inconnu « ${jobId} » — un redémarrage du serveur efface les jobs d'arrière-plan`)
    }
    if (job.workspace !== workspace) {
      return refusal(`le processus « ${jobId} » n'appartient pas à ce workspace`)
    }
    if (job.running) {
      job.killed = true
      job.child.kill('SIGKILL')
      job.running = false
    }
    return { ok: true, job: this.snapshot(job) }
  }

  /** Live + finished jobs of a workspace (finished kept for reading, oldest evicted). */
  list(workspace: string): ShellJobSnapshot[] {
    return [...this.jobs.values()].filter((j) => j.workspace === workspace).map((j) => this.snapshot(j))
  }

  /** Kills everything (server shutdown). */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.running) job.child.kill('SIGKILL')
    }
    this.jobs.clear()
  }

  /** Keeps at most JOB_MAX_PER_WORKSPACE * 2 entries per workspace: finished first out. */
  private evict(workspace: string): void {
    const ofWs = [...this.jobs.values()].filter((j) => j.workspace === workspace)
    const limit = JOB_MAX_PER_WORKSPACE * 2
    if (ofWs.length <= limit) return
    for (const j of ofWs.sort((a, b) => Number(a.running) - Number(b.running) || a.startedAt - b.startedAt)) {
      this.jobs.delete(j.jobId)
      if (this.jobs.size <= limit) break
    }
  }

  private snapshot(job: ShellJob): ShellJobSnapshot {
    const { child: _child, ...rest } = job
    return rest
  }
}
