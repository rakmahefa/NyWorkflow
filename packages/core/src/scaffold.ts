/**
 * Scaffold (M11) — the default agentic ICM tree, what every new workspace
 * is born with. Modern and complete on purpose: a CONTEXT.md charter the
 * agent reads first, plus the four folders of a working session (inbox,
 * notes, research, outputs) — and the explicit permission to grow the
 * tree (mkdir). Everything is plain files: observable, diffable, editable
 * by the human before the agent even starts.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceName } from './icm.ts'

/** The four folders of a working session — free tree, sane defaults. */
export const SCAFFOLD_FOLDERS = ['inbox', 'notes', 'research', 'outputs'] as const

/**
 * The CONTEXT.md charter — the interpretable part of the ICM. Written in
 * French (the pilot's language), under 80 lines, addressed to the agent
 * that will read it on every turn.
 */
export function scaffoldContext(name: string): string {
  return `# ${name} — workspace ICM agentique

## Mission

(Décris ici l'objectif de ce workspace — c'est la première chose que
l'agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — lire ce fichier, explorer l'arbre (ls, glob, read).
2. **Planifier** — écrire le plan dans \`notes/plan.md\`.
3. **Agir** — outils : read, write, ls, glob, mkdir, shell, websearch.
4. **Livrer** — les livrables finaux dans \`outputs/\`, jamais ailleurs.

## Arborescence

| Dossier | Rôle |
|---|---|
| \`inbox/\` | entrées déposées par le pilote |
| \`notes/\` | plans, brouillons, raisonnement de l'agent |
| \`research/\` | lectures web nettoyées (websearch) |
| \`outputs/\` | livrables finaux |

L'arbre est **libre** : crée les dossiers dont tu as besoin (mkdir).
Un sous-dossier qui acquiert un rôle mérite son propre \`CONTEXT.md\`.

## Outils

- \`read {"path"}\`, \`ls {"path"}\`, \`glob {"pattern"}\` — explorer.
- \`mkdir {"path"}\` — créer un dossier (libre).
- \`write {"path","content"}\` — écrire un fichier (approbation du pilote).
- \`shell {"command"}\` — commande bash, cwd = racine (approbation).
- \`websearch {"query"}\` — recherche ; \`websearch {"url"}\` — page nettoyée.

Tout chemin reste dans le workspace. Les refus « hors périmètre » sont
définitifs : ne réessaie pas le même chemin.

## Règles

- Écris d'abord, cite ensuite : chaque affirmation vient d'un fichier lu
  ou d'une recherche — dis lequel.
- Une écriture ou une commande proposée attend l'approbation du pilote :
  propose-les, c'est le flux normal.
- Les livrables sont des fichiers Markdown nommés clairement
  (\`outputs/rapport.md\`, pas \`outputs/final_v2_CORRECT.md\`).
`
}

/**
 * Creates a fresh agentic workspace: refuses an existing folder (the
 * scaffold never overwrites), writes the charter and the four folders
 * (each with a .gitkeep so the empty tree renders).
 */
export async function scaffoldAgenticWorkspace(root: string): Promise<void> {
  const name = workspaceName(root)
  if (root.trim() === '' || root === '/' || root === '.') {
    throw new Error('nom de workspace invalide')
  }
  if (existsSync(root)) {
    throw new Error(`le workspace « ${name} » existe déjà`)
  }
  try {
    await mkdir(root, { recursive: true }) // parents allowed, root fresh
    await writeFile(join(root, 'CONTEXT.md'), scaffoldContext(name), 'utf8')
    for (const folder of SCAFFOLD_FOLDERS) {
      await mkdir(join(root, folder), { recursive: true })
      await writeFile(join(root, folder, '.gitkeep'), '', 'utf8')
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('le workspace')) throw err
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`droits insuffisants pour créer « ${root} »`)
    }
    throw err
  }
}
