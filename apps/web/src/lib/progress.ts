/**
 * Workflow view helpers (M6) — pure functions, unit-tested: how the stages
 * of a workspace light up for a given run state, and the French label of a
 * run state. The statuses derive from RunState + the stage order, exactly
 * the way runStateFromEvents computes them server-side:
 *
 *   done      → every stage has an output
 *   idle      → nothing finished yet (an interrupted stage re-runs)
 *   checkpoint→ state.stage is the LAST finished stage
 *   running / approval / error → state.stage is the CURRENT (unfinished) one
 */
import type { RunStateDto } from './sessionApi'

export type StageStatus = 'done' | 'current' | 'pending'

/** Per-stage status, aligned with `stages` (same order, same length). */
export function stageStatuses(stages: readonly { stage: string }[], state: RunStateDto['state']): StageStatus[] {
  const all = (s: StageStatus): StageStatus[] => stages.map(() => s)

  if (state.status === 'done') return all('done')
  if (state.status === 'idle') return all('pending')

  // checkpoint.stage = last finished; running/approval/error.stage = current.
  const finishedThrough = state.status === 'checkpoint' ? state.stage : null
  const current = state.status === 'checkpoint' ? null : state.stage

  const at = stages.findIndex((s) => s.stage === (finishedThrough ?? current))
  if (at === -1) return all('pending') // unknown stage name: honest default

  return stages.map((s, i): StageStatus => {
    if (finishedThrough !== null) return i <= at ? 'done' : 'pending'
    if (i < at) return 'done'
    if (i === at) return 'current'
    return 'pending'
  })
}

/** French label of a run state, for badges and run rows. */
export function stateLabel(state: RunStateDto['state']): string {
  switch (state.status) {
    case 'idle':
      return 'En attente'
    case 'running':
      return 'En cours'
    case 'checkpoint':
      return 'Checkpoint'
    case 'done':
      return 'Terminé'
    case 'error':
      return 'Erreur'
    case 'approval':
      return 'Approbation requise'
  }
}
