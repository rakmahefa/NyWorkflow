/**
 * Décodage défensif du flux `StreamGenerate` de l'interface Gemini.
 *
 * Format ligne à ligne : la première ligne du flux est `)]}'` (anti-JSON-hijack),
 * ensuite chaque ligne est un tableau JSON dont la première cellule ressemble à
 * `["wrb.fr", [..], "<json interne sérialisé>"]`. Seules les lignes `wrb.fr`
 * portent la conversation ; le texte vit dans inner[4] (candidats), le candidat
 * le plus long gagne — chaque frame est un **snapshot** complet, pas un delta.
 *
 * Les erreurs amont (`BardErrorInfo [n]`) ne sont détectées QUE sur les
 * métadonnées décodées : une prose qui cite le marqueur reste de la prose.
 */

const MAX_BUFFER_BYTES = 64 * 1024 * 1024
const MAX_TOOL_EVENTS_PER_STREAM = 256
const MAX_METADATA_BYTES = 64 * 1024

export type FrameEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'metadata'; kind: string; value: unknown }

const TOOL_KEYS = ['functionCall', 'function_call', 'toolCall', 'tool_call', 'toolUse', 'tool_use']
const METADATA_KEYS = ['usageMetadata', 'usage', 'finishReason', 'blockReason']

const CODE_REF_RE = /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g
const CARD_CONTENT_RE = /http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g
const BARD_ERROR_RE = /BardErrorInfo\s*\[(\d+)\]/

export class FrameDecoder {
  private buf = ''
  private emittedToolIds = new Set<string>()
  private nextCallId = 0

  pending(): string {
    return this.buf
  }

  clear(): void {
    this.buf = ''
    this.emittedToolIds.clear()
    this.nextCallId = 0
  }

  /** Pousse un segment de texte décodé ; retourne les événements des lignes complètes. */
  feed(chunk: string): FrameEvent[] {
    if (chunk.length === 0) return []
    this.buf += chunk
    if (this.buf.length > MAX_BUFFER_BYTES && !this.buf.includes('\n')) {
      this.buf = ''
      return []
    }
    const out: FrameEvent[] = []
    while (true) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) break
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      out.push(...this.decodeLine(line.replace(/[\r\n]+$/, '')))
    }
    return out
  }

  /** Flush final : la dernière ligne sans \n est décodée aussi. */
  finish(): FrameEvent[] {
    if (this.buf.trim().length === 0) {
      this.buf = ''
      return []
    }
    const line = this.buf
    this.buf = ''
    return this.decodeLine(line.replace(/[\r\n]+$/, ''))
  }

  private decodeLine(line: string): FrameEvent[] {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed === ")]}'") return []
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      return [] // ligne non-JSON (préfixes de longueur, etc.) — ignorée
    }
    return this.decodeValue(value)
  }

  private decodeValue(value: unknown): FrameEvent[] {
    if (!Array.isArray(value)) return []
    const first = value[0]
    if (!Array.isArray(first)) return []
    if (first[0] !== 'wrb.fr') return []
    const inner = first[2]
    if (typeof inner === 'string') {
      try {
        return this.decodeInner(JSON.parse(inner) as unknown)
      } catch {
        return [{ type: 'metadata', kind: 'unparsed_frame', value: { bytes: inner.length, preview: inner.slice(0, 512) } }]
      }
    }
    if (inner !== null && typeof inner === 'object') return this.decodeInner(inner)
    return [{ type: 'metadata', kind: 'unexpected_inner', value: { preview: String(inner).slice(0, 512) } }]
  }

  private decodeInner(inner: unknown): FrameEvent[] {
    const events: FrameEvent[] = []
    this.collectToolCalls(inner, events)
    this.collectMetadata(inner, events)
    if (inner !== null && typeof inner === 'object') {
      const candidates = (inner as Record<string, unknown>)[4]
      if (Array.isArray(candidates)) {
        let longest: string | undefined
        for (const candidate of candidates) {
          if (candidate === null || typeof candidate !== 'object') continue
          const segments = (candidate as Record<string, unknown>)[1]
          if (!Array.isArray(segments)) continue
          const text = segments.filter((s): s is string => typeof s === 'string').join('')
          if (text.length > 0 && (longest === undefined || text.length > longest.length)) longest = text
        }
        if (longest !== undefined) events.push({ type: 'text', text: longest })
      }
    }
    return events
  }

  private collectToolCalls(value: unknown, events: FrameEvent[]): void {
    if (events.length >= MAX_TOOL_EVENTS_PER_STREAM) return
    if (Array.isArray(value)) {
      for (const v of value) this.collectToolCalls(v, events)
      return
    }
    if (value === null || typeof value !== 'object') return
    const map = value as Record<string, unknown>
    for (const key of TOOL_KEYS) {
      const call = parseToolObject(map[key])
      if (call) {
        const id = call.id ?? `gemini_call_${this.nextCallId++}`
        if (this.emittedToolIds.size >= MAX_TOOL_EVENTS_PER_STREAM || this.emittedToolIds.has(id)) continue
        this.emittedToolIds.add(id)
        events.push({ type: 'toolCall', id, name: call.name, arguments: call.arguments })
      }
    }
    for (const v of Object.values(map)) this.collectToolCalls(v, events)
  }

  private collectMetadata(inner: unknown, events: FrameEvent[]): void {
    if (inner === null || typeof inner !== 'object') return
    const map = inner as Record<string, unknown>
    for (const key of METADATA_KEYS) {
      if (key in map) {
        const bytes = JSON.stringify(map[key])?.length ?? 0
        if (bytes <= MAX_METADATA_BYTES) events.push({ type: 'metadata', kind: key, value: map[key] })
      }
    }
  }
}

function parseToolObject(value: unknown): { id?: string; name: string; arguments: unknown } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const map = value as Record<string, unknown>
  const name = typeof map.name === 'string' ? map.name : typeof map.functionName === 'string' ? map.functionName : typeof map.toolName === 'string' ? map.toolName : ''
  if (name.trim().length === 0) return undefined
  const arguments_ = map.arguments ?? map.args ?? map.parameters
  if (arguments_ === undefined) return undefined
  const id = typeof map.id === 'string' ? map.id : typeof map.callId === 'string' ? map.callId : typeof map.call_id === 'string' ? map.call_id : undefined
  return { id, name, arguments: arguments_ }
}

/** Retire les blocs code_reference et card_content que Gemini glisse dans le texte. */
export function cleanText(text: string, trim: boolean): string {
  const out = text.replace(CODE_REF_RE, '').replace(CARD_CONTENT_RE, '')
  return trim ? out.trim() : out
}

/** Code d'erreur amont dans une chaîne décodée (BardErrorInfo [n]). */
export function bardErrorCode(raw: string): number | undefined {
  const m = raw.match(BARD_ERROR_RE)
  return m ? Number(m[1]) : undefined
}

/** Flux wrb.fr présent mais aucun événement exploitable. */
export function isEmptyStream(raw: string): boolean {
  if (!raw.includes('"wrb.fr"')) return false
  const decoder = new FrameDecoder()
  const events = [...decoder.feed(raw), ...decoder.finish()]
  return events.every((e) => !((e.type === 'text' && e.text.length > 0) || e.type === 'toolCall'))
}
