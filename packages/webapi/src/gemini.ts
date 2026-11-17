/**
 * Client de l'interface web Gemini — la refonte moderne du client de
 * ny-gemini-acp (Rust). Trois différences structurelles qui répondent aux
 * casses historiques :
 *
 *   1. `bl` auto-découvert sur la page /app (plus de version figée qui périmait) ;
 *   2. jetons de page rafraîchis **avant chaque retry** sur erreur HTTP 4xx ;
 *   3. table de modèles data-driven (voir models.ts).
 *
 * Le protocole lui-même (payload f.req, frames wrb.fr, snapshots) est un port
 * fidèle : c'est la donnée imposée par Google, pas un choix d'architecture.
 */
import { CookieJar, loadCookieSource, type CookieSource } from './cookies.ts'
import { sapisidHash, GEMINI_ORIGIN } from './auth.ts'
import { resolveModel, loadModelTable, type ModelTable, type ResolvedModel } from './models.ts'
import { buildFreq, extractPageTokens, extractBl, nextReqid, type PageTokens } from './payload.ts'
import { FrameDecoder, bardErrorCode, cleanText, type FrameEvent } from './frames.ts'

export const DEFAULT_BL = 'boq_assistant-bard-web-server_20260716.08_p0'
const TOKEN_TTL_MS = 10 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_RAW_ACCUMULATOR = 64 * 1024
const MAX_BACKOFF_MS = 30_000

export type GeminiErrorKind =
  | 'authentication'
  | 'network'
  | 'upstream'
  | 'unknown-model'
  | 'divergence'
  | 'safety'
  | 'empty'
  | 'http'

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind
  readonly status?: number

  constructor(kind: GeminiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'GeminiError'
    this.kind = kind
    this.status = status
  }
}

export interface GeminiClientConfig {
  /** Base de l'interface Gemini (défaut https://gemini.google.com ; maquette en tests). */
  baseUrl?: string
  cookieFile?: string
  /** Cookies bruts « k=v; … » — gagne sur le fichier. */
  rawCookies?: string
  defaultModel?: string
  modelsFile?: string
  /** Force le `bl` (sinon auto-découverte + repli constant). */
  bl?: string
  /** Compte multi-session (préfixe /u/N). */
  authUser?: number
  timeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}

export interface GeminiTurnOptions {
  prompt: string
  /** Nom de modèle, suffixe @think= accepté. Défaut : celui de la config. */
  model?: string
  /** Fichiers de référence (upload côté interface — non utilisé par la passerelle v1). */
  refs?: string[]
  /** Annulation : le générateur se termine sans erreur. */
  signal?: AbortSignal
}

export type GeminiStreamItem =
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'metadata'; kind: string; value: unknown }

interface PageState {
  tokens: PageTokens
  bl: string
  fetchedAt: number
}

interface TurnState {
  decoder: FrameDecoder
  emitted: string
  emittedTools: Set<string>
  diverged: boolean
  rawAcc: string
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    if (signal) signal.addEventListener('abort', done, { once: true })
  })
}

/** Backoff exponentiel borné + jitter ±25 % — jamais deux retries à la même distance. */
export function backoffMs(attempt: number, baseMs: number): number {
  const delay = Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  const jitter = delay / 4
  return Math.max(0, Math.round(delay + (Math.random() * 2 - 1) * jitter))
}

export class GeminiWebClient {
  private readonly baseUrl: string
  private readonly cookieFile: string
  private readonly rawCookies?: string
  private readonly defaultModel: string
  private readonly modelsFile?: string
  private readonly forcedBl?: string
  private readonly authUser?: number
  private readonly timeoutMs: number
  private readonly retryAttempts: number
  private readonly retryDelayMs: number

  private cookieSource: CookieSource | undefined
  private rawJar: CookieJar | undefined
  private page: PageState | undefined
  private modelTableCache: ModelTable | undefined

  constructor(config: GeminiClientConfig = {}) {
    this.baseUrl = config.baseUrl?.replace(/\/+$/, '') || GEMINI_ORIGIN
    this.cookieFile = config.cookieFile ?? ''
    this.rawCookies = config.rawCookies
    this.defaultModel = config.defaultModel ?? 'gemini-3.6-flash'
    this.modelsFile = config.modelsFile
    this.forcedBl = config.bl
    this.authUser = config.authUser
    this.timeoutMs = config.timeoutMs ?? 180_000
    this.retryAttempts = Math.max(1, config.retryAttempts ?? 3)
    this.retryDelayMs = config.retryDelayMs ?? 2_000
  }

  /** Instantané de diagnostic (aucune requête réseau) — sert l'endpoint /. */
  describe(): { cookies: boolean; bl: string | null; defaultModel: string; models: string[] } {
    const table = this.modelTable()
    return {
      cookies: this.jar()?.hasValidCookies() ?? false,
      bl: this.forcedBl ?? this.page?.bl ?? null,
      defaultModel: this.defaultModel,
      models: Object.keys(table),
    }
  }

