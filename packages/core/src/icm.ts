/**
 * ICM — Interpretable Context Methodology (pivot M11, layout M14).
 *
 * A session IS its context: the session folder (the pilot's project) is
 * the working ground, the HIDDEN `.workspace/` tree inside it is the
 * agent's ICM (memory + organization), and the CONTEXT.md files are the
 * interpretable part (what a human reads and edits). This module loads
 * that picture into a compact, honest form the model receives on every
 * turn — and assembles the system prompt that tells the model, without
 * ambiguity, THAT it runs inside the NyWorkflow harness, HOW its tools
 * work and WHERE its ICM lives (the M14 answer to « le modèle est
 * confus »).
 *
 * Pure Node (fs reads only): no network, no model — trivially testable.
 */
import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { ICM_DIR } from './scaffold.ts'

/** One CONTEXT.md file, as loaded for the model. */
export interface IcmFile {
  /** ICM-relative POSIX path, e.g. "" for the root CONTEXT.md of the ICM. */
  path: string
  content: string
}

/** A workspace as the model sees it: its tree, and its CONTEXT.md files. */
export interface IcmWorkspace {
  /** Session folder name (display). */
  name: string
  /** Rendered tree (renderTree format), ICM first, project after. */
  tree: string
  /** CONTEXT.md files: ICM root first, then folders in path order. */
  contexts: IcmFile[]
  /** True when the ICM lives in the hidden `.workspace/` (M14 layout). */
  icmDir: boolean
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
export const TREE_SKIP_DIRS = new Set(['.git', 'node_modules', '.nyworkflow', '.logs', 'dist', 'playwright-report', 'test-results'])

const CONTEXT_FILENAME = 'CONTEXT.md'

/** Session folder display name — the folder name, for prompts. */
export function workspaceName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? root
}

/**
 * Walks a tree breadth-safe (depth-capped, entry-capped, junk skipped)
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

/** Reads one CONTEXT.md, capped — unreadable returns undefined (never fatal). */
async function readContext(file: string): Promise<string | undefined> {
  try {
    const content = await readFile(file, 'utf8')
    return content.length > CONTEXT_MAX_CHARS
      ? `${content.slice(0, CONTEXT_MAX_CHARS)}\n… (tronqué à ${CONTEXT_MAX_CHARS} caractères)`
      : content
  } catch {
    return undefined
  }
}

/**
 * Loads the ICM of a session folder (M14 layout first, legacy fallback):
 *
 *   - `<root>/.workspace/` exists → the ICM lives THERE: contexts are its
 *     CONTEXT.md files, and the tree shows `.workspace/` (the agent's
 *     memory) followed by the project's visible tree (the work ground);
 *   - otherwise (workspaces scaffolded before M14) → legacy: contexts are
 *     the root CONTEXT.md files, the tree is the folder as-is.
 */
export async function loadIcm(root: string): Promise<IcmWorkspace> {
  const icmRoot = join(root, ICM_DIR)
  let icmEntries: TreeEntry[] = []
  let icmTruncated = false
  let icmDir = false
  try {
    const walked = await walkTree(icmRoot)
    // walkTree swallows an absent folder as empty — tell present vs absent apart.
    await readdir(icmRoot)
    icmDir = true
    // The .workspace root itself, then its subtree — renderTree shows the
    // folder name, so the entry must exist for `.workspace/` to appear.
    icmEntries = [{ path: ICM_DIR, dir: true }, ...walked.entries.map((e) => ({ path: `${ICM_DIR}/${e.path}`, dir: e.dir }))]
    icmTruncated = walked.truncated
  } catch {
    icmDir = false // no .workspace — legacy layout
  }

  const project = await walkTree(root)
  const truncated = icmTruncated || project.truncated
  // The ICM tree first (the agent's home), the project after (the work).
  const entries = [...icmEntries, ...project.entries].slice(0, TREE_MAX_ENTRIES)

  // Contexts: from the ICM dir when it exists, else from the root (legacy).
  const base = icmDir ? icmEntries.slice(1).map((e) => ({ ...e, path: e.path.slice(ICM_DIR.length + 1) })) : project.entries
  const contextPaths: string[] = []
  if (base.some((e) => e.path === CONTEXT_FILENAME)) contextPaths.push('')
  contextPaths.push(
    ...base
      .filter((e) => !e.dir && e.path !== CONTEXT_FILENAME && e.path.endsWith(`/${CONTEXT_FILENAME}`))
      .map((e) => e.path)
      .sort((a, b) => a.localeCompare(b)),
  )
  const contexts: IcmFile[] = []
  for (const p of contextPaths.slice(0, CONTEXT_MAX_FILES)) {
    // Root context: '' means the root CONTEXT.md itself, not the folder.
    const content = await readContext(p === '' ? join(icmDir ? icmRoot : root, CONTEXT_FILENAME) : join(icmDir ? icmRoot : root, p))
    if (content !== undefined) contexts.push({ path: p, content })
  }
  return { name: workspaceName(root), tree: renderTree(entries, truncated), contexts, icmDir }
}

/**
 * Builds the system prompt of an agentic session — the harness identity
 * the model needs to stop being confused (M14, pilot-driven): it runs
 * INSIDE NyWorkflow, its tools are real tool_calls executed in the
 * session folder, and its ICM is the `.workspace/` tree whose charter
 * and contexts follow. Tools are declared separately (standard
 * tool_calls through the gateway); this prompt teaches the CONTEXT, the
 * operating mode and the folder semantics.
 */
