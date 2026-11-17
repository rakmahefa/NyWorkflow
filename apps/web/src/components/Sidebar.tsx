import type { SessionInfo } from '../lib/types'

interface SidebarProps {
  sessions: readonly SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  onNew(): void
}

export function Sidebar({ sessions, activeId, onSelect, onNew }: SidebarProps) {
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
          <button
            key={s.id}
            className="session-item"
            data-test="session-item"
            aria-current={s.id === activeId}
            onClick={() => onSelect(s.id)}
          >
            {s.title}
          </button>
        ))}
      </nav>
    </aside>
  )
}
