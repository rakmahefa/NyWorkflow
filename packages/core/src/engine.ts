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
 *
 * Tools (M5): with options.tools, the stage becomes a small agent loop.
 * The model may call read/ls/glob (auto-executed, scoped to the workspace
 * root) and write. A valid, scoped write PAUSES the stage — RunState
 * 'approval' — until a human decides through resolve('approve'|'refuse'):
 * approved, the write runs and the loop continues; refused, the model is
 * told and continues without it. Every call and outcome is journaled
 * (tool.call / tool.result); an out-of-scope call is refused AND journaled,
 * never silently dropped. resumeStage rebuilds the conversation from the
 * journal — tool.result.data makes the replay byte-faithful, so a run
 * paused before a restart resumes exactly where it was.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { checkToolCall, executeToolCall, refusedByUser, displayPath } from '@nyworkflow/tools'
import type { ToolCall, ToolOutcome, ToolRefusal } from '@nyworkflow/tools'
import type { SessionEvent } from '@nyworkflow/session'
import type { RunState, StageContract, Workspace } from './index'
import { assembleStageMessages, workspaceName } from './prompt.ts'
import type { LoadedInput, StageChatMessage, StageLlm } from './prompt.ts'
import { outcomeAsFact, parseToolRequest, renderToolResult, serializeToolRequest } from './protocol.ts'

/** Tool calls per stage attempt, replayed ones included. */
export const MAX_TOOL_CALLS = 8

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
  /** M5: enable the tool loop — read/ls/glob auto, write pauses for approval. */
  tools?: boolean
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

/**
 * Thrown when a valid, scoped write pauses the stage for a human approval.
 * tool.call is already journaled at this point; tool.result follows the
 * decision. createRun.advance() catches this and settles on RunState
 * 'approval' — never an error.
 */
