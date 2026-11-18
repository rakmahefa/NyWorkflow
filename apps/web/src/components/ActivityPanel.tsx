import { useCallback, useEffect, useState } from 'react'
import * as api from '../lib/sessionApi'
import type { ChatMsg, RequestTrace } from '../lib/types'

/**
 * The activity tab (M12, M13, M17, M18) — the FILTERED profiling view of
 * one session. The model's behaviour having become coherent, the display
 * follows: ONE collapsible block per TURN (its rounds, its tool calls,
 * its outcome), folded by default — the pilot reads a one-line summary
 * (« Tour 3 · 8 fichiers lus · 2 commandes lancées · 54 s · ok ») and
 * expands only what needs attention. The raw payloads (arguments, results
 * fed back to the model) stay HERE, in the profiling tab — the chat shows
 * titles and statuses only.
 *
 * Turn blocks derive from the session's journal (tool.call/tool.result +
 * turn.completed, M13) and from the live round traces the browser loop
 * records as they stream: the whole tab survives reloads.
 */

const fmtTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const fmtDuration = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`)

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

/** One letter-icon per tool — a quick visual grammar for the activity. */
const TOOL_GLYPH: Record<string, string> = {
  read: '📖',
  write: '✍️',
  ls: '🗂️',
  glob: '🔍',
  mkdir: '📁',
  shell: '⌨️',
  websearch: '🌐',
  shell_output: '📡',
  shell_kill: '🛑',
}

/** M18 — the Z.ai-style summary of a tool set: counts by tool, French. */
const TOOL_GROUP_LABEL: Record<string, (n: number) => string> = {
  read: (n) => (n === 1 ? '1 fichier lu' : `${n} fichiers lus`),
  write: (n) => (n === 1 ? '1 fichier écrit' : `${n} fichiers écrits`),
  ls: (n) => (n === 1 ? '1 dossier listé' : `${n} dossiers listés`),
  glob: (n) => (n === 1 ? '1 recherche de fichiers' : `${n} recherches de fichiers`),
  mkdir: (n) => (n === 1 ? '1 dossier créé' : `${n} dossiers créés`),
  shell: (n) => (n === 1 ? '1 commande lancée' : `${n} commandes lancées`),
  websearch: (n) => (n === 1 ? '1 recherche web' : `${n} recherches web`),
  shell_output: (n) => (n === 1 ? '1 job suivi' : `${n} jobs suivis`),
  shell_kill: (n) => (n === 1 ? '1 job arrêté' : `${n} jobs arrêtés`),
}

/** « 2 fichiers lus · 1 commande lancée » — the head line of a turn. */
function toolSummary(rows: readonly ChatMsg[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.tool ?? '', (counts.get(r.tool ?? '') ?? 0) + 1)
  const parts: string[] = []
  for (const [tool, n] of counts) {
    parts.push(TOOL_GROUP_LABEL[tool] !== undefined ? TOOL_GROUP_LABEL[tool]!(n) : `${n} ${tool}`)
  }
  return parts.join(' · ')
}

/** Compact display of a tool call's target. */
function targetOf(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    for (const key of ['path', 'pattern', 'command', 'query', 'url', 'jobId']) {
      const v = a[key]
      if (typeof v === 'string' && v !== '') return v
    }
  }
  return ''
}

/** One TURN of the session: its live round traces, its journaled summary
 * (turn.completed, when known), and its tool rows. */
interface TurnBlock {
  key: string
  /** Live round traces (round ≥ 1), journal order. */
  rounds: RequestTrace[]
  /** The journaled turn.completed summary — present after a reload. */
  final?: RequestTrace
  /** The turn's tool rows, journal order. */
  tools: ChatMsg[]
  /** True while the turn has neither a final summary nor a closing round. */
  running: boolean
}

/** M18 — builds the turn blocks from the merged timeline: a live trace
 * with round 1 opens a turn, a journaled turn.completed (final) closes
 * it, tool rows land in the open turn. Orphans (tools before any trace,
 * after a reload) get their own block. */
function buildTurns(traces: readonly RequestTrace[], toolRows: readonly ChatMsg[]): TurnBlock[] {
  const entries: Array<{ at: number; kind: 'request' | 'tool'; trace?: RequestTrace; row?: ChatMsg }> = [
    ...traces.map((t): { at: number; kind: 'request' | 'tool'; trace: RequestTrace } => ({ at: t.at, kind: 'request', trace: t })),
    ...toolRows.map((r): { at: number; kind: 'request' | 'tool'; row: ChatMsg } => ({ at: r.at, kind: 'tool', row: r })),
  ].sort((a, b) => a.at - b.at)
  const turns: TurnBlock[] = []
  let k = 0
  let current: TurnBlock | null = null
  const openTurn = (): TurnBlock => {
    if (current === null) {
      current = { key: `turn-${k++}`, rounds: [], tools: [], running: true }
      turns.push(current)
    }
    return current
  }
  for (const e of entries) {
    if (e.kind === 'request' && e.trace !== undefined) {
      const t = e.trace
      if (t.final === true) {
        // The journaled summary closes whatever block is open — or stands
        // alone when the reload rebuilt the turn from the journal only.
        const block = openTurn()
        block.final = t
        block.running = false
        current = null
      } else if (t.round === 1) {
        // A new live turn starts — the previous block, if unfinished, is
        // closed implicitly (its turn.completed never arrived).
        current = null
        openTurn().rounds.push(t)
      } else {
        openTurn().rounds.push(t)
      }
    } else if (e.kind === 'tool' && e.row !== undefined) {
      openTurn().tools.push(e.row)
    }
  }
  // A block whose last live round closed (ok/error/stopped) is done even
  // without its journaled summary.
  for (const t of turns) {
    if (t.final === undefined && t.rounds.length > 0) {
      const last = t.rounds[t.rounds.length - 1]!
      t.running = last.outcome === 'tool_calls'
    } else if (t.final === undefined) {
      t.running = t.tools.some((r) => r.ok === undefined)
    }
  }
  return turns
}

/** M17 — the response block of a round card. Nothing when the trace is
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
      {trace.feedback !== undefined && trace.feedback !== '' ? (
        <>
          <p className="act-sub">Rappel de protocole renvoyé au modèle (mentor)</p>
          <pre className="act-mentor" data-test="act-mentor">{trace.feedback}</pre>
        </>
      ) : null}
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

/** One live ROUND of a turn — compact head (round, outcome, duration),
 * expandable body (facts + the model's response, M17). */
function RoundCard({ trace }: { trace: RequestTrace }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="act-card request" data-test="act-request" data-outcome={trace.outcome}>
      <button type="button" className="act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="act-time">{fmtTime(trace.at)}</span>
        <span className="act-icon" aria-hidden="true">⚡</span>
        <span className="act-title">
          Round {trace.round} — <code>{trace.model}</code>
        </span>
        <span className={`act-tag ${OUTCOME_CLASS[trace.outcome]}`}>{OUTCOME_LABEL[trace.outcome]}</span>
        <span className="act-meta">
          {trace.messages} msg · {trace.tools} outils · {trace.ms} ms
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

/** One tool row of the profiling view: compact head (title, target,
 * status), expandable body (the EXACT arguments and payload — profiling
 * material, this tab is its home). */
function ToolCard({ row }: { row: ChatMsg }) {
  const [open, setOpen] = useState(false)
  const state = row.ok === undefined ? 'pending' : row.ok ? 'ok' : 'err'
  const target = targetOf(row.args)
  return (
    <div className="act-card tool" data-test="act-tool" data-state={state}>
      <button type="button" className="act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="act-time">{fmtTime(row.at)}</span>
        <span className="act-icon" aria-hidden="true">{TOOL_GLYPH[row.tool ?? ''] ?? '🔧'}</span>
        <span className="act-title">
          {row.title !== undefined && row.title !== '' ? (
            <>
              {row.title} — <code>{row.tool}</code>
            </>
          ) : (
            <code>{row.tool}</code>
          )}
          {target !== '' ? ` « ${target} »` : ''}
        </span>
        <span className={`act-tag ${state === 'ok' ? 'tag-ok' : state === 'err' ? 'tag-err' : 'tag-warn'}`}>
          {state === 'ok' ? 'ok' : state === 'err' ? 'refusé/erreur' : 'en attente'}
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

/** M18 — ONE TURN, one collapsible block: head = the filtered summary the
 * pilot reads (turn number, model, tool counts, duration, outcome); body =
 * the rounds with their tool calls nested underneath, plus the journaled
 * summary when the turn was rebuilt from the journal. */
function TurnBlockView({ turn, index, defaultOpen }: { turn: TurnBlock; index: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const final = turn.final
  const model = final?.model ?? turn.rounds[turn.rounds.length - 1]?.model ?? ''
  const rounds = final?.round ?? turn.rounds.length
  const ms = final?.ms ?? turn.rounds.reduce((acc, r) => acc + r.ms, 0)
  const outcome = final?.outcome ?? (turn.running ? 'tool_calls' : turn.rounds[turn.rounds.length - 1]?.outcome ?? 'ok')
  const ok = turn.tools.filter((r) => r.ok === true).length
  const err = turn.tools.filter((r) => r.ok === false).length
  const pending = turn.tools.length - ok - err
  // Tools nest under their round (live turns): a row belongs to the last
  // round that started before it.
  const toolsOfRound = (i: number): ChatMsg[] => {
    const round = turn.rounds[i]
    const next = turn.rounds[i + 1]
    if (round === undefined) return []
    if (next === undefined) return turn.tools.filter((t) => t.at >= round.at)
    return turn.tools.filter((t) => t.at >= round.at && t.at < next.at)
  }
  return (
    <div className="turn-block" data-test="act-turn" data-running={turn.running} data-open={open}>
      <button type="button" className="turn-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="turn-label">Tour {index}</span>
        {model !== '' ? <code className="turn-model">{model}</code> : null}
        <span className="turn-summary">{turn.tools.length > 0 ? toolSummary(turn.tools) : rounds > 0 ? `${rounds} round${rounds > 1 ? 's' : ''}` : ''}</span>
        <span className="turn-meta">
          {rounds > 0 ? `${rounds} r` : ''}
          {turn.tools.length > 0 ? ` · ${turn.tools.length} appels` : ''}
          {ms > 0 ? ` · ${fmtDuration(ms)}` : ''}
        </span>
        {turn.running ? (
          <span className="act-tag tag-warn">en cours</span>
        ) : (
          <>
            {pending > 0 ? <span className="act-tag tag-warn">{pending} ⏳</span> : null}
            {err > 0 ? <span className="act-tag tag-err">{err} ✗</span> : null}
            <span className={`act-tag ${OUTCOME_CLASS[outcome]}`}>{OUTCOME_LABEL[outcome]}</span>
          </>
        )}
      </button>
      {open ? (
        <div className="turn-body">
          {final !== undefined ? (
            <div className="turn-final" data-test="act-turn-final">
              <dl className="act-facts">
                <div>
                  <dt>Modèle</dt>
                  <dd>
                    <code>{final.model}</code>
                  </dd>
                </div>
                <div>
                  <dt>Niveau de réflexion</dt>
                  <dd>{final.thinkLevel === null ? 'défaut du modèle' : `@think=${final.thinkLevel}`}</dd>
                </div>
                <div>
                  <dt>Tour</dt>
                  <dd>
                    {final.round} round{final.round > 1 ? 's' : ''} · {final.ms} ms · {final.messages} msg · {final.tools} outils
                  </dd>
                </div>
                <div>
                  <dt>Production</dt>
                  <dd>
                    réflexion {final.thinkingChars.toLocaleString('fr-FR')} car. · réponse {final.textChars.toLocaleString('fr-FR')} car.
                  </dd>
                </div>
              </dl>
              {final.error !== undefined ? <p className="act-error">{final.error}</p> : null}
            </div>
          ) : null}
          {turn.rounds.map((r, i) => (
            <div key={r.id} className="turn-round">
              <RoundCard trace={r} />
              {toolsOfRound(i).map((t) => (
                <ToolCard key={t.id} row={t} />
              ))}
            </div>
          ))}
          {(turn.rounds.length === 0 ? turn.tools : turn.tools.filter((t) => t.at < (turn.rounds[0]?.at ?? 0))).map((t) => (
            <ToolCard key={t.id} row={t} />
          ))}
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
  const turns = buildTurns(traces, toolRows)
  // Only the RUNNING last turn opens itself — everything else stays folded:
  // one line per turn is the filtered view the pilot asked for.
  return (
    <div className="activity" data-test="activity-panel">
      {turns.length === 0 ? (
        <p className="empty">Aucune activité encore — envoyez un message pour voir les tours et les outils en direct.</p>
      ) : (
        <>
          <p className="activity-note">
            Un tour par bloc, replié d’office — les titres d’appels et les statuts suffisent ; les payloads exacts (arguments,
            résultats renvoyés au modèle) se déplient ici, et vivent dans <code>model.jsonl</code>.
          </p>
          {turns.map((t, i) => (
            <TurnBlockView key={t.key} turn={t} index={i + 1} defaultOpen={t.running && i === turns.length - 1} />
          ))}
        </>
      )}
      {sessionId !== undefined ? <SessionLogsCard sessionId={sessionId} /> : null}
    </div>
  )
}
