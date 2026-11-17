/**
 * Configuration de la passerelle — tout vient de l'environnement `NYW_WEBAPI_*`,
 * jamais d'un fichier caché : 12 facteurs, testable (l'env est injectable).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

export interface WebApiConfig {
  /** Adresse d'écoute. Boucle par défaut — l'exposition réseau est un milestone à part entière. */
  host: string
  port: number
  /** Fichier de cookies Gemini (3 formats acceptés — voir cookies.ts). */
  cookieFile: string
  /** Cookies bruts « k=v; k2=v2 » passés directement (gagne sur le fichier). */
  rawCookies?: string
  /** Modèle par défaut quand la requête n'en porte pas. */
  defaultModel: string
  /** Table de modèles JSON de remplacement (data-driven — voir models.ts). */
  modelsFile?: string
  /** Force la version `bl` de l'interface Gemini (sinon : auto-découverte + repli). */
  geminiBl?: string
  /** Compte multi-session Google (préfixe /u/N). */
  authUser?: number
  /** Base de l'interface Gemini — surchargée par les tests (maquette locale). */
  baseUrl: string
  /** Délai maximal d'une requête amont, ms. */
  timeoutMs: number
  retryAttempts: number
  retryDelayMs: number
}

export const DEFAULT_PORT = 8081
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_GEMINI_BASE_URL = 'https://gemini.google.com'
export const DEFAULT_TIMEOUT_MS = 180_000
export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_RETRY_DELAY_MS = 2_000

/**
 * Racine du monorepo : le premier dossier parent qui contient pnpm-workspace.yaml.
 * Repli : le dossier courant (paquet installé hors repo).
 */
export function findRepoRoot(from: string): string {
  let dir = path.resolve(from)
  while (true) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

/** Dossier de ce source — fonctionne en Node nu comme sous Vitest. */
const here = path.dirname(fileURLToPath(import.meta.url))

/** Cookies par défaut : <repo>/.nyworkflow/cookies/gemini.json (déjà gitignoré). */
export function defaultCookieFile(): string {
  return path.join(findRepoRoot(here), '.nyworkflow', 'cookies', 'gemini.json')
}

function int(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function loadWebApiConfig(env: Record<string, string | undefined> = process.env): WebApiConfig {
  const rawCookies = env.NYW_WEBAPI_COOKIES?.trim() || undefined
  const authUser = env.NYW_WEBAPI_AUTH_USER !== undefined && env.NYW_WEBAPI_AUTH_USER !== '' ? Number(env.NYW_WEBAPI_AUTH_USER) : undefined
  return {
    host: env.NYW_WEBAPI_HOST?.trim() || DEFAULT_HOST,
    port: int(env, 'NYW_WEBAPI_PORT', DEFAULT_PORT),
    cookieFile: env.NYW_WEBAPI_COOKIE_FILE?.trim() || defaultCookieFile(),
    rawCookies,
    defaultModel: env.NYW_WEBAPI_MODEL?.trim() || 'gemini-3.6-flash',
    modelsFile: env.NYW_WEBAPI_MODELS_FILE?.trim() || undefined,
    geminiBl: env.NYW_WEBAPI_GEMINI_BL?.trim() || undefined,
    authUser: Number.isFinite(authUser) ? authUser : undefined,
    baseUrl: env.NYW_WEBAPI_GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
    timeoutMs: int(env, 'NYW_WEBAPI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    retryAttempts: Math.max(1, int(env, 'NYW_WEBAPI_RETRY_ATTEMPTS', DEFAULT_RETRY_ATTEMPTS)),
    retryDelayMs: int(env, 'NYW_WEBAPI_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS),
  }
}
