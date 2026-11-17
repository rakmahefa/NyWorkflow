import type { ChatMsg } from '../lib/types'

/** Message list of the active session. The caret marks an ongoing stream. */
export function ChatView({ messages }: { messages: readonly ChatMsg[] }) {
  if (messages.length === 0) {
    return (
      <div className="chat">
        <p className="empty">Envoyez un message pour commencer.</p>
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
