import { describe, expect, it } from 'vitest'
import { sapisidHashAt, sapisidHash, GEMINI_ORIGIN } from './auth.ts'

describe('sapisidHash', () => {
  it('reproduit le vecteur connu (vérifié indépendamment en Python dans ny-gemini-acp)', () => {
    expect(sapisidHashAt('test-sapisid', GEMINI_ORIGIN, 1_700_000_000)).toBe('SAPISIDHASH 1700000000_8b5814e54e0d42919ef58b02d65c57aa9e31a041')
  })

  it('produit le format deux parties : SAPISIDHASH ts_sha1hex40', () => {
    const h = sapisidHash('mon-sapisid')
    expect(h).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/)
  })

  it('dépend du sapisid, de l’origine et de l’horodatage', () => {
    const a = sapisidHashAt('s', 'https://gemini.google.com', 100)
    const b = sapisidHashAt('s2', 'https://gemini.google.com', 100)
    const c = sapisidHashAt('s', 'https://other.example', 100)
    const d = sapisidHashAt('s', 'https://gemini.google.com', 101)
    expect(new Set([a, b, c, d]).size).toBe(4)
  })
})
