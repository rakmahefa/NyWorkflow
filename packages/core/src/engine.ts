/**
 * Execution — one stage at a time, the filesystem as orchestrator.
 *
 * Chaining: a stage's declared inputs are loaded from disk at call time,
 * never cached — the output of stage N is the input of stage N+1 because the
 * contract says so, and a human may edit any file between two stages (the
 * next stage reads the edited version).
 *
 * Checkpoints: createRun pauses after every stage (RunState 'checkpoint');
 * the caller resumes manually with advance(). Run state survives restarts:
 * runStateFromEvents re-derives it from the session journal (append-only,
 * the single source of truth), so the web server can serve /workspaces
 * statelessly.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionEvent } from '@nyworkflow/session'
import type { RunState, StageContract, Workspace } from './index'
import { assembleStageMessages, workspaceName } from './prompt.ts'
import type { LoadedInput, StageLlm } from './prompt.ts'

/** Options of a single stage execution. */
export interface RunStageOptions {
  workspace: Workspace
  /** Stage folder name, e.g. '01-recherche'. */
  stage: string
  /** The run subject (the question asked in the UI), if this stage needs it. */
  subject?: string
  llm: StageLlm
  model: string
  /** Cancels the stream; no output is written on abort. */
  signal?: AbortSignal
  /** Streaming hook (tokens as they arrive — the UI, logs). */
  onToken?: (delta: string) => void
  /** Called as events occur (stage.started before the call, stage.output after the write). */
  onEvent?: (event: SessionEvent) => void | Promise<void>
  /** Injectable clock (tests). Default: real time. */
  now?: () => string
}

/** What one stage execution produced. */
export interface RunStageResult {
  stage: string
  /** The model's reply, exactly what was written. */
  reply: string
  /** Workspace-relative POSIX paths of the files written. */
  outputs: string[]
  /** Events emitted, in order. */
  events: SessionEvent[]
}

/** Guards that `target` stays strictly inside `base` (lexical check). */
function inside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function findContract(workspace: Workspace, stage: string): StageContract {
  const contract = workspace.stages.find((s) => s.stage === stage)
  if (!contract) throw new Error(`étape inconnue « ${stage} » — étapes : ${workspace.stages.map((s) => s.stage).join(', ')}`)
  return contract
}

/**
 * Loads every declared input of a stage, fresh from disk. Non-file inputs
 * (source '') carry the run subject. Missing files and missing subject throw
 * clear French errors.
 */
export async function loadStageInputs(
  workspace: Workspace,
  contract: StageContract,
  subject?: string,
): Promise<LoadedInput[]> {
  const root = resolve(workspace.root)
  const loaded: LoadedInput[] = []
  for (const ref of contract.inputs) {
    if (ref.source === '') {
      if (subject === undefined || subject.trim() === '') {
        throw new Error(
          `l'étape « ${contract.stage} » attend le sujet de la requête (entrée « ${ref.origin ?? 'Sujet'} ») — transmettez-le au lancement du run`,
        )
      }
      loaded.push({ ref, content: subject })
      continue
    }
    const target = resolve(root, ref.source)
    if (!inside(root, target)) {
      throw new Error(`entrée hors workspace : ${ref.source}`)
    }
    let content: string
    try {
      content = await readFile(target, 'utf8')
    } catch (err) {
      throw new Error(
        `entrée manquante : ${ref.source} (${ref.origin ?? 'entrée'}) — l'étape précédente ne s'est-elle pas exécutée, ou le fichier a-t-il été déplacé ?`,
      )
    }
    loaded.push({ ref, content })
  }
  return loaded
}

/** Writes the reply to the stage's first declared output. Returns the workspace-relative path. */
async function writeOutput(workspace: Workspace, contract: StageContract, reply: string): Promise<string> {
  if (contract.outputs.length === 0) {
    throw new Error(`aucune sortie déclarée pour « ${contract.stage} » — rien à écrire`)
  }
  if (contract.outputs.length > 1) {
    throw new Error(
      `une seule sortie par étape est supportée en v1 — « ${contract.stage} » en déclare ${contract.outputs.length}`,
    )
  }
  const stageDir = resolve(workspace.root, contract.stage)
  const target = resolve(stageDir, contract.outputs[0] as string)
  if (!inside(stageDir, target)) {
    throw new Error(`sortie hors du dossier de l'étape : ${contract.outputs[0]}`)
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, reply, 'utf8')
  return [contract.stage, contract.outputs[0]].join('/')
}

/**
 * Executes one stage: inputs loaded fresh → context assembled → LLM stream →
 * output written. Emits stage.started before the model call and stage.output
 * after the write (through onEvent, awaited).
 */
export async function runStage(options: RunStageOptions): Promise<RunStageResult> {
  const { workspace, llm, model, signal, onToken, onEvent } = options
  const now = options.now ?? (() => new Date().toISOString())
  const contract = findContract(workspace, options.stage)
  const events: SessionEvent[] = []

  const emit = async (event: SessionEvent): Promise<void> => {
    events.push(event)
    await onEvent?.(event)
  }

  await emit({ type: 'stage.started', at: now(), stage: contract.stage })

  const loaded = await loadStageInputs(workspace, contract, options.subject)
  const messages = assembleStageMessages({
    workspace: workspaceName(workspace.root),
    contract,
    map: workspace.map,
    loaded,
  })

  let reply = ''
  for await (const token of llm.chatStream({ model, messages, signal })) {
    if (signal?.aborted) break
    reply += token
    onToken?.(token)
  }
  if (signal?.aborted) {
    throw new Error(`flux interrompu pour « ${contract.stage} » — aucune sortie écrite`)
  }
  if (reply.trim() === '') {
    throw new Error(`réponse vide du modèle pour « ${contract.stage} » — aucune sortie écrite`)
  }

  const output = await writeOutput(workspace, contract, reply)
  await emit({ type: 'stage.output', at: now(), stage: contract.stage, files: [output] })

  return { stage: contract.stage, reply, outputs: [output], events }
}

