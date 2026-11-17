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
 * M9 — auth multi-sessions : chaque fichier est un compte Google ET son index
 * de session. L'index vit dans un manifeste `accounts.json` (dans le
 * répertoire de cookies, surchargeable par NYW_WEBAPI_ACCOUNTS_FILE) :
 *
 *   { "accounts": [
 *       { "file": "a-perso.json", "authUser": 0, "label": "Perso" },
 *       { "file": "b-pro.json",   "authUser": 1, "label": "Pro" }
 *   ] }
 *
 * Sans entrée de manifeste pour un compte, l'index global (NYW_WEBAPI_AUTH_USER)
 * reste le repli — historique préservé. Le diagnostic porte désormais aussi
 * l'expiration des cookies (`expiresAt`, voir cookies.ts) : le pilote voit
 * venir l'expiration au lieu de la découvrir en 401.
 *
 * Les cookies bruts `NYW_WEBAPI_COOKIES` restent un compte unique qui gagne
 * sur tout le reste (comportement historique conservé).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { CookieJar, loadCookieSource, type CookieSource } from './cookies.ts'

export interface AccountStatus {
  /** Chemin du fichier de cookies (ou libellé env pour les cookies bruts). */
  file: string
  /** Des cookies exploitables sont présents. */
  cookies: boolean
  /** Fichier illisible/malformé — cause lisible. */
  error?: string
  /** M9 : index de session Google (`/u/N`) du compte, depuis le manifeste. */
  authUser?: number
  /** M9 : libellé du compte, depuis le manifeste. */
  label?: string
  /**
   * M9 : expiration la plus proche des cookies qui servent encore, secondes
   * epoch. Dans le passé = déjà expiré (à recharger). Absent = pas de date
   * connue (chaîne brute, cookies de session).
   */
  expiresAt?: number
}

/** Entrée de manifeste une fois validée. */
interface ManifestEntry {
  authUser?: number
  label?: string
}

/** Manifeste chargé — jamais d'exception (la passerelle démarre toujours). */
export interface ManifestSource {
  /** Clé = basename du fichier de cookies tel qu'écrit dans le manifeste. */
  entries: Map<string, ManifestEntry>
  mtimeMs?: number
  error?: string
}

const EMPTY_MANIFEST: ManifestSource = { entries: new Map() }

/**
 * Charge et valide le manifeste des comptes. Tolérant comme loadModelTable :
 * fichier absent/illisible → manifeste vide (jamais fatal) ; entrées invalides
 * ignorées une par une. Accepte un tableau au premier niveau OU
 * `{ "accounts": [...] }`.
 */
export function loadAccountsManifest(file: string): ManifestSource {
  let mtimeMs: number | undefined
  let raw: string
  try {
    mtimeMs = statSync(file).mtimeMs
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { entries: new Map(), mtimeMs, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { accounts?: unknown })?.accounts)
        ? ((parsed as { accounts: unknown[] }).accounts)
        : undefined
    if (list === undefined) throw new Error('accounts.json invalide : attendu un tableau ou { "accounts": [...] }')
    const entries = new Map<string, ManifestEntry>()
    for (const item of list) {
      const e = item as { file?: unknown; authUser?: unknown; label?: unknown }
      if (typeof e.file !== 'string' || e.file.length === 0) continue // entrée sans fichier : ignorée
      const authUser =
        typeof e.authUser === 'number' && Number.isInteger(e.authUser) && e.authUser >= 0 ? e.authUser : undefined
      if (e.authUser !== undefined && authUser === undefined) continue // index invalide : l'entrée est ignorée
      const entry: ManifestEntry = {}
      if (authUser !== undefined) entry.authUser = authUser
      if (typeof e.label === 'string' && e.label.length > 0) entry.label = e.label
      // Premier manifeste pour un basename gagne : ordre du fichier = ordre lu.
      if (!entries.has(e.file)) entries.set(e.file, entry)
    }
    return { entries, mtimeMs }
  } catch (err) {
    return { entries: new Map(), mtimeMs, error: err instanceof Error ? err.message : String(err) }
  }
}

interface Account {
  file: string
  /** Stat lazy — décrit sans lever. */
  status: AccountStatus
  source?: CookieSource
  lastMtimeMs?: number | undefined
  /** mtime du manifeste utilisé pour le dernier calcul de status. */
  statusManifestMtime?: number | undefined
}

const RAW_COOKIES_LABEL = '(NYW_WEBAPI_COOKIES)'

export class CookieStore {
  private readonly rawCookies?: string
  private readonly cookieFile: string
  private readonly files: string[] = []
  private active = 0
  private readonly accounts = new Map<string, Account>()
  /** Manifeste des comptes (accounts.json) — fichier explicite ou auto à côté des cookies. */
  private readonly manifestFile: string | undefined
  private manifestCache: ManifestSource | undefined