export function buildIcmSystemPrompt(icm: IcmWorkspace): string {
  const sections: string[] = []

  // 1. Identity — no ambiguity about what is speaking and where it runs.
  sections.push(
    [
      '# Tu es l’agent du harness NyWorkflow',
      '',
      `Tu es un agent exécuté DANS le harness NyWorkflow — pas un chatbot. Ta session vit dans le dossier « ${icm.name} » ` +
        'sur la machine du pilote : ce dossier est ton terrain de travail réel, et ton point d’entrée est l’ICM ' +
        '(Interpretable Context Methodology) — le contexte interprétable chargé dans ce prompt et entretenu dans l’arbre du workspace.',
      '',
      '**Agir = appeler un outil.** Tes tool_calls sont RÉELS : chaque appel est exécuté par le harness dans le dossier de la session ' +
        '(lire un fichier, écrire, lancer une commande bash, chercher sur le web) et le résultat te revient. Une réponse qui décrirait ' +
        'une action sans l’avoir exécutée, ou qui improviserait un contenu au lieu d’aller le lire, est un échec. ' +
        'Quand l’action t’est ouverte, utilise tes outils.',
    ].join('\n'),
  )

  // 2. Environment — where things live.
  sections.push(
    [
      '# Ton environnement',
      '',
      icm.icmDir
        ? [
            '- **Racine de la session** : le dossier du projet du pilote — ses fichiers sont ton matériau de travail.',
            `- **\`${ICM_DIR}/\`** : ton ICM, l’arbre caché qui t’appartient — charte, plan, tâches, journal, décisions, recherche, mémoire, livrables. C’est là que tu t’organises.`,
            '- **`.logs/`** : logs de profilage du harness — ne lis ni ne modifie jamais ce dossier.',
          ].join('\n')
        : [
            '- **Racine de la session** : le dossier du workspace — ses fichiers (charte comprise) sont ton terrain.',
            '- L’arbre est libre : crée les dossiers dont tu as besoin (mkdir).',
          ].join('\n'),
    ].join('\n'),
  )

  // 3. The ICM itself — tree then contexts, already loaded.
  sections.push(['# ICM chargé — arbre du workspace', '', '```', icm.tree, '```'].join('\n'))

  const root = icm.contexts.find((c) => c.path === '')
  if (root !== undefined) {
    sections.push(['# ICM chargé — charte (CONTEXT.md racine)', '', root.content.trim()].join('\n'))
  }
  const nested = icm.contexts.filter((c) => c.path !== '')
  if (nested.length > 0) {
    sections.push(['# ICM chargé — CONTEXT.md des dossiers', ...nested.flatMap((c) => [`## ${c.path}`, '', c.content.trim()])].join('\n'))
  }
  if (icm.contexts.length === 0) {
    sections.push(
      [
        '# ICM chargé — CONTEXT.md',
        '',
        '(aucun — ce workspace est vierge : commence par explorer l’arbre, puis écris un CONTEXT.md à la racine ' +
          'pour poser la mission : c’est la première chose que lira le prochain tour.)',
      ].join('\n'),
    )
  } else {
    sections.push(
      [
        '# Méthode ICM',
        '',
        '1. **Comprendre** — les CONTEXT.md ci-dessus sont DÉJÀ chargés dans ce prompt : **ne les relis pas** avec `read`' +
          ' (leur contenu est déjà sous tes yeux). Explore le reste de l’arbre (ls, glob, read) seulement quand la tâche l’exige.',
        '2. **Planifier** — consigne ton plan et tes hypothèses dans `notes/` (crée-le s’il n’existe pas, mkdir) : une tâche non triviale commence par une entrée de plan.',
        '3. **Agir** — exécute avec tes outils : read, write, ls, glob, mkdir, shell, websearch. Les écritures (write, shell) attendent l’approbation du pilote selon le niveau de sécurité : propose-les quand même, c’est le flux normal.',
        '4. **Livrer** — les livrables finaux vont dans `outputs/` ; les lectures web nettoyées dans `research/`.',
        '5. **Retenir** — un fait durable va dans `memory/core.md`, une erreur évitable dans `memory/lessons.md`, une décision dans `notes/decisions.md` : la mémoire se met à jour PENDANT le travail.',
      ].join('\n'),
    )
  }

  // 4. Operating mode — parallel, background, honest loop.
  sections.push(
    [
      '# Mode agentique',
      '',
      '- **Parallélise** : les appels indépendants (read, ls, glob, websearch…) se lancent ENSEMBLE dans une même réponse — un appel par lecture sérieuse, pas un par tour.',
      '- **Arrière-plan** : une commande longue (build, veille, sleep) part avec `"background": true` — tu reçois un jobId immédiat, suis-la avec `shell_output {"jobId"}`, arrête-la avec `shell_kill {"jobId"}`.',
      '- **Explore sans demander** : read/ls/glob/mkdir/websearch sont libres — agis. Seuls write et shell peuvent attendre le pilote, et c’est le flux normal : propose-les quand même.',
      '- **Boucle honnête** : un outil refusé (hors périmètre, arguments invalides) est un signal — corrige l’appel, ne le répète pas à l’identique.',
      '- **Conclus en donnant les chemins** des fichiers écrits et le résultat des commandes.',
    ].join('\n'),
  )

  // 5. Conventions.
  sections.push(
    [
      '# Conventions',
      '',
      '- Tout chemin reste dans le dossier de la session — les refus « hors périmètre » sont définitifs.',
      '- websearch rend du contenu **nettoyé** (scripts, nav et attributs partis, balises sémantiques gardées) : exploite-le, consigne l’utile dans `research/`.',
      '- Le journal de session est la vérité des échanges ; le workspace est l’état.',
      '- Réponds en français, concrètement, et conclus en donnant le chemin des fichiers écrits.',
    ].join('\n'),
  )

  return sections.join('\n\n')
}
