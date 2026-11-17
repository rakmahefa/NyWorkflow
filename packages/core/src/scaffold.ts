/**
 * Scaffold v2 (M13) — the COMPLETE agentic ICM tree every new workspace is
 * born with. Shaped by the field’s current best practice:
 *
 *   - one CONTEXT.md per folder, the folder’s explicit role contract
 *     (Model Workspace Protocol: the structure IS the orchestration);
 *   - a plan/tasks/journal/decisions quartet in notes/ — plan first,
 *     tasks tracked, work journaled, decisions recorded ADR-lite
 *     (the "structured scratchpad" pattern);
 *   - a memory/ folder with the MemGPT split: core (facts always true)
 *     and lessons (what not to repeat) — durable across turns;
 *   - research/ with a source ledger (query, URL, date, key fact) so
 *     every claim traces back to a read;
 *   - inbox/ (pilot’s inputs), outputs/ (final deliverables only),
 *     archive/ (finished work out of the way).
 *
 * Everything is plain Markdown, ready to use: the templates carry their
 * own instructions and example lines. The tree stays FREE — the agent
 * grows it with mkdir; the loader caps at 8 CONTEXT.md files, and this
 * scaffold spends exactly 7, leaving one for the agent.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workspaceName } from './icm.ts'

/** The six role folders of a working session — free tree, sane defaults. */
export const SCAFFOLD_FOLDERS = ['inbox', 'notes', 'research', 'memory', 'outputs', 'archive'] as const

/** Every file the scaffold writes, relative to the workspace root. */
export const SCAFFOLD_FILES = [
  'CONTEXT.md',
  'inbox/CONTEXT.md',
  'notes/CONTEXT.md',
  'notes/plan.md',
  'notes/tasks.md',
  'notes/journal.md',
  'notes/decisions.md',
  'research/CONTEXT.md',
  'research/sources.md',
  'memory/CONTEXT.md',
  'memory/core.md',
  'memory/lessons.md',
  'outputs/CONTEXT.md',
  'archive/CONTEXT.md',
] as const

/**
 * The CONTEXT.md charter — the interpretable part of the ICM. Written in
 * French (the pilot’s language), addressed to the agent that reads it on
 * every turn: mission, method, the tree map, the tools, the rules.
 */
export function scaffoldContext(name: string): string {
  return `# ${name} — workspace ICM agentique

## Mission

(Décris ici l’objectif de ce workspace — c’est la première chose que
l’agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — lire les CONTEXT.md, explorer l’arbre (ls, glob, read).
2. **Planifier** — écrire le plan dans \`notes/plan.md\`, les tâches dans \`notes/tasks.md\`.
3. **Agir** — outils : read, write, ls, glob, mkdir, shell, websearch.
4. **Livrer** — les livrables finaux dans \`outputs/\`, jamais ailleurs.
5. **Retenir** — mettre à jour \`memory/\` : ce qui est vrai reste, ce qui
   a été appris s’écrit.

## Carte de l’arbre

| Chemin | Rôle |
|---|---|
| \`CONTEXT.md\` | cette charte — mission, méthode, règles |
| \`inbox/\` | entrées déposées par le pilote (à lire, puis à vider) |
| \`notes/plan.md\` | le plan vivant : objectif, étapes, statut |
| \`notes/tasks.md\` | la file de tâches : à faire / en cours / fait |
| \`notes/journal.md\` | le journal de travail, chronologique |
| \`notes/decisions.md\` | les décisions prises, et pourquoi |
| \`research/sources.md\` | le registre des sources lues |
| \`research/*\` | les lectures web nettoyées (websearch) |
| \`memory/core.md\` | mémoire vive : ce qui est toujours vrai ici |
| \`memory/lessons.md\` | leçons apprises — à ne pas refaire |
| \`outputs/\` | livrables finaux, prêts à être lus |
| \`archive/\` | le travail terminé, sorti du chemin |

L’arbre est **libre** : crée les dossiers dont tu as besoin (mkdir).
Un sous-dossier qui acquiert un rôle mérite son propre \`CONTEXT.md\`
(au plus 8 sont chargés — ce scaffold en dépense 7).

## Outils

- \`read {"path"}\`, \`ls {"path"}\`, \`glob {"pattern"}\` — explorer (libre).
- \`mkdir {"path"}\` — créer un dossier (libre).
- \`write {"path","content"}\` — écrire un fichier (selon le niveau de
  sécurité de la session : approbation du pilote, ou accepté d’avance).
- \`shell {"command"}\` — commande bash, cwd = racine ; \`"background": true\`
  pour une commande longue — jobId rendu immédiat.
- \`shell_output {"jobId"}\` / \`shell_kill {"jobId"}\` — suivre / arrêter un
  processus d’arrière-plan (libre).
- \`websearch {"query"}\` — recherche ; \`websearch {"url"}\` — page nettoyée.

Les appels indépendants se lancent ENSEMBLE dans une même réponse.
Si les outils sont désactivés (sécurité « aucun outil »), réponds à partir
de l’ICM et de la conversation, sans tool_call.

Tout chemin reste dans le workspace. Les refus « hors périmètre » sont
définitifs : ne réessaie pas le même chemin.

## Règles

- **Écris d’abord, cite ensuite** : chaque affirmation vient d’un fichier
  lu ou d’une recherche — dis lequel (\`research/sources.md\`).
- **Plan avant action** : une tâche non triviale commence par une entrée
  dans \`notes/plan.md\` et \`notes/tasks.md\`.
- **Décisions notées** : un choix qui engage (architecture, méthode,
  périmètre) va dans \`notes/decisions.md\` — contexte, choix, raison.
- **Mémoire à jour** : un fait durable appris va dans \`memory/core.md\` ;
  une erreur évitable va dans \`memory/lessons.md\`.
- **Hygiène** : \`inbox/\` se vide, \`outputs/\` ne contient que du final,
  l’archivé va dans \`archive/\`.
- Les livrables sont des fichiers Markdown nommés clairement
  (\`outputs/rapport.md\`, pas \`outputs/final_v2_CORRECT.md\`).
`
}

