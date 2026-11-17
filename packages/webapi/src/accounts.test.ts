import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CookieStore, loadAccountsManifest } from './accounts.ts'

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

describe('loadAccountsManifest (M9 — /u/N par compte)', () => {
  const MANIFEST = (rows: unknown[]) => JSON.stringify({ accounts: rows })

  it('lit les entrées valides : index, libellé, basename', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'accounts.json')
      writeFileSync(file, MANIFEST([
        { file: 'a.json', authUser: 1, label: 'Perso' },
        { file: 'b.json', authUser: 0 },
      ]))
      const m = loadAccountsManifest(file)
      expect(m.error).toBeUndefined()
      expect(m.entries.get('a.json')).toEqual({ authUser: 1, label: 'Perso' })
      expect(m.entries.get('b.json')).toEqual({ authUser: 0 })
      expect(m.entries.size).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepte aussi un tableau au premier niveau', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'accounts.json')
      writeFileSync(file, JSON.stringify([{ file: 'a.json', authUser: 3 }]))
      const m = loadAccountsManifest(file)
      expect(m.entries.get('a.json')).toEqual({ authUser: 3 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fichier absent/illisible/JSON invalide → manifeste vide, jamais d’exception', () => {
    expect(loadAccountsManifest(path.join(tmpdir(), 'nexiste-pas', 'accounts.json')).entries.size).toBe(0)
    const dir = tempDir()
    try {
      const file = path.join(dir, 'accounts.json')
      writeFileSync(file, '{pas du json')
      const m = loadAccountsManifest(file)
      expect(m.entries.size).toBe(0)
      expect(typeof m.error).toBe('string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forme inattendue (ni tableau ni {accounts}) → vide avec erreur', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'accounts.json')
      writeFileSync(file, JSON.stringify({ comptes: [] }))
      const m = loadAccountsManifest(file)
      expect(m.entries.size).toBe(0)
      expect(m.error).toMatch(/accounts\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('entrées invalides ignorées une par une (index négatif, fractionnaire, sans fichier)', () => {
    const dir = tempDir()
    try {
      const file = path.join(dir, 'accounts.json')
      writeFileSync(file, MANIFEST([
        { file: 'bon.json', authUser: 2, label: 'Ok' },
        { file: 'negatif.json', authUser: -1 }, // index invalide → entrée ignorée
        { file: 'fraction.json', authUser: 2.5 }, // idem
        { authUser: 4 }, // sans fichier → ignorée
        { file: 'sans-index.json', label: 'Libellé seul' }, // valide : index absent, label conservé
      ]))
      const m = loadAccountsManifest(file)
      expect(m.entries.size).toBe(2)
      expect(m.entries.get('bon.json')).toEqual({ authUser: 2, label: 'Ok' })
      expect(m.entries.get('sans-index.json')).toEqual({ label: 'Libellé seul' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CookieStore — manifeste des comptes (M9)', () => {
  it('accounts.json auto-découvert à côté des cookies : authUser + label au diagnostic, activeAuthUser suit la rotation', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'a-perso.json'), EDIT_THIS_COOKIE('A'))
      writeFileSync(path.join(dir, 'b-pro.json'), EDIT_THIS_COOKIE('B'))
      writeFileSync(
        path.join(dir, 'accounts.json'),
        JSON.stringify({ accounts: [
          { file: 'a-perso.json', authUser: 0, label: 'Perso' },
          { file: 'b-pro.json', authUser: 1, label: 'Pro' },
        ] }),
      )
      const store = new CookieStore(dir)
      expect(store.count()).toBe(2) // accounts.json n'est PAS un compte
      expect(store.activeAuthUser()).toBe(0)

      const d = store.describe()
      expect(d.accounts.map((a) => a.authUser)).toEqual([0, 1])
      expect(d.accounts.map((a) => a.label)).toEqual(['Perso', 'Pro'])

      // Rotation : l'index de session suit le compte actif.
      store.rotate(new Set([0]))
      expect(store.activeIndex()).toBe(1)
      expect(store.activeAuthUser()).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compte sans entrée de manifeste → activeAuthUser undefined (repli client sur NYW_WEBAPI_AUTH_USER)', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'a.json'), EDIT_THIS_COOKIE('A'))
      writeFileSync(path.join(dir, 'b.json'), EDIT_THIS_COOKIE('B'))
      writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ file: 'a.json', authUser: 7, label: 'Sept' }] }))
      const store = new CookieStore(dir)
      expect(store.activeAuthUser()).toBe(7)
      store.rotate(new Set([0]))
      expect(store.activeAuthUser()).toBeUndefined() // b.json n'a pas d'entrée
      const d = store.describe()
      expect(d.accounts[0]).toMatchObject({ authUser: 7, label: 'Sept' })
      expect(d.accounts[1]?.authUser).toBeUndefined()
      expect(d.accounts[1]?.label).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('relecture à chaud du manifeste : changer un index s’applique sans redémarrer', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'a.json'), EDIT_THIS_COOKIE('A'))
      const manifest = path.join(dir, 'accounts.json')
      writeFileSync(manifest, JSON.stringify({ accounts: [{ file: 'a.json', authUser: 1 }] }))
      const store = new CookieStore(dir)
      expect(store.activeAuthUser()).toBe(1)

      writeFileSync(manifest, JSON.stringify({ accounts: [{ file: 'a.json', authUser: 4, label: 'Corrigé' }] }))
      const later = new Date(Date.now() + 2000)
      utimesSync(manifest, later, later)
      expect(store.activeAuthUser()).toBe(4)
      expect(store.describe().accounts[0]).toMatchObject({ authUser: 4, label: 'Corrigé' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compte FICHIER unique : pas de manifeste auto, un accountsFile explicite s’applique par basename', () => {
    const dir = tempDir()
    try {
      const cookie = path.join(dir, 'seul.json')
      writeFileSync(cookie, EDIT_THIS_COOKIE('S'))
      const manifest = path.join(dir, 'ailleurs.json')
      writeFileSync(manifest, JSON.stringify({ accounts: [{ file: 'seul.json', authUser: 2, label: 'Solo' }] }))
      const store = new CookieStore(cookie, undefined, manifest)
      expect(store.activeAuthUser()).toBe(2)
      expect(store.describe().accounts[0]).toMatchObject({ authUser: 2, label: 'Solo' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cookies bruts (env) : jamais de manifeste — index undefined, le client repliera sur la config', () => {
    const store = new CookieStore('/nimporte/quoi', 'SAPISID=env', '/quelque/part.json')
    expect(store.activeAuthUser()).toBeUndefined()
  })
})

describe('CookieStore — expiration au diagnostic (M9)', () => {
  const ETC_EXPIRY = (value: string, expirationDate?: number) =>
    JSON.stringify([{ name: 'SAPISID', value, domain: '.google.com', ...(expirationDate !== undefined ? { expirationDate } : {}) }])

  it('compte vivant : expiresAt = la plus proche des dates des cookies vivants', () => {
    const dir = tempDir()
    try {
      const soon = Math.floor(Date.now() / 1000) + 3 * 86_400
      const later = Math.floor(Date.now() / 1000) + 40 * 86_400
      writeFileSync(path.join(dir, 'a.json'), ETC_EXPIRY('A', later))
      writeFileSync(path.join(dir, 'b.json'), ETC_EXPIRY('B', soon))
      const store = new CookieStore(dir)
      const d = store.describe()
      expect(d.accounts[0]?.expiresAt).toBe(later)
      expect(d.accounts[1]?.expiresAt).toBe(soon)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compte expiré : cookies false + expiresAt dans le passé — distinguable d’un compte sans cookies', () => {
    const dir = tempDir()
    try {
      const past = Math.floor(Date.now() / 1000) - 2 * 86_400
      writeFileSync(path.join(dir, 'mort.json'), ETC_EXPIRY('M', past))
      const store = new CookieStore(dir)
      const status = store.describe().accounts[0]
      expect(status?.cookies).toBe(false)
      expect(status?.expiresAt).toBe(past)
      expect(store.jar()?.header()).toBe('') // le jar du compte mort ne sert rien
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sans date connue (chaîne brute) : pas de champ expiresAt du tout', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'brut.json'), 'SAPISID=ok; HSID=h')
      const store = new CookieStore(dir)
      const status = store.describe().accounts[0]
      expect(status?.cookies).toBe(true)
      expect('expiresAt' in (status ?? {})).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
