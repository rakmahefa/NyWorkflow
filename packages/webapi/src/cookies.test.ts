import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CookieJar, loadCookieSource } from './cookies.ts'

const ETC = JSON.stringify([
  { name: 'SAPISID', value: 'abc', domain: '.google.com' },
  { name: 'HSID', value: 'h1', domain: '.google.com' },
  { name: '__Secure-1PSID', value: 'p1', domain: '.google.com' },
])

describe('CookieJar — 3 formats d’entrée', () => {
  it('EditThisCookie (tableau JSON)', () => {
    const jar = CookieJar.parse(ETC)
    expect(jar.header()).toBe('SAPISID=abc; HSID=h1; __Secure-1PSID=p1')
    expect(jar.sapisid()).toBe('abc')
  })

  it('objet gemini-web2api {cookie, sapisid}', () => {
    const jar = CookieJar.parse('{"cookie":"A=1; B=2","sapisid":"override"}')
    expect(jar.header()).toBe('A=1; B=2')
    expect(jar.sapisid()).toBe('override')
  })

  it('chaîne brute « k=v; k2=v2 »', () => {
    const jar = CookieJar.parse('A=1; B=2')
    expect(jar.header()).toBe('A=1; B=2')
  })

  it('objet sans cookie → erreur explicite', () => {
    expect(() => CookieJar.parse('{"sapisid":"x"}')).toThrow(/cookie/)
  })

  it('EditThisCookie invalide → erreur explicite', () => {
    expect(() => CookieJar.parse('[{"name":"a"}]')).toThrow()
  })
})

describe('CookieJar — filtrage de validité', () => {
  it('retire les cookies expirés', () => {
    const jar = CookieJar.parse(
      JSON.stringify([
        { name: 'A', value: '1', domain: '.google.com', expirationDate: 1 }, // 1970 — expiré
        { name: 'B', value: '2', domain: '.google.com', expirationDate: 4_102_444_800 }, // 2100 — valide
      ]),
    )
    expect(jar.header()).toBe('B=2')
  })

  it('retire les cookies d’un domaine non google', () => {
    const jar = CookieJar.parse(
      JSON.stringify([
        { name: 'A', value: '1', domain: 'example.com' },
        { name: 'B', value: '2', domain: 'accounts.google.com' },
        { name: 'C', value: '3' }, // sans domaine — garde
      ]),
    )
    expect(jar.header()).toBe('B=2; C=3')
  })

  it('retire les entrées vides', () => {
    const jar = CookieJar.parse('A=; B=2; =3; C=4')
    expect(jar.header()).toBe('B=2; C=4')
  })

  it('sapisid remonte depuis le cookie SAPISID quand l’objet n’en porte pas', () => {
    const jar = CookieJar.parse('{"cookie":"SAPISID=zz; X=1"}')
    expect(jar.sapisid()).toBe('zz')
  })

  it('hasValidCookies reflète la présence d’au moins un cookie valide', () => {
    expect(CookieJar.parse('A=1').hasValidCookies()).toBe(true)
    expect(CookieJar.parse('A=').hasValidCookies()).toBe(false)
  })
})

describe('loadCookieSource', () => {
  it('fichier absent → jar undefined, sans exception', () => {
    const src = loadCookieSource(path.join(tmpdir(), 'nexiste-pas', 'cookie.json'))
    expect(src.jar).toBeUndefined()
  })

  it('fichier présent → jar + mtime ; réécriture → mtime change', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nyw-cookies-'))
    const file = path.join(dir, 'cookie.json')
    try {
      writeFileSync(file, 'A=1')
      const first = loadCookieSource(file)
      expect(first.jar?.header()).toBe('A=1')
      // mtime forcée différente (réécriture + utimes)
      writeFileSync(file, 'B=2')
      const t = new Date(Date.now() + 2000)
      utimesSync(file, t, t)
      const second = loadCookieSource(file)
      expect(second.jar?.header()).toBe('B=2')
      expect(second.mtimeMs).not.toBe(first.mtimeMs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
