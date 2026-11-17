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
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="dot" />
        <h1>NyWorkflow</h1>
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
          Workflows
        </button>
      </div>
      {view === 'chat' ? (
        <>
          <button className="new-session" onClick={onNew}>
            + Nouvelle session
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
    </aside>
  )
}
