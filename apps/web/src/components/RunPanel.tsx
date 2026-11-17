import { useState } from 'react'
import type { RunStateDto } from '../lib/sessionApi'
import { resolveApproval } from '../lib/sessionApi'

/**
 * The run side of a workflow session (M5): the pending-approval card (the
 * one place a human grants a write) and the tool activity, journaled and
 * re-derived — visible after reloads, like everything else. The workflow
 * view itself (stages, progression) arrives in M6; this panel is
 * deliberately minimal: it exists so an approval never needs curl.
 */

/** Compact path display of a pending call's args. */
function targetOf(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const path = (args as { path?: unknown }).path
    if (typeof path === 'string' && path !== '') return path
  }
  return JSON.stringify(args)
}

export function RunPanel({
  workspace,
  run,
  onResolved,
  onError,
}: {
  workspace: string
  run: RunStateDto
  /** Called after a successful decision — the parent refetches the run. */
  onResolved: (decision: 'approve' | 'refuse', state: RunStateDto['state']) => void
  /** Called when the decision request itself fails. */
  onError: (message: string) => void
}) {
  const [pending, setPending] = useState<'approve' | 'refuse' | null>(null)
  const approval = run.state.status === 'approval' ? run.state : null
  const activity = run.tools

  if (!approval && activity.length === 0) return null

  const decide = (decision: 'approve' | 'refuse') => {
    if (pending !== null) return
    setPending(decision)
    void resolveApproval(workspace, run.id, decision)
      .then((result) => onResolved(decision, result.state))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPending(null))
  }

  return (
    <div className="run-panel">
      {approval ? (
        <div className="approval-card" data-test="approval-card">
          <p>
            L'étape <strong>{approval.stage}</strong> demande l'outil <code>{approval.tool}</code> :{' '}
            <code>{targetOf(approval.args)}</code>
          </p>
          <p className="approval-hint">Écriture dans le workspace — approuvez pour l'exécuter, refusez pour continuer sans elle.</p>
          <div className="approval-actions">
            <button type="button" data-test="approve-btn" disabled={pending !== null} onClick={() => decide('approve')}>
              {pending === 'approve' ? 'Approbation…' : 'Approuver'}
            </button>
            <button type="button" data-test="refuse-btn" disabled={pending !== null} onClick={() => decide('refuse')}>
              {pending === 'refuse' ? 'Refus…' : 'Refuser'}
            </button>
          </div>
        </div>
      ) : null}
      {activity.length > 0 ? (
        <ul className="tool-activity" data-test="tool-activity">
          {activity.map((t, i) => (
            <li key={`${t.at}-${i}`} className="tool-row" data-test="tool-row" data-ok={t.ok === undefined ? 'pending' : t.ok ? 'ok' : 'refused'}>
              {t.ok === undefined ? (
                <span>⏳ {t.tool} — en attente d'approbation</span>
              ) : (
                <span>
                  {t.ok ? '✓' : '✗'} {t.summary}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
