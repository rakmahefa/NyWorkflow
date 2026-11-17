/** Compact display of a pending call's args. */
function targetOf(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    for (const key of ['path', 'command', 'query', 'url', 'jobId']) {
      const v = a[key]
      if (typeof v === 'string' && v !== '') return v
    }
  }
  return JSON.stringify(args)
}

function argString(args: unknown, key: string): string | undefined {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

/**
 * The approval card (M5 pattern, M11 chat edition, M12 richer): a
 * dangerous tool call (write, shell) paused for the one human decision
 * that resumes the agent. Journaled server-side — survives reloads; the
 * turn loop, if alive, continues on decision. M12 shows WHAT will be
 * written or run: the file content, the command (its background flag
 * included) — never a blind approve.
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
  const content = tool === 'write' ? argString(args, 'content') : undefined
  const command = tool === 'shell' ? argString(args, 'command') : undefined
  const background =
    tool === 'shell' && args !== null && typeof args === 'object' && (args as Record<string, unknown>).background === true
  return (
    <div className="approval-card" data-test="approval-card">
      <p>
        L'agent demande l'outil <code>{tool}</code> : <code>{targetOf(args)}</code>
      </p>
      {content !== undefined ? (
        <details className="approval-preview" data-test="approval-preview">
          <summary>Aperçu du contenu ({content.length} caractères)</summary>
          <pre>{content.length > 2000 ? `${content.slice(0, 2000)}\n… (tronqué)` : content}</pre>
        </details>
      ) : null}
      {command !== undefined ? (
        <div className="approval-preview" data-test="approval-preview">
          <pre>{command}</pre>
          {background ? <p className="approval-hint">Commande détachée (arrière-plan) — un jobId sera rendu immédiatement.</p> : null}
        </div>
      ) : null}
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
