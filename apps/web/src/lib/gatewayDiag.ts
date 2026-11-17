/**
 * Diagnostic de la passerelle (M8) — la vue UI de GET / à travers le proxy
 * same-origin /api : état, cookies, comptes, bl, proxy, journal amont.
 * Forme additive : les champs v1 (status/version/provider/defaultModel/
 * models/cookies/bl) sont stables, les champs M8 sont optionnels.
 *
 * M9 : les comptes portent leur session /u/N, leur libellé et l'expiration
 * de leurs cookies (expiresAt, secondes epoch) ; le journal agrégé devient
 * accountUsage (stats par compte).
 */
import type { TurnRecordDto } from './types'

export interface GatewayAccountDto {
  file: string
  cookies: boolean
  error?: string
  /** M9 : index de session Google (/u/N) du compte. */
  authUser?: number
  /** M9 : libellé du compte (manifeste accounts.json). */
  label?: string
  /** M9 : expiration la plus proche des cookies vivants, secondes epoch (passé = déjà expiré). */
  expiresAt?: number
}

export interface AccountUsageDto {
  account: number
  turns: number
  ok: number
  failed: number
  lastAt?: string
  totalMs: number
}

export interface GatewayDiagnostic {
  status: string
  version?: string
  provider?: string
  defaultModel?: string
  models?: string[]
  gateway?: {
    cookies: boolean
    bl: string | null
    cookieFile?: string
    rawCookies?: boolean
    accounts?: GatewayAccountDto[]
    activeAccount?: number
    /** M9 : session /u/N effective du compte actif (null = sans préfixe). */
    authUser?: number | null
    /** M9 : statistiques d'utilisation par compte. */
    accountUsage?: AccountUsageDto[]
    proxy?: string | null
    recent?: TurnRecordDto[]
  }
}

/** Récupère GET /api/ — jamais d'exception : l'erreur est le résultat. */
export async function fetchGatewayDiagnostic(baseUrl = '/api'): Promise<{ ok: true; data: GatewayDiagnostic } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, data: (await res.json()) as GatewayDiagnostic }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `passerelle injoignable (${why})` }
  }
}

/** Heure ISO → HH:MM:SS lisible dans le journal. */
export function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export type ExpiryTone = 'ok' | 'warn' | 'err'

export interface ExpiryView {
  /** Texte prêt à afficher (« 30 nov. », « dans 6 j · 23 nov. », « expiré depuis 3 j »). */
  text: string
  tone: ExpiryTone
}

const DAY_SEC = 86_400

/**
 * M9 — expiration d'un compte en texte lisible. Passé = « expiré depuis » (err),
 * ≤ 7 jours = « dans N j » (warn, on voit venir l'expiration), sinon la date
 * seule (ok). `nowMs` injectable pour des tests déterministes.
 */
export function formatExpiry(expiresAt: number, nowMs: number = Date.now()): ExpiryView {
  const nowSec = Math.floor(nowMs / 1000)
  const date = new Date(expiresAt * 1000)
  const fmtDate = Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  if (expiresAt <= nowSec) {
    const sinceDays = Math.max(1, Math.round((nowSec - expiresAt) / DAY_SEC))
    return { text: `expiré depuis ${sinceDays} j`, tone: 'err' }
  }
  const inDays = Math.round((expiresAt - nowSec) / DAY_SEC)
  if (inDays <= 7) {
    return { text: `dans ${inDays} j · ${fmtDate}`, tone: 'warn' }
  }
  return { text: fmtDate, tone: 'ok' }
}
