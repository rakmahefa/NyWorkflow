/**
 * Tool protocol — how the engine and the model talk about tools (M5).
 *
 * A tool request is a SINGLE-LINE JSON object with exactly two keys:
 *   {"tool":"read","args":{"path":"CONTEXT.md"}}
 * A reply that does not parse this way is the final artifact, written to
 * output/ verbatim (the M4 behavior). Single-line keeps pretty-printed
 * JSON artifacts on the artifact path; exact keys keep accidental JSON
 * artifacts with a "tool" field from hijacking the loop.
 *
 * renderToolResult is used BOTH live (as the loop feeds an outcome back)
 * and on replay (as resumeStage rebuilds a conversation from the journal)
 * — the two must produce byte-identical messages, or a resumed run would
 * not see what a live run saw. tool.result.data exists in the journal
 * precisely for that.
 */
import { TOOL_NAMES } from '@nyworkflow/tools'
import type { ToolCall, ToolOutcome, ToolRefusal } from '@nyworkflow/tools'
import type { SessionEvent } from '@nyworkflow/session'

export type { ToolCall }

/** Parses a model reply as a tool request, or null (it's the artifact). */
export function parseToolRequest(reply: string): ToolCall | null {
  const t = reply.trim()
  if (!t.startsWith('{') || !t.endsWith('}') || t.includes('\n')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  if (keys.length !== 2 || keys[0] !== 'args' || keys[1] !== 'tool') return null
  if (typeof obj.tool !== 'string' || !(TOOL_NAMES as readonly string[]).includes(obj.tool)) return null
  const args = obj.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  return { tool: obj.tool as ToolCall['tool'], args: args as Record<string, unknown> }
}

/** Canonical single-line form — what the journal replays as the assistant turn. */
export function serializeToolRequest(call: ToolCall): string {
  return JSON.stringify({ tool: call.tool, args: call.args })
}

/** The user turn that carries a tool outcome back to the model (live and replay). */
export function renderToolResult(fact: { ok: boolean; summary: string; data?: unknown }): string {
  return fact.ok
    ? JSON.stringify({ ok: true, result: fact.data })
    : JSON.stringify({ ok: false, error: fact.summary })
}

/** Live outcomes and journal events share the same shape on purpose. */
export function outcomeAsFact(outcome: ToolOutcome): { ok: boolean; summary: string; data?: unknown } {
  return outcome.ok
    ? { ok: true, summary: outcome.summary, data: outcome.data }
    : { ok: false, summary: (outcome as ToolRefusal).summary }
}

/** The system-prompt section that teaches the model the protocol. */
export function toolsPreamble(): string {
  return [
    'Outils disponibles — le périmètre est la racine du workspace, tout autre chemin est refusé :',
    '- read {"path":"…"} : lire un fichier du workspace',
    '- ls {"path":"…"} : lister un dossier du workspace',
    '- glob {"pattern":"…"} : chercher des fichiers (*, **, ?)',
    '- write {"path":"…","content":"…"} : écrire un fichier (approbation humaine requise avant exécution)',
    'Pour appeler un outil, réponds UNIQUEMENT par un objet JSON sur une seule ligne, exactement : {"tool":"read","args":{"path":"CONTEXT.md"}}',
    'Tu reçois ensuite le résultat au format {"ok":true,"result":…} ou {"ok":false,"error":"…"}.',
    'Sinon, réponds directement par le contenu final de l\'artefact demandé.',
  ].join('\n')
}