  constructor(cookieFile: string, rawCookies?: string, accountsFile?: string) {
    this.cookieFile = cookieFile
    this.rawCookies = rawCookies
    if (rawCookies !== undefined) return
    if (cookieFile === '') return
    // Répertoire = un compte par fichier (trié). Fichier = compte unique.
    try {
      const st = statSync(cookieFile)
      if (st.isDirectory()) {
        this.manifestFile = accountsFile ?? path.join(cookieFile, 'accounts.json')
        // Le manifeste n'est PAS un compte : exclu du listing (par chemin exact —
        // un fichier de cookies homonyme ailleurs n'est pas touché).
        this.files.push(
          ...readdirSync(cookieFile)
            .filter((f) => !f.startsWith('.'))
            .sort()
            .map((f) => path.join(cookieFile, f))
            .filter((f) => f !== this.manifestFile),
        )
      } else {
        this.files.push(cookieFile)
        if (accountsFile !== undefined) this.manifestFile = accountsFile
      }
    } catch {
      // Absent au boot : le compte apparaîtra « sans cookies » dans describe(),
      // et sera relu à chaud s'il apparaît (un seul fichier, pas de scan répertoire).
      this.files.push(cookieFile)
      if (accountsFile !== undefined) this.manifestFile = accountsFile
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
   * M9 — index de session (`/u/N`) du compte ACTIF, depuis le manifeste.
   * Undefined = pas d'entrée pour ce compte (le client repliera sur
   * NYW_WEBAPI_AUTH_USER). Cookies bruts : jamais (compte unique historique).
   */
  activeAuthUser(): number | undefined {
    if (this.rawCookies !== undefined) return undefined
    if (this.files.length === 0) return undefined
    const file = this.files[this.active]
    if (file === undefined) return undefined
    return this.manifest().entries.get(path.basename(file))?.authUser
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
      return {
        cookieFile: RAW_COOKIES_LABEL,
        rawCookies: true,
        accounts: [this.rawAccount().status],
        active: 0,
      }
    }
    const manifest = this.manifest()
    const accounts = this.files.map((file, i) => {
      const account = this.loadAccount(i, manifest)
      return account?.status ?? { file, cookies: false, error: 'illisible' }
    })
    return { cookieFile: this.cookieFile, rawCookies: false, accounts, active: this.active }
  }

  // ---------------------------------------------------------------- internals

  /** Manifeste en vigueur — rechargé à chaud dès que sa mtime change. */
  private manifest(): ManifestSource {
    if (this.manifestFile === undefined) return EMPTY_MANIFEST
    let mtimeMs: number | undefined
    try {
      mtimeMs = statSync(this.manifestFile).mtimeMs
    } catch {
      mtimeMs = undefined
    }
    if (this.manifestCache !== undefined && this.manifestCache.mtimeMs === mtimeMs) return this.manifestCache
    this.manifestCache = this.manifestFile === '' || mtimeMs === undefined ? { entries: new Map(), mtimeMs } : loadAccountsManifest(this.manifestFile)
    return this.manifestCache
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
      const status: AccountStatus = { file: RAW_COOKIES_LABEL, cookies: jar.hasValidCookies() }
      const expiry = jar.earliestExpiry()
      if (expiry !== undefined) status.expiresAt = expiry
      account.status = status
    } catch (err) {
      account.source = { jar: undefined, mtimeMs: undefined }
      account.status = { file: RAW_COOKIES_LABEL, cookies: false, error: err instanceof Error ? err.message : String(err) }
    }
    return account
  }

  private loadAccount(index: number, manifest?: ManifestSource): Account | undefined {
    const file = this.files[index]
    if (file === undefined) return undefined
    const m = manifest ?? this.manifest()
    let account = this.accounts.get(file)
    if (account === undefined) {
      account = { file, status: { file, cookies: false } }
      this.accounts.set(file, account)
    }
    try {
      const fresh = loadCookieSource(file)
      const cookieChanged = account.source === undefined || account.lastMtimeMs !== fresh.mtimeMs
      // Le statut est recalculé si le fichier de cookies OU le manifeste a bougé.
      const manifestChanged = account.statusManifestMtime !== m.mtimeMs
      if (cookieChanged) {
        account.source = fresh
        account.lastMtimeMs = fresh.mtimeMs
      }
      if (cookieChanged || manifestChanged) {
        const entry = m.entries.get(path.basename(file)) ?? undefined
        const jar = account.source?.jar
        const status: AccountStatus = {
          file,
          cookies: jar?.hasValidCookies() ?? false,
          error:
            fresh.error ??
            (account.source?.jar === undefined && fresh.mtimeMs !== undefined ? 'format de cookies non reconnu' : undefined),
        }
        if (entry?.authUser !== undefined) status.authUser = entry.authUser
        if (entry?.label !== undefined) status.label = entry.label
        const expiry = jar?.earliestExpiry()
        if (expiry !== undefined) status.expiresAt = expiry
        account.status = status
        account.statusManifestMtime = m.mtimeMs
      }
    } catch (err) {
      account.status = { file, cookies: false, error: err instanceof Error ? err.message : String(err) }
    }
    return account
  }
}
