import { useEffect, useRef, useState } from 'react'
import * as api from '../lib/sessionApi'
import { loadDefaultSecurity, SECURITY_HINT, SECURITY_LABEL, slugify } from '../lib/security'
import type { SecurityLevel, SessionInfo } from '../lib/types'

const LAST_WS_KEY = 'nyworkflow.lastWorkspace'

type Mode = 'existing' | 'new' | 'folder'

interface NewSessionDialogProps {
  /** 'server' — the dialog lists real workspaces; 'memory' falls back to plain. */
  mode: 'booting' | 'server' | 'memory'
  initialTitle: string
  /** M12 — preselected workspace (the sidebar's per-group "+"). */
  initialWorkspace?: string
  onClose(): void
  onCreated(session: SessionInfo): void
}

/**
 * New agentic session (M11, M12, M13): a title, where the session — and the
 * model — will live, and the security level of its tools. Three ways to
 * bind a workspace:
 *   - a fresh scaffold — the DEFAULT when the registry is empty: the
 *     COMPLETE ICM tree (M13), auto-named from the title;
 *   - an existing workspace (the registry);
 *   - **a folder of the user's disk** (M12): browsed, then registered
 *     as-is — the tree is the user's own, nothing is created inside.
 * The last used workspace and the security level are remembered.
 */
