/**
 * Authentification des clients web Google : en-tête `Authorization: SAPISIDHASH …`.
 *
 * hash = SHA1 hex minuscule de `${ts} ${sapisid} ${origin}`, présenté comme
 * `SAPISIDHASH ${ts}_${hash}` — origin = https://gemini.google.com.
 */
import { createHash } from 'node:crypto'

export const GEMINI_ORIGIN = 'https://gemini.google.com'

/** Variante à horodatage fixé (tests / vecteurs connus). */
export function sapisidHashAt(sapisid: string, origin: string, ts: number): string {
  const digest = createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex')
  return `SAPISIDHASH ${ts}_${digest}`
}

/** En-tête `Authorization` pour l'interface Gemini. */
export function sapisidHash(sapisid: string, origin: string = GEMINI_ORIGIN): string {
  return sapisidHashAt(sapisid, origin, Math.floor(Date.now() / 1000))
}
