import { useEffect, useRef, useState } from 'react'
import type { ChatMsg } from '../lib/types'

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

/** Pretty one-line description of a call (what the harness tracking shows). */
function toolLine(m: ChatMsg): string {
  const target = targetOf(m.args)
  if (m.ok === undefined) return `${m.tool} « ${target} » — en attente d'approbation`
  return m.summary ?? `${m.tool} — fait`
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

/** One tool row of the agent's activity (M11, M12: expandable details). */
function ToolRow({ m }: { m: ChatMsg }) {
  const [open, setOpen] = useState(false)
  const state = m.ok === undefined ? 'pending' : m.ok ? 'ok' : 'err'
  const background =
    m.tool === 'shell' && m.args !== null && typeof m.args === 'object' && (m.args as Record<string, unknown>).background === true
  return (
    <div className="msg tool" data-test="tool-row" data-state={state} data-tool={m.tool}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-glyph" aria-hidden="true">{TOOL_GLYPH[m.tool ?? ''] ?? '🔧'}</span>
        <span className={`tool-state ${state}`} aria-hidden="true">{state === 'pending' ? '⏳' : state === 'ok' ? '✓' : '✗'}</span>
        <span className="tool-label">
          <code>{m.tool}</code>
          {background ? <span className="tool-bg">arrière-plan</span> : null} {toolLine(m)}
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
 * The thinking block (M12): streamed live above the answer, collapsible
 * with a chevron — open while it streams, collapsed once the answer text
 * starts (a summary line keeps it one row tall).
 */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Once the ANSWER text starts arriving, fold the thinking — one row tall.
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])

  useEffect(() => {
    if (open && streaming) bodyRef.current?.scrollIntoView({ block: 'nearest' })
  }, [text, open, streaming])

  return (
    <div className="thinking" data-test="thinking-block">
      <button type="button" className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s var(--ease)' }}>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="thinking-title">Réflexion</span>
        <span className="thinking-meta">{text.length} caractères{streaming ? ' · en cours…' : ''}</span>
      </button>
      {open ? (
        <div className="thinking-body" ref={bodyRef}>
          {text}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The session stream (M11, M12): chat messages (with their thinking block),
 * and the agent's tool activity, interleaved in journal order. The caret
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
  return (
    <div className="chat">
      {messages.map((m) =>
        m.role === 'tool' ? (
          <ToolRow key={m.id} m={m} />
        ) : (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' && m.thinking !== undefined && m.thinking !== '' ? (
              <ThinkingBlock text={m.thinking} streaming={m.streaming === true} />
            ) : null}
            {m.text}
            {m.role === 'assistant' && m.streaming ? <span className="caret">▍</span> : null}
          </div>
        ),
      )}
    </div>
  )
}
