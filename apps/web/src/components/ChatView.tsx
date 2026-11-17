import type { ChatMsg } from '../lib/types'

/** Compact display of a tool call's target. */
function targetOf(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    for (const key of ['path', 'pattern', 'command', 'query', 'url']) {
      const v = a[key]
      if (typeof v === 'string' && v !== '') return v
    }
  }
  return JSON.stringify(args)
}

/** One tool row of the agent's activity (M11). */
function ToolRow({ m }: { m: ChatMsg }) {
  const state = m.ok === undefined ? 'pending' : m.ok ? 'ok' : 'err'
  const label =
    m.ok === undefined
      ? `${m.tool} « ${targetOf(m.args)} » — en attente d'approbation`
      : (m.summary ?? `${m.tool} — fait`)
  return (
    <div className="msg tool" data-test="tool-row" data-state={state}>
      <span aria-hidden="true">{state === 'pending' ? '⏳' : state === 'ok' ? '✓' : '✗'}</span> {label}
    </div>
  )
}

/**
 * The session stream (M11): chat messages and the agent's tool activity,
 * interleaved in journal order. The caret marks an ongoing stream.
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
            {m.text}
            {m.role === 'assistant' && m.streaming ? <span className="caret">▍</span> : null}
          </div>
        ),
      )}
    </div>
  )
}
