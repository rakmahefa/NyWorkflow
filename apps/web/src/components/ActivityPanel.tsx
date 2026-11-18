import { useCallback, useEffect, useState } from 'react'
import * as api from '../lib/sessionApi'
import type { ChatMsg, RequestTrace } from '../lib/types'

/**
 * The activity tab (M12, M13, M17) — harness-style tracking of one session:
 * every model request WITH ITS RESPONSE (first event, thinking titles,
 * excerpts, tool calls — M17: the pilot reads what the model said, protocol
 * compliance at a glance), every tool call (args + the payload returned to
 * the model), and the session's OWN profiling quartet (M17) — its
 * .logs/<sessionId>/ folder, model.jsonl first: the responses of THAT
 * session, next to the session itself.
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

/** M17 — the response block of a request card. Nothing when the trace is
 * pre-M17 (no payload captured): honest, not a fake empty answer. */
function ResponseView({ trace }: { trace: RequestTrace }) {
  if (trace.firstEvent === undefined) {
    return <p className="act-sub">Réponse non journalisée (trace d’avant M17) — elle est dans model.jsonl.</p>
  }
  const firstOk = trace.firstEvent === 'thinking'
  const titled = (trace.thinkingTitles?.length ?? 0) > 0
  const argsAllOk = (trace.toolCalls ?? []).every((c) => c.argsOk)
  return (
    <>
      <p className="act-sub">Protocole</p>
      <p className="act-protocol">
        <span className={`tag ${firstOk ? 'tag-ok' : 'tag-err'}`}>{firstOk ? 'thinking d’abord' : `premier événement : ${trace.firstEvent}`}</span>{' '}
        <span className={`tag ${titled ? 'tag-ok' : 'tag-err'}`}>{titled ? `thinking titré (${trace.thinkingTitles?.length})` : 'thinking non titré'}</span>{' '}
        {(trace.toolCalls ?? []).length > 0 ? (
          <span className={`tag ${argsAllOk ? 'tag-ok' : 'tag-err'}`}>{argsAllOk ? 'arguments valides' : 'arguments mal formés'}</span>
        ) : null}
        {trace.systemChars !== undefined ? <span className="tag">ICM {trace.systemChars.toLocaleString('fr-FR')} car.</span> : null}
      </p>
      {trace.thinkingTitles !== undefined && trace.thinkingTitles.length > 0 ? (
        <>
          <p className="act-sub">Titres du thinking</p>
          <p className="act-titles">{trace.thinkingTitles.join(' · ')}</p>
        </>
      ) : null}
      {trace.thinking !== undefined && trace.thinking !== '' ? (
        <>
          <p className="act-sub">Thinking (extrait)</p>
          <pre>{trace.thinking}</pre>
        </>
      ) : null}
      {trace.text !== undefined && trace.text !== '' ? (
        <>
          <p className="act-sub">Réponse du modèle (extrait)</p>
          <pre>{trace.text}</pre>
        </>
      ) : null}
      {trace.toolCalls !== undefined && trace.toolCalls.length > 0 ? (
        <>
          <p className="act-sub">Tool calls émis</p>
          <ul className="act-calls">
            {trace.toolCalls.map((c, i) => (
              <li key={`${c.tool}-${i}`}>
                <code>{c.tool}</code>
                {c.title !== '' ? ` — ${c.title}` : ' — (sans titre)'}
                {!c.argsOk ? <span className="tag tag-err"> arguments mal formés</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
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
          <ResponseView trace={trace} />
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

/**
 * M17 — the session's OWN quartet, read from its folder: the pilot opens the
 * Activity tab and reads THIS session's model.jsonl (the model's responses)
 * without leaving the UI — the logs were on disk only until now.
 */
function SessionLogsCard({ sessionId }: { sessionId: string }) {
  const [logs, setLogs] = useState<api.SessionLogsDto | null>(null)
  const [logTail, setLogTail] = useState<{ name: string; tail: string } | null>(null)

  const refresh = useCallback(() => {
    void api
      .listSessionLogs(sessionId)
      .then(setLogs)
      .catch(() => setLogs(null))
  }, [sessionId])

  useEffect(() => {
    refresh()
    setLogTail(null)
  }, [refresh])

  return (
    <div className="act-logs" data-test="session-logs">
      <div className="act-logs-head">
        <h4>Journaux de la session</h4>
        <button type="button" className="diag-refresh" data-test="session-logs-refresh" onClick={refresh}>
          Rafraîchir
        </button>
      </div>
      {logs === null ? (
        <p className="activity-note">Journaux injoignables (serveur de sessions absent ?).</p>
      ) : logs.dir === '' ? (
        <p className="activity-note">Dossier de logs introuvable — la session n’est liée à aucun dossier résolu.</p>
      ) : (
        <>
          <p className="activity-note">
            Le quatuor de CETTE session, dans son propre dossier : <code>{logs.dir}</code> — model.jsonl porte les réponses du
            modèle (model.response) et ce qu’on lui a répondu (model.observation). Zippé, ce dossier est la matière première
            du harness.
          </p>
          <table className="journal" data-test="session-logs-table">
            <thead>
              <tr>
                <th>Journal</th>
                <th>Lignes</th>
                <th>Taille</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.files.map((f) => (
                <tr key={f.name} data-test="session-logs-row">
                  <td className="journal-model">{f.name}</td>
                  <td>{f.lines}</td>
                  <td>{(f.bytes / 1024).toFixed(1)} Kio</td>
                  <td>
                    <button
                      type="button"
                      className="diag-refresh"
                      onClick={() =>
                        void api
                          .tailSessionLog(sessionId, f.name, 50)
                          .then((t) => setLogTail(t.tail === '' ? { name: f.name, tail: '(vide)' } : { name: f.name, tail: t.tail }))
                          .catch(() => setLogTail(null))
                      }
                    >
                      Voir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {logTail !== null ? (
            <pre className="log-tail" data-test="session-log-tail">{logTail.name} — 50 dernières lignes
{'\n'}{logTail.tail}</pre>
          ) : null}
        </>
      )}
    </div>
  )
}

export function ActivityPanel({
  traces,
  toolRows,
  sessionId,
}: {
  traces: readonly RequestTrace[]
  toolRows: readonly ChatMsg[]
  /** M17 — the session's own logs are part of its profiling view. */
  sessionId?: string
}) {
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
      {sessionId !== undefined ? <SessionLogsCard sessionId={sessionId} /> : null}
    </div>
  )
}
