import { useCallback, useEffect, useState } from 'react'
import type { RunStateDto, StageDto, WorkspaceDetailDto } from '../lib/sessionApi'
import { advanceRun, getWorkspace, readWorkspaceFile } from '../lib/sessionApi'
import { stateLabel, stageStatuses } from '../lib/progress'
import { RunPanel } from './RunPanel'

/**
 * The workflow view (M6): the pipeline as a human reads it — stages in
 * order, each with its status (fait / en cours / à venir), the files a run
 * wrote per stage, and a click-to-preview of their CURRENT disk content
 * (the filesystem is the orchestrator: an edit at the checkpoint shows
 * here). Runs are created and advanced from this view; a paused write
 * still lands on the M5 approval card. Everything is re-derived from the
 * journals on every refresh — reload-proof, like the rest of the app.
 */

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; content: string; bytes: number }
  | { status: 'error'; message: string }

const STAGE_LABEL: Record<'done' | 'current' | 'pending', string> = {
  done: 'Fait',
  current: 'En cours',
  pending: 'À venir',
}

/** One output file of a done stage: path + lazy preview of disk content. */
function OutputFile({ workspace, path }: { workspace: string; path: string }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PreviewState | null>(null)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setPreview({ status: 'loading' })
    // Fetched on every open: the file may have been edited at a checkpoint.
    readWorkspaceFile(workspace, path)
      .then((p) => setPreview({ status: 'ok', content: p.content, bytes: p.bytes }))
      .catch((err: unknown) => setPreview({ status: 'error', message: err instanceof Error ? err.message : String(err) }))
  }

  return (
    <div className="output-file" data-test="output-file">
      <button type="button" className="output-toggle" data-test="output-toggle" onClick={toggle}>
        <span className="output-chevron" data-open={open}>
          ▸
        </span>
        <code>{path}</code>
      </button>
      {open ? (
        preview === null || preview.status === 'loading' ? (
          <p className="output-note">Chargement…</p>
        ) : preview.status === 'error' ? (
          <p className="output-note output-error">Aperçu impossible — {preview.message}</p>
        ) : (
          <pre className="output-preview" data-test="output-preview">
            {preview.content}
          </pre>
        )
      ) : null}
    </div>
  )
}

