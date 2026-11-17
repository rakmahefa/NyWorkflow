/**
 * ICM — Interpretable Context Methodology (pivot M11).
 *
 * A session IS its context: the workspace folder is a free tree, the
 * CONTEXT.md files are the interpretable part (what a human reads and
 * edits), and this module loads that tree into a compact, honest picture
 * the model receives on every turn. No stages, no numbered contracts —
 * the engine of phase 1 is gone; the agent orchestrates itself with its
 * tools, guided by the ICM.
 *
 * Pure Node (fs reads only): no network, no model — trivially testable.
 */
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** One CONTEXT.md file, as loaded for the model. */
export interface IcmFile {
  /** Root-relative POSIX path, e.g. "" for the root CONTEXT.md. */
  path: string
  content: string
}

/** A workspace as the model sees it: its tree, and its CONTEXT.md files. */
export interface IcmWorkspace {
  /** Workspace folder name (display). */
  name: string
  /** Rendered tree (renderTree format), root first. */
  tree: string
  /** CONTEXT.md files: root first, then folders in path order. */
  contexts: IcmFile[]
}

/** One entry of the walked tree. */
export interface TreeEntry {
  /** Root-relative POSIX path. */
  path: string
  dir: boolean
}

/** Tree walk caps — a runaway workspace must not saturate the prompt. */
export const TREE_MAX_ENTRIES = 500
export const TREE_MAX_DEPTH = 6
/** CONTEXT.md caps: at most 8 files, 32 KiB each. */
export const CONTEXT_MAX_FILES = 8
export const CONTEXT_MAX_CHARS = 32_768
/** Folders never walked — never part of the ICM. */
export const TREE_SKIP_DIRS = new Set(['.git', 'node_modules', '.nyworkflow', 'dist', 'playwright-report', 'test-results'])

const CONTEXT_FILENAME = 'CONTEXT.md'

/** Workspace display name — the folder name, for prompts. */
export function workspaceName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? root
}

/**
 * Walks the tree breadth-safe (depth-capped, entry-capped, junk skipped)
 * and returns entries in reading order: per folder, dirs first then files,
 * each group alphabetical. The caps are honest: over the limit, the tree
 * says so — it never silently lies about the workspace.
 */
export async function walkTree(root: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const entries: TreeEntry[] = []
  let truncated = false

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > TREE_MAX_DEPTH) {
      truncated = true
      return
    }
    let dirents: Dirent[]
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return // unreadable folder: nothing to say about it
    }
    dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const e of dirents) {
      if (entries.length >= TREE_MAX_ENTRIES) {
        truncated = true
        return
      }
      if (e.isDirectory() && (e.name.startsWith('.') || TREE_SKIP_DIRS.has(e.name))) continue // hidden/junk folders
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      entries.push({ path: childRel, dir: e.isDirectory() })
      if (e.isDirectory()) await walk(childRel, depth + 1)
    }
  }

  await walk('', 0)
  return { entries, truncated }
}

/**
 * Renders the tree the way a human reads it — connectors, trailing slash
 * for folders. Pure: the tests assert the exact bytes.
 */
export function renderTree(entries: readonly TreeEntry[], truncated = false): string {
  if (entries.length === 0) return '(arbre vide)'
  const lines: string[] = []
  for (const e of entries) {
    const depth = e.path === '' ? 0 : e.path.split('/').length - 1
    const name = e.path.split('/').pop() ?? e.path
    const prefix = depth === 0 ? '' : `${'│   '.repeat(depth - 1)}${'├── '}`
    lines.push(`${prefix}${name}${e.dir ? '/' : ''}`)
  }
  if (truncated) lines.push('… (arbre tronqué — trop d’entrées ou profondeur > 6)')
  return lines.join('\n')
}

/**
 * Loads the ICM of a workspace: its tree + every CONTEXT.md (root first,
 * path order, capped). A workspace without CONTEXT.md is valid — the
 * system prompt then carries only the tree and the method.
 */
export async function loadIcm(root: string): Promise<IcmWorkspace> {
  const { entries, truncated } = await walkTree(root)
  const contextPaths: string[] = []
  if (entries.some((e) => e.path === CONTEXT_FILENAME)) contextPaths.push('')
  contextPaths.push(
    ...entries
      .filter((e) => !e.dir && e.path !== CONTEXT_FILENAME && e.path.endsWith(`/${CONTEXT_FILENAME}`))
      .map((e) => e.path)
      .sort((a, b) => a.localeCompare(b)),
  )
  const contexts: IcmFile[] = []
  for (const p of contextPaths.slice(0, CONTEXT_MAX_FILES)) {
    let content: string
    try {
      // Root context: '' means the root CONTEXT.md itself, not the folder.
      content = await readFile(p === '' ? join(root, CONTEXT_FILENAME) : join(root, p), 'utf8')
    } catch {
      continue // unreadable CONTEXT.md is skipped, never fatal
    }
    const cut = content.length > CONTEXT_MAX_CHARS
    contexts.push({
      path: p,
      content: cut ? `${content.slice(0, CONTEXT_MAX_CHARS)}\n… (tronqué à ${CONTEXT_MAX_CHARS} caractères)` : content,
    })
  }
  return { name: workspaceName(root), tree: renderTree(entries, truncated), contexts }
}

