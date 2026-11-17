import { useState } from 'react'
import type { SessionInfo } from '../lib/types'

interface SidebarProps {
  sessions: readonly SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  onNew(): void
  onFork(id: string): void
  onDelete(id: string): void
  /** Menu Paramètres (M8). */
  onOpenSettings(): void
}

/** Icônes de navigation, dans l'esprit dsh (trait 1.5, 16px). */
function NavIcon({ kind }: { kind: 'chat' | 'gear' }) {
  if (kind === 'gear') {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8 1.8v1.7M8 12.5v1.7M2.9 4.95l1.45.85M11.65 10.2l1.45.85M2.9 11.05l1.45-.85M11.65 5.8l1.45-.85"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
      <path
        d="M13.5 7.25a5.25 5.25 0 0 1-7.72 4.63L2.5 13l1.12-3.28A5.25 5.25 0 1 1 13.5 7.25Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Sessions only (M11): the sidebar is the session list — each row carries
 * its workspace tag, a fork, and a two-step delete (no accidental loss:
 * the journal is the only copy).
 */
export function Sidebar({ sessions, activeId, onSelect, onNew, onFork, onDelete, onOpenSettings }: SidebarProps) {
  /** The session whose delete is armed (two-step confirmation, M11). */
  const [armedDelete, setArmedDelete] = useState<string | null>(null)

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">N</span>
        <h1>NyWorkflow</h1>
        <span className="brand-badge">ICM</span>
      </div>
      <button className="new-session" data-test="new-session-btn" onClick={onNew}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
          <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Nouvelle session
      </button>
      <nav className="sessions" aria-label="Sessions">
        {sessions.map((s) => (
          <div className="session-row" data-active={s.id === activeId} key={s.id}>
            <button
              className="session-item"
              data-test="session-item"
              aria-current={s.id === activeId}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title">{s.title}</span>
              {s.workspace !== undefined ? <span className="session-ws">{s.workspace}</span> : null}
            </button>
            <div className="session-actions">
              <button
                className="fork"
                data-test="fork-btn"
                title={`Forker « ${s.title} »`}
                aria-label={`Forker la session « ${s.title} »`}
                onClick={() => onFork(s.id)}
              >
                Fork
              </button>
              {armedDelete === s.id ? (
                <>
                  <button
                    className="del confirm"
                    data-test="confirm-delete-btn"
                    title="Confirmer la suppression (le journal est supprimé)"
                    onClick={() => {
                      setArmedDelete(null)
                      onDelete(s.id)
                    }}
                  >
                    Supprimer ?
                  </button>
                  <button
                    className="del cancel"
                    data-test="cancel-delete-btn"
                    aria-label="Annuler la suppression"
                    onClick={() => setArmedDelete(null)}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <button
                  className="del"
                  data-test="delete-btn"
                  title={`Supprimer « ${s.title} »`}
                  aria-label={`Supprimer la session « ${s.title} »`}
                  onClick={() => setArmedDelete(s.id)}
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="settings-btn" data-test="settings-btn" onClick={onOpenSettings}>
          <NavIcon kind="gear" />
          Paramètres
        </button>
      </div>
    </aside>
  )
}
