/**
 * Diagnostic de la passerelle (M8) — la vue UI de GET / à travers le proxy
 * same-origin /api : état, cookies, comptes, bl, proxy, journal amont.
 * Forme additive : les champs v1 (status/version/provider/defaultModel/
 * models/cookies/bl) sont stables, les champs M8 sont optionnels.
 */
import type { TurnRecordDto } from './types'

export interface GatewayAccountDto {
  file: string
  cookies: boolean
  error?: string
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
