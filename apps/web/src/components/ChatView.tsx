import { useEffect, useRef, useState } from 'react'
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
  return JSON.stringify(args)
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

/** The summary for the HEAD LINE: the server writes « tool « target » —
 * outcome », but the line already shows tool and target — strip the
 * redundant prefix, keep the informative tail (full summary in details). */
function headSummary(m: ChatMsg): string {
  const s = m.summary ?? ''
  if (m.tool === undefined) return s
  const re = new RegExp(`^${m.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(arrière-plan\\))? « [^»]* » — `)
  return s.replace(re, '')
}

/** A tool call's args and result payload, pretty-printed and capped. */
function prettyJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? ''
    return raw.length > 4000 ? `${raw.slice(0, 4000)}\n… (tronqué)` : raw
  } catch {
    return String(value)
  }
}

/** One tool row of the agent's activity (M11, M12: expandable details; M15:
 * the call's `title` argument leads the line when the model filled it). */
function ToolRow({ m }: { m: ChatMsg }) {
  const [open, setOpen] = useState(false)
  const state = m.ok === undefined ? 'pending' : m.ok ? 'ok' : 'err'
  const background =
    m.tool === 'shell' && m.args !== null && typeof m.args === 'object' && (m.args as Record<string, unknown>).background === true
  return (
    <div className="msg tool" data-test="tool-row" data-state={state} data-tool={m.tool} {...(m.title !== undefined ? { 'data-title': m.title } : {})}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-glyph" aria-hidden="true">{TOOL_GLYPH[m.tool ?? ''] ?? '🔧'}</span>
        <span className={`tool-state ${state}`} aria-hidden="true">{state === 'pending' ? '⏳' : state === 'ok' ? '✓' : '✗'}</span>
        <span className="tool-label">
          {m.title !== undefined && m.title !== '' ? <span className="tool-title">{m.title}</span> : null}
          {background ? <span className="tool-bg">arrière-plan</span> : null}
          <code>{m.tool}</code> « {targetOf(m.args)} »
          {m.ok === undefined ? (
            <span className="tool-sum"> — en attente d'approbation</span>
          ) : m.summary !== undefined && m.summary !== '' ? (
            <span className="tool-sum"> — {headSummary(m)}</span>
          ) : null}
        </span>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="tool-details" data-test="tool-details">
          <p className="tool-details-title">Arguments</p>
          <pre>{prettyJson(m.args ?? {})}</pre>
          {m.ok !== undefined ? (
            <>
              <p className="tool-details-title">Résultat renvoyé au modèle</p>
              <pre>{m.ok && m.data !== undefined ? prettyJson(m.data) : prettyJson({ ok: false, summary: m.summary })}</pre>
            </>
          ) : null}
        </div>
      ) : null}
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
 * One GROUP of tool calls (M15): the calls of a same model round run in
 * parallel and land together — they are shown as ONE collapsible card that
 * holds their rows. The header counts them live (pending, ok, err); a single
 * call renders as the plain row (no wrapper noise).
 */
function ToolGroup({ rows }: { rows: readonly ChatMsg[] }) {
  const [open, setOpen] = useState(true)
  if (rows.length === 1) return <ToolRow m={rows[0]!} />
  const pending = rows.filter((r) => r.ok === undefined).length
  const ok = rows.filter((r) => r.ok === true).length
  const err = rows.filter((r) => r.ok === false).length
  return (
    <div className="tool-group" data-test="tool-group" data-count={rows.length}>
      <button type="button" className="tool-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tool-group-title">Actions de l'agent</span>
        <span className="tool-group-meta">
          {rows.length} appels
          {ok > 0 ? <span className="tool-state ok"> · {ok} ✓</span> : null}
          {err > 0 ? <span className="tool-state err"> · {err} ✗</span> : null}
          {pending > 0 ? <span className="tool-state pending"> · {pending} ⏳</span> : null}
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
 * The session stream (M11, M12, M15): chat messages (with their titled
 * thinking cards), and the agent's tool activity — the calls of one round
 * grouped into a single collapsible card, in journal order. The caret
 * marks an ongoing stream.
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
