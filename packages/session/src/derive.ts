/**
 * Derivation — the journal is the only source of truth, so everything the
 * UI shows (title, date, chat history) is re-derived from its events.
 * Chat history keeps user/assistant messages only: tool and stage events
 * join the view as tool activity (M5), never the model history shape.
 */
import type { SessionEvent } from './index'

export interface DerivedMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
}

/** One tool call as shown in the UI — ok undefined while pending approval. */
export interface DerivedToolCall {
  tool: string
  args: unknown
  at: string
  ok?: boolean
  summary?: string
}

export interface DerivedSession {
  /** ISO date of session.created (falls back to the first event). */
  createdAt: string
  /** Title as shown, fork suffix included. */
  title: string
  /** Title without the fork suffix. */
  baseTitle: string
  /** Present when this journal is a fork. */
  forkedFrom?: string
  /** ICM workspace name, when this session runs a workflow. (M4) */
  workspace?: string
  /** Chat messages in order. */
  messages: DerivedMessage[]
  /** Tool calls in order, paired with their result when resolved. (M5) */
  tools: DerivedToolCall[]
}

const TITLE_MAX = 60

type CreatedEvent = Extract<SessionEvent, { type: 'session.created' }>
type ForkedEvent = Extract<SessionEvent, { type: 'session.forked' }>
type UserEvent = Extract<SessionEvent, { type: 'user.message' }>
type ChatEvent = Extract<SessionEvent, { type: 'user.message' | 'assistant.message' }>

const isChatEvent = (e: SessionEvent): e is ChatEvent => e.type === 'user.message' || e.type === 'assistant.message'

/** Projects a journal into what the UI and the model history need. */
export function deriveSession(events: SessionEvent[]): DerivedSession {
  const created = events.find((e): e is CreatedEvent => e.type === 'session.created')
  const forked = events.find((e): e is ForkedEvent => e.type === 'session.forked')
  const firstUser = events.find((e): e is UserEvent => e.type === 'user.message')

  // Title precedence: title given at creation, else the first user message,
  // else a neutral fallback.
  const baseTitle = created?.title?.trim() || firstUser?.text.trim().slice(0, TITLE_MAX) || 'Session'

  const messages: DerivedMessage[] = events.filter(isChatEvent).map((e) =>
    e.type === 'user.message'
      ? { role: 'user', text: e.text, at: e.at }
      : { role: 'assistant', text: e.text, at: e.at },
  )

  // Tool calls pair with the tool.result that follows them in the journal;
  // a call without a result is pending (waiting for a human approval).
  const tools: DerivedToolCall[] = []
  for (const e of events) {
    if (e.type === 'tool.call') {
      tools.push({ tool: e.tool, args: e.args, at: e.at })
    } else if (e.type === 'tool.result') {
      const open = [...tools].reverse().find((t) => t.ok === undefined)
      if (open) {
        open.ok = e.ok
        open.summary = e.summary
      }
    }
  }

  return {
    createdAt: created?.at ?? events[0]?.at ?? '',
    baseTitle,
    title: forked ? `${baseTitle} (fork)` : baseTitle,
    forkedFrom: forked?.from,
    workspace: created?.workspace,
    messages,
    tools,
  }
}
