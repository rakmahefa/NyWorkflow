/**
 * Security levels, browser side (M13). A tiny local mirror of
 * @nyworkflow/session's SecurityLevel: that package re-exports node:fs
 * code (journal primitives), so only TYPES may cross into the browser
 * bundle — runtime helpers live here.
 */
import type { SecurityLevel } from './types'

export const SECURITY_LEVELS: readonly SecurityLevel[] = ['ask', 'accept', 'no-tools']

export const DEFAULT_SECURITY: SecurityLevel = 'ask'

/** localStorage key of the default level for NEW sessions. */
export const SECURITY_KEY = 'nyworkflow.security'

export const SECURITY_LABEL: Record<SecurityLevel, string> = {
  ask: 'Demander toujours',
  accept: 'Accepter automatiquement',
  'no-tools': 'Aucun outil',
}

export const SECURITY_HINT: Record<SecurityLevel, string> = {
  ask: 'write et shell attendent ton approbation (défaut)',
  accept: 'tous les outils s’exécutent sans approbation',
  'no-tools': 'outils désactivés — conversation ICM pure',
}

/** Narrows anything into a SecurityLevel (default 'ask'). */
export function asSecurityLevel(value: unknown): SecurityLevel | undefined {
  return typeof value === 'string' && (SECURITY_LEVELS as readonly string[]).includes(value)
    ? (value as SecurityLevel)
    : undefined
}

/** The stored default for new sessions ('ask' when never set). */
export function loadDefaultSecurity(): SecurityLevel {
  return asSecurityLevel(localStorage.getItem(SECURITY_KEY)) ?? DEFAULT_SECURITY
}

export function saveDefaultSecurity(level: SecurityLevel): void {
  localStorage.setItem(SECURITY_KEY, level)
}

/** slug from a session title — the default workspace name of a new session. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug === '' ? '' : slug
}
