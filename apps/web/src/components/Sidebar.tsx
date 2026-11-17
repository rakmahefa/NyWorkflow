import type { SessionInfo } from '../lib/types'

interface SidebarProps {
  sessions: readonly SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  onNew(): void
  onFork(id: string): void
}

export function Sidebar({ sessions, activeId, onSelect, onNew, onFork }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="dot" />
        <h1>NyWorkflow</h1>
      </div>
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
    </aside>
  )
}