/**
 * Builds the system prompt of an agentic session: the ICM (method, tree,
 * CONTEXT.md files) the model receives on every turn — "le ICM vers le
 * modèle", as the pilot says. Tools are declared separately (standard
 * tool_calls through the gateway); this prompt teaches the CONTEXT, the
 * conventions and the folder semantics.
 */
export function buildIcmSystemPrompt(icm: IcmWorkspace): string {
  const sections: string[] = []

  sections.push(
    `Tu es un agent ICM (Interpretable Context Methodology) — le workspace « ${icm.name} » est ton contexte, ` +
      'le système de fichiers est l’orchestrateur : chaque dossier a un rôle, chaque fichier un état, ' +
      'et chaque CONTEXT.md se lit avant d’agir.',
  )

  sections.push(
    [
      '## Méthode ICM',
      '1. **Comprendre** — lis les CONTEXT.md ci-dessous, explore l’arbre (ls, glob, read) avant d’agir.',
      '2. **Planifier** — consigne ton plan et tes hypothèses dans notes/ (crée-le s’il n’existe pas, mkdir).',
      '3. **Agir** — tes outils : read, write, ls, glob, mkdir, shell, websearch. Les écritures (write, shell) attendent l’approbation du pilote : propose-les quand même, c’est le flux normal.',
      '4. **Livrer** — les livrables finaux vont dans outputs/ ; les lectures web nettoyées dans research/.',
    ].join('\n'),
  )

  sections.push([`## Arborescence actuelle`, '```', icm.tree, '```'].join('\n'))

  const root = icm.contexts.find((c) => c.path === '')
  if (root !== undefined) {
    sections.push(['## CONTEXT.md racine', '', root.content.trim()].join('\n'))
  }
  const nested = icm.contexts.filter((c) => c.path !== '')
  if (nested.length > 0) {
    sections.push(
      ['## CONTEXT.md des dossiers', ...nested.flatMap((c) => [`### ${c.path}`, '', c.content.trim()])].join('\n'),
    )
  }
  if (icm.contexts.length === 0) {
    sections.push(
      [
        '## CONTEXT.md',
        '(aucun — ce workspace est vierge : commence par explorer l’arbre, puis écris un CONTEXT.md à la racine ' +
          'pour poser la mission : c’est la première chose que lira le prochain tour.)',
      ].join('\n'),
    )
  }

  sections.push(
    [
      '## Méthode agentique (M12)',
      '- **Parallélise** : les appels indépendants (read, ls, glob, websearch…) se lancent ENSEMBLE dans une même réponse — un appel par lecture sérieuse, pas un par tour.',
      '- **Arrière-plan** : une commande longue (build, veille, sleep) part avec `"background": true` — tu reçois un jobId immédiat, suis-la avec `shell_output {"jobId"}`, arrête-la avec `shell_kill {"jobId"}`.',
      '- **Explore sans demander** : read/ls/glob/mkdir/websearch sont libres — agis. Seuls write et shell attendent le pilote, et c’est le flux normal : propose-les quand même.',
      '- **Boucle honnête** : un outil refusé (hors périmètre, arguments invalides) est un signal — corrige l’appel, ne le répète pas à l’identique.',
      '- **Conclus en donnant les chemins** des fichiers écrits et le résultat des commandes.',
    ].join('\n'),
  )

  sections.push(
    [
      '## Conventions',
      '- L’arbre est **libre** : crée les dossiers dont tu as besoin (mkdir) ; garde des noms courts et lisibles.',
      '- Tout chemin reste dans le workspace — les refus « hors périmètre » sont définitifs.',
      '- websearch rend du contenu **nettoyé** (scripts, nav et attributs partis, balises sémantiques gardées) : exploite-le, consigne l’utile dans research/.',
      '- Le journal de session est la vérité des échanges ; le workspace est l’état. Réponds en français, concrètement, et conclus en donnant le chemin des fichiers écrits.',
    ].join('\n'),
  )

  return sections.join('\n\n')
}
