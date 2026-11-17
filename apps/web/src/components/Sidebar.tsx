import { useEffect, useState } from 'react'
import type { SessionInfo } from '../lib/types'

interface SidebarProps {
  sessions: readonly SessionInfo[]
  activeId: string | null
  onSelect(id: string): void
  onNew(): void
  /** M12 — opens the dialog with this workspace preselected. */
  onNewInWorkspace(workspace: string): void
  onFork(id: string): void
  onDelete(id: string): void
  /** M12 — inline rename (server + store). */
  onRename(id: string, title: string): void
  /** Menu Paramètres (M8). */
  onOpenSettings(): void
}

const COLLAPSE_KEY = 'nyworkflow.wsCollapse'
const NO_WS = '(sans workspace)'

/** One session, with inline rename (M12). */
function SessionRow({
  session,
  active,
  armedDelete,
  renaming,
  onSelect,
  onArmDelete,
  onCancelDelete,
  onConfirmDelete,
  onFork,
  onStartRename,
  onRename,
}: {
  session: SessionInfo
  active: boolean
  armedDelete: boolean
  renaming: boolean
  onSelect(): void
  onArmDelete(): void
  onCancelDelete(): void
  onConfirmDelete(): void
  onFork(): void
  onStartRename(): void
  onRename(title: string): void
}) {
  const [draft, setDraft] = useState(session.title)

  useEffect(() => {
    setDraft(session.title)
  }, [session.title])

  const submitRename = (): void => {
    const title = draft.trim().slice(0, 60)
    if (title !== '' && title !== session.title) onRename(title)
    else setDraft(session.title)
  }

  return (
    <div className="session-row" data-active={active} key={session.id}>
      {renaming ? (
        <input
          className="session-rename"
          data-test="session-rename-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitRename()
            }
            if (e.key === 'Escape') setDraft(session.title)
          }}
          aria-label={`Renommer « ${session.title} »`}
        />
      ) : (
        <button
          className="session-item"
          data-test="session-item"
          aria-current={active}
          onClick={() => onSelect()}
          onDoubleClick={onStartRename}
          title={`${session.title} — double-clic pour renommer`}
        >
          <span className="session-title">{session.title}</span>
        </button>
      )}
      <div className="session-actions">
        {renaming ? null : (
          <>
            <button
              className="fork"
              data-test="fork-btn"
              title={`Forker « ${session.title} »`}
              aria-label={`Forker la session « ${session.title} »`}
              onClick={onFork}
            >
              Fork
            </button>
            <button
              className="del"
              data-test="rename-btn"
              title="Renommer"
              aria-label={`Renommer la session « ${session.title} »`}
              onClick={onStartRename}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                <path d="M11.3 2.2l2.5 2.5L6 12.5l-3.2.7.7-3.2 7.8-7.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            </button>
            {armedDelete ? (
              <>
                <button
                  className="del confirm"
                  data-test="confirm-delete-btn"
                  title="Confirmer la suppression (le journal est supprimé)"
                  onClick={onConfirmDelete}
                >
                  Supprimer ?
                </button>
                <button
                  className="del cancel"
                  data-test="cancel-delete-btn"
                  aria-label="Annuler la suppression"
                  onClick={onCancelDelete}
                >
                  ✕
                </button>
              </>
            ) : (
              <button
                className="del"
                data-test="delete-btn"
                title={`Supprimer « ${session.title} »`}
                aria-label={`Supprimer la session « ${session.title} »`}
                onClick={onArmDelete}
              >
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Sessions grouped by workspace (M12): each group is collapsible with its
 * session count, a "+" to start a session right inside it, and the sessions
 * carry fork, rename (inline) and the two-step delete. Legacy sessions
 * without a workspace land in their own group at the bottom.
 */
export function Sidebar({ sessions, activeId, onSelect, onNew, onNewInWorkspace, onFork, onDelete, onRename, onOpenSettings }: SidebarProps) {
  /** The session whose delete is armed (two-step confirmation, M11). */
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  /** The session being renamed inline (M12). */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** Collapsed workspace groups, persisted across reloads (M12). */
  const [collapsed, setCollapsed] = useState<readonly string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as unknown
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
  }, [collapsed])

  // Groups: one per workspace (most recent session first), orphans last.
  const groups = new Map<string, SessionInfo[]>()
  for (const s of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    const key = s.workspace ?? NO_WS
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    if (a === NO_WS) return 1
    if (b === NO_WS) return -1
    return a.localeCompare(b)
  })

  const toggle = (ws: string): void => {
    setCollapsed((prev) => (prev.includes(ws) ? prev.filter((w) => w !== ws) : [...prev, ws]))
  }

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
      <nav className="sessions" aria-label="Sessions par workspace">
        {ordered.map(([ws, group]) => {
          const isCollapsed = collapsed.includes(ws)
          return (
            <section className="ws-group" key={ws} data-test="ws-group">
              <div className="ws-group-head">
                <button
                  className="ws-group-toggle"
                  data-test="ws-group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(ws)}
                  title={ws === NO_WS ? 'Sessions sans workspace (anciennes)' : `Workspace ${ws}`}
                >
                  <svg
                    className="chev"
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    aria-hidden="true"
                    style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s var(--ease)' }}
                  >
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="ws-group-name">{ws === NO_WS ? 'Sans workspace' : ws}</span>
                </button>
                <span className="ws-group-count">{group.length}</span>
                {ws !== NO_WS ? (
                  <button
                    className="ws-group-new"
                    data-test="ws-group-new"
                    title={`Nouvelle session dans « ${ws} »`}
                    aria-label={`Nouvelle session dans le workspace « ${ws} »`}
                    onClick={() => onNewInWorkspace(ws)}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
                      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                ) : null}
              </div>
              {isCollapsed
                ? null
                : group.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      active={s.id === activeId}
                      armedDelete={armedDelete === s.id}
                      renaming={renaming === s.id}
                      onSelect={() => onSelect(s.id)}
                      onArmDelete={() => setArmedDelete(s.id)}
                      onCancelDelete={() => setArmedDelete(null)}
                      onConfirmDelete={() => {
                        setArmedDelete(null)
                        onDelete(s.id)
                      }}
                      onFork={() => onFork(s.id)}
                      onStartRename={() => setRenaming(s.id)}
                      onRename={(title) => {
                        setRenaming(null)
                        onRename(s.id, title)
                      }}
                    />
                  ))}
            </section>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="settings-btn" data-test="settings-btn" onClick={onOpenSettings}>
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 1.8v1.7M8 12.5v1.7M2.9 4.95l1.45.85M11.65 10.2l1.45.85M2.9 11.05l1.45-.85M11.65 5.8l1.45-.85"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Paramètres
        </button>
      </div>
    </aside>
  )
}
