/**
 * M13 — the pilot's security level, a session concept of its own file so
 * both the journal types (index.ts) and the derivation (derive.ts) share
 * the exact same narrow set. The level governs the agent's tools:
 *
 *   ask       — write/shell pause for a human approval (the M11 default)
 *   accept    — every tool runs without approval (the pilot trusts the agent)
 *   no-tools  — tools disabled: the ICM still loads, the model converses,
 *               but no tool_call is declared nor executed
 *
 * The journal is the truth: the level chosen at creation rides
 * session.created, a live change appends session.security (the last one
 * wins). The HTTP layer enforces it on EVERY /tool call — the browser
 * mirror (no declarations under no-tools) is a convenience, not the gate.
 */
export type SecurityLevel = 'ask' | 'accept' | 'no-tools'

export const SECURITY_LEVELS: readonly SecurityLevel[] = ['ask', 'accept', 'no-tools']

export const DEFAULT_SECURITY: SecurityLevel = 'ask'

/** Narrows an unknown value into a SecurityLevel (anything else → undefined). */
export function asSecurityLevel(value: unknown): SecurityLevel | undefined {
  return typeof value === 'string' && (SECURITY_LEVELS as readonly string[]).includes(value)
    ? (value as SecurityLevel)
    : undefined
}
