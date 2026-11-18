import { useEffect, useRef, useState } from 'react'
import { isDangerousTool } from '../lib/agentTools'
import type { ChatMsg, ThinkingBlock } from '../lib/types'

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

/**
 * M18 — the Z.ai-style group summary: counts aggregated BY TOOL, one label
 * per tool present in the group (« 8 fichiers lus · 4 fichiers écrits ·
 * 2 commandes lancées »). The pilot reads the group's intention at a
 * glance, without ever opening it.
 */
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

/** The aggregated head line of a group: « 2 fichiers lus · 1 dossier listé ». */
function groupSummary(rows: readonly ChatMsg[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.tool ?? '', (counts.get(r.tool ?? '') ?? 0) + 1)
  const parts: string[] = []
  for (const [tool, n] of counts) {
    parts.push(TOOL_GROUP_LABEL[tool] !== undefined ? TOOL_GROUP_LABEL[tool]!(n) : `${n} ${tool}`)
  }
  return parts.join(' · ')
}

/** The summary for the HEAD LINE: the server writes « tool « target » —
 * outcome », but the line already shows tool and target — strip the
 * redundant prefix, keep the informative tail (full summary in the
 * activity tab). */
function headSummary(m: ChatMsg): string {
  const s = m.summary ?? ''
  if (m.tool === undefined) return s
  const re = new RegExp(`^${m.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(arrière-plan\\))? « [^»]* » — `)
  return s.replace(re, '')
}

/**
 * M18 — one tool row of the chat: TITLE, TARGET and STATUS, nothing else.
 * The raw JSON (arguments, result payload) is profiling material: it lives
 * in the Activité tab and in model.jsonl, not in the conversation. A
 * pending row says whether it is RUNNING or WAITING FOR APPROVAL — the
 * pilot never guesses.
 */
