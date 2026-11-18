/**
 * Scope guard — the one permission that matters: every tool path stays
 * strictly inside the workspace root. Lexical checks first (empty path,
 * absolute paths, backslashes, '..' escapes), then a realpath pass so a
 * symlink cannot tunnel out of the workspace. Every refusal carries a
 * French reason — refusals are journaled, never silent.
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** Why a path was refused. */
export type ScopeRefusal = 'empty' | 'absolute' | 'backslash' | 'escape' | 'symlink-escape' | 'forbidden' | 'unresolvable'

export interface ScopeResolution {
  ok: boolean
  /** Absolute canonical target (only when ok). */
  target?: string
  /** Root-relative POSIX display path (only when ok). */
  rel?: string
  /** Refusal code + French reason (only when !ok). */
  code?: ScopeRefusal
  reason?: string
}

export const SCOPE_REASONS: Record<ScopeRefusal, string> = {
  empty: 'chemin vide',
  absolute: 'chemin absolu interdit',
  backslash: 'séparateur « \\ » interdit',
  escape: 'chemin hors workspace',
  'symlink-escape': 'symlink pointant hors du workspace',
  // Audit S4 — le prompt enseigne « ne lis ni ne modifie jamais .logs/ » :
  // le scope l'impose aussi (les logs de session d'un workspace ne sont pas
  // la matière première des outils).
  forbidden: 'dossier .logs/ réservé au harness (interdit aux outils)',
  unresolvable: 'chemin non résolvable (permissions ou boucle de symlinks)',
}

/** Lexical pass: shape of the path, no filesystem access. */
function lexicalCheck(root: string, raw: string): ScopeResolution {
  const refuse = (code: ScopeRefusal): ScopeResolution => ({ ok: false, code, reason: SCOPE_REASONS[code] })
  const t = raw.trim()
  if (t === '') return refuse('empty')
  if (t.includes('\\')) return refuse('backslash')
  if (t.startsWith('/') || /^[A-Za-z]:/.test(t)) return refuse('absolute')

  const rel = posix.normalize(t)
  if (rel === '..' || rel.startsWith('../')) return refuse('escape')

  // Audit S4 — .logs/ est le journal du harness (il contient les réponses
  // des modèles, y compris celles des AUTRES sessions du workspace) : le
  // prompt l'interdit aux outils, le scope l'imprime pareil.
  if (rel === '.logs' || rel.startsWith('.logs/')) return refuse('forbidden')

  const target = resolve(root, rel)
  const back = relative(root, target)
  if (back.startsWith('..') || isAbsolute(back)) return refuse('escape')
  return { ok: true, target, rel: back === '' ? '.' : back.split(sep).join('/') }
}

/**
 * Resolves `raw` inside `root` or refuses. The realpath pass walks up to the
 * deepest existing ancestor of the target, canonicalises it, and checks
 * containment — so a symlinked directory cannot escape the workspace, and a
 * not-yet-existing target (a write) inherits its parent's verdict.
 */
export async function resolveInScope(root: string, raw: string): Promise<ScopeResolution> {
  const lex = lexicalCheck(root, raw)
  if (!lex.ok) return lex

  const realRoot = await realpath(root) // the workspace always exists (it parsed)
  let probe = lex.target as string
  const tail: string[] = []
  for (;;) {
    let canonical: string
    try {
      canonical = await realpath(probe)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Audit R2 — une erreur fs qui n'est pas ENOENT (EACCES sur un
      // ancêtre, ELOOP sur une boucle de symlinks…) est un REFUS propre et
      // journalisé, pas une 500 : le chemin existe mais ne se résout pas.
      if (code !== 'ENOENT') return { ok: false, code: 'unresolvable', reason: `${SCOPE_REASONS.unresolvable} (${code ?? 'erreur fs'}) : ${lex.rel}` }
      // Not there (yet): judge by the deepest existing ancestor.
      tail.unshift(basename(probe))
      const parent = dirname(probe)
      if (parent === probe) return { ok: false, code: 'escape', reason: SCOPE_REASONS.escape }
      probe = parent
      continue
    }
    const back = relative(realRoot, canonical)
    if (back === '' || (!back.startsWith('..') && !isAbsolute(back))) {
      return { ok: true, target: tail.length > 0 ? join(canonical, ...tail) : canonical, rel: lex.rel }
    }
    return { ok: false, code: 'symlink-escape', reason: `${SCOPE_REASONS['symlink-escape']} : ${lex.rel}` }
  }
}
