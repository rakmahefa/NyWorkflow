import type { SessionInfo } from '../lib/types'
import type { WorkspaceSummaryDto } from '../lib/sessionApi'

/** The two faces of the harness: chat sessions, or ICM workflows. (M6) */
export type View = 'chat' | 'workflows'

interface SidebarProps {
  view: View
  onViewChange(view: View): void
  sessions: readonly SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  onNew(): void
  onFork(id: string): void
  /** Workspaces as listed (null = loading, server mode only). */
  workspaces: readonly WorkspaceSummaryDto[] | null
  activeWorkspace: string | null
  onSelectWorkspace(name: string): void
  onRefreshWorkspaces(): void
  /** Menu Paramètres (M8). */
  onOpenSettings(): void
}

/** Icônes de navigation, dans l'esprit dsh (trait 1.5, 16px). */
function NavIcon({ kind }: { kind: 'chat' | 'flow' | 'gear' }) {
  if (kind === 'chat') {
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
      <rect x="1.75" y="2.75" width="5" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9.25" y="9.25" width="5" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.25 9.25v2a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function Sidebar({
  view,
  onViewChange,
  sessions,
  activeId,
  onSelect,
  onNew,
  onFork,
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  onRefreshWorkspaces,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">N</span>
        <h1>NyWorkflow</h1>
        <span className="brand-badge">ICM</span>
      </div>
      <div className="tabs" role="tablist" aria-label="Vues">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'chat'}
          data-test="tab-sessions"
          className="tab"
          data-active={view === 'chat'}
          onClick={() => onViewChange('chat')}
        >
          <NavIcon kind="chat" />
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'workflows'}
          data-test="tab-workflows"
          className="tab"
          data-active={view === 'workflows'}
          onClick={() => onViewChange('workflows')}
        >
          <NavIcon kind="flow" />
          Workflows
        </button>
      </div>
      {view === 'chat' ? (
        <>
          <button className="new-session" onClick={onNew}>
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
                  {s.title}
                </button>
                <button
                  className="fork"
                  data-test="fork-btn"
                  title={`Forker « ${s.title} »`}
                  aria-label={`Forker la session « ${s.title} »`}
                  onClick={() => onFork(s.id)}
                >
                  Fork
                </button>
              </div>
            ))}
          </nav>
        </>
      ) : (
        <>
          <button className="new-session" onClick={onRefreshWorkspaces}>
            ↻ Rafraîchir
          </button>
          <nav className="workspaces" aria-label="Workspaces">
            {workspaces === null ? <p className="ws-empty">Chargement…</p> : null}
            {workspaces !== null && workspaces.length === 0 ? (
              <p className="ws-empty">Aucun workspace. Ajoutez un dossier dans examples/workspaces/ (ou NYW_WORKSPACES).</p>
            ) : null}
            {workspaces?.map((w) => (
              <button
                type="button"
                key={w.name}
                className="workspace-item"
                data-test="workspace-item"
                data-active={w.name === activeWorkspace}
                data-broken={w.error !== undefined}
                onClick={() => onSelectWorkspace(w.name)}
              >
                <span className="ws-name">{w.name}</span>
                <span className="ws-meta">{w.error !== undefined ? 'illisible' : `${w.stages?.length ?? 0} étapes`}</span>
              </button>
            ))}
          </nav>
        </>
      )}
      <div className="sidebar-foot">
        <button type="button" className="settings-btn" data-test="settings-btn" onClick={onOpenSettings}>
          <NavIcon kind="gear" />
          Paramètres
        </button>
      </div>
    </aside>
  )
}