export class ToolApprovalPause extends Error {
  readonly call: ToolCall
  constructor(call: ToolCall) {
    super(`write « ${displayPath(call)} » en attente d'approbation`)
    this.call = call
  }
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

/** Streams one model call to completion; throws on abort (nothing written). */
async function streamOnce(
  llm: StageLlm,
  model: string,
  messages: StageChatMessage[],
  signal: AbortSignal | undefined,
  onToken: ((delta: string) => void) | undefined,
): Promise<string> {
  let reply = ''
  for await (const token of llm.chatStream({ model, messages, signal })) {
    if (signal?.aborted) break
    reply += token
    onToken?.(token)
  }
  if (signal?.aborted) throw new Error('flux interrompu — aucune sortie écrite')
  return reply
}

interface AgentLoopArgs {
  root: string
  stage: string
  llm: StageLlm
  model: string
  signal?: AbortSignal
  onToken?: (delta: string) => void
  now: () => string
  emit: (event: SessionEvent) => Promise<void>
  /** Conversation so far (system + context + replayed tool turns). */
  messages: StageChatMessage[]
  /** Tool calls already spent (replayed ones included). */
  used: number
}

/**
 * The agent loop: model reply → tool request? → journal, check, execute (or
 * pause, or refuse) → feed the outcome back → repeat. Returns the final
 * artifact. The assistant turn of a tool request is ALWAYS the canonical
 * serialization, so a later replay rebuilds the identical conversation.
 */
async function agentLoop(args: AgentLoopArgs): Promise<string> {
  let messages = [...args.messages]
  let used = args.used
  for (;;) {
    const reply = await streamOnce(args.llm, args.model, messages, args.signal, args.onToken)
    const call = parseToolRequest(reply)
    if (call === null) {
      if (reply.trim() === '') {
        throw new Error(`réponse vide du modèle pour « ${args.stage} » — aucune sortie écrite`)
      }
      return reply
    }
    used++
    if (used > MAX_TOOL_CALLS) {
      throw new Error(
        `trop d'appels d'outils pour « ${args.stage} » (max ${MAX_TOOL_CALLS} par tentative) — l'étape peut être relancée`,
      )
    }

    await args.emit({ type: 'tool.call', at: args.now(), tool: call.tool, args: call.args })
    const check = await checkToolCall(args.root, call)
    let outcome: ToolOutcome
    if (!check.ok) {
      // Unknown tool, bad args, out of scope: refused AND journaled — the
      // model is told and may continue without the file.
      outcome = check.refusal as ToolRefusal
    } else if (check.approval) {
      // Valid and scoped, but writing needs a human: pause the stage here.
      throw new ToolApprovalPause(call)
    } else {
      outcome = await executeToolCall(args.root, call, true)
    }
    const fact = outcomeAsFact(outcome)
    await args.emit({ type: 'tool.result', at: args.now(), ok: fact.ok, summary: fact.summary, data: fact.data })

    messages = [
      ...messages,
      { role: 'assistant', content: serializeToolRequest(call) },
      { role: 'user', content: renderToolResult(fact) },
    ]
  }
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
 * output written. With tools, the LLM call becomes the agent loop (see
 * agentLoop). Emits stage.started (carrying the model, M5) before the model
 * call and stage.output after the write (through onEvent, awaited).
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

  await emit({ type: 'stage.started', at: now(), stage: contract.stage, model })

  const loaded = await loadStageInputs(workspace, contract, options.subject)
  const messages = assembleStageMessages({
    workspace: workspaceName(workspace.root),
    contract,
    map: workspace.map,
    loaded,
    tools: options.tools === true,
  })

  const reply =
    options.tools === true
      ? await agentLoop({
          root: resolve(workspace.root),
          stage: contract.stage,
          llm,
          model,
          signal,
          onToken,
          now,
          emit,
          messages,
          used: 0,
        })
      : await streamOnce(llm, model, messages, signal, onToken)

  if (options.tools !== true && reply.trim() === '') {
    throw new Error(`réponse vide du modèle pour « ${contract.stage} » — aucune sortie écrite`)
  }

  const output = await writeOutput(workspace, contract, reply)
  await emit({ type: 'stage.output', at: now(), stage: contract.stage, files: [output] })

  return { stage: contract.stage, reply, outputs: [output], events }
}

/** Events of the CURRENT attempt of `stage`: after its last stage.started. */
function stageAttemptEvents(events: readonly SessionEvent[], stage: string): SessionEvent[] {
  let lastStart = -1
  let i = -1
  for (const e of events) {
    i++
    if (e.type === 'stage.started' && e.stage === stage) lastStart = i
  }
  if (lastStart === -1) return []
  return events.slice(lastStart + 1)
}

/** The pending (unresolved) tool call of a stage's current attempt, if any. */
export function pendingToolCall(
  events: readonly SessionEvent[],
  stage: string,
): { tool: string; args: unknown } | null {
  let open: { tool: string; args: unknown } | null = null
  for (const e of stageAttemptEvents(events, stage)) {
    if (e.type === 'stage.output' && e.stage === stage) return null // attempt completed
    if (e.type === 'tool.call') open = { tool: e.tool, args: e.args }
    else if (e.type === 'tool.result') open = null
  }
  return open
}

/** The model that ran `stage` (its last stage.started) — for approvals. */
export function stageModelFromEvents(events: readonly SessionEvent[], stage: string): string | undefined {
  let model: string | undefined
  for (const e of events) {
    if (e.type === 'stage.started' && e.stage === stage && typeof e.model === 'string' && e.model !== '') model = e.model
  }
  return model
}

/** Options of resumeStage — resolving a paused write, then continuing. */
export interface ResumeStageOptions {
  workspace: Workspace
  stage: string
  subject?: string
  llm: StageLlm
  model: string
  /** The human decision on the pending call. */
  decision: 'approve' | 'refuse'
  /** The run's journal so far (replayed to rebuild the conversation). */
  events: readonly SessionEvent[]
  signal?: AbortSignal
  onToken?: (delta: string) => void
  onEvent?: (event: SessionEvent) => void | Promise<void>
  now?: () => string
}

/**
 * Resolves a paused stage: rebuild the conversation from the journal (the
 * closed tool turns of the current attempt), apply the decision to the
 * pending call (approve → execute and journal; refuse → journal the
 * refusal), then continue the agent loop to the final artifact. stage.started
 * is NOT re-emitted — the attempt is already open in the journal.
 */
export async function resumeStage(options: ResumeStageOptions): Promise<RunStageResult> {
  const { workspace, llm, model, decision, signal, onToken, onEvent } = options
  const now = options.now ?? (() => new Date().toISOString())
  const contract = findContract(workspace, options.stage)
  const events: SessionEvent[] = []

  const emit = async (event: SessionEvent): Promise<void> => {
    events.push(event)
    await onEvent?.(event)
  }

  const pending = pendingToolCall(options.events, contract.stage)
  if (!pending) {
    throw new Error(`aucun appel d'outil en attente pour « ${contract.stage} » — rien à reprendre`)
  }

  const loaded = await loadStageInputs(workspace, contract, options.subject)
  let messages = assembleStageMessages({
    workspace: workspaceName(workspace.root),
    contract,
    map: workspace.map,
    loaded,
    tools: true,
  })

  // Replay the closed turns of this attempt, exactly as the model saw them.
  let used = 0
  let open: { tool: string; args: unknown } | null = null
  for (const e of stageAttemptEvents(options.events, contract.stage)) {
    if (e.type === 'tool.call') {
      open = { tool: e.tool, args: e.args }
      used++
    } else if (e.type === 'tool.result' && open) {
      messages = [
        ...messages,
        { role: 'assistant', content: serializeToolRequest(open as ToolCall) },
        { role: 'user', content: renderToolResult({ ok: e.ok, summary: e.summary, data: e.data }) },
      ]
      open = null
    }
  }
  if (!open) {
    throw new Error(`incohérence de journal : aucun appel en attente pour « ${contract.stage} »`)
  }

  // The pending call: announce it, resolve it, feed the outcome back.
  const call: ToolCall = { tool: open.tool as ToolCall['tool'], args: (open.args ?? {}) as Record<string, unknown> }
  messages = [...messages, { role: 'assistant', content: serializeToolRequest(call) }]
  const outcome = decision === 'approve' ? await executeToolCall(resolve(workspace.root), call, true) : refusedByUser(call)
  const fact = outcomeAsFact(outcome)
  await emit({ type: 'tool.result', at: now(), ok: fact.ok, summary: fact.summary, data: fact.data })
  messages = [...messages, { role: 'user', content: renderToolResult(fact) }]

  const reply = await agentLoop({
    root: resolve(workspace.root),
    stage: contract.stage,
    llm,
    model,
    signal,
    onToken,
    now,
    emit,
    messages,
    used: used + 1,
  })

  const output = await writeOutput(workspace, contract, reply)
  await emit({ type: 'stage.output', at: now(), stage: contract.stage, files: [output] })
  return { stage: contract.stage, reply, outputs: [output], events }
}

/**
 * Re-derives the run state from a session journal (append-only truth):
 *   - run.completed present            → done (its stages list)
 *   - a pending tool.call in the current stage (M5)
 *                                      → approval (a write awaits a human)
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

  const pending = pendingToolCall(events, unfinished.stage)
  if (pending) {
    return { status: 'approval', stage: unfinished.stage, tool: pending.tool, args: pending.args }
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
  /** M5: enable the tool loop for stage execution. */
  tools?: boolean
}

