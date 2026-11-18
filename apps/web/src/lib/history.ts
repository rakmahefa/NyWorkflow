import type { ChatMessage } from '@nyworkflow/adapter-llm'
import type { ChatMsg } from './types'
import { titleOfArgs } from './agentTools'

/** Max rows sent to the model per request (chat + tool rows). */
const MAX_ROWS = 24

/**
 * Session rows → model messages. Chat rows become user/assistant messages;
 * each ADJACENT GROUP of settled tool rows becomes the assistant tool_calls
 * message (the WHOLE group — the model sees its calls as it made them,
 * together) followed by one tool message per call, in the protocol's
 * response format:
 *
 *   {"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}
 *
 * The tool + title echo lets the model correlate each result with its call
 * without guessing (M16 — the group returns to the model INTACT, at the
 * end of the protocol, as the ICM teaches it). Pending rows (paused for a
 * human) are not sent: their result doesn't exist yet.
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
  let i = 0
  while (i < usable.length) {
    const r = usable[i]
    if (r === undefined) break
    if (r.role === 'user' || r.role === 'assistant') {
      out.push({ role: r.role, content: r.text })
      i++
      continue
    }
    // Tool rows — gather the WHOLE adjacent group (the calls of one
    // protocol step), then render it as the model made it: one assistant
    // message with every call, then every result.
    const group: ChatMsg[] = []
    while (i < usable.length && usable[i]?.role === 'tool') {
      group.push(usable[i] as ChatMsg)
      i++
    }
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: group.map((g) => ({
        id: `call-${g.id}`,
        type: 'function' as const,
        function: { name: g.tool ?? 'unknown', arguments: JSON.stringify(g.args ?? {}) },
      })),
    })
    for (const g of group) {
      const tool = g.tool ?? 'unknown'
      const title = titleOfArgs(g.args)
      out.push({
        role: 'tool',
        tool_call_id: `call-${g.id}`,
        content:
          g.ok === true
            ? JSON.stringify({ tool, title, ok: true, result: g.data ?? g.summary })
            : JSON.stringify({ tool, title, ok: false, error: g.summary ?? 'refusé' }),
      })
    }
  }
  return out
}
