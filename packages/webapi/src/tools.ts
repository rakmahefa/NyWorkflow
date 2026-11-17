/**
 * Outils client (M10) — `tools` à la OpenAI dans `/v1/chat/completions` et
 * `functionDeclarations` à la Google dans `:generateContent`.
 *
 * L'interface web Gemini ne connaît pas les outils du CLIENT (ses propres
 * extensions sont autre chose — jamais exposées ici). La passerelle les passe
 * donc **par le prompt** : un préambule apprend au modèle les outils et UNE
 * convention d'appel, le texte de réponse est ensuite décodé à la recherche
 * des blocs. Zéro magie : tout ce qui ne respecte pas la convention est du
 * texte, jamais perdu.
 *
 * Convention (choisie rare en prose) :
 *
 *   {{tool {"name": "get_weather", "arguments": {"city": "Paris"}} }}
 *
 * Le décodage est incrémental (le bloc peut arriver coupé en plein milieu
 * d'un delta), tolère les fences ```json autour du bloc, les arguments
 * imbriqués (`}}` DANS le JSON ne piègent pas le scanner : il compte les
 * accolades en ignorant les chaînes), et retombe toujours sur « c'était du
 * texte » (bloc invalide, jamais refermé, trop long) — le contenu de la
 * réponse n'est jamais altéré ni perdu.
 */

/** Marqueur ouvrant d'un appel d'outil. */
export const TOOLS_OPEN = '{{tool'
/** Marqueur fermant d'un appel d'outil. */
export const TOOLS_CLOSE = '}}'

/** Garde-fou : un bloc outil qui dépasse cette taille redevient du texte. */
export const MAX_TOOL_BLOCK_BYTES = 64 * 1024

/** Outil normalisé — tel que le client l'a déclaré. */
export interface ToolSpec {
  name: string
  description: string
  /** Schéma JSON des arguments (objet JSON Schema), optionnel. */
  parameters?: Record<string, unknown>
}

/** Choix d'outil demandé par le client. */
export type ToolChoice =
  | { kind: 'auto' }
  | { kind: 'none' }
  | { kind: 'required' }
  | { kind: 'forced'; name: string }

/** Appel décodé depuis la réponse du modèle. */
export interface ParsedToolCall {
  name: string
  /** Arguments tels qu'émis par le modèle (objet, ou chaîne si le modèle a fourni du JSON déjà sérialisé). */
  args: unknown
}

/** Sortie d'un push du splitter : du texte prêt à émettre, et/ou des appels décodés. */
export interface ToolStreamEvent {
  text: string
  toolCalls: ParsedToolCall[]
}

/** Erreur de validation des outils — message court, côté API publique. */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolValidationError'
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Normalise `tools` (format OpenAI : `{type:'function', function:{name,…}}`).
 * Tolérance anti-casseur : l'entrée plate `{name, description, parameters}`
 * (style Google) est acceptée aussi. Rejette (400 en amont) : non-tableau,
 * entrée sans nom, schéma non objet, noms dupliqués.
 */
export function normalizeTools(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) throw new ToolValidationError('tools : tableau d’outils attendu')
  const out: ToolSpec[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isObj(entry)) throw new ToolValidationError('tools[] : objet attendu pour chaque outil')
    const fn = isObj(entry.function) ? entry.function : entry
    const name = fn.name
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ToolValidationError('tools[] : function.name (chaîne non vide) requis')
    }
    const trimmed = name.trim()
    if (seen.has(trimmed)) throw new ToolValidationError(`tools[] : nom d’outil dupliqué « ${trimmed} »`)
    seen.add(trimmed)
    const description = typeof fn.description === 'string' ? fn.description : ''
    let parameters: Record<string, unknown> | undefined
    if (fn.parameters !== undefined && fn.parameters !== null) {
      if (!isObj(fn.parameters)) throw new ToolValidationError(`tools[${trimmed}] : parameters : objet JSON Schema attendu`)
      parameters = fn.parameters
    }
    out.push({ name: trimmed, description, ...(parameters !== undefined ? { parameters } : {}) })
  }
  return out
}

/**
 * Interprète `tool_choice` : 'auto' (défaut), 'none', 'required', ou
 * `{type:'function', function:{name}}` (l'entrée plate `{name}` est tolérée).
 */
export function parseToolChoice(raw: unknown): ToolChoice {
  if (raw === undefined || raw === null) return { kind: 'auto' }
  if (raw === 'auto') return { kind: 'auto' }
  if (raw === 'none') return { kind: 'none' }
  if (raw === 'required') return { kind: 'required' }
  if (isObj(raw)) {
    const fn = isObj(raw.function) ? raw.function : raw
    if (typeof fn.name === 'string' && fn.name.trim().length > 0) return { kind: 'forced', name: fn.name.trim() }
  }
  throw new ToolValidationError('tool_choice : "auto", "none", "required" ou {type:"function", function:{name}} attendu')
}