export function NewSessionDialog({ mode, initialTitle, initialWorkspace, onClose, onCreated }: NewSessionDialogProps) {
  const [title, setTitle] = useState(initialTitle)
  const [mode_, setMode] = useState<Mode>('existing')
  const [workspaces, setWorkspaces] = useState<readonly api.WorkspaceSummaryDto[]>([])
  const [selected, setSelected] = useState(initialWorkspace ?? '')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** M13 — the security level of the session's tools (default remembered). */
  const [security, setSecurity] = useState<SecurityLevel>(() => loadDefaultSecurity())

  // --- folder browser state (M12) ---
  const [browse, setBrowse] = useState<api.BrowseDto | null>(null)
  const [browsePath, setBrowsePath] = useState('')
  const [folderName, setFolderName] = useState('')
  const [browsing, setBrowsing] = useState(false)
  /** Latest browse request wins — a stale response never clobbers the screen. */
  const browseSeq = useRef(0)
  /** True once the user typed a path: the initial home load must not overwrite it. */
  const pathTouched = useRef(false)

  useEffect(() => {
    if (mode !== 'server') return
    let cancelled = false
    void api
      .listWorkspaces()
      .then((list) => {
        if (cancelled) return
        setWorkspaces(list)
        const last = localStorage.getItem(LAST_WS_KEY) ?? ''
        setSelected((prev) => {
          if (prev !== '' && list.some((w) => w.name === prev)) return prev
          return list.some((w) => w.name === last) ? (last as string) : (list[0]?.name ?? '')
        })
        if (list.length === 0) setMode('new')
      })
      .catch(() => {
        if (!cancelled) setError('Workspaces injoignables — réessayez.')
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  // M13 — un titre tapé propose le nom du nouveau workspace (slug).
  useEffect(() => {
    if (mode_ !== 'new') return
    setNewName((current) => (current === '' || current === slugify(current) ? slugify(title) : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, mode_])

  // Loads the folder browser (home on first open).
  useEffect(() => {
    if (mode_ !== 'folder' || browse !== null || mode !== 'server') return
    void loadBrowse(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode_, browse, mode])

  const loadBrowse = (path: string | undefined): void => {
    const seq = ++browseSeq.current
    setBrowsing(true)
    setError('')
    void api
      .browseFolders(path)
      .then((dto) => {
        if (seq !== browseSeq.current) return // réponse périmée — une plus récente a pris l'écran
        setBrowse(dto)
        // Le chargement initial (home) ne doit JAMAIS écraser un chemin déjà tapé.
        setBrowsePath((current) => (path === undefined && pathTouched.current ? current : dto.path))
        setFolderName((current) => (current === '' ? (dto.path.split('/').pop() ?? '') : current))
      })
      .catch((err) => {
        if (seq === browseSeq.current) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (seq === browseSeq.current) setBrowsing(false)
      })
  }

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
        if (mode_ === 'new') {
          const name = newName.trim()
          if (name === '') {
            setError('Nom du nouveau workspace attendu.')
            return
          }
          workspace = (await api.createWorkspace(name)).name
        } else if (mode_ === 'folder') {
          const path = browsePath.trim()
          if (path === '' || browse === null || path !== browse.path) {
            setError('Choisissez un dossier (naviguez jusqu’à lui, ou collez son chemin absolu).')
            return
          }
          const name = folderName.trim()
          if (name === '') {
            setError('Nom de workspace attendu pour ce dossier.')
            return
          }
          try {
            workspace = (await api.registerWorkspace(name, path)).name
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            return
          }
        } else if (workspace === '') {
          setError('Choisissez un workspace (ou créez-en un).')
          return
        }
        localStorage.setItem(LAST_WS_KEY, workspace)
        const dto = await api.createSession(title.trim() || undefined, workspace, security)
        onCreated({ id: dto.id, title: dto.title, createdAt: dto.createdAt, workspace, security: dto.security })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  const tab = (value: Mode, label: string): React.ReactNode => (
    <button
      type="button"
      key={value}
      className={`ws-tab ${mode_ === value ? 'active' : ''}`}
      data-test={`ws-mode-${value}`}
      onClick={() => {
        setMode(value)
        setError('')
      }}
    >
      {label}
    </button>
  )

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
            <div className="ws-tabs" role="tablist" aria-label="Workspace">
              {tab('existing', 'Existant')}
              {tab('new', 'Créer (ICM complet)')}
              {tab('folder', 'Dossier du disque')}
            </div>
            {mode_ === 'existing' ? (
              <label className="field">
                <span>Workspace ICM</span>
                <select
                  data-test="ws-select"
                  value={selected}
                  disabled={workspaces.length === 0}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {workspaces.length === 0 ? <option value="">(aucun workspace)</option> : null}
                  {workspaces.map((w) => (
                    <option key={w.name} value={w.name}>
                      {w.name}
                      {w.folder ? ' (dossier)' : ''}
                      {w.summary !== undefined ? ` — ${w.summary}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {mode_ === 'new' ? (
              <label className="field">
                <span>Nom du workspace à créer</span>
                <input
                  data-test="new-ws-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ex. rapport-loutres"
                />
                <span className="hint">
                  Scaffold ICM complet (M13) : charte + inbox / notes (plan, tâches, journal, décisions) / research
                  (registre des sources) / memory (mémoire vive, leçons) / outputs / archive — chaque fichier .md
                  prêt à l’emploi, l’arbre reste libre ensuite.
                </span>
              </label>
            ) : null}
            {mode_ === 'folder' ? (
              <div className="folder-picker" data-test="folder-picker">
                <div className="folder-bar">
                  <input
                    data-test="folder-path-input"
                    value={browsePath}
                    onChange={(e) => {
                      pathTouched.current = true
                      setBrowsePath(e.target.value)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        loadBrowse(browsePath.trim() || undefined)
                      }
                    }}
                    placeholder="chemin absolu du dossier"
                    aria-label="Chemin du dossier"
                  />
                  <button type="button" data-test="folder-go" onClick={() => loadBrowse(browsePath.trim() || undefined)} disabled={browsing}>
                    {browsing ? '…' : 'Ouvrir'}
                  </button>
                </div>
                <div className="folder-list" data-test="folder-list" role="listbox" aria-label="Sous-dossiers">
                  {browse === null ? (
                    <p className="hint">Chargement…</p>
                  ) : (
                    <>
                      {browse.parent !== null ? (
                        <button type="button" className="folder-row up" data-test="folder-up" onClick={() => loadBrowse(browse.parent!)}>
                          <span aria-hidden="true">↑</span> …
                        </button>
                      ) : null}
                      {browse.dirs.length === 0 ? (
                        <p className="hint">(aucun sous-dossier)</p>
                      ) : (
                        browse.dirs.map((d) => (
                          <div className="folder-row" key={d.path} data-test="folder-row">
                            <button type="button" className="folder-open" onClick={() => loadBrowse(d.path)} title={`Ouvrir ${d.path}`}>
                              <span aria-hidden="true">▸</span> {d.name}
                            </button>
                            <button
                              type="button"
                              className="folder-choose"
                              data-test="folder-choose"
                              onClick={() => {
                                loadBrowse(d.path)
                                setFolderName(d.name)
                              }}
                            >
                              Choisir
                            </button>
                          </div>
                        ))
                      )}
                      {browse.truncated ? <p className="hint">(liste tronquée à 500 dossiers)</p> : null}
                    </>
                  )}
                </div>
                <label className="field">
                  <span>Nom du workspace pour ce dossier</span>
                  <input data-test="folder-ws-name" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="ex. mes-documents" />
                  <span className="hint">
                    Le dossier est enregistré TEL QUEL (aucun fichier créé) — son arbre et ses CONTEXT.md deviennent l’ICM.
                  </span>
                </label>
              </div>
            ) : null}
          </>
        ) : (
          <p className="hint">API indisponible — la session sera locale (repli mémoire), sans workspace.</p>
        )}
        <label className="field">
          <span>Niveau de sécurité des outils</span>
          <select data-test="security-level" value={security} onChange={(e) => setSecurity(e.target.value as SecurityLevel)}>
            <option value="ask">{SECURITY_LABEL.ask} — {SECURITY_HINT.ask}</option>
            <option value="accept">{SECURITY_LABEL.accept} — {SECURITY_HINT.accept}</option>
            <option value="no-tools">{SECURITY_LABEL['no-tools']} — {SECURITY_HINT['no-tools']}</option>
          </select>
          <span className="hint">Modifiable à tout moment dans le bandeau de la session.</span>
        </label>
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