/** A checkpointed run: advance() executes the next stage, then pauses. */
export interface WorkflowRun {
  /** Current state — meaningful between advance() calls. */
  state(): RunState
  /**
   * Executes the next unfinished stage, then pauses at a checkpoint (or
   * done). Rejects on execution failure; the state becomes 'error' and the
   * next advance() retries the same stage. From 'done': no-op. From
   * 'approval': refuses — resolve the pending tool call first.
   */
  advance(): Promise<RunState>
  /**
   * M5: resolves the pending tool call ('approve' executes it, 'refuse'
   * journals the refusal), then continues the stage to its artifact.
   * Rejects when nothing is pending.
   */
  resolve(decision: 'approve' | 'refuse'): Promise<RunState>
}

/** First workspace stage without an output in `done`; undefined when all are done. */
function nextStage(workspace: Workspace, done: ReadonlySet<string>): StageContract | undefined {
  return workspace.stages.find((s) => !done.has(s.stage))
}

/**
 * Creates a checkpointed run. With initialEvents (a replayed journal), the
 * run resumes where the filesystem left off: finished stages are skipped,
 * the first unfinished one re-runs. A paused approval (derived from the
 * journal) is resolved with resolve().
 */
export function createRun(options: CreateRunOptions): WorkflowRun {
  const { workspace, llm, model, subject, signal, onToken, onEvent, now } = options
  const root = resolve(workspace.root)
  const allStages = workspace.stages.map((s) => s.stage)
  const tools = options.tools === true

  const done = new Set<string>()
  for (const e of options.initialEvents ?? []) {
    if (e.type === 'stage.output' && allStages.includes(e.stage)) done.add(e.stage)
  }
  const hasCompletedEvent = (options.initialEvents ?? []).some((e) => e.type === 'run.completed')

  let state: RunState = hasCompletedEvent
    ? { status: 'done', stages: allStages }
    : runStateFromEvents(options.initialEvents ?? [], workspace)

  // Everything this instance emits — resumeStage replays initialEvents
  // plus these, so resolve() works on a fresh instance AND a live one.
  const emitted: SessionEvent[] = []

  const emit = async (event: SessionEvent): Promise<void> => {
    emitted.push(event)
    await onEvent?.(event)
  }

  const nowFn = now ?? (() => new Date().toISOString())

  /** Post-stage settling, shared by advance() and resolve(). */
  const settle = async (result: { stage: string }): Promise<RunState> => {
    done.add(result.stage)
    const isLast = workspace.stages[workspace.stages.length - 1]?.stage === result.stage
    if (isLast) {
      await emit({ type: 'run.completed', at: nowFn(), stages: allStages })
      state = { status: 'done', stages: allStages }
    } else {
      state = { status: 'checkpoint', stage: result.stage }
    }
    return state
  }

  return {
    state: () => state,

    async advance(): Promise<RunState> {
      if (state.status === 'done') return state
      if (state.status === 'approval') {
        throw new Error(
          `l'appel d'outil « ${state.tool} » est en attente — approuvez-le ou refusez-le avant d'avancer`,
        )
      }
      const contract = nextStage(workspace, done)
      if (contract === undefined) {
        // Every stage has an output but the journal lacks run.completed
        // (crash between the last output and the completion event): finish.
        await emit({ type: 'run.completed', at: nowFn(), stages: allStages })
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
          tools,
        })
        return await settle(result)
      } catch (err) {
        if (err instanceof ToolApprovalPause) {
          state = { status: 'approval', stage: contract.stage, tool: err.call.tool, args: err.call.args }
          return state
        }
        const message = err instanceof Error ? err.message : String(err)
        state = { status: 'error', stage: contract.stage, message }
        throw err
      }
    },

    async resolve(decision: 'approve' | 'refuse'): Promise<RunState> {
      if (state.status !== 'approval') {
        throw new Error('aucun appel d\'outil en attente pour ce run — avancez d\'abord')
      }
      const stageName = state.stage
      state = { status: 'running', stage: stageName }
      try {
        const result = await resumeStage({
          workspace: { ...workspace, root },
          stage: stageName,
          subject,
          llm,
          model,
          decision,
          events: [...(options.initialEvents ?? []), ...emitted],
          signal,
          onToken,
          onEvent: emit,
          now,
        })
        return await settle(result)
      } catch (err) {
        if (err instanceof ToolApprovalPause) {
          // The model asked for another write while resuming: pause again —
          // the new tool.call is journaled, another decision is expected.
          state = { status: 'approval', stage: stageName, tool: err.call.tool, args: err.call.args }
          return state
        }
        const message = err instanceof Error ? err.message : String(err)
        state = { status: 'error', stage: stageName, message }
        throw err
      }
    },
  }
}
