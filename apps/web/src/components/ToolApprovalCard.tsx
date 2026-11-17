/** Compact display of a pending call's args. */
function targetOf(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    const path = a.path
    if (typeof path === 'string' && path !== '') return path
    const command = a.command
    if (typeof command === 'string' && command !== '') return command
    const query = a.query ?? a.url
    if (typeof query === 'string' && query !== '') return query
  }
  return JSON.stringify(args)
}

/**
 * The approval card (M5 pattern, M11 chat edition): a dangerous tool call
 * (write, shell) paused for the one human decision that resumes the agent.
 * Journaled server-side — survives reloads; the turn loop, if alive,
 * continues on decision.
 */
export function ToolApprovalCard({
  tool,
  args,
  onDecide,
}: {
  tool: string
  args: unknown
  onDecide(decision: 'approve' | 'refuse'): void
}) {
  return (
    <div className="approval-card" data-test="approval-card">
      <p>
        L'agent demande l'outil <code>{tool}</code> : <code>{targetOf(args)}</code>
      </p>
      <p className="approval-hint">
        Écriture ou commande dans le workspace — approuvez pour l'exécuter, refusez pour que l'agent continue sans.
      </p>
      <div className="approval-actions">
        <button type="button" data-test="approve-btn" onClick={() => onDecide('approve')}>
          Approuver
        </button>
        <button type="button" data-test="refuse-btn" onClick={() => onDecide('refuse')}>
          Refuser
        </button>
      </div>
    </div>
  )
}
