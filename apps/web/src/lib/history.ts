import type { ChatMessage } from '@nyworkflow/adapter-llm'
import type { ChatMsg } from './types'

/** Max messages sent to the model per request. */
const MAX_HISTORY = 20

/**
 * Session messages → model messages: user/assistant only, complete
 * (not streaming), non-empty, capped to the last MAX_HISTORY entries.
 */
export function toLlmHistory(msgs: readonly ChatMsg[]): ChatMessage[] {
  return msgs
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.streaming && m.text.trim() !== '')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.text }))
}