  async *stream(options: GeminiTurnOptions): AsyncGenerator<GeminiStreamItem, void, void> {
    const table = this.modelTable()
    let resolved: ResolvedModel
    try {
      resolved = resolveModel(options.model ?? this.defaultModel, table, this.defaultModel)
    } catch (err) {
      throw new GeminiError('unknown-model', errText(err))
    }
    const signal = options.signal
    const state: TurnState = { decoder: new FrameDecoder(), emitted: '', emittedTools: new Set(), diverged: false, rawAcc: '' }

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (signal?.aborted) return
      try {
        yield* this.attempt(options.prompt, resolved, options.refs ?? [], state, signal)
        return // tentative menée à son terme
      } catch (err) {
        if (signal?.aborted) return
        const error = err instanceof GeminiError ? err : new GeminiError('network', errText(err))
        const fatal =
          error.kind === 'authentication' || error.kind === 'upstream' || error.kind === 'unknown-model' || error.kind === 'safety'
        if (fatal) throw error
        // On ne réessaie que si rien n'a été consommé : réémettre un texte déjà
        // livré dupliquerait la réponse chez le consommateur.
        const canRetry = attempt < this.retryAttempts && state.emitted.length === 0 && state.emittedTools.size === 0
        if (!canRetry) {
          if (error.kind === 'http' && (error.status === 401 || error.status === 403)) {
            throw new GeminiError('authentication', `Cookies Gemini expirés ou refusés (HTTP ${error.status}) — rechargez-les puis réessayez.`, error.status)
          }
          throw error
        }
        // Anti-casseurs : un 4xx signale souvent des jetons de page périmés —
        // on les rafraîchit AVANT de réessayer (ny-gemini-acp réessayait à l'identique).
        if (error.kind === 'http' && error.status !== undefined && error.status >= 400 && error.status < 500) {
          this.page = undefined
          await this.pageState()
        }
        await sleep(backoffMs(attempt, this.retryDelayMs), signal)
        state.decoder.clear()
        state.diverged = false
        state.rawAcc = ''
      }
    }
  }

  /** Réponse complète en chaîne — un tool_call en plein texte est une erreur explicite. */
  async complete(options: GeminiTurnOptions): Promise<string> {
    let out = ''
    for await (const item of this.stream(options)) {
      if (item.type === 'text') out += item.delta
      else if (item.type === 'toolCall') throw new GeminiError('upstream', `Gemini a émis un appel d'outil (${item.name}) pendant une complétion texte`)
    }
    return out
  }

  // ---------------------------------------------------------------- internals

  private async *attempt(
    prompt: string,
    model: ResolvedModel,
    refs: string[],
    state: TurnState,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<GeminiStreamItem, void, void> {
    const { url, headers, body } = await this.buildRequest(prompt, model, refs)
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: combined })
    } catch (err) {
      if (signal?.aborted) return
      throw new GeminiError('network', `requête Gemini impossible : ${errText(err)}`)
    }
    if (!res.ok) throw new GeminiError('http', `Gemini a répondu HTTP ${res.status}`, res.status)
    if (!res.body) throw new GeminiError('network', 'flux absent dans la réponse Gemini')

    const decoder = new TextDecoder()
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) return
      const text = decoder.decode(chunk, { stream: true })
      if (text.length > 0) yield* this.feedText(text, state)
    }
    const tail = decoder.decode()
    if (tail.length > 0) yield* this.feedText(tail, state)
    for (const event of state.decoder.finish()) yield* this.emitFrame(event, state)

    if (state.diverged) {
      throw new GeminiError('divergence', 'le flux Gemini a divergé (snapshots incompatibles) et n’a pas pu être réconcilié')
    }
    if (state.emitted.length === 0 && state.emittedTools.size === 0) {
      throw new GeminiError('empty', 'Gemini n’a produit aucune réponse exploitable (flux vide).')
    }
  }

  /** Un segment de texte décodé → frames → événements émis (deltas par snapshot). */
  private async *feedText(text: string, state: TurnState): AsyncGenerator<GeminiStreamItem, void, void> {
    if (state.decoder.pending().length + text.length > MAX_FRAME_BYTES) {
      throw new GeminiError('upstream', `frame Gemini au-delà de la limite de sécurité (${MAX_FRAME_BYTES} octets)`)
    }
    if (state.rawAcc.length < MAX_RAW_ACCUMULATOR) state.rawAcc = (state.rawAcc + text).slice(0, MAX_RAW_ACCUMULATOR)
    for (const event of state.decoder.feed(text)) yield* this.emitFrame(event, state)
  }

  private async *emitFrame(event: FrameEvent, state: TurnState): AsyncGenerator<GeminiStreamItem, void, void> {
    if (event.type === 'metadata') {
      if (event.kind === 'blockReason') {
        const reason = typeof event.value === 'string' ? event.value : 'politique de sécurité'
        throw new GeminiError('safety', `Gemini a refusé de répondre (blockReason : ${reason}). Reformulez votre prompt.`)
      }
      // BardErrorInfo : signal structurel uniquement — la prose qui le cite reste de la prose.
      const code = bardErrorCode(JSON.stringify(event.value) ?? '')
      if (code !== undefined) {
        if (code === 401) {
          throw new GeminiError('authentication', 'Cookies Gemini expirés — rechargez .nyworkflow/cookies/gemini.json (voir README).', 401)
        }
        throw new GeminiError('upstream', `Gemini a rejeté la requête (BardErrorInfo ${code}).`, code)
      }
      yield { type: 'metadata', kind: event.kind, value: event.value }
      return
    }
    if (event.type === 'toolCall') {
      if (state.emittedTools.has(event.id)) return
      state.emittedTools.add(event.id)
      yield { type: 'toolCall', id: event.id, name: event.name, arguments: event.arguments }
      return
    }
    // Snapshot texte : delta = ce qui dépasse ce qui a déjà été émis.
    const candidate = event.text
    if (candidate === state.emitted) {
      state.diverged = false
      return
    }
    if (!candidate.startsWith(state.emitted)) {
      state.diverged = true
      return // on attend un snapshot compatible avant d'émettre quoi que ce soit
    }
    const delta = cleanText(candidate.slice(state.emitted.length), false)
    state.emitted = candidate
    state.diverged = false
    if (delta.length > 0) yield { type: 'text', delta }
  }

  private async buildRequest(
    prompt: string,
    model: ResolvedModel,
    refs: string[],
  ): Promise<{ url: string; headers: Record<string, string>; body: string }> {
    const prefix = this.authUser !== undefined ? `/u/${this.authUser}` : ''
    const page = await this.pageState()
    const bl = this.forcedBl ?? page.bl
    const url = `${this.baseUrl}${prefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(bl)}&hl=en&_reqid=${nextReqid()}&rt=c`
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      origin: GEMINI_ORIGIN,
      referer: `${GEMINI_ORIGIN}${prefix}/app`,
      'x-same-domain': '1',
      'user-agent': USER_AGENT,
    }
    const jar = this.jar()
    const cookie = jar?.header()
    if (cookie && cookie.length > 0) headers.cookie = cookie
    const sapisid = jar?.sapisid()
    if (sapisid) headers.authorization = sapisidHash(sapisid, GEMINI_ORIGIN)
    if (this.authUser !== undefined) headers['x-goog-authuser'] = String(this.authUser)
    return { url, headers, body: buildFreq(prompt, model, refs, page.tokens.at) }
  }

  private modelTable(): ModelTable {
    this.modelTableCache ??= loadModelTable(this.modelsFile)
    return this.modelTableCache
  }

  private jar(): CookieJar | undefined {
    if (this.rawCookies !== undefined) {
      this.rawJar ??= safeParse(this.rawCookies)
      return this.rawJar
    }
    if (this.cookieFile === '') return undefined
    const fresh = loadCookieSource(this.cookieFile)
    if (this.cookieSource === undefined || this.cookieSource.mtimeMs !== fresh.mtimeMs) this.cookieSource = fresh
    return this.cookieSource.jar
  }

  /** Jetons de page + bl, avec TTL 10 min ; découverte au premier besoin. */
  private async pageState(): Promise<PageState> {
    if (this.page !== undefined && Date.now() - this.page.fetchedAt < TOKEN_TTL_MS) return this.page
    await this.refreshPage()
    this.page ??= { tokens: {}, bl: DEFAULT_BL, fetchedAt: Date.now() }
    return this.page
  }

  private async refreshPage(): Promise<void> {
    const prefix = this.authUser !== undefined ? `/u/${this.authUser}` : ''
    const url = `${this.baseUrl}${prefix}/app`
    try {
      const headers: Record<string, string> = { accept: 'text/html', 'user-agent': USER_AGENT, origin: GEMINI_ORIGIN, referer: `${GEMINI_ORIGIN}${prefix}/app` }
      const jar = this.jar()
      const cookie = jar?.header()
      if (cookie && cookie.length > 0) headers.cookie = cookie
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return // repli : jetons vides + bl constant
      const body = await res.text()
      this.page = { tokens: extractPageTokens(body), bl: extractBl(body) ?? DEFAULT_BL, fetchedAt: Date.now() }
    } catch {
      // Page injoignable : on garde DEFAULT_BL et des jetons vides — la requête
      // principale dira son mot, avec des erreurs typées.
    }
  }
}

function safeParse(raw: string): CookieJar | undefined {
  try {
    return CookieJar.parse(raw)
  } catch {
    return undefined
  }
}