/** One folder’s CONTEXT.md — its explicit role contract. */
function folderContext(folder: string, role: string, rules: string[]): string {
  return [`# ${folder}/`, '', role, '', ...(rules.length > 0 ? ['## Règles', ...rules.map((r) => `- ${r}`), ''] : [])].join('\n')
}

/** The full scaffold as a path → content map (pure: tests assert the bytes). */
export function scaffoldFiles(name: string): Record<string, string> {
  const files: Record<string, string> = {
    'CONTEXT.md': scaffoldContext(name),
    'inbox/CONTEXT.md': folderContext(
      'inbox',
      'Les entrées du pilote : fichiers, briefs, consignes déposés ici AVANT le travail. Le workspace commence souvent par vider cette boîte.',
      ['Tout ce qui entre est lu, puis traité (déplacé, résumé dans notes/, ou archivé).', 'inbox/ ne devient jamais un dépôt permanent — il se vide.'],
    ),
    'notes/CONTEXT.md': folderContext(
      'notes',
      'Le travail vivant de la session : plan, tâches, journal, décisions. Rien d’ici n’est un livrable — c’est l’atelier.',
      ['plan.md est le plan VIVANT : mis à jour à chaque étape franchie, pas réécrit de zéro.', 'tasks.md suit l’avancement (à faire / en cours / fait).', 'journal.md reçoit une ligne par bloc de travail, la plus récente en dernier.', 'decisions.md : une décision par entrée — contexte, choix, raison.'],
    ),
    'notes/plan.md': [
      '# Plan de travail',
      '',
      '> Le plan vivant — mis à jour au fil de l’avancement, jamais réécrit de zéro.',
      '',
      '## Objectif',
      '',
      '(Un paragraphe : ce que ce workspace doit produire, et pour qui.)',
      '',
      '## Étapes',
      '',
      '| # | Étape | Statut | Notes |',
      '|---|---|---|---|',
      '| 1 | (ex. Lire les entrées de inbox/) | à faire | |',
      '| 2 | (ex. Rechercher le contexte — research/) | à faire | |',
      '| 3 | (ex. Rédiger le livrable — outputs/) | à faire | |',
      '',
    ].join('\n'),
    'notes/tasks.md': [
      '# Tâches',
      '',
      '> La file de travail — une ligne par tâche, barrée quand elle est faite.',
      '',
      '- [ ] (ex. Dépouiller inbox/ — déplacer/résumer chaque entrée)',
      '- [ ] (ex. Ouvrir research/sources.md et consigner la première lecture)',
      '- [x] (exemple de tâche terminée — garde cette ligne comme modèle, supprime-la)',
      '',
    ].join('\n'),
    'notes/journal.md': [
      '# Journal de travail',
      '',
      '> Chronologique, la plus récente entrée EN DERNIER. Une entrée par bloc de travail : ce qui a été fait, découvert, décidé.',
      '',
      '## 2026-…',
      '',
      '- … (workspace créé — le scaffold est en place, la mission attend dans CONTEXT.md)',
      '',
    ].join('\n'),
    'notes/decisions.md': [
      '# Décisions',
      '',
      '> Une décision par entrée, ADR léger : le contexte, le choix, la raison. On ne supprime pas une décision — on la remplace par une nouvelle.',
      '',
      '## D1 — (titre de la décision)',
      '',
      '- **Contexte** : …',
      '- **Choix** : …',
      '- **Raison** : …',
      '- **Date** : 2026-…',
      '',
    ].join('\n'),
    'research/CONTEXT.md': folderContext(
      'research',
      'Les lectures du web, nettoyées par websearch (scripts et navigation partis, le contenu reste). Un fichier par sujet, jamais un dump brut.',
      ['Chaque lecture consigne sa source dans sources.md (requête ou URL, date, fait clé).', 'Un fichier de research/ résume et cite — il ne recopie pas des pages entières.', 'Le contenu périmé part en archive/, il ne s’accumule pas.'],
    ),
    'research/sources.md': [
      '# Registre des sources',
      '',
      '> La traçabilité : chaque fait cité renvoie à une ligne d’ici.',
      '',
      '| Date | Requête / URL | Ce qu’on en retire |',
      '|---|---|---|',
      '| 2026-… | (ex. websearch « … ») | (le fait clé, en une ligne) |',
      '',
    ].join('\n'),
    'memory/CONTEXT.md': folderContext(
      'memory',
      'La mémoire durable de l’agent, au sens MemGPT : core = les faits toujours vrais (pinned), lessons = les leçons apprises. Chargée à chaque tour via ce CONTEXT.md — gardez-la dense.',
      ['core.md : ce qui est TOUJOURS vrai dans ce workspace (préférences du pilote, contraintes, vocabulaire). Pas d’historique ici.', 'lessons.md : ce qui a mal tourné et comment l’éviter — une leçon par ligne, actionnable.', 'La mémoire se met à jour pendant le travail, pas à la fin.'],
    ),
    'memory/core.md': [
      '# Mémoire vive',
      '',
      '> Les faits toujours vrais ici — lus à chaque tour. Dense, pas narratif.',
      '',
      '- (ex. Le pilote veut ses livrables en français, ton direct.)',
      '- (ex. Les montants sont en ariary, deux décimales.)',
      '- (ex. Le format de sortie attendu : Markdown, un fichier par livrable dans outputs/.)',
      '',
    ].join('\n'),
    'memory/lessons.md': [
      '# Leçons apprises',
      '',
      '> Ce qui a mal tourné, et comment l’éviter. Une leçon par ligne, actionnable.',
      '',
      '- (ex. Le site X bloque les requêtes sans User-Agent → passer par websearch query, pas url.)',
      '- (ex. Le pilote refuse les write hors outputs/ → proposer, jamais imposer.)',
      '',
    ].join('\n'),
    'outputs/CONTEXT.md': folderContext(
      'outputs',
      'Les livrables FINAUX uniquement — ce que le pilote vient chercher. Un fichier par livrable, nommé clairement, complet.',
      ['Rien ici n’est un brouillon : les brouillons vivent dans notes/.', 'Un livrable se relit avant de se déclarer fini (cohérence, sources, orthographe).', 'La version remplacée part en archive/, pas dans outputs/final_v2.md.'],
    ),
    'archive/CONTEXT.md': folderContext(
      'archive',
      'Le travail terminé ou remplacé, sorti du chemin mais jamais détruit — l’historique du workspace.',
      ['On archive un fichier, on ne le supprime pas.', 'Un sous-dossier par affaire archivée, daté : archive/2026-11-rapport-v1/.', 'L’archive ne se relit que si on remonte une décision — voir notes/decisions.md.'],
    ),
  }
  return files
}

/**
 * Creates a fresh agentic workspace with the COMPLETE ICM tree: refuses an
 * existing folder (the scaffold never overwrites), writes the charter, the
 * six role folders and every ready-to-use template.
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
    const files = scaffoldFiles(name)
    for (const rel of Object.keys(files).sort()) {
      const content = files[rel]
      if (content === undefined) continue // unreachable — rel comes from the map
      const target = join(root, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('le workspace')) throw err
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`droits insuffisants pour créer « ${root} »`)
    }
    throw err
  }
}
