/**
 * Browser client for the same-origin APIs: /sessions (journals) and
 * /workspaces (agentic ICM surface, M11). Failures bubble up: the app
 * decides whether to fall back to in-memory sessions (never a silent
 * loss).
 */
import type { SecurityLevel, SessionEvent } from '@nyworkflow/session'
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
  /** M13 — effective security level ('ask' by default). */
  security: SecurityLevel
  events: SessionEvent[]
  messages: { role: 'user' | 'assistant'; text: string; at: number }[]
}

/** All sessions derived from their journals, oldest first. */
export function listSessions(): Promise<SessionDto[]> {
  return jsonFetch<{ sessions: SessionDto[] }>('/sessions').then((b) => b.sessions)
}

/** Creates a session journal (title optional, workspace required for agents,
 * security level chosen at creation — M13). */
export function createSession(title?: string, workspace?: string, security?: SecurityLevel): Promise<SessionDto> {
  return jsonFetch<SessionDto>('/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title, workspace, security }),
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

/** M12 — renames a session (append-only: session.renamed wins in derivation). */
export function renameSession(id: string, title: string): Promise<SessionDto> {
  return jsonFetch<SessionDto>(`/sessions/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ title }),
  })
}

/** M13 — changes the session's security level live (session.security event). */
export function setSecurity(id: string, level: SecurityLevel): Promise<SessionDto> {
  return jsonFetch<SessionDto>(`/sessions/${encodeURIComponent(id)}/security`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ level }),
  })
}

/** The summary of a completed agent turn — journaled as turn.completed (M13). */
export interface TurnSummary {
  model: string
  thinkLevel?: number | null
  rounds: number
  ms: number
  outcome: 'ok' | 'error' | 'stopped'
  toolCalls: number
  messages?: number
  tools?: number
  thinkingChars: number
  textChars: number
  error?: string
}

/** M13 — journals a completed turn: the durable trace of the browser loop. */
export function postTurn(id: string, turn: TurnSummary): Promise<void> {
  return jsonFetch<unknown>(`/sessions/${encodeURIComponent(id)}/turn`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(turn),
  }).then(() => undefined)
}

/** One tool call as the model made it (M16 model log). */
export interface ResponseToolCall {
  tool: string
  title?: string
  args?: unknown
  /** M17 — the RAW arguments string, as emitted (bad formats stay visible). */
  rawArgs?: string
  /** M17 — false when the raw arguments did not parse as a JSON object. */
  argsOk?: boolean
}

/** One round's MODEL RESPONSE — logged to model.jsonl (M16): what the
 * model actually said, plus what the server needs to compute protocol
 * compliance (firstEvent, thinkingTitles, titles on the calls). */
export interface ModelResponseSummary {
  model: string
  round: number
  ms: number
  outcome: 'ok' | 'tool_calls' | 'stopped' | 'error'
  /** Kind of the FIRST streamed event — the thinking-first check. */
  firstEvent: 'thinking' | 'text' | 'tool_calls' | 'none'
  systemChars: number
  messages: number
  /** M21 — the plan-contract refusal sent to the next round (when this
   * response's group was NOT executed: announced plan ≠ emitted group). */
  feedback?: string
  thinkingChars: number
  textChars: number
  thinkingTitles: string[]
  thinking?: string
  text?: string
  toolCalls: ResponseToolCall[]
  error?: string
}

/** M17 — one tool result of the group, as fed back to the model (the
 * observation step of the three-step protocol). */
export interface ObservationResult {
  tool: string
  title: string
  ok: boolean
  /** The result payload (ok) or the failure summary — what the model reads. */
  result?: string
  error?: string
  ms?: number
}

/** M17 — the group's results, logged as model.observation in model.jsonl. */
export interface ObservationSummary {
  model: string
  /** The round that EMITTED the calls. */
  round: number
  /** The round that will READ the results (round + 1 by construction). */
  fedToRound: number
  ms: number
  results: ObservationResult[]
  /** M20 — the mentor's protocol reminder that rides with this observation
   * (the exact text the next round reads). */
  feedback?: string
}

/** M16 — logs one round's model response (model.jsonl, 4th profiling log). */
export function postResponse(id: string, response: ModelResponseSummary): Promise<void> {
  return jsonFetch<unknown>(`/sessions/${encodeURIComponent(id)}/response`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(response),
  }).then(() => undefined)
}

/** M17 — logs the tool-group RESULTS that circulate back to the model
 * (model.observation, in model.jsonl — the observation step of the protocol). */
export function postObservation(id: string, observation: ObservationSummary): Promise<void> {
  return jsonFetch<unknown>(`/sessions/${encodeURIComponent(id)}/observation`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(observation),
  }).then(() => undefined)
}

// --- M13/M16 : logs de profilage (lecture seule) ----------------------------------

/** GET /logs — the profiling quartet (engine, session, activity, model), as listed. */
export interface LogsDto {
  dir: string
  files: { name: string; bytes: number; lines: number }[]
}

/** GET /logs/:name?tail=N — the last lines of one log. */
export function listLogs(): Promise<LogsDto> {
  return jsonFetch<LogsDto>('/logs')
}

export function tailLog(name: string, tail = 200): Promise<{ name: string; tail: string; stats: { bytes: number; lines: number } }> {
  return jsonFetch(`/logs/${encodeURIComponent(name)}?tail=${tail}`)
}

// --- M17 : les journaux DE LA SESSION (son propre quatuor) --------------------

/** GET /sessions/:id/logs — the session's OWN quartet inside its folder. */
export interface SessionLogsDto {
  /** '' when the folder cannot be resolved (the UI says so honestly). */
  dir: string
  workspace: string
  files: { name: string; bytes: number; lines: number }[]
}

/** M17 — the session's own logs (listing), and the tail of one of them. */
export function listSessionLogs(id: string): Promise<SessionLogsDto> {
  return jsonFetch<SessionLogsDto>(`/sessions/${encodeURIComponent(id)}/logs`)
}

export function tailSessionLog(
  id: string,
  name: string,
  tail = 200,
): Promise<{ name: string; dir: string; tail: string; stats: { bytes: number; lines: number } }> {
  return jsonFetch(`/sessions/${encodeURIComponent(id)}/logs/${encodeURIComponent(name)}?tail=${tail}`)
}

// --- M17 : localisation de dossier (le pont du sélecteur natif) ----------------

/** GET /workspaces/locate?name=… — candidates for the picked folder's name. */
export interface LocateDto {
  name: string
  candidates: string[]
  truncated: boolean
  scanned: number
  roots: string[]
}

/** M17 — resolves a natively picked folder NAME into candidate server paths. */
export function locateFolders(name: string): Promise<LocateDto> {
  return jsonFetch<LocateDto>(`/workspaces/locate?name=${encodeURIComponent(name)}`)
}

// --- /workspaces : surface ICM agentique (M11) ---------------------------------

/** One workspace as listed. */
export interface WorkspaceSummaryDto {
  name: string
  summary?: string
  /** M12 — external registration: the folder lives outside the registry. */
  folder?: boolean
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
  | { status: 'executed'; callId: string; outcome: ToolOutcome }
  | { status: 'pending'; callId: string; call: { tool: string; args: unknown } }

// --- M12 : dossiers du disque + navigateur --------------------------------

/** One directory of the folder browser. */
export interface BrowseDirDto {
  name: string
  path: string
}

/** GET /workspaces/browse — the dialog's folder picker. */
export interface BrowseDto {
  path: string
  parent: string | null
  dirs: BrowseDirDto[]
  truncated: boolean
  home: string
}

/** All workspaces. */
export function listWorkspaces(): Promise<WorkspaceSummaryDto[]> {
  return jsonFetch<{ workspaces: WorkspaceSummaryDto[] }>('/workspaces').then((b) => b.workspaces)
}

/** M12 — lists the sub-directories of a disk folder (home by default). */
export function browseFolders(path?: string): Promise<BrowseDto> {
  const q = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : ''
  return jsonFetch<BrowseDto>(`/workspaces/browse${q}`)
}

/** Scaffolds a fresh agentic workspace (charter + inbox/notes/research/outputs). */
export function createWorkspace(name: string): Promise<{ name: string; tree: string }> {
  return jsonFetch<{ name: string; tree: string }>('/workspaces', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  })
}

/** M12 — registers an EXISTING disk folder as a workspace (no scaffold, as-is). */
export function registerWorkspace(name: string, path: string): Promise<{ name: string; tree: string; folder?: boolean }> {
  return jsonFetch<{ name: string; tree: string; folder?: boolean }>('/workspaces', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name, path }),
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