/**
 * Le préambule ajouté au prompt quand des outils sont actifs — la seule
 * « API » que comprend l'interface web Gemini pour les outils du client.
 */
export function toolsPreamble(tools: ToolSpec[], choice: ToolChoice): string {
  const lines: string[] = ['[Tool calling]', 'You can call tools. Available tools:']
  for (const t of tools) {
    lines.push('')
    lines.push(`- ${t.name}${t.description.length > 0 ? `: ${t.description}` : ''}`)
    if (t.parameters !== undefined) lines.push(`  parameters (JSON Schema): ${JSON.stringify(t.parameters)}`)
  }
  lines.push('')
  lines.push('To call tools, output one block per call, using EXACTLY this format, with nothing else in your reply:')
  lines.push('{{tool {"name": "tool_name", "arguments": {"arg1": "value1"}} }}')
  lines.push('Rules:')
  lines.push('- "arguments" is a JSON object that follows the tool\'s JSON Schema.')
  lines.push('- Output only the tool call blocks - no prose before, between or after them.')
  lines.push('- Never invent tool results; they arrive in the next turn.')
  if (choice.kind === 'required') lines.push('You MUST call at least one tool in this reply - do not answer in prose.')
  if (choice.kind === 'forced') lines.push(`You MUST call the tool "${choice.name}" in this reply - do not answer in prose.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- scanner JSON

/** Résultat du scan d'une valeur JSON : fin trouvée / incomplète / impossible. */
export type JsonScan = { end: number } | { pending: true } | null

/**
 * Trouve la fin d'une valeur JSON à partir de `from` (espaces sautés) :
 * aware des chaînes et des échappements — les `}}` STRUCTURELS ou DANS une
 * chaîne ne font pas office de fermeture. `{pending}` = la valeur a commencé
 * mais n'est pas complète ; `null` = aucun caractère ici ne peut commencer
 * une valeur JSON.
 */
export function scanJsonValue(s: string, from: number): JsonScan {
  let i = from
  while (i < s.length && /\s/.test(s[i] ?? '')) i++
  if (i >= s.length) return { pending: true }
  const c = s[i] as string
  if (c === '{' || c === '[') {
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < s.length; j++) {
      const ch = s[j] as string
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return { end: j + 1 }
      }
    }
    return { pending: true }
  }
  if (c === '"') {
    let esc = false
    for (let j = i + 1; j < s.length; j++) {
      const ch = s[j] as string
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') return { end: j + 1 }
    }
    return { pending: true }
  }
  if (c === '-' || (c >= '0' && c <= '9') || c === 't' || c === 'f' || c === 'n') {
    let j = i
    while (j < s.length && !/[\s,}\]]/.test(s[j] ?? '')) j++
    return j > i ? { end: j } : null
  }
  return null
}

const WS = ' \t\r\n'

const skipWs = (s: string, i: number): number => {
  while (i < s.length && WS.includes(s[i] as string)) i++
  return i
}

/** `s` est-il un préfixe propre (strict) de `marker` ? — « `» ou «`` » avant une fence. */
function isPartialPrefix(s: string, marker: string): boolean {
  return s.length > 0 && s.length < marker.length && marker.startsWith(s)
}

const HEAD_FENCE = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?/

type SolvedBlock = { call: ParsedToolCall; consumed: number } | 'incomplete' | 'not-a-block'

/**
 * Tente de résoudre un bloc complet dans ce qui suit le marqueur ouvrant.
 * - `{call, consumed}` : bloc valide, `consumed` octets mangés (fermeture comprise) ;
 * - `'incomplete'` : le tampon s'arrête en plein bloc (ou sur un préfixe de
 *   fence) — attendre la suite ;
 * - `'not-a-block'` : la convention n'est pas respectée — c'est de la prose,
 *   le marqueur redevient du texte (le contenu n'est jamais perdu).
 *
 * Tolérances : whitespace autour, fences ```json … ``` autour du JSON,
 * fermeture collée (`…}}}}`), arguments imbriqués.
 */
