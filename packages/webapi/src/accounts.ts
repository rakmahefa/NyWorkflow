/**
 * Multi-comptes cookies — la rotation que ny-gemini-acp n'avait pas : quand un
 * compte est refusé (401/expiré), la passerelle passe au suivant au lieu de
 * tomber.
 *
 * `NYW_WEBAPI_COOKIE_FILE` pointe soit un fichier (comportement historique),
 * soit un RÉPERTOIRE : chaque fichier dedans est un compte (tri par nom pour
 * un ordre déterministe). Relecture à chaud par mtime, fichier par fichier —
 * remplacer un cookie ne redémarre rien.
 *
 * Les cookies bruts `NYW_WEBAPI_COOKIES` restent un compte unique qui gagne
 * sur tout le reste (comportement historique conservé).
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { CookieJar, loadCookieSource, type CookieSource } from './cookies.ts'

export interface AccountStatus {
  /** Chemin du fichier de cookies (ou libellé env pour les cookies bruts). */
  file: string
  /** Des cookies exploitables sont présents. */
  cookies: boolean
  /** Fichier illisible/malformé — cause lisible. */
  error?: string
}

interface Account {
  file: string
  /** Stat lazy — décrit sans lever. */
  status: AccountStatus
  source?: CookieSource
  lastMtimeMs?: number | undefined
}

const RAW_COOKIES_LABEL = '(NYW_WEBAPI_COOKIES)'

export class CookieStore {
  private readonly rawCookies?: string
  private readonly cookieFile: string
  private readonly files: string[] = []
  private active = 0
  private readonly accounts = new Map<string, Account>()

  constructor(cookieFile: string, rawCookies?: string) {
    this.cookieFile = cookieFile
    this.rawCookies = rawCookies
    if (rawCookies !== undefined) return
    if (cookieFile === '') return
    // Répertoire = un compte par fichier (trié). Fichier = compte unique.
    try {
      const st = statSync(cookieFile)
      if (st.isDirectory()) {
        this.files.push(
          ...readdirSync(cookieFile)
            .filter((f) => !f.startsWith('.'))
            .sort()
            .map((f) => path.join(cookieFile, f)),
        )
      } else {
        this.files.push(cookieFile)
      }
    } catch {
      // Absent au boot : le compte apparaîtra « sans cookies » dans describe(),
      // et sera relu à chaud s'il apparaît (un seul fichier, pas de scan répertoire).
      this.files.push(cookieFile)
    }
  }

  /** Nombre de comptes (0 si aucun cookie configuré). */
  count(): number {
    if (this.rawCookies !== undefined) return 1
    return this.files.length === 0 ? 0 : this.files.length
  }

  /** Index du compte actif (rotation) — 0 par défaut. */
  activeIndex(): number {
    return this.active
  }

  /**
   * Passe au compte suivant. `tried` = indices déjà tentés pour CE tour (la
   * garde anti-boucle appartient à l'appelant, qui sait quand le tour a fini).
   * Retourne false si tout a été essayé.
   */
  rotate(tried: ReadonlySet<number>): boolean {
    if (this.count() < 2) return false
    for (let step = 1; step <= this.files.length; step++) {
      const candidate = (this.active + step) % this.files.length
      if (!tried.has(candidate)) {
        this.active = candidate
        return true
      }
    }
    return false
  }

  /** Jar du compte actif — rechargé à chaud si le fichier a changé. */
  jar(): CookieJar | undefined {
    if (this.rawCookies !== undefined) {
      return this.rawAccount().source?.jar
    }
    if (this.files.length === 0) return undefined
    return this.loadAccount(this.active)?.source?.jar
  }

  /** Diagnostic complet pour GET / — aucune exception. */
  describe(): { cookieFile: string; rawCookies: boolean; accounts: AccountStatus[]; active: number } {
    if (this.rawCookies !== undefined) {
      const jar = this.rawAccount().source?.jar
      return {
        cookieFile: RAW_COOKIES_LABEL,
        rawCookies: true,
        accounts: [{ file: RAW_COOKIES_LABEL, cookies: jar?.hasValidCookies() ?? false }],
        active: 0,
      }
    }
    const accounts = this.files.map((file, i) => {
      const account = this.loadAccount(i)
      return account?.status ?? { file, cookies: false, error: 'illisible' }
    })
    return { cookieFile: this.cookieFile, rawCookies: false, accounts, active: this.active }
  }

  private rawAccount(): Account {
    let account = this.accounts.get(RAW_COOKIES_LABEL)
    if (account === undefined) {
      account = { file: RAW_COOKIES_LABEL, status: { file: RAW_COOKIES_LABEL, cookies: false } }
      this.accounts.set(RAW_COOKIES_LABEL, account)
    }
    // Re-parse à chaque appel : une chaîne brute ne change pas de mtime, elle
    // est simplement relue (coût négligeable, comportement prévisible).
    try {
      const jar = CookieJar.parse(this.rawCookies ?? '')
      account.source = { jar, mtimeMs: undefined }
      account.status = { file: RAW_COOKIES_LABEL, cookies: jar.hasValidCookies() }
    } catch (err) {
      account.source = { jar: undefined, mtimeMs: undefined }
      account.status = { file: RAW_COOKIES_LABEL, cookies: false, error: err instanceof Error ? err.message : String(err) }
    }
    return account
  }

  private loadAccount(index: number): Account | undefined {
    const file = this.files[index]
    if (file === undefined) return undefined
    let account = this.accounts.get(file)
    if (account === undefined) {
      account = { file, status: { file, cookies: false } }
      this.accounts.set(file, account)
    }
    try {
      const fresh = loadCookieSource(file)
      if (account.source === undefined || account.lastMtimeMs !== fresh.mtimeMs) {
        account.source = fresh
        account.lastMtimeMs = fresh.mtimeMs
        account.status = {
          file,
          cookies: fresh.jar?.hasValidCookies() ?? false,
          error: fresh.error ?? (fresh.jar === undefined && fresh.mtimeMs !== undefined ? 'format de cookies non reconnu' : undefined),
        }
      }
    } catch (err) {
      account.status = { file, cookies: false, error: err instanceof Error ? err.message : String(err) }
    }
    return account
  }
}