function ToolRow({ m }: { m: ChatMsg }) {
  const state = m.ok === undefined ? 'pending' : m.ok ? 'ok' : 'err'
  const background =
    m.tool === 'shell' && m.args !== null && typeof m.args === 'object' && (m.args as Record<string, unknown>).background === true
  const target = targetOf(m.args)
  return (
    <div className="msg tool" data-test="tool-row" data-state={state} data-tool={m.tool} {...(m.title !== undefined ? { 'data-title': m.title } : {})}>
      <span className="tool-glyph" aria-hidden="true">{TOOL_GLYPH[m.tool ?? ''] ?? '🔧'}</span>
      <span className={`tool-state ${state}`} aria-hidden="true">{state === 'pending' ? '⏳' : state === 'ok' ? '✓' : '✗'}</span>
      <span className="tool-label">
        {m.title !== undefined && m.title !== '' ? <span className="tool-title">{m.title}</span> : null}
        {background ? <span className="tool-bg">arrière-plan</span> : null}
        <code>{m.tool}</code>
        {target !== '' ? <> « {target} »</> : null}
        {m.ok === undefined ? (
          <span className="tool-sum"> — {isDangerousTool(m.tool ?? '') ? 'en attente d’approbation' : 'en cours…'}</span>
        ) : m.summary !== undefined && m.summary !== '' ? (
          <span className="tool-sum"> — {headSummary(m)}</span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * One titled card of the model's thought process (M12 streamed, M15 titled
 * and collapsible): the two-phase protocol opens each response with a titled
 * internal dialogue — the pilot reads the title folded, expands at will.
 * Anonymous blocks (a model's native reasoning channel) keep the M12 look.
 */
function ThinkingCard({ block, streaming }: { block: ThinkingBlock; streaming: boolean }) {
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titled = block.title !== ''

  // Once the ANSWER text starts arriving, fold the thinking — one row tall.
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])

  useEffect(() => {
    if (open && streaming) bodyRef.current?.scrollIntoView({ block: 'nearest' })
  }, [block.text, open, streaming])

  return (
    <div className="thinking" data-test="thinking-block" {...(titled ? { 'data-title': block.title } : {})}>
      <button type="button" className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="thinking-title">{titled ? block.title : 'Réflexion'}</span>
        <span className="thinking-meta">{block.text.length} caractères{streaming ? ' · en cours…' : ''}</span>
      </button>
      {open ? (
        <div className="thinking-body" ref={bodyRef}>
          {block.text}
        </div>
      ) : null}
    </div>
  )
}

/** The message's thinking (M15): each titled block is its own collapsible
 * card — several blocks stack in protocol order. */
function ThinkingBlocks({ m }: { m: ChatMsg }) {
  const blocks =
    m.thinkingBlocks !== undefined && m.thinkingBlocks.length > 0
      ? m.thinkingBlocks
      : [{ title: '', text: m.thinking ?? '' }]
  return (
    <>
      {blocks.map((b, i) => (
        <ThinkingCard key={i} block={b} streaming={m.streaming === true && i === blocks.length - 1} />
      ))}
    </>
  )
}

/**
 * One GROUP of tool calls (M15 grouped, M18 Z.ai-style): the calls of a
 * same model round run in parallel and land together — ONE collapsible
 * card whose HEAD aggregates them by tool (« 8 fichiers lus · 2 commandes
 * lancées »). The tree is OPEN while calls are pending (the pilot watches
 * the live statuses) and FOLDS ITSELF when the group settles — unless the
 * pilot opened or closed it by hand, which always wins.
 */
function ToolGroup({ rows }: { rows: readonly ChatMsg[] }) {
  const pendingCount = rows.filter((r) => r.ok === undefined).length
  const pending = pendingCount > 0
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? pending
  if (rows.length === 1) return <ToolRow m={rows[0]!} />
  const ok = rows.filter((r) => r.ok === true).length
  const err = rows.filter((r) => r.ok === false).length
  const state = pending ? 'pending' : err > 0 ? 'err' : 'ok'
  return (
    <div className="tool-group" data-test="tool-group" data-count={rows.length} data-state={state}>
      <button type="button" className="tool-group-head" onClick={() => setManual(!open)} aria-expanded={open}>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tool-group-title">{groupSummary(rows)}</span>
        <span className="tool-group-meta">
          {pending ? (
            <span className="tool-state pending">⏳ {rows.length - pendingCount}/{rows.length}</span>
          ) : (
            <>
              {ok > 0 ? <span className="tool-state ok">{ok} ✓</span> : null}
              {err > 0 ? <span className="tool-state err">{err} ✗</span> : null}
            </>
          )}
        </span>
      </button>
      {open ? (
        <div className="tool-group-body">
          {rows.map((r) => (
            <ToolRow key={r.id} m={r} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The session stream (M11, M12, M15, M18): chat messages (with their titled
 * thinking cards), and the agent's tool activity — the calls of one round
 * grouped into a single collapsible card, in journal order. The USER speaks
 * from the right; EVERYTHING the agent produces (thinking, actions, text)
 * stays on the left. The caret marks an ongoing stream.
 */
export function ChatView({ messages }: { messages: readonly ChatMsg[] }) {
  if (messages.length === 0) {
    return (
      <div className="chat">
        <p className="empty">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            width="28"
            height="28"
            aria-hidden="true"
            style={{ display: 'block', margin: '0 auto 8px', opacity: 0.45 }}
          >
            <path
              d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.3-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          Envoyez un message pour commencer.
        </p>
      </div>
    )
  }
  // M15 — consecutive tool rows form ONE group: the calls of a round arrive
  // together (parallel dispatch) and replay together (journal order), so
  // adjacency IS the grouping — live and after a reload alike.
  const rendered: Array<{ kind: 'msg'; m: ChatMsg } | { kind: 'group'; rows: ChatMsg[] }> = []
  for (const m of messages) {
    const last = rendered[rendered.length - 1]
    if (m.role === 'tool') {
      if (last !== undefined && last.kind === 'group') last.rows.push(m)
      else rendered.push({ kind: 'group', rows: [m] })
    } else {
      rendered.push({ kind: 'msg', m })
    }
  }
  return (
    <div className="chat">
      {rendered.map((item, i) =>
        item.kind === 'group' ? (
          <ToolGroup key={`g${item.rows[0]?.id ?? i}`} rows={item.rows} />
        ) : (
          <div key={item.m.id} className={`msg ${item.m.role}`}>
            {item.m.role === 'assistant' && item.m.thinking !== undefined && item.m.thinking !== '' ? (
              <ThinkingBlocks m={item.m} />
            ) : null}
            {item.m.text}
            {item.m.role === 'assistant' && item.m.streaming ? <span className="caret">▍</span> : null}
          </div>
        ),
      )}
    </div>
  )
}
