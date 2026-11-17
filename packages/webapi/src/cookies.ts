/**
 * Cookies Google — 3 formats acceptés en entrée (mêmes que ny-gemini-acp,
 * compatibilité totale avec les habitudes existantes) :
 *
 *   1. export **EditThisCookie** : tableau JSON [{name, value, domain, expirationDate}]
 *   2. objet gemini-web2api     : {"cookie": "k=v; k2=v2", "sapisid": "…"}
 *   3. chaîne brute             : "k=v; k2=v2"
 *
 * Un cookie n'entre dans l'en-tête que s'il est non vide, non expiré et
 * (quand le domaine est connu) rattaché à google.com. Le fichier est relu
 * dès que sa date de modification change — pas besoin de redémarrer la
 * passerelle pour changer de cookie.
 */
import { readFileSync, statSync } from 'node:fs'

export interface CookieEntry {
  name: string
  value: string
  domain?: string
  /** Secondes epoch — absent = session courante. */
  expiresAt?: number
}

function isGoogleDomain(domain: string): boolean {
  return domain === 'google.com' || domain.endsWith('.google.com')
}

export class CookieJar {
  readonly entries: CookieEntry[]
  private readonly sapisidOverride?: string

  constructor(entries: CookieEntry[], sapisidOverride?: string) {
    this.entries = entries
    this.sapisidOverride = sapisidOverride
  }

  static parse(raw: string): CookieJar {
    const head = raw.trimStart()[0]
    if (head === '[') return CookieJar.parseEditThisCookie(raw)
    if (head === '{') return CookieJar.parseObject(raw)
    return CookieJar.parseRaw(raw)
  }

  private static parseEditThisCookie(raw: string): CookieJar {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('cookie.json n’est pas un export EditThisCookie valide')
    }
    if (!Array.isArray(parsed)) throw new Error('cookie.json n’est pas un export EditThisCookie valide')
    const entries: CookieEntry[] = parsed.map((c) => {
      const entry = c as { name?: unknown; value?: unknown; domain?: unknown; expirationDate?: unknown }
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string' || entry.name.length === 0 || entry.value.length === 0) {
        throw new Error('cookie.json n’est pas un export EditThisCookie valide (entrée sans nom ou sans valeur)')
      }
      return {
        name: entry.name,
        value: entry.value,
        domain: typeof entry.domain === 'string' ? entry.domain : undefined,
        expiresAt: typeof entry.expirationDate === 'number' ? Math.floor(entry.expirationDate) : undefined,
      }
    })
    return new CookieJar(entries)
  }

  private static parseObject(raw: string): CookieJar {
    const obj = JSON.parse(raw) as { cookie?: unknown; sapisid?: unknown }
    if (typeof obj.cookie !== 'string') throw new Error('format objet cookie invalide (attendu {"cookie", "sapisid"})')
    return new CookieJar(CookieJar.parseRaw(obj.cookie).entries, typeof obj.sapisid === 'string' ? obj.sapisid : undefined)
  }

  private static parseRaw(raw: string): CookieJar {
    const entries: CookieEntry[] = []
    for (const pair of raw.split(';')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name && value) entries.push({ name, value })
    }
    return new CookieJar(entries)
  }

  /** En-tête `Cookie` — entrées valides uniquement, jointes par « ; ». */
  header(nowSec: number = Math.floor(Date.now() / 1000)): string {
    return this.entries
      .filter(
        (c) =>
          c.name !== '' &&
          c.value !== '' &&
          (c.expiresAt === undefined || c.expiresAt > nowSec) &&
          (c.domain === undefined || isGoogleDomain(c.domain)),
      )
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }

  /** Le SAPISID : celui de l'objet gemini-web2api, sinon le cookie du même nom. */
  sapisid(): string | undefined {
    if (this.sapisidOverride) return this.sapisidOverride
    return this.entries.find((c) => c.name === 'SAPISID')?.value
  }

  hasValidCookies(nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    return this.header(nowSec).length > 0
  }
}

export interface CookieSource {
  jar: CookieJar | undefined
  mtimeMs: number | undefined
}

/** Charge la source de cookies (fichier + mtime) — jamais d'exception : absence = jar absent. */
export function loadCookieSource(cookieFile: string): CookieSource {
  try {
    const mtimeMs = statSync(cookieFile).mtimeMs
    const jar = CookieJar.parse(readFileSync(cookieFile, 'utf8'))
    return { jar, mtimeMs }
  } catch {
    return { jar: undefined, mtimeMs: undefined }
  }
}
