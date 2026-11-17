/**
 * Conversion Gemini API v1beta (M10) — les routes Google-style de la passerelle :
 *
 *   GET  /v1beta/models
 *   GET  /v1beta/models/{name}
 *   POST /v1beta/models/{model}:generateContent
 *   POST /v1beta/models/{model}:streamGenerateContent   (?alt=sse → SSE)
 *
 * L'interface web Gemini ne parle que « un prompt → du texte » : les
 * `contents`/`parts`/`systemInstruction` sont aplatis en prompt (mêmes
 * marqueurs de rôle que /v1 — convert.ts), les `functionDeclarations`
 * deviennent le préambule d'outils (tools.ts), et les `functionCall` de la
 * réponse sont reconstruits depuis les blocs décodés du texte. Les tours
 * précédents qui contiennent des `functionCall` / `functionResponse` (la
 * boucle d'outils Google) sont rends en texte avec la MÊME convention, si
 * bien que le modèle reconnaît ses propres appels.
 *
 * `generationConfig` est accepté et ignoré (aucun paramètre de génération
 * n'est exposé par l'interface web) — jamais d'erreur sur ce qu'on ne sert pas.
 */
import { normalizeTools, parseToolChoice, toolsPreamble, TOOLS_OPEN, TOOLS_CLOSE, type ParsedToolCall, type ToolChoice, type ToolSpec } from './tools.ts'
import { tokenEstimate } from './convert.ts'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Une entrée du listing `GET /v1beta/models` (champs utiles, sans invention). */
export interface V1BetaModelInfo {
  name: string
  displayName: string
  description: string
  supportedGenerationMethods: string[]
}

export function v1betaModelInfo(id: string): V1BetaModelInfo {
  return {
    name: `models/${id}`,
    displayName: id,
    description: 'Gemini served through the NyWorkflow webapi gateway',
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  }
}

// ------------------------------------------------------------------ requête

/** Requête v1beta normalisée : un prompt, des outils, un choix d'outil. */
export interface NormalizedGenerateRequest {
  prompt: string
  tools: ToolSpec[]
  choice: ToolChoice
}

/** Une part d'historique rendue en texte — text, functionCall et functionResponse. */
function partToText(part: unknown): string {
  if (!isObj(part)) return ''
  if (typeof part.text === 'string') return part.text
  if (isObj(part.functionCall) && typeof part.functionCall.name === 'string') {
    // La même convention que le préambule d'outils : le modèle se reconnaît.
    return `${TOOLS_OPEN} ${JSON.stringify({ name: part.functionCall.name, arguments: part.functionCall.args ?? {} })} ${TOOLS_CLOSE}`
  }
  if (isObj(part.functionResponse) && typeof part.functionResponse.name === 'string') {
    const response = part.functionResponse.response
    const rendered = typeof response === 'string' ? response : JSON.stringify(response ?? {})
    return `[Tool result ${part.functionResponse.name}]: ${rendered}`
  }
  return ''
}

function contentToText(content: unknown, rolePrefix: string): string {
  if (typeof content === 'string') return content.trim().length > 0 ? `${rolePrefix}${content}` : ''
  if (!isObj(content) || !Array.isArray(content.parts)) return ''
  const text = content.parts.map(partToText).filter((t) => t.length > 0).join('\n')
  return text.length > 0 ? `${rolePrefix}${text}` : ''
}

/** `systemInstruction` : chaîne directe ou {parts:[…]}. */
function systemInstructionText(si: unknown): string {
  if (typeof si === 'string') return si
  if (isObj(si)) return contentToText(si, '')
  return ''
}

/** `tools` v1beta : [{functionDeclarations:[{name, description, parameters}]}]. */
function v1betaTools(raw: unknown): ToolSpec[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('tools : tableau attendu (functionDeclarations)')
  const declarations: unknown[] = []
  for (const entry of raw) {
    if (!isObj(entry)) throw new Error('tools[] : objet attendu')
    if (entry.functionDeclarations !== undefined) {
      if (!Array.isArray(entry.functionDeclarations)) throw new Error('tools[] : functionDeclarations : tableau attendu')
      declarations.push(...entry.functionDeclarations)
    } else {
      declarations.push(entry) // tolérance : déclaration plate directe
    }
  }
  if (declarations.length === 0) return []
  return normalizeTools(declarations) // lève une Error claire si malformé
}

