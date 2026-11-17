/**
 * Browser client for the /sessions API (same origin — the dev and preview
 * servers both mount it). Failures bubble up: the app decides whether to
 * fall back to in-memory sessions (never a silent loss).
 */
import type { SessionDto } from '../server/handler'

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

/** All sessions derived from their journals, oldest first. */
export function listSessions(): Promise<SessionDto[]> {
  return jsonFetch<{ sessions: SessionDto[] }>('/sessions').then((b) => b.sessions)
}

/** Creates a session journal (title optional — server numbers the fallback). */
export function createSession(title?: string): Promise<SessionDto> {
  return jsonFetch<SessionDto>('/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  })
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

// --- Workspaces (M5): the run side of a session that executes a workflow. ---

/** What /workspaces returns for one run (state + tool activity + outputs). */
export interface RunStateDto {
  id: string
  title: string
  createdAt: number
  state:
    | { status: 'idle' }
    | { status: 'running'; stage: string }
    | { status: 'checkpoint'; stage: string }
    | { status: 'done'; stages: string[] }
    | { status: 'error'; stage: string; message: string }
    | { status: 'approval'; stage: string; tool: string; args: unknown }
  tools: { tool: string; args: unknown; at: number; ok?: boolean; summary?: string }[]
  /** Files written by each stage, in first-write order. (M6) */
  outputs: { stage: string; files: string[] }[]
}

/** One workspace as listed — parsed, or the reason it is not. (M6) */
export interface WorkspaceSummaryDto {
  name: string
  stages?: { stage: string; title: string }[]
  error?: string
}

/** A stage contract, as the detail view consumes it. (M6) */
export interface StageDto {
  stage: string
  title: string
  inputs: { source: string; scope: string; origin?: string; why?: string }[]
  process: string[]
  outputs: string[]
}

/** The detail view: the map, the contracts, this workspace's runs. (M6) */
export interface WorkspaceDetailDto {
  name: string
  map: string
  stages: StageDto[]
  runs: RunStateDto[]
}

/** All workspaces, parsed or with their parse error. (M6) */
export function listWorkspaces(): Promise<WorkspaceSummaryDto[]> {
  return jsonFetch<{ workspaces: WorkspaceSummaryDto[] }>('/workspaces').then((b) => b.workspaces)
}

/** The detail view of one workspace. (M6) */
export function getWorkspace(name: string): Promise<WorkspaceDetailDto> {
  return jsonFetch<WorkspaceDetailDto>(`/workspaces/${encodeURIComponent(name)}`)
}

/** Creates a run: the subject becomes a journaled session. (M6) */
export function createRun(name: string, subject: string): Promise<RunStateDto> {
  return jsonFetch<RunStateDto>(`/workspaces/${encodeURIComponent(name)}/runs`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ subject }),
  })
}

/** Executes the next stage server-side, then pauses at the checkpoint. (M6) */
export function advanceRun(
  name: string,
  id: string,
  body: { model: string; tools?: boolean },
): Promise<{ state: RunStateDto['state']; outputs: string[] }> {
  return jsonFetch(`/workspaces/${encodeURIComponent(name)}/runs/${encodeURIComponent(id)}/advance`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
}

/** Read-only preview of a workspace file (scope-guarded server-side). (M6) */
export function readWorkspaceFile(name: string, path: string): Promise<{ path: string; content: string; bytes: number }> {
  return jsonFetch(`/workspaces/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`)
}

/** Fetches a run's state and tool activity (for the active run session). */
export function getRun(workspace: string, id: string): Promise<RunStateDto> {
  return jsonFetch<RunStateDto>(`/workspaces/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(id)}`)
}

/** Resolves a paused tool call — approve executes it, refuse journals the refusal. */
export function resolveApproval(
  workspace: string,
  id: string,
  decision: 'approve' | 'refuse',
): Promise<{ state: RunStateDto['state']; outputs: string[] }> {
  return jsonFetch(`/workspaces/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(id)}/approval`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ decision }),
  })
}