export function solveToolBlock(s: string): SolvedBlock {
  let i = skipWs(s, 0)
  const fence = s.slice(i).match(HEAD_FENCE)
  if (fence) i += fence[0].length
  else if (isPartialPrefix(s.slice(i), '```')) return 'incomplete'
  i = skipWs(s, i)
  if (i >= s.length) return 'incomplete'
  const scan = scanJsonValue(s, i)
  if (scan === null) return 'not-a-block'
  if (!('end' in scan)) return 'incomplete' // valeur commencée mais non refermée
  const rawCandidate = s.slice(i, scan.end)
  let parsed: unknown
  try {
    parsed = JSON.parse(rawCandidate)
  } catch {
    return 'not-a-block' // structure complète mais JSON invalide — prose
  }
  if (!isObj(parsed) || typeof parsed.name !== 'string' || parsed.name.length === 0) return 'not-a-block'
  // Fermeture : ws, fence de queue optionnelle, ws, puis `}}` exactement.
  let j = skipWs(s, scan.end)
  if (s.startsWith('```', j)) j = skipWs(s, j + 3)
  else if (isPartialPrefix(s.slice(j), '```')) return 'incomplete'
  if (s.startsWith(TOOLS_CLOSE, j)) {
    return { call: { name: parsed.name, args: parsed.arguments ?? {} }, consumed: j + TOOLS_CLOSE.length }
  }
  // Le tampon s'arrête juste après la valeur, ou sur un préfixe du marqueur
  // fermant (`}` seul — le second peut arriver au prochain delta) : on attend.
  if (j >= s.length) return 'incomplete'
  if (isPartialPrefix(s.slice(j), TOOLS_CLOSE)) return 'incomplete'
  return 'not-a-block'
}

// ------------------------------------------------------------------ splitter

/** Le plus long suffixe de `s` qui est un préfixe propre du marqueur ouvrant. */
function partialMarkerSuffix(s: string): number {
  const max = Math.min(s.length, TOOLS_OPEN.length - 1)
  for (let len = max; len > 0; len--) {
    if (s.slice(s.length - len) === TOOLS_OPEN.slice(0, len)) return len
  }
  return 0
}

/**
 * Sépare un flux de texte en deltas de texte et appels d'outil — incrémental,
 * jamais perdant : tout ce qui n'est pas un bloc valide ressort en texte.
 */
export class ToolStreamSplitter {
  private mode: 'text' | 'tool' = 'text'
  private buf = ''

  /** Un delta de texte en entrée ; en sortie, du texte à émettre et/ou des appels décodés. */
  push(delta: string): ToolStreamEvent {
    if (delta.length === 0) return { text: '', toolCalls: [] }
    this.buf += delta
    return this.mode === 'text' ? this.pumpText() : this.pumpTool()
  }

  /** Fin de flux : vide les réserves (un bloc jamais refermé redevient du texte). */
  finish(): ToolStreamEvent {
    if (this.mode === 'text') {
      const text = this.buf
      this.buf = ''
      return { text, toolCalls: [] }
    }
    const text = TOOLS_OPEN + this.buf
    this.buf = ''
    this.mode = 'text'
    return { text, toolCalls: [] }
  }

  private pumpText(): ToolStreamEvent {
    const toolCalls: ParsedToolCall[] = []
    let out = ''
    let s = this.buf
    for (let guard = 0; ; guard++) {
      if (guard > 1000) break // garde théorique — les boucles progressent toujours
      const idx = s.indexOf(TOOLS_OPEN)
      if (idx < 0) break
      out += s.slice(0, idx)
      const rest = s.slice(idx + TOOLS_OPEN.length)
      const solved = solveToolBlock(rest)
      if (solved === 'incomplete') {
        this.mode = 'tool'
        this.buf = rest
        return { text: out, toolCalls }
      }
      if (solved === 'not-a-block') {
        out += TOOLS_OPEN // faux positif : le marqueur reste du texte, on poursuit après
        s = rest
        continue
      }
      toolCalls.push(solved.call)
      s = rest.slice(solved.consumed)
    }
    const hold = partialMarkerSuffix(s)
    out += s.slice(0, s.length - hold)
    this.buf = s.slice(s.length - hold)
    return { text: out, toolCalls }
  }

  private pumpTool(): ToolStreamEvent {
    const solved = solveToolBlock(this.buf)
    if (solved === 'incomplete') {
      if (this.buf.length > MAX_TOOL_BLOCK_BYTES) {
        // Jamais de mémoire infinie : ce pseudo-bloc redevient du texte.
        const text = TOOLS_OPEN + this.buf
        this.buf = ''
        this.mode = 'text'
        return { text, toolCalls: [] }
      }
      return { text: '', toolCalls: [] }
    }
    if (solved === 'not-a-block') {
      this.mode = 'text'
      this.buf = TOOLS_OPEN + this.buf
      return this.pumpText()
    }
    const rest = this.buf.slice(solved.consumed)
    this.mode = 'text'
    this.buf = rest
    const ev = this.pumpText()
    return { text: ev.text, toolCalls: [solved.call, ...ev.toolCalls] }
  }
}

/** Arguments d'appel sérialisés pour l'API OpenAI (`function.arguments` est une chaîne JSON). */
export function openAiArguments(call: ParsedToolCall): string {
  if (typeof call.args === 'string') {
    const trimmed = call.args.trim()
    if (trimmed.length === 0) return '{}'
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
    // Chaîne non-JSON : encapsulée en valeur — jamais perdu, jamais invalide.
    return JSON.stringify({ value: call.args })
  }
  return JSON.stringify(call.args ?? {})
}
