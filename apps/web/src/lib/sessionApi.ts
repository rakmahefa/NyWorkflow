/**
 * Browser client for the same-origin APIs: /sessions (journals) and
 * /workspaces (agentic ICM surface, M11). Failures bubble up: the app
 * decides whether to fall back to in-memory sessions (never a silent
 * loss).
 */
import type { SessionEvent } from '@nyworkflow/session'
import type { ToolOutcome } from '@nyworkflow/tools'

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' }

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { error?: string }).error ?? ''
    } catch {
      // no JSON body — the HTTP code is all we have
    }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

// --- /sessions : journaux -----------------------------------------------------

/** A session: derived header + raw journal events, in order. */
export interface SessionDto {
  id: string
  title: string
  createdAt: number
  forkedFrom?: string
  workspace?: string
  events: SessionEvent[]
  messages: { role: 'user' | 'assistant'; text: string; at: number }[]
}

/** All sessions derived from their journals, oldest first. */
export function listSessions(): Promise<SessionDto[]> {
  return jsonFetch<{ sessions: SessionDto[] }>('/sessions').then((b) => b.sessions)
}

/** Creates a session journal (title optional, workspace required for agents). */
export function createSession(title?: string, workspace?: string): Promise<SessionDto> {
  return jsonFetch<SessionDto>('/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title, workspace }),
  })
}

/** M11 — deletes a session journal (its chat and tool history with it). */
export function deleteSession(id: string): Promise<void> {
  return jsonFetch<{ ok: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined)
}

/** Appends one chat event to a journal. */
export function appendChatEvent(id: string, role: 'user' | 'assistant', text: string): Promise<void> {
  return jsonFetch<unknown>(`/sessions/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ type: `${role}.message`, text }),
  }).then(() => undefined)
}

/** Forks a journal: byte-exact copy plus the session.forked event. */
export function forkSession(id: string): Promise<SessionDto> {
  return jsonFetch<SessionDto>(`/sessions/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    headers: jsonHeaders,
  })
}

// --- /workspaces : surface ICM agentique (M11) ---------------------------------

/** One workspace as listed. */
export interface WorkspaceSummaryDto {
  name: string
  summary?: string
}

/** The ICM of a workspace, system prompt pre-assembled server-side. */
export interface IcmDto {
  name: string
  tree: string
  contexts: { path: string; content: string }[]
  system: string
}

/** What POST /tool answers. */
export type ToolRunDto =
  | { status: 'executed'; outcome: ToolOutcome }
  | { status: 'pending'; call: { tool: string; args: unknown } }

/** All workspaces. */
export function listWorkspaces(): Promise<WorkspaceSummaryDto[]> {
  return jsonFetch<{ workspaces: WorkspaceSummaryDto[] }>('/workspaces').then((b) => b.workspaces)
}

/** Scaffolds a fresh agentic workspace (charter + inbox/notes/research/outputs). */
export function createWorkspace(name: string): Promise<{ name: string; tree: string }> {
  return jsonFetch<{ name: string; tree: string }>('/workspaces', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
}

/** The ICM toward the model: tree, CONTEXT.md files, assembled system prompt. */
export function getIcm(name: string): Promise<IcmDto> {
  return jsonFetch<IcmDto>(`/workspaces/${encodeURIComponent(name)}/icm`)
}

/** Runs one agent tool call server-side (journaled); dangerous ones pause. */
export function runTool(name: string, sessionId: string, tool: string, args: unknown): Promise<ToolRunDto> {
  return jsonFetch<ToolRunDto>(`/workspaces/${encodeURIComponent(name)}/tool`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId, tool, args }),
  })
}

/** Resolves a paused (dangerous) tool call — approve executes it, refuse journals the refusal. */
export function decideTool(name: string, sessionId: string, decision: 'approve' | 'refuse'): Promise<ToolRunDto> {
  return jsonFetch<ToolRunDto>(`/workspaces/${encodeURIComponent(name)}/tool/decision`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId, decision }),
  })
}
