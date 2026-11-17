import type { ChatMsg } from '../lib/types'

/** Message list of the active session. The caret marks an ongoing stream. */
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
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          {m.text}
          {m.role === 'assistant' && m.streaming ? <span className="caret">▍</span> : null}
        </div>
      ))}
    </div>
  )
}