/** `toolConfig.functionCallingConfig` : mode AUTO/ANY/NONE + allowedFunctionNames. */
function v1betaToolChoice(raw: unknown, tools: ToolSpec[]): ToolChoice {
  if (!isObj(raw) || !isObj(raw.functionCallingConfig)) return { kind: 'auto' }
  const cfg = raw.functionCallingConfig
  const mode = typeof cfg.mode === 'string' ? cfg.mode.toUpperCase() : 'AUTO'
  if (mode === 'NONE') return { kind: 'none' }
  if (mode === 'ANY') {
    const allowed = Array.isArray(cfg.allowedFunctionNames) ? cfg.allowedFunctionNames.filter((n): n is string => typeof n === 'string') : []
    const first = allowed[0]
    if (first !== undefined && tools.some((t) => t.name === first)) return { kind: 'forced', name: first }
    return { kind: 'required' }
  }
  return { kind: 'auto' }
}

/**
 * Normalise un corps `:generateContent` en {prompt, tools, choice}.
 * Lève une `Error` au message clair sur les corps invraisemblables
 * (l'appelant la traduit en 400 INVALID_ARGUMENT).
 */
export function parseGenerateRequest(body: unknown): NormalizedGenerateRequest {
  if (!isObj(body)) throw new Error('corps : objet JSON attendu')
  const contents = body.contents
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error('contents : au moins un contenu requis')
  }
  const parts: string[] = []
  const system = systemInstructionText(body.systemInstruction)
  if (system.trim().length > 0) parts.push(`[System instruction]: ${system}`)
  for (const content of contents) {
    if (!isObj(content)) continue
    const role = typeof content.role === 'string' ? content.role : 'user'
    if (role === 'system') {
      const text = contentToText(content, '')
      if (text.length > 0) parts.push(`[System instruction]: ${text}`)
    } else if (role === 'model') {
      const text = contentToText(content, '')
      if (text.length > 0) parts.push(`[Assistant]: ${text}`)
    } else {
      const text = contentToText(content, '')
      if (text.length > 0) parts.push(text) // user — et tout rôle inconnu : texte nu
    }
  }
  let prompt = parts.join('\n\n')
  const tools = v1betaTools(body.tools)
  const choice = v1betaToolChoice(body.toolConfig, tools)
  if (tools.length > 0 && choice.kind !== 'none') {
    prompt += (prompt.length > 0 ? '\n\n' : '') + toolsPreamble(tools, choice)
  }
  return { prompt, tools, choice }
}

// ------------------------------------------------------------------ réponse

/** `usageMetadata` Google — mêmes estimations honnêtes que /v1 (caractères / 4). */
export function usageMetadata(prompt: string, completion: string): { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number } {
  const pt = tokenEstimate(prompt)
  const ct = tokenEstimate(completion)
  return { promptTokenCount: pt, candidatesTokenCount: ct, totalTokenCount: pt + ct }
}

/** Sérialise un appel pour l'estimation de tokens (et le compte final). */
export function callToText(call: ParsedToolCall): string {
  return `${TOOLS_OPEN} ${JSON.stringify({ name: call.name, arguments: call.args })} ${TOOLS_CLOSE}`
}

/** Réponse complète `:generateContent` — parts texte et/ou functionCall. */
export function buildGenerateResponse(model: string, text: string, calls: ParsedToolCall[], prompt: string): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  if (text.length > 0) parts.push({ text })
  for (const call of calls) parts.push({ functionCall: { name: call.name, args: call.args } })
  const completion = text + calls.map(callToText).join('')
  return {
    candidates: [{ content: { role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: usageMetadata(prompt, completion),
    modelVersion: model,
  }
}

/** Chunk de stream : un delta de texte. */
export function generateTextChunk(text: string): Record<string, unknown> {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] }
}

/** Chunk de stream : un appel d'outil décodé. */
export function generateCallChunk(call: ParsedToolCall): Record<string, unknown> {
  return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] }, index: 0 }] }
}

/** Chunk final : finishReason + usage (Google ne met pas de marqueur [DONE]). */
export function generateFinalChunk(model: string, prompt: string, completion: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: usageMetadata(prompt, completion),
    modelVersion: model,
  }
}
