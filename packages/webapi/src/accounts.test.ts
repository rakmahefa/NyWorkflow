import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CookieStore } from './accounts.ts'

const EDIT_THIS_COOKIE = (value: string) => JSON.stringify([{ name: 'SAPISID', value, domain: '.google.com' }])

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'nyw-accounts-'))
}

describe('CookieStore — fichier unique (comportement historique)', () => {
  it('charge un fichier de cookies et expose le jar', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'cookies.json')
      writeFileSync(file, EDIT_THIS_COOKIE('s1'))
      const store = new CookieStore(file)
      expect(store.count()).toBe(1)
      expect(store.jar()?.header()).toBe('SAPISID=s1')
      expect(store.activeIndex()).toBe(0)
      const d = store.describe()
      expect(d.cookieFile).toBe(file)
      expect(d.rawCookies).toBe(false)
      expect(d.accounts).toEqual([{ file, cookies: true }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fichier absent : 1 compte sans cookies, sans exception', () => {
    const store = new CookieStore('/tmp/nyw-inexistant-xyz/cookies.json')
    expect(store.count()).toBe(1)
    expect(store.jar()).toBeUndefined()
    expect(store.describe().accounts[0]?.cookies).toBe(false)
  })

  it('aucune config : zéro compte', () => {
    const store = new CookieStore('')
    expect(store.count()).toBe(0)
    expect(store.jar()).toBeUndefined()
  })

  it('recharge à chaud sur changement de mtime', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'cookies.json')
      writeFileSync(file, EDIT_THIS_COOKIE('avant'))
      const store = new CookieStore(file)
      expect(store.jar()?.header()).toBe('SAPISID=avant')

      writeFileSync(file, EDIT_THIS_COOKIE('après'))
      const later = new Date(Date.now() + 2000)
      utimesSync(file, later, later)
      expect(store.jar()?.header()).toBe('SAPISID=après')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CookieStore — répertoire multi-comptes', () => {
  it('un compte par fichier, trié par nom', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'b-compte.json'), EDIT_THIS_COOKIE('B'))
      writeFileSync(path.join(dir, 'a-compte.json'), EDIT_THIS_COOKIE('A'))
      writeFileSync(path.join(dir, '.invisible'), EDIT_THIS_COOKIE('X'))
      const store = new CookieStore(dir)
      expect(store.count()).toBe(2)
      const d = store.describe()
      expect(d.accounts.map((a) => path.basename(a.file))).toEqual(['a-compte.json', 'b-compte.json'])
      expect(d.accounts.every((a) => a.cookies)).toBe(true)
      expect(store.jar()?.header()).toBe('SAPISID=A') // premier compte actif
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rotation : avance et boucle, puis false quand tout est essayé', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'a.json'), EDIT_THIS_COOKIE('A'))
      writeFileSync(path.join(dir, 'b.json'), EDIT_THIS_COOKIE('B'))
      writeFileSync(path.join(dir, 'c.json'), EDIT_THIS_COOKIE('C'))
      const store = new CookieStore(dir)
      const tried = new Set<number>([0])
      expect(store.jar()?.header()).toBe('SAPISID=A')

      expect(store.rotate(tried)).toBe(true)
      expect(store.activeIndex()).toBe(1)
      expect(store.jar()?.header()).toBe('SAPISID=B')
      tried.add(1)

      expect(store.rotate(tried)).toBe(true)
      expect(store.jar()?.header()).toBe('SAPISID=C')
      tried.add(2)

      // Tout a été essayé pour ce tour : plus de rotation.
      expect(store.rotate(tried)).toBe(false)
      expect(store.activeIndex()).toBe(2)

      // Un NOUVEAU tour repart de la position courante et peut boucler.
      const fresh = new Set<number>([2])
      expect(store.rotate(fresh)).toBe(true)
      expect(store.activeIndex()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('un seul compte : pas de rotation', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'unique.json'), EDIT_THIS_COOKIE('U'))
      const store = new CookieStore(dir)
      expect(store.rotate(new Set([0]))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fichier malformé dans le répertoire : compte marqué en erreur, les autres vivent', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'a-bon.json'), EDIT_THIS_COOKIE('OK'))
      writeFileSync(path.join(dir, 'z-mauvais.json'), '{pas du json')
      const store = new CookieStore(dir)
      expect(store.count()).toBe(2)
      const d = store.describe()
      expect(d.accounts[0]).toMatchObject({ cookies: true })
      expect(d.accounts[1]?.cookies).toBe(false)
      expect(typeof d.accounts[1]?.error).toBe('string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CookieStore — cookies bruts (env)', () => {
  it('un compte unique, libellé env, gagne sur le fichier', () => {
    const store = new CookieStore('/nimporte/quoi', 'SAPISID=env; HSID=h')
    expect(store.count()).toBe(1)
    expect(store.jar()?.header()).toContain('SAPISID=env')
    const d = store.describe()
    expect(d.rawCookies).toBe(true)
    expect(d.accounts).toEqual([{ file: '(NYW_WEBAPI_COOKIES)', cookies: true }])
  })

  it('chaîne brute invalide : cookies absents, sans exception', () => {
    const store = new CookieStore('', '   ')
    expect(store.jar()).toBeDefined() // jar vide, pas d'explosion
    expect(store.describe().accounts[0]?.cookies).toBe(false)
  })
})

describe('CookieStore — répertoire vide', () => {
  it('zéro compte, describe cohérent', () => {
    const dir = tempDir()
    try {
      mkdirSync(path.join(dir, 'vide'))
      const store = new CookieStore(path.join(dir, 'vide'))
      expect(store.count()).toBe(0)
      expect(store.jar()).toBeUndefined()
      expect(store.describe().accounts).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
