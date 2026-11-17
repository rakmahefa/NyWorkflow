/**
 * Conversion des requêtes OpenAI `/v1/chat/completions` vers l'interface web
 * Gemini — qui ne connaît qu'un prompt unique. Port du convertisseur de
 * ny-gemini-acp (marqueurs de rôle explicites, contenu multipart aplati).
 *
 * M10 : la boucle d'outils traverse — un message `tool` (résultat renvoyé par
 * le client) porte son marqueur, et les `tool_calls` d'un message assistant
 * sont rendus avec la MÊME convention de blocs que le préambule d'outils
 * (tools.ts), pour que le modèle reconnaisse ses propres appels au tour suivant.
 */
import { TOOLS_OPEN, TOOLS_CLOSE } from './tools.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: unknown
}

/** Contenu OpenAI : chaîne, ou tableau de parties ({type:'text', text}) aplaties. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter((t) => t.length > 0)
      .join(' ')
  }
  return ''
}

/** Les `tool_calls` d'un message assistant, rendus dans la convention de blocs (tools.ts). */
function toolCallsText(msg: Record<string, unknown>): string {
  const calls = msg.tool_calls
  if (!Array.isArray(calls)) return ''
  const blocks: string[] = []
  for (const call of calls) {
    if (call === null || typeof call !== 'object') continue
    const fn = (call as Record<string, unknown>).function
    const source = typeof fn === 'object' && fn !== null ? (fn as Record<string, unknown>) : (call as Record<string, unknown>)
    const name = source.name
    if (typeof name !== 'string' || name.length === 0) continue
    const rawArgs = source.arguments
    let args: unknown = rawArgs ?? {}
    if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
      try {
        args = JSON.parse(rawArgs)
      } catch {
        args = { value: rawArgs } // jamais perdu, jamais invalide
      }
    }
    blocks.push(`${TOOLS_OPEN} ${JSON.stringify({ name, arguments: args })} ${TOOLS_CLOSE}`)
  }
  return blocks.join('\n')
}

export function messagesToPrompt(messages: unknown): string {
  const parts: string[] = []
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg === null || typeof msg !== 'object') continue
      const m = msg as Record<string, unknown>
      const role = typeof m.role === 'string' ? m.role : 'user'
      const content = contentText(m.content)
      if (role === 'system') parts.push(`[System instruction]: ${content}`)
      else if (role === 'assistant') {
        const calls = toolCallsText(m)
        const rendered = [content.length > 0 ? `[Assistant]: ${content}` : '', calls].filter((s) => s.length > 0).join('\n')
        if (rendered.length > 0) parts.push(rendered)
      } else if (role === 'tool') parts.push(`[Tool result]: ${content}`) // M10 — résultat d'outil renvoyé par le client
      else if (content.length > 0) parts.push(content) // user — et tout rôle inconnu : texte nu
    }
  }
  return parts.join('\n\n')
}

/** Estimation de tokens en caractères / 4 — cohérente (total = entrée + sortie) même en non-ASCII. */
export function tokenEstimate(text: string): number {
  return Math.floor([...text].length / 4)
}

export function usage(prompt: string, completion: string): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const pt = tokenEstimate(prompt)
  const ct = tokenEstimate(completion)
  return { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct }
}
