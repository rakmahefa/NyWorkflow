import { useEffect, useRef, useState } from 'react'
import * as api from '../lib/sessionApi'
import { loadDefaultSecurity, SECURITY_HINT, SECURITY_LABEL, slugify } from '../lib/security'
import type { SecurityLevel, SessionInfo } from '../lib/types'

const LAST_WS_KEY = 'nyworkflow.lastWorkspace'

/**
 * M17 — the browser's NATIVE directory picker (File System Access API,
 * Chromium). The web platform deliberately hides the absolute path of a
 * picked folder: the handle's only server-usable piece is its NAME, which
 * GET /workspaces/locate turns into candidate paths.
 *
 * M21 — FIREFOX COMPATIBILITY: `showDirectoryPicker` is Chromium-only, so
 * the Explorer button now ALWAYS shows. Where the API is missing (Firefox,
 * Safari…), the click opens the standard folder-selection input
 * (`<input type="file" webkitdirectory>`): the browser's own dialog, the
 * picked folder's NAME read back from the first file's relative path —
 * same locate resolution, same candidates flow.
 */
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>
const nativePicker = (): DirectoryPicker | undefined => {
  const w = window as unknown as { showDirectoryPicker?: DirectoryPicker }
  return typeof w.showDirectoryPicker === 'function' ? w.showDirectoryPicker.bind(w) : undefined
}

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
 * New agentic session (M11–M14, M17, M21): a title, where the session — and the
 * model — will live, and the security level of its tools. The session
 * folder is MANDATORY (M14): three ways to bind one —
 *   - a fresh scaffold — the DEFAULT when the registry is empty: the
 *     COMPLETE ICM tree (M14) inside its hidden `.workspace/`, auto-named
 *     from the title;
 *   - an existing workspace (the registry);
 *   - **a folder of the user's disk** (M12): browsed, then registered —
 *     M14: the hidden `.workspace/` ICM tree is created INSIDE it, the
 *     pilot's own files are never touched elsewhere. M17: the « Explorer… »
 *     button opens the browser's NATIVE directory dialog (Chromium) and
 *     resolves the picked folder into a server path (/workspaces/locate).
 *     M21: on Firefox/Safari the same button opens the browser's standard
 *     folder selection (webkitdirectory input) — same resolution.
 * Every session folder carries its `.logs/<sessionId>/` profiling quartet
 * (M14, M16). The last used workspace and the security level are remembered.
 * Without the server API there is NO session: the folder is mandatory.
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
  /** M22 — the folder EXPLICITLY chosen to be USED by the session: set by
   * « Utiliser ce dossier », by a row's « Utiliser », or by a resolved
   * explorer pick (native or Firefox). The submit registers THIS path —
   * navigating alone never selects anything. */
  const [usedPath, setUsedPath] = useState<string | null>(null)

  // --- M17 : sélecteur natif « Explorer » ---
  /** True while the picked name is being resolved by /workspaces/locate. */
  const [exploring, setExploring] = useState(false)
  /** Several folders carry the picked name: the pilot clicks the right one. */
  const [locateCandidates, setLocateCandidates] = useState<string[]>([])
  /** Confirmation line of a resolved pick ('' = nothing to say). */
  const [picked, setPicked] = useState('')
  const picker = nativePicker()
  /** M21 — the hidden folder-selection input (Firefox/Safari fallback). */
  const folderInputRef = useRef<HTMLInputElement>(null)

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

  /** M17/M22 — applies a RESOLVED path (locate or candidate click): the
   * folder becomes the one the session will USE — path filled and verified
   * by the server's own browser, the name slugged, the selection visible. */
  const applyPickedFolder = (path: string, name: string): void => {
    setLocateCandidates([])
    setUsedPath(path)
    setPicked(`Dossier sélectionné : ${path} — il sera utilisé par la session.`)
    pathTouched.current = true
    setBrowsePath(path)
    setFolderName(slugify(name) || name)
    loadBrowse(path)
  }

  /** M22 — USES the folder currently listed (the navigation's destination):
   * the selection becomes explicit and visible, the workspace name follows. */
  const useCurrentFolder = (): void => {
    if (browse === null) return
    const base = browse.path.split('/').pop() ?? browse.path
    setUsedPath(browse.path)
    setLocateCandidates([])
    setPicked(`Dossier sélectionné : ${browse.path} — il sera utilisé par la session.`)
    setFolderName(slugify(base) || base)
  }

  /** M22 — USES one listed sub-folder directly (no navigation): the pilot
   * points at the row, the session takes that folder. */
  const useSubFolder = (path: string, name: string): void => {
    setUsedPath(path)
    setLocateCandidates([])
    setPicked(`Dossier sélectionné : ${path} — il sera utilisé par la session.`)
    setFolderName(slugify(name) || name)
  }

  /** M17/M21 — resolves a picked folder NAME into a server path via
   * /workspaces/locate (the web platform hides the path — the name is all
   * it gives, whichever picker produced it). */
  const resolvePickedName = (name: string): void => {
    if (exploring) return
    setError('')
    setPicked('')
    setLocateCandidates([])
    setExploring(true)
    void (async () => {
      try {
        const res = await api.locateFolders(name)
        if (res.candidates.length === 1) {
          applyPickedFolder(res.candidates[0] as string, name)
        } else if (res.candidates.length === 0) {
          setError(
            `« ${name} » est introuvable depuis le dossier personnel du serveur — le sélecteur du navigateur ne transmet pas le chemin. Naviguez jusqu’à ce dossier dans la liste ci-dessous, puis cliquez « Utiliser ce dossier » : la sélection sera appliquée.`,
          )
        } else {
          setLocateCandidates(res.candidates)
          setError(`${res.candidates.length} dossiers s’appellent « ${name} » — cliquez sur le bon ci-dessous.`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setExploring(false)
      }
    })()
  }

  /** M21 — the Firefox/Safari path: the standard folder-selection input.
   * The dialog is the browser's own; the folder's name comes back from the
   * first file's relative path ("myFolder/sub/file.txt" → "myFolder"). */
  const onFolderInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    // The File must be captured BEFORE the value reset — the FileList is a
    // LIVE view of the input, clearing the value empties it.
    const first = e.target.files?.[0] as (File & { webkitRelativePath?: string }) | undefined
    e.target.value = '' // re-picking the same folder must re-fire the change
    if (first === undefined) return
    const rel = first.webkitRelativePath ?? ''
    const name = rel.split('/')[0] ?? ''
    if (name === '' || name === '.') {
      setError('Dossier illisible — choisissez un dossier contenant au moins un fichier, ou naviguez avec la liste.')
      return
    }
    resolvePickedName(name)
  }

  /** M17/M21 — the Explorer button: NATIVE dialog where the File System
   * Access API exists (Chrome/Edge), the browser's folder selection
   * everywhere else (Firefox…) — the same locate resolution follows. */
  const pickNativeFolder = (): void => {
    if (exploring) return
    if (picker === undefined) {
      folderInputRef.current?.click()
      return
    }
    void (async () => {
      let name = ''
      try {
        const handle = await picker({ mode: 'read' })
        name = handle.name
      } catch {
        return // dialogue annulé — silencieux, jamais une erreur
      }
      resolvePickedName(name)
    })()
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
        // M14 — the session folder is MANDATORY: without the server there is
        // no folder to bind, hence no session — the harness IS the server.
        if (mode !== 'server') {
          setError('Serveur requis — une session ICM vit dans un dossier workspace (lancez « pnpm dev » puis réessayez).')
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
          // M22 — the folder must have been EXPLICITLY used: « Utiliser ce
          // dossier », a row's « Utiliser », or a resolved explorer pick.
          // Navigating alone never selects — the miss the pilot reported.
          if (usedPath === null) {
            setError('Choisissez le dossier à utiliser : naviguez jusqu’à lui (ou passez par l’explorateur), puis cliquez « Utiliser ce dossier ».')
            return
          }
          const name = folderName.trim()
          if (name === '') {
            setError('Nom de workspace attendu pour ce dossier.')
            return
          }
          try {
            workspace = (await api.registerWorkspace(name, usedPath)).name
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            return
          }
        } else if (workspace === '') {
          setError('Le dossier de la session est obligatoire — choisissez-en un (ou créez-en un).')
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
                <span>Dossier de la session (workspace) — obligatoire</span>
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
                <span className="hint">
                  La session vit dans ce dossier : son ICM dans <code>.workspace/</code> (caché) et ses logs dans{' '}
                  <code>.logs/</code> — jamais ailleurs.
                </span>
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
                  Scaffold ICM complet (M14) : charte + inbox / notes (plan, tâches, journal, décisions) / research
                  (registre des sources) / memory (mémoire vive, leçons) / outputs / archive — tout l’arbre naît dans
                  le dossier caché <code>.workspace/</code>, chaque fichier .md prêt à l’emploi.
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
                  {/* M17/M21 — le bouton Explorer : boîte de navigation
                      native (Chrome/Edge) ou sélection de dossier du
                      navigateur (Firefox…) — puis résolution du nom en
                      chemin serveur via /workspaces/locate. */}
                  <button
                    type="button"
                    className="folder-explorer"
                    data-test="folder-explorer"
                    disabled={exploring}
                    onClick={pickNativeFolder}
                    title="Ouvre la boîte de sélection de dossier (native ou navigateur)"
                  >
                    {exploring ? 'Recherche…' : 'Explorer…'}
                  </button>
                  <button type="button" data-test="folder-go" onClick={() => loadBrowse(browsePath.trim() || undefined)} disabled={browsing}>
                    {browsing ? '…' : 'Ouvrir'}
                  </button>
                </div>
                {/* M21 — le repli Firefox/Safari : l’entrée de sélection de
                    dossier du navigateur (webkitdirectory) ne vit que là où
                    l’API native manque — même bouton, même résolution. */}
                {picker === undefined ? (
                  <>
                    <input
                      ref={folderInputRef}
                      type="file"
                      className="folder-input-hidden"
                      data-test="folder-input"
                      onChange={onFolderInput}
                      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                    />
                    <p className="hint" data-test="folder-explorer-unsupported">
                      Sélecteur natif indisponible dans ce navigateur — « Explorer… » ouvre la sélection de dossier du navigateur (choisissez un dossier contenant au moins un fichier), et la liste ci-dessous navigue dans tous les cas.
                    </p>
                  </>
                ) : null}
                {/* M22 — LA SÉLECTION EXPLICITE : le dossier courant devient
                    celui que la session UTILISERA. Naviguer ne sélectionne
                    rien — ce bouton si. */}
                <button
                  type="button"
                  className="folder-use"
                  data-test="folder-use"
                  disabled={browsing || browse === null}
                  onClick={useCurrentFolder}
                >
                  {usedPath !== null && usedPath === browse?.path ? '✓ Utilisé — ce dossier' : 'Utiliser ce dossier'}
                  {browse !== null ? <code> {browse.path}</code> : null}
                </button>
                {picked !== '' ? (
                  <p className="hint folder-picked" data-test="folder-picked">
                    {picked}
                  </p>
                ) : null}
                {locateCandidates.length > 0 ? (
                  <div className="locate-candidates" data-test="locate-candidates">
                    {locateCandidates.map((p) => (
                      <button
                        type="button"
                        key={p}
                        className="locate-candidate"
                        data-test="locate-candidate"
                        onClick={() => applyPickedFolder(p, p.split('/').pop() ?? p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                ) : null}
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
                          <div className="folder-row" key={d.path} data-test="folder-row" data-used={usedPath === d.path}>
                            <button type="button" className="folder-open" onClick={() => loadBrowse(d.path)} title={`Ouvrir ${d.path}`}>
                              <span aria-hidden="true">▸</span> {d.name}
                            </button>
                            <button
                              type="button"
                              className="folder-choose"
                              data-test="folder-choose"
                              title={`La session utilisera ${d.path}`}
                              onClick={() => useSubFolder(d.path, d.name)}
                            >
                              Utiliser
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
                    Le dossier sélectionné sera UTILISÉ par la session comme terrain : un <code>.workspace/</code> caché (l’ICM complet) et un{' '}
                    <code>.logs/</code> par session y seront créés — vos propres fichiers ne sont jamais modifiés ailleurs.
                  </span>
                </label>
              </div>
            ) : null}
          </>
        ) : (
          <p className="hint">
            API indisponible — le dossier de session étant obligatoire, aucune session ne peut être créée :
            démarrez le serveur (<code>pnpm dev</code>) puis réessayez.
          </p>
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
