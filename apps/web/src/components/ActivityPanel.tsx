import { useState } from 'react'
import type { ChatMsg, RequestTrace } from '../lib/types'

/**
 * The activity tab (M12, M13) — harness-style tracking of one session: every
 * model request (model, think level, duration, outcome) and every tool
 * call (args + the payload returned to the model), in chronological order.
 *
 * Tool history AND completed turns derive from the session's journal
 * (tool.call/tool.result + turn.completed, M13): the whole tab survives
 * reloads; live requests are traced by the browser loop as they stream.
 */

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const OUTCOME_LABEL: Record<RequestTrace['outcome'], string> = {
  ok: 'réponse',
  tool_calls: 'appels d’outils',
  error: 'erreur',
  stopped: 'interrompu',
}

const OUTCOME_CLASS: Record<RequestTrace['outcome'], string> = {
  ok: 'tag-ok',
  tool_calls: 'tag-ws',
  error: 'tag-err',
  stopped: 'tag-warn',
}

function prettyJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? ''
    return raw.length > 4000 ? `${raw.slice(0, 4000)}\n… (tronqué)` : raw
  } catch {
    return String(value)
  }
}

/** One chronological entry of the merged timeline. */
type Entry =
  | { kind: 'request'; at: number; trace: RequestTrace }
  | { kind: 'tool'; at: number; row: ChatMsg }

/** Merges traces and tool rows by timestamp. */
function merge(traces: readonly RequestTrace[], toolRows: readonly ChatMsg[]): Entry[] {
  const entries: Entry[] = [
    ...traces.map((t): Entry => ({ kind: 'request', at: t.at, trace: t })),
    ...toolRows.map((r): Entry => ({ kind: 'tool', at: r.at, row: r })),
  ]
  return entries.sort((a, b) => a.at - b.at)
}

function RequestCard({ trace }: { trace: RequestTrace }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="act-card request" data-test="act-request" data-outcome={trace.outcome}>
      <button type="button" className="act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="act-time">{fmtTime(trace.at)}</span>
        <span className="act-icon" aria-hidden="true">⚡</span>
        <span className="act-title">
          Requête modèle — <code>{trace.model}</code>
        </span>
        <span className={`act-tag ${OUTCOME_CLASS[trace.outcome]}`}>{OUTCOME_LABEL[trace.outcome]}</span>
        <span className="act-meta">
          tour {trace.round} · {trace.messages} msg · {trace.tools} outils · {trace.ms} ms
          {trace.thinkingChars > 0 ? ` · réflexion ${trace.thinkingChars}` : ''}
          {trace.textChars > 0 ? ` · réponse ${trace.textChars}` : ''}
        </span>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="act-body">
          {trace.error !== undefined ? <p className="act-error">{trace.error}</p> : null}
          <dl className="act-facts">
            <div>
              <dt>Modèle demandé</dt>
              <dd>
                <code>{trace.model}</code>
              </dd>
            </div>
            <div>
              <dt>Niveau de réflexion</dt>
              <dd>{trace.thinkLevel === null ? 'défaut du modèle' : `@think=${trace.thinkLevel}`}</dd>
            </div>
            <div>
              <dt>Contexte envoyé</dt>
              <dd>
                {trace.messages} messages · {trace.tools} déclarations d’outils
              </dd>
            </div>
            <div>
              <dt>Durée</dt>
              <dd>{trace.ms} ms</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}

function ToolCard({ row }: { row: ChatMsg }) {
  const [open, setOpen] = useState(false)
  const state = row.ok === undefined ? 'pending' : row.ok ? 'ok' : 'err'
  return (
    <div className="act-card tool" data-test="act-tool" data-state={state}>
      <button type="button" className="act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="act-time">{fmtTime(row.at)}</span>
        <span className="act-icon" aria-hidden="true">🔧</span>
        <span className="act-title">
          <code>{row.tool}</code> — {row.ok === undefined ? 'en attente d’approbation' : (row.summary ?? 'fait')}
        </span>
        <span className={`act-tag ${state === 'ok' ? 'tag-ok' : state === 'err' ? 'tag-err' : 'tag-warn'}`}>
          {state === 'ok' ? 'ok' : state === 'err' ? 'refusé/erreur' : 'approbation'}
        </span>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="act-body">
          <p className="act-sub">Arguments</p>
          <pre>{prettyJson(row.args ?? {})}</pre>
          <p className="act-sub">Résultat renvoyé au modèle</p>
          <pre>{row.ok === true && row.data !== undefined ? prettyJson(row.data) : prettyJson({ ok: false, summary: row.summary })}</pre>
        </div>
      ) : null}
    </div>
  )
}

export function ActivityPanel({ traces, toolRows }: { traces: readonly RequestTrace[]; toolRows: readonly ChatMsg[] }) {
  const entries = merge(traces, toolRows)
  return (
    <div className="activity" data-test="activity-panel">
      {entries.length === 0 ? (
        <p className="empty">Aucune activité encore — envoyez un message pour voir les requêtes et les outils en direct.</p>
      ) : (
        <>
          <p className="activity-note">
            Outils ET tours terminés sont journalisés (ils survivent au rechargement) ; les requêtes en cours se suivent en direct.
          </p>
          {entries.map((e, i) =>
            e.kind === 'request' ? <RequestCard key={`r-${e.trace.id}`} trace={e.trace} /> : <ToolCard key={`t-${e.row.id}-${i}`} row={e.row} />,
          )}
        </>
      )}
    </div>
  )
}