/**
 * Re-derives the run state from a session journal (append-only truth):
 *   - run.completed present            → done (its stages list)
 *   - some stages have a stage.output   → checkpoint after the last one in
 *                                          workspace order; a stage is done
 *                                          only when it has an output
 *   - nothing finished yet              → idle (an interrupted stage.started
 *                                          means the stage re-runs)
 * Stages of other workspaces or unknown names are ignored.
 */
export function runStateFromEvents(events: readonly SessionEvent[], workspace: Workspace): RunState {
  // run.completed is authoritative: the journal says the run is over.
  const lastRun = [...events].reverse().find((e) => e.type === 'run.completed')
  if (lastRun && lastRun.type === 'run.completed') {
    return { status: 'done', stages: lastRun.stages }
  }

  const names = new Set(workspace.stages.map((s) => s.stage))
  const done = new Set<string>()
  for (const e of events) {
    if (e.type === 'stage.output' && names.has(e.stage)) done.add(e.stage)
  }

  const unfinished = workspace.stages.find((s) => !done.has(s.stage))
  if (unfinished === undefined) {
    // Every stage has an output but no run.completed: crash between the
    // last output and the completion event — one checkpoint away from done.
    return { status: 'checkpoint', stage: workspace.stages[workspace.stages.length - 1]?.stage ?? '' }
  }

  const index = workspace.stages.indexOf(unfinished)
  if (index <= 0) return { status: 'idle' }
  return { status: 'checkpoint', stage: (workspace.stages[index - 1] as StageContract).stage }
}

/** Options of a checkpointed run. */
export interface CreateRunOptions {
  workspace: Workspace
  /** The run subject (the question asked in the UI). */
  subject?: string
  llm: StageLlm
  model: string
  signal?: AbortSignal
  onToken?: (delta: string) => void
  /** Journal hook: every event of the run, in order (stage + run.completed). */
  onEvent?: (event: SessionEvent) => void | Promise<void>
  /** Prior journal events — resume a run after a restart (default: fresh run). */
  initialEvents?: readonly SessionEvent[]
  now?: () => string
}

/** A checkpointed run: advance() executes the next stage, then pauses. */
export interface WorkflowRun {
  /** Current state — meaningful between advance() calls. */
  state(): RunState
  /**
   * Executes the next unfinished stage, then pauses at a checkpoint (or
   * done). Rejects on execution failure; the state becomes 'error' and the
   * next advance() retries the same stage. From 'done': no-op.
   */
  advance(): Promise<RunState>
}

/** First workspace stage without an output in `done`; undefined when all are done. */
function nextStage(workspace: Workspace, done: ReadonlySet<string>): StageContract | undefined {
  return workspace.stages.find((s) => !done.has(s.stage))
}

/**
 * Creates a checkpointed run. With initialEvents (a replayed journal), the
 * run resumes where the filesystem left off: finished stages are skipped,
 * the first unfinished one re-runs.
 */
export function createRun(options: CreateRunOptions): WorkflowRun {
  const { workspace, llm, model, subject, signal, onToken, onEvent, now } = options
  const root = resolve(workspace.root)
  const allStages = workspace.stages.map((s) => s.stage)

  const done = new Set<string>()
  for (const e of options.initialEvents ?? []) {
    if (e.type === 'stage.output' && allStages.includes(e.stage)) done.add(e.stage)
  }
  const hasCompletedEvent = (options.initialEvents ?? []).some((e) => e.type === 'run.completed')

  let state: RunState = hasCompletedEvent
    ? { status: 'done', stages: allStages }
    : runStateFromEvents(options.initialEvents ?? [], workspace)

  const emit = async (event: SessionEvent): Promise<void> => {
    await onEvent?.(event)
  }

  return {
    state: () => state,

    async advance(): Promise<RunState> {
      if (state.status === 'done') return state
      const contract = nextStage(workspace, done)
      if (contract === undefined) {
        // Every stage has an output but the journal lacks run.completed
        // (crash between the last output and the completion event): finish.
        await emit({ type: 'run.completed', at: (now ?? (() => new Date().toISOString()))(), stages: allStages })
        state = { status: 'done', stages: allStages }
        return state
      }
      state = { status: 'running', stage: contract.stage }
      try {
        const result = await runStage({
          workspace: { ...workspace, root },
          stage: contract.stage,
          subject,
          llm,
          model,
          signal,
          onToken,
          onEvent: emit,
          now,
        })
        done.add(result.stage)
        const isLast = workspace.stages[workspace.stages.length - 1]?.stage === result.stage
        if (isLast) {
          await emit({ type: 'run.completed', at: (now ?? (() => new Date().toISOString()))(), stages: allStages })
          state = { status: 'done', stages: allStages }
        } else {
          state = { status: 'checkpoint', stage: result.stage }
        }
        return state
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state = { status: 'error', stage: contract.stage, message }
        throw err
      }
    },
  }
}
