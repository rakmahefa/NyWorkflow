import { useEffect, useState } from 'react'
import * as api from '../lib/sessionApi'
import type { SessionInfo } from '../lib/types'

const LAST_WS_KEY = 'nyworkflow.lastWorkspace'

interface NewSessionDialogProps {
  /** 'server' — the dialog lists real workspaces; 'memory' falls back to plain. */
  mode: 'booting' | 'server' | 'memory'
  initialTitle: string
  onClose(): void
  onCreated(session: SessionInfo): void
}

/**
 * New agentic session (M11): a title, and the workspace the session — and
 * the model — will live in. The picker lists the registry; a fresh
 * workspace can be scaffolded inline (the modern agentic ICM tree). The
 * last used workspace is remembered.
 */
export function NewSessionDialog({ mode, initialTitle, onClose, onCreated }: NewSessionDialogProps) {
  const [title, setTitle] = useState(initialTitle)
  const [workspaces, setWorkspaces] = useState<readonly api.WorkspaceSummaryDto[]>([])
  const [selected, setSelected] = useState('')
  const [createNew, setCreateNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (mode !== 'server') return
    let cancelled = false
    void api
      .listWorkspaces()
      .then((list) => {
        if (cancelled) return
        setWorkspaces(list)
        const last = localStorage.getItem(LAST_WS_KEY) ?? ''
        setSelected(list.some((w) => w.name === last) ? last : (list[0]?.name ?? ''))
        if (list.length === 0) setCreateNew(true)
      })
      .catch(() => {
        if (!cancelled) setError('Workspaces injoignables — réessayez.')
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (): void => {
    if (busy) return
    setError('')
    void (async () => {
      setBusy(true)
      try {
        if (mode !== 'server') {
          onCreated({ id: `local-${Date.now().toString(36)}`, title: title.trim() || 'Session', createdAt: Date.now() })
          return
        }
        let workspace = selected
        if (createNew) {
          const name = newName.trim()
          if (name === '') {
            setError('Nom du nouveau workspace attendu.')
            return
          }
          workspace = (await api.createWorkspace(name)).name
        } else if (workspace === '') {
          setError('Choisissez un workspace (ou créez-en un).')
          return
        }
        localStorage.setItem(LAST_WS_KEY, workspace)
        const dto = await api.createSession(title.trim() || undefined, workspace)
        onCreated({ id: dto.id, title: dto.title, createdAt: dto.createdAt, workspace })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="modal-overlay" data-test="new-session-dialog" role="dialog" aria-modal="true" aria-label="Nouvelle session">
      <div className="modal">
        <h3>Nouvelle session ICM</h3>
        <label className="field">
          <span>Titre (optionnel)</span>
          <input
            data-test="session-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ex. Rapport loutres Q4"
            autoFocus
          />
        </label>
        {mode === 'server' ? (
          <>
            <label className="field">
              <span>Workspace ICM</span>
              <select
                data-test="ws-select"
                value={createNew ? '' : selected}
                disabled={createNew || workspaces.length === 0}
                onChange={(e) => setSelected(e.target.value)}
              >
                {workspaces.length === 0 ? <option value="">(aucun workspace)</option> : null}
                {workspaces.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name}
                    {w.summary !== undefined ? ` — ${w.summary}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                data-test="new-ws-toggle"
                checked={createNew}
                onChange={(e) => setCreateNew(e.target.checked)}
              />
              <span>Créer un nouveau workspace (arbre agentique : CONTEXT.md + inbox/notes/research/outputs)</span>
            </label>
            {createNew ? (
              <label className="field">
                <span>Nom du workspace</span>
                <input
                  data-test="new-ws-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ex. rapport-loutres"
                />
              </label>
            ) : null}
          </>
        ) : (
          <p className="hint">API indisponible — la session sera locale (repli mémoire), sans workspace.</p>
        )}
        {error !== '' ? <p className="form-error" data-test="dialog-error">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" data-test="dialog-cancel-btn" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="primary" data-test="create-session-btn" disabled={busy} onClick={submit}>
            {busy ? 'Création…' : 'Créer la session'}
          </button>
        </div>
      </div>
    </div>
  )
}
