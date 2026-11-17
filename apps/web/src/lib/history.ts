import type { ChatMessage } from '@nyworkflow/adapter-llm'
import type { ChatMsg } from './types'

/** Max rows sent to the model per request (chat + tool rows). */
const MAX_ROWS = 24

/**
 * Session rows → model messages. Chat rows become user/assistant messages;
 * each settled tool row becomes the assistant tool_calls message + the tool
 * result — the standard round-trip the gateway replays upstream. Pending
 * rows (paused for a human) are not sent: their result doesn't exist yet.
 */
export function toAgentMessages(rows: readonly ChatMsg[]): ChatMessage[] {
  const usable = rows
    .filter((r) => {
      if (r.streaming) return false
      if (r.role === 'user' || r.role === 'assistant') return r.text.trim() !== ''
      if (r.role === 'tool') return r.ok !== undefined
      return false
    })
    .slice(-MAX_ROWS)

  const out: ChatMessage[] = []
  for (const r of usable) {
    if (r.role === 'user' || r.role === 'assistant') {
      out.push({ role: r.role, content: r.text })
      continue
    }
    // Tool row: the call the model made, then the outcome it received.
    const callId = `call-${r.id}`
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: r.tool ?? 'unknown', arguments: JSON.stringify(r.args ?? {}) },
        },
      ],
    })
    out.push({
      role: 'tool',
      tool_call_id: callId,
      content:
        r.ok === true
          ? JSON.stringify({ ok: true, result: r.data ?? r.summary })
          : JSON.stringify({ ok: false, error: r.summary ?? 'refusé' }),
    })
  }
  return out
}
