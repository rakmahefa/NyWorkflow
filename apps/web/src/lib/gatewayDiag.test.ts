import { describe, expect, it } from 'vitest'
import { formatExpiry, timeOf } from './gatewayDiag'

// now fixe : 2026-11-17T12:00:00Z — les tests sont déterministes.
const NOW_MS = Date.parse('2026-11-17T12:00:00Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)
const DAY = 86_400

// Même formatage que formatExpiry — l'assertion teste la logique (délais,
// tons), le rendu de la date suit la locale du navigateur.
const fmtDate = (sec: number): string => new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

describe('formatExpiry (M9 — le pilote voit venir l’expiration)', () => {
  it('date passée → « expiré depuis N j » en erreur', () => {
    expect(formatExpiry(NOW_SEC - 3 * DAY, NOW_MS)).toEqual({ text: 'expiré depuis 3 j', tone: 'err' })
    // Expired for less than 24h → still "depuis 1 j", never "depuis 0 j".
    expect(formatExpiry(NOW_SEC - 3600, NOW_MS).text).toBe('expiré depuis 1 j')
  })

  it('≤ 7 jours → « dans N j · date » en avertissement (on voit venir)', () => {
    expect(formatExpiry(NOW_SEC + 6 * DAY, NOW_MS).tone).toBe('warn')
    expect(formatExpiry(NOW_SEC + 6 * DAY, NOW_MS).text).toBe(`dans 6 j · ${fmtDate(NOW_SEC + 6 * DAY)}`)
    expect(formatExpiry(NOW_SEC + 1 * DAY, NOW_MS).text).toBe(`dans 1 j · ${fmtDate(NOW_SEC + 1 * DAY)}`)
  })

  it('au-delà de 7 jours → la date seule, ton neutre', () => {
    const view = formatExpiry(NOW_SEC + 30 * DAY, NOW_MS)
    expect(view.tone).toBe('ok')
    expect(view.text).toBe(fmtDate(NOW_SEC + 30 * DAY))
  })

  it('limite exacte : 7 jours pile = warn, 8 jours = ok', () => {
    expect(formatExpiry(NOW_SEC + 7 * DAY, NOW_MS).tone).toBe('warn')
    expect(formatExpiry(NOW_SEC + 8 * DAY, NOW_MS).tone).toBe('ok')
  })
})

describe('timeOf', () => {
  it('format l’heure locale (12 h ou 24 h selon le système)', () => {
    expect(timeOf('2026-11-17T12:34:56Z')).toMatch(/^\d{1,2}:\d{2}:\d{2}/)
  })
  it('date invalide → tiret', () => {
    expect(timeOf('nimporte')).toBe('—')
  })
})
