/**
 * Conversion des requêtes OpenAI `/v1/chat/completions` vers l'interface web
 * Gemini — qui ne connaît qu'un prompt unique. Port du convertisseur de
 * ny-gemini-acp (marqueurs de rôle explicites, contenu multipart aplati).
 */

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

export function messagesToPrompt(messages: unknown): string {
  const parts: string[] = []
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg === null || typeof msg !== 'object') continue
      const role = typeof (msg as { role?: unknown }).role === 'string' ? (msg as { role: string }).role : 'user'
      const content = contentText((msg as { content?: unknown }).content)
      if (role === 'system') parts.push(`[System instruction]: ${content}`)
      else if (role === 'assistant') parts.push(`[Assistant]: ${content}`)
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