export function WorkflowsView({
  name,
  memory,
  model,
  modelAvailable,
  selectedRunId,
  onSelectRun,
  onCreateRun,
}: {
  /** Selected workspace name; null = nothing selected yet. */
  name: string | null
  /** True when the server APIs are absent (in-memory fallback). */
  memory: boolean
  /** Model for stage execution (the header picker drives it). */
  model: string
  modelAvailable: boolean
  selectedRunId: string | null
  onSelectRun(id: string | null): void
  /** Creates the run server-side and syncs the session store. */
  onCreateRun(subject: string): Promise<RunStateDto>
}) {
  const [detail, setDetail] = useState<WorkspaceDetailDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [tools, setTools] = useState(false)
  const [creating, setCreating] = useState(false)
  const [advancing, setAdvancing] = useState(false)

  const refresh = useCallback(() => {
    if (name === null) {
      setDetail(null)
      return
    }
    setLoading(true)
    let cancelled = false
    getWorkspace(name)
      .then((d) => {
        if (!cancelled) {
          setDetail(d)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetail(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [name])

  useEffect(() => {
    setDetail(null)
    setError(null)
    return refresh()
  }, [refresh])

  if (memory) {
    return (
      <section className="wf-view">
        <p className="empty">API /workspaces indisponible — lancez le serveur (pnpm dev) pour exécuter des workflows.</p>
      </section>
    )
  }
  if (name === null) {
    return (
      <section className="wf-view">
        <p className="empty">Choisissez un workspace dans la barre latérale.</p>
      </section>
    )
  }

  const runs = detail?.runs ?? []
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs.at(-1) ?? null
  // Sans run sélectionné, le pipeline reste visible — tout simplement à venir.
  const statuses = detail ? stageStatuses(detail.stages, selectedRun?.state ?? { status: 'idle' }) : []
  const canAdvance =
    selectedRun !== null &&
    modelAvailable &&
    !advancing &&
    (selectedRun.state.status === 'idle' || selectedRun.state.status === 'checkpoint' || selectedRun.state.status === 'error')

  const submitRun = (e: React.FormEvent) => {
    e.preventDefault()
    const clean = subject.trim()
    if (clean === '' || creating) return
    setCreating(true)
    onCreateRun(clean)
      .then((dto) => {
        setSubject('')
        onSelectRun(dto.id)
        refresh()
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }

  const doAdvance = () => {
    if (!selectedRun || advancing) return
    setAdvancing(true)
    setError(null)
    advanceRun(name, selectedRun.id, { model, tools })
      .then(() => refresh())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        refresh()
      })
      .finally(() => setAdvancing(false))
  }

  const filesForStage = (stage: string): string[] => {
    const entry = selectedRun?.outputs.find((o) => o.stage === stage)
    return entry ? entry.files : []
  }

  return (
    <section className="wf-view" data-test="workflow-view">
      <form className="wf-new-run" onSubmit={submitRun}>
        <input
          data-test="subject-input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Sujet du run — la question posée à la première étape"
          aria-label="Sujet du run"
          maxLength={10_000}
        />
        <button type="submit" data-test="create-run-btn" disabled={subject.trim() === '' || creating}>
          {creating ? 'Création…' : 'Nouveau run'}
        </button>
      </form>

      {error !== null ? (
        <p className="wf-error" data-test="wf-error">
          {error}
        </p>
      ) : null}
      {loading && detail === null ? <p className="empty">Chargement du workspace…</p> : null}

      {detail !== null ? (
        <>
          <details className="wf-map">
            <summary>Carte du workspace — {detail.stages.length} étapes</summary>
            <pre>{detail.map}</pre>
          </details>

          {runs.length === 0 ? (
            <p className="empty" data-test="no-runs">
              Aucun run pour ce workspace — donnez un sujet pour commencer.
            </p>
          ) : (
            <div className="wf-runs" data-test="run-list">
              {runs.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className="run-row"
                  data-test="run-row"
                  data-active={r.id === selectedRun?.id}
                  onClick={() => onSelectRun(r.id)}
                >
                  <span className="run-title">{r.title}</span>
                  <span className="run-badge" data-state={r.state.status}>
                    {stateLabel(r.state)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedRun !== null ? (
            <div className="wf-run" data-test="run-detail">
              <div className="wf-actions">
                <button
                  type="button"
                  className="advance-btn"
                  data-test="advance-btn"
                  disabled={!canAdvance}
                  onClick={doAdvance}
                >
                  {advancing
                    ? 'Exécution…'
                    : selectedRun.state.status === 'done'
                      ? 'Workflow terminé'
                      : selectedRun.state.status === 'approval'
                        ? 'Approbation requise'
                        : selectedRun.state.status === 'error'
                          ? 'Relancer l’étape'
                          : 'Exécuter l’étape suivante'}
                </button>
                <label className="tools-toggle">
                  <input
                    type="checkbox"
                    data-test="tools-toggle"
                    checked={tools}
                    onChange={(e) => setTools(e.target.checked)}
                  />{' '}
                  Outils (écritures sur approbation)
                </label>
                {!modelAvailable ? <span className="wf-hint">Sélectionnez un modèle dans l’en-tête.</span> : null}
              </div>
              {selectedRun.state.status === 'error' ? (
                <p className="wf-error" data-test="run-error">
                  Étape « {selectedRun.state.stage} » en échec — {selectedRun.state.message}
                </p>
              ) : null}

              <RunPanel workspace={name} run={selectedRun} onResolved={() => refresh()} onError={(why) => setError(why)} />
            </div>
          ) : null}

          <ol className="wf-stages" data-test="stage-list">
            {detail.stages.map((s: StageDto, i: number) => {
              const status = statuses[i] ?? 'pending'
              const files = filesForStage(s.stage)
              return (
                <li key={s.stage} className="stage-card" data-test="stage-card" data-status={status}>
                  <div className="stage-head">
                    <span className="stage-num">{i + 1}</span>
                    <span className="stage-name">
                      {s.title} <code>{s.stage}</code>
                    </span>
                    <span className="stage-badge" data-status={status}>
                      {STAGE_LABEL[status]}
                    </span>
                  </div>
                  {status === 'pending' && s.outputs.length > 0 ? (
                    <p className="stage-expected">
                      Sortie attendue : <code>{[s.stage, s.outputs[0]].join('/')}</code>
                    </p>
                  ) : null}
                  {files.map((f) => (
                    <OutputFile key={f} workspace={name} path={f} />
                  ))}
                </li>
              )
            })}
          </ol>
        </>
      ) : null}
    </section>
  )
}
