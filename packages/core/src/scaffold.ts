/**
 * Scaffold v5 (M19) — the COMPLETE agentic ICM tree, living in the HIDDEN
 * `.workspace/` folder inside the session's folder (the project).
 *
 * The layout follows the modern agent-config pattern (`.git`, `.claude`,
 * `.continue`): the user's project stays pristine at the root — the
 * agent's whole ICM lives hidden inside `.workspace/`:
 *
 *   <dossier de la session>/
 *   ├── .workspace/          ← l'ICM complet (caché)
 *   │   ├── CONTEXT.md       la charte — mission, méthode, règles
 *   │   ├── harness/         la doc du harness : charte chargée + moteur
 *   │   ├── tools/           le protocole cinq phases + une fiche par outil
 *   │   ├── skills/          l'arsenal : évaluation + registre (M19)
 *   │   ├── inbox/           entrées du pilote
 *   │   ├── notes/           plan, tâches, journal, décisions
 *   │   ├── research/        lectures web + registre des sources
 *   │   ├── memory/          MemGPT split : core (faits) / lessons
 *   │   ├── outputs/         livrables finaux
 *   │   └── archive/         travail terminé
 *   └── .logs/               logs de profilage par session (M14, + model.jsonl M16)
 *
 * Shaped by the field's current best practice (M13, unchanged): one
 * CONTEXT.md per folder (Model Workspace Protocol — the structure IS the
 * orchestration), the plan/tasks/journal/decisions quartet (structured
 * scratchpad), the MemGPT memory split, a source ledger so every claim
 * traces back to a read.
 *
 * M16 — the base ICM teaches the harness itself (pilot-driven): the
 * `harness/` folder documents WHAT runs the agent (charter loaded each
 * turn + the engine in depth), the `tools/` folder documents HOW to act
 * (the three-step tool protocol, loaded each turn, plus ONE rigorous
 * fiche per tool — exact arguments, correct launch patterns, common
 * errors — read on demand, keeping the prompt bounded).
 *
 * M19 — the base ICM teaches the ARSENAL (pilot-driven): the `skills/`
 * folder carries the capability-evaluation protocol and the skill
 * REGISTRY, both loaded each turn — the agent evaluates whether a task
 * needs skills or specific tooling it lacks, then BUILDS them from its
 * base tools (research → `skills/<nom>/SKILL.md` + helper scripts →
 * registry), uses them, and improves both the skills and the ICM itself.
 * A skill folder is read ON DEMAND (SKILL.md, never a CONTEXT.md — the
 * prompt stays bounded; only the registry is always loaded).
 *
 * Everything is plain Markdown, ready to use. The tree stays FREE — the
 * agent grows it with mkdir; the loader caps at 12 CONTEXT.md files, and
 * this scaffold spends exactly 10, leaving two for the agent.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workspaceName } from './icm.ts'

/** The hidden folder, at the session folder's root, holding the whole ICM. */
export const ICM_DIR = '.workspace'

/** The nine role folders of a working session — free tree, sane defaults. */
export const SCAFFOLD_FOLDERS = ['harness', 'tools', 'skills', 'inbox', 'notes', 'research', 'memory', 'outputs', 'archive'] as const

/** The ten agent tools, in catalog order (one fiche each under tools/). */
export const TOOL_NAMES = ['read', 'write', 'ls', 'glob', 'mkdir', 'shell', 'websearch', 'shell_output', 'shell_kill', 'no_tool'] as const

/** Every file the scaffold writes, relative to the `.workspace/` root. */
export const SCAFFOLD_FILES = [
  'CONTEXT.md',
  'harness/CONTEXT.md',
  'harness/ENGINE.md',
  'tools/CONTEXT.md',
  ...TOOL_NAMES.map((t) => `tools/${t}.md`),
  'skills/CONTEXT.md',
  'skills/_MODELE.md',
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
 * French (the pilot's language), addressed to the agent that reads it on
 * every turn: mission, method, the tree map, the tools, the rules.
 */
export function scaffoldContext(name: string): string {
  return `# ${name} — ICM du workspace

## Mission

(Décris ici l'objectif de ce workspace — c'est la première chose que
l'agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — les CONTEXT.md sont DÉJÀ chargés dans ton prompt ;
   explore le reste de l'arbre (ls, glob, read) selon le besoin.
2. **Évaluer** — la tâche nécessite-t-elle une compétence ou un outillage
   spécifique ? Le registre des skills (chargé) dit ce qui existe ; ce
   qui manque se CONSTRUIT — le protocole d'évaluation vit dans
   \`.workspace/skills/CONTEXT.md\`.
3. **Planifier** — écrire le plan dans \`.workspace/notes/plan.md\`, les
   tâches dans \`.workspace/notes/tasks.md\`.
4. **Agir** — tes outils : read, write, ls, glob, mkdir, shell, websearch.
5. **Livrer** — les livrables finaux dans \`.workspace/outputs/\`.
6. **Retenir** — mettre à jour \`.workspace/memory/\` : ce qui est vrai
   reste, ce qui a été appris s'écrit — et l'arsenal aussi : une leçon
   qui revient devient une skill.

## Carte de l’arbre

| Chemin | Rôle |
|---|---|
| \`.workspace/CONTEXT.md\` | cette charte — mission, méthode, règles |
| \`.workspace/harness/\` | la doc du harness : charte chargée à chaque tour + le moteur en profondeur |
| \`.workspace/tools/\` | le protocole cinq phases (chargé) + une fiche rigoureuse par outil |
| \`.workspace/skills/\` | ton arsenal : le protocole d'évaluation + le registre des skills (chargés) ; une skill = un dossier lu à la demande |
| \`.workspace/inbox/\` | entrées déposées par le pilote (à lire, puis à vider) |
| \`.workspace/notes/plan.md\` | le plan vivant : objectif, étapes, statut |
| \`.workspace/notes/tasks.md\` | la file de tâches : à faire / en cours / fait |
| \`.workspace/notes/journal.md\` | le journal de travail, chronologique |
| \`.workspace/notes/decisions.md\` | les décisions prises, et pourquoi |
| \`.workspace/research/sources.md\` | le registre des sources lues |
| \`.workspace/research/*\` | les lectures web nettoyées (websearch) |
| \`.workspace/memory/core.md\` | mémoire vive : ce qui est toujours vrai ici |
| \`.workspace/memory/lessons.md\` | leçons apprises — à ne pas refaire |
| \`.workspace/outputs/\` | livrables finaux, prêts à être lus |
| \`.workspace/archive/\` | le travail terminé, sorti du chemin |
| (racine du dossier) | TON projet — les fichiers du pilote, à toi d'agir dessus |

L'arbre est **libre** : crée les dossiers dont tu as besoin (mkdir), dans
\`.workspace/\` pour ton organisation, à la racine pour les livrables du
pilote. Un sous-dossier qui acquiert un rôle mérite son propre
\`CONTEXT.md\` (au plus 12 sont chargés — ce scaffold en dépense 10 ;
une skill, elle, se lit à la demande : son dossier porte un SKILL.md,
jamais un CONTEXT.md).

## Outils

Neuf outils, un contrat — le **protocole cinq phases** : thinking titré
d'abord, listing du contrat, prose dans [MESSAGE], action (tool_calls
parallèles et titrés), puis ATTENTE du feedback du harness sur le groupe
entier des résultats. Le contrat et le catalogue vivent dans
\`.workspace/tools/CONTEXT.md\` (chargé à chaque tour) ; la fiche
rigoureuse de chaque outil (arguments exacts, lancements corrects,
erreurs courantes) est dans \`.workspace/tools/<outil>.md\` — lis-la avant
ta première utilisation. Ton harness lui-même est documenté dans
\`.workspace/harness/\`.

Résumé : \`read\`, \`write\`, \`ls\`, \`glob\`, \`mkdir\`, \`shell\`,
\`websearch\`, \`shell_output\`, \`shell_kill\` — les appels indépendants
se lancent ENSEMBLE dans une même réponse, puis on attend les résultats.
Si les outils sont désactivés (sécurité « aucun outil »), réponds à partir
de l'ICM et de la conversation, sans tool_call.

Tout chemin reste dans le dossier de la session. Les refus « hors
périmètre » sont définitifs : ne réessaie pas le même chemin.

## Règles

- **Écris d'abord, cite ensuite** : chaque affirmation vient d'un fichier
  lu ou d'une recherche — dis lequel (\`.workspace/research/sources.md\`).
- **Plan avant action** : une tâche non triviale commence par une entrée
  dans \`.workspace/notes/plan.md\` et \`.workspace/notes/tasks.md\`.
- **Décisions notées** : un choix qui engage (architecture, méthode,
  périmètre) va dans \`.workspace/notes/decisions.md\` — contexte, choix, raison.
- **Mémoire à jour** : un fait durable appris va dans
  \`.workspace/memory/core.md\` ; une erreur évitable va dans
  \`.workspace/memory/lessons.md\`.
- **Hygiène** : \`.workspace/inbox/\` se vide, \`.workspace/outputs/\` ne
  contient que du final, l'archivé va dans \`.workspace/archive/\`.
- **L'arsenal grandit** : une procédure refaite deux fois devient une
  skill inscrite au registre ; l'ICM elle-même s'améliore (chartes plus
  justes, mémoire plus dense) — chaque changement s'explique dans
  \`.workspace/notes/journal.md\`.
- Les livrables sont des fichiers Markdown nommés clairement
  (\`.workspace/outputs/rapport.md\`, pas \`final_v2_CORRECT.md\`).
`
}

/** One folder's CONTEXT.md — its explicit role contract. */
function folderContext(folder: string, role: string, rules: string[]): string {
  return [`# ${folder}/`, '', role, '', ...(rules.length > 0 ? ['## Règles', ...rules.map((r) => `- ${r}`), ''] : [])].join('\n')
}

/**
 * `harness/CONTEXT.md` — the harness charter, LOADED each turn: what
 * NyWorkflow is, the three pillars that carry every session, and what the
 * engine does FOR the agent. The depth (ENGINE.md) is read on demand.
 */
function harnessContext(): string {
  return `# harness/ — le harness NyWorkflow, ton moteur d’exécution

Tu ne t’exécutes pas seul : un **harness** te porte. Le connaître, c’est
travailler avec lui plutôt que contre lui — quel que soit le modèle qui
te pilote, ce contrat est le même.

## Les trois piliers d’une session

1. **Le modèle — toi.** Tu raisonnes (thought process titré), tu décides,
   tu agis (tool_calls). Tu ne vois le monde QUE par tes outils.
2. **Le harness (engine) — NyWorkflow.** Il exécute : il charge l’ICM dans
   ton prompt, dispatch tes tool_calls (en parallèle et en arrière-plan),
   te renvoie leurs résultats groupés, journalise tout, et applique la
   sécurité. C’est lui qui détient la vérité de ce qui s’est réellement
   passé.
3. **L’ICM — ton contexte interprétable.** L’arbre \`.workspace/\` : charte,
   plan, journal, mémoire. Chargée dans ton prompt à chaque tour, entretenue
   par tes écritures — c’est TOI qui la fais vivre.

## Ce que le engine fait pour toi, à chaque tour

- Il **recharge l’ICM** (l’arbre a pu grandir depuis le tour précédent).
- Il **exécute tes tool_calls en parallèle et en arrière-plan**, puis te
  renvoie le groupe ENTIER des résultats, dans un format défini — voir
  \`tools/CONTEXT.md\` (le protocole cinq phases).
- Il **journalise** chaque appel, chaque résultat, chaque décision — le
  journal est la vérité des échanges.
- Il **garde la sécurité** : selon le niveau de la session, tes écritures
  et tes shells attendent l’approbation du pilote (c’est le flux normal,
  propose-les quand même) ou sont acceptées d’avance.

## Ce que le harness attend de toi

- Le **protocole cinq phases** à chaque réponse (thinking titré → listing
  → message → action → feedback du harness) — le détail dans
  \`tools/CONTEXT.md\`.
- Des **tool_calls corrects** : lis la fiche d’un outil
  (\`tools/<outil>.md\`) avant ta première utilisation ou quand un appel
  échoue.
- **Jamais de contournement** : n’improvise pas un résultat, ne prétends
  pas avoir agi — le journal sait, le pilote lit.

## Pour aller plus loin

\`harness/ENGINE.md\` — la boucle de tour en profondeur (rounds, dispatch,
journal, logs, plafonds). \`harness/CONTEXT.md\` (ce fichier) suffit pour
travailler ; ENGINE.md explique le pourquoi.
`
}

/**
 * `harness/ENGINE.md` — the engine in depth: the turn loop, the rounds,
 * the dispatch, the journal, the logs, the caps. Read on demand by an
 * agent that wants the why behind the contract.
 */
function harnessEngine(): string {
  return `# ENGINE — le moteur NyWorkflow en profondeur

La boucle d’un tour, telle que le engine la vit. Utile pour comprendre
pourquoi le protocole cinq phases existe, et ce que deviennent tes appels.

## La boucle de tour (round par round)

1. **Message du pilote** — enregistré dans le journal.
2. **Rechargement de l’ICM** — l’arbre \`.workspace/\` est re-walké, les
   CONTEXT.md (max 12, 32 Kio chacun) rechargés dans ton prompt système.
   Conséquence : ce que tu écris dans l’ICM est VU au round suivant.
3. **Ton protocole cinq phases** — thinking titré, listing [TOOL_LISTING],
   prose [MESSAGE], action (tool_calls), puis STOP : tu attends le feedback.
4. **Dispatch du groupe** — le engine exécute TOUS les appels du groupe :
   les indépendants en parallèle (Promise.all), les shells longs en
   arrière-plan (jobId rendu immédiat). Sous sécurité « ask », les appels
   dangereux (write, shell) attendent le pilote UNE PAR UNE.
5. **Retour du groupe ENTIER** — chaque appel reçoit sa réponse, au format
   \`{"tool":…, "title":…, "ok":…, "result"|"error":…}\`. Le groupe complet
   te revient avant qu’un nouveau round démarre.
6. **Nouveau round** — retour à 1 (avec l’ICM rechargé et les résultats
   dans l’historique) : nouveau protocole, jusqu’à la réponse finale
   (une réponse sans tool_call termine le tour).

## Le journal — la vérité des échanges

Chaque événement (messages, tool_calls, résultats, décisions, sécurité)
est append-only dans le journal de la session. Le rechargement de l’UI le
rejoue à l’identique. Un appel non journalisé n’a pas existé ; un résultat
improvisé contredit le journal — le pilote le voit.

## La sécurité — trois niveaux

- **ask** (défaut) : write et shell attendent l’approbation du pilote.
  C’est le flux NORMAL : propose l’appel, la carte d’approbation s’affiche.
- **accept** : tout s’exécute sans demande (sessions de confiance).
- **no-tools** : aucun tool_call n’est exécuté — tous refusés avec la
  raison. Réponds alors à partir de l’ICM et de la conversation.

## Les logs de profilage — \`.logs/\`, interdits

\`<dossier>/.logs/<sessionId>/\` contient quatre journaux JSONL (engine,
session, activity, model — dont TES réponses, pour améliorer le harness).
Ils sont pour le PILOTE : ne les lis ni ne les modifie jamais. L’arbre de
l’ICM ne les montre même pas.

## Les plafonds — honnêtes et constants

- read : 32 Kio par fichier ; write : 128 Kio ; ls : 500 entrées ;
  glob : motif ≤ 256 caractères.
- shell avant-plan : 30 s max, sorties bornées ; arrière-plan : 10 min
  max, 16 jobs simultanés par workspace, sorties accumulées bornées.
- Les refus « hors périmètre » sont DÉFINITIFS : tout chemin reste dans le
  dossier de la session.
`
}

/**
 * `tools/CONTEXT.md` — the five-phase tool protocol, LOADED each turn.
 * This is the contract that makes the model's actions reliable whatever
 * the loader: every phase carries an EXACT header, think first, announce
 * the listing, prose in [MESSAGE], act in parallel, then WAIT for the
 * harness's feedback before the next round.
 */
function toolsContext(): string {
  return `# tools/ — le protocole d’utilisation des outils

Dix outils, un seul contrat. Le protocole cinq phases ci-dessous régit
CHAQUE réponse ; les fiches (\`read.md\`, \`write.md\`, …) documentent chaque
outil rigoureusement — lis une fiche avant ta première utilisation de
l’outil, ou quand un appel échoue.

## Le protocole cinq phases — à CHAQUE réponse

Chaque phase a son EN-TÊTE EXACT : une phase sans son en-tête est REJETÉE
(jamais affichée, jamais exécutée) et le feedback du harness te le dit.

1. **Thinking** — d’abord, toujours : tu dialogues avec toi-même dans ton
   thought process titré. Voir le protocole de réponse dans le prompt système.
2. **Listing** — ta première ligne visible annonce le contrat :
   \`[TOOL_LISTING] 3 tool_calls — [Titre A] [Titre B] [Titre C]\` (ou
   \`[TOOL_LISTING] no_tool\`).
3. **Message** — ta prose au pilote vit dans la section \`[MESSAGE]\` —
   toute prose hors de cette section est DROPPÉE.
4. **Action** — tu émets tes tool_calls : les appels **indépendants
   ENSEMBLE** dans la même réponse (le engine les exécute en parallèle),
   chacun avec son \`title\`, en nombre EXACTEMENT égal à ton listing. Puis
   tu **TERMINES ta réponse** — jamais de texte après les tool_calls,
   jamais de résultat annoncé avant de l’avoir reçu.
   Sans outil : \`[TOOL_LISTING] no_tool\`, la prose dans \`[MESSAGE]\`, puis
   l’appel unique \`no_tool\` dans la même réponse.
5. **Observation** — tu **ATTENDS**. Le engine exécute le groupe entier
   et te renvoie, à la fin du protocole, TOUTES les réponses du groupe,
   une par appel, dans ce format :

\`\`\`
{"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}
{"tool": "shell", "title": "Compiler le projet", "ok": false, "error": "…refusé par le pilote"}
\`\`\`

C’est en recevant ce feedback qu’un **NOUVEAU tour démarre** : le engine
— pas toi seul — décide de la suite. Un tour ne se termine QUE par la
signature \`no_tool\`.

## Le contrat d’appels — le listing [TOOL_LISTING]

La section \`[TOOL_LISTING]\` ENGAGE ta réponse :

\`\`\`
[TOOL_LISTING] 3 tool_calls — [Lire le plan] [Lister inbox] [Vérifier uv]
[TOOL_LISTING] no_tool
\`\`\`

- Le **nombre annoncé** doit être le **nombre d’appels émis** — le engine
  vérifie la correspondance et REFUSE le groupe non conforme (tu devras
  le réémettre complet) : ni appel oublié, ni appel surprise.
- Les **titres entre crochets** disent l’intention de chaque appel —
  l’ordre annoncé est l’ordre émis.
- \`no_tool\` s’émet **SEUL** : c’est la signature de la réponse finale
  sans outil, jamais mélangé à de vrais appels.
- Un bloc d’appel **mal formé** n’est jamais décodé ni exécuté — format
  exact : \`{{tool {"name": "…", "arguments": {…}} }}\`.

## Règles de lancement

- **Indépendants → ensemble** : trois fichiers à lire ? TROIS read dans
  la même réponse. C’est plus rapide et le engine est fait pour ça.
- **Dépendants → attendre** : un appel qui a besoin du résultat d’un autre
  (lire PUIS écrire, chercher PUIS lire l’URL trouvée) attend le protocole
  suivant.
- **Un groupe = une étape** : les tool_calls d’une même réponse forment un
  groupe cohérent, affiché groupé au pilote — un groupe par intention.
- **Titres partout** : le \`title\` (≤ 60 caractères) dit l’étape au pilote ;
  il te revient dans la réponse — exploite-le pour te repérer.
- **Erreur = signal** : un refus (arguments invalides, hors périmètre,
  refusé par le pilote) se corrige, ne se répète pas à l’identique.

## Catalogue

| Outil | Rôle | Libre ? | Fiche |
|---|---|---|---|
| read | lire un fichier (≤ 32 Kio) | oui | \`tools/read.md\` |
| write | écrire un fichier (≤ 128 Kio) | approbation | \`tools/write.md\` |
| ls | lister un dossier | oui | \`tools/ls.md\` |
| glob | chercher par motif | oui | \`tools/glob.md\` |
| mkdir | créer un dossier | oui | \`tools/mkdir.md\` |
| shell | commande bash (30 s / 10 min bg) | approbation | \`tools/shell.md\` |
| websearch | recherche ou page nettoyée | oui | \`tools/websearch.md\` |
| shell_output | suivre un job d’arrière-plan | oui | \`tools/shell_output.md\` |
| shell_kill | arrêter un job d’arrière-plan | oui | \`tools/shell_kill.md\` |
| no_tool | signer la réponse finale sans outil | oui | \`tools/no_tool.md\` |

« Libre » = sans approbation du pilote. Le niveau de sécurité de la
session (ask / accept / no-tools) prime — voir \`harness/ENGINE.md\`.
`
}

/**
 * `skills/CONTEXT.md` — the ARSENAL charter, LOADED each turn (M19): the
 * capability-evaluation protocol (does the task need a skill or specific
 * tooling? what exists? what must be BUILT from the base tools?), the
 * improvement loop (use → observe → refine; lessons that repeat become
 * skills), the right to improve the ICM itself, and the REGISTRY — the
 * one table the next turn reads to know what exists without opening a
 * single skill folder.
 */
function skillsContext(): string {
  return `# skills/ — ton arsenal : les compétences que tu construis

Tes neuf outils de base sont fixes — mais COMPLETS : avec read, write,
ls, glob, mkdir, shell et websearch, tu construis ce qui manque à la
tâche. Une **skill** est cette construction : un dossier
\`skills/<nom>/\` avec un \`SKILL.md\` (mission, déclencheurs, procédure,
commandes exactes, pièges) et, au besoin, des scripts ou gabarits — tes
outils spécialisés, faits par toi, réutilisables. Le gabarit d’une
skill vit dans \`skills/_MODELE.md\`.

## Le protocole d’évaluation — avant toute tâche non triviale

1. **De quoi la tâche a-t-elle besoin ?** — compétence métier, format de
   livrable, recherche, outillage spécifique.
2. **Une skill du registre la couvre-t-elle ?** — lis son \`SKILL.md\` et
   suis-la ; elle ne se réinvente pas.
3. **Manque ?** — CONSTRUIS la compétence avant d’improviser :
   - cherche ce qu’il faut savoir (websearch, read sur le projet) ;
   - crée \`skills/<nom>/SKILL.md\` sur le modèle de \`_MODELE.md\` ;
   - écris les scripts et gabarits utiles, teste-les (shell) ;
   - INSCRIS-la au registre ci-dessous, consigne les sources dans
     \`research/sources.md\` et la décision dans \`notes/decisions.md\`.
4. **Jamais deux fois** — la même procédure improvisée deux fois est une
   skill qui manque : écris-la.

## La boucle d’amélioration — après chaque usage

- **Ça a marché** — renforce la skill : précise l’étape qui a coincé, la
  commande exacte qui a passé.
- **Ça a échoué** — corrige la skill ET consigne la leçon dans
  \`memory/lessons.md\` : une leçon qui revient est une skill à écrire.
- **C’est obsolète** — la skill part en \`archive/\` et quitte le
  registre.

## L’ICM elle-même s’améliore

Les chartes (CONTEXT.md) sont des FICHIERS que tu écris : ce que tu
améliores dedans est chargé au tour suivant. Une règle fausse se
corrige, une information manquante s’ajoute (dense — tout ce qui est
chargé se relit à chaque tour), un rôle récurrent mérite son dossier
avec son CONTEXT.md. Note ce que tu changes dans \`notes/journal.md\` :
l’arsenal est vivant, pas figé.

## Registre des skills

> LA table à tenir à jour : une ligne par skill, tout ce que le tour
> suivant doit savoir sans ouvrir le dossier. Un dossier de skill ne
> porte PAS de CONTEXT.md (il serait chargé à chaque tour) — son
> SKILL.md se lit à la demande.

| Skill | Ce qu’elle fait | Statut |
|---|---|---|
| (aucune — la première que tu construis s’inscrit ici) | | |
`
}

/**
 * `skills/_MODELE.md` — the template of a SKILL.md, read on demand: copy,
 * fill, delete the banner. A skill relits in thirty seconds and runs
 * without hesitation — dense, exact, actionable.
 */
function skillsTemplate(): string {
  return `# _MODELE — le gabarit d’une skill

> Copie ce fichier dans \`skills/<nom>/SKILL.md\` et remplis chaque
> section. Une skill se relit en 30 secondes et s’exécute sans
> hésitation : dense, exacte, actionnable. Supprime ce bandeau une fois
> rempli, puis inscris la skill au registre de \`skills/CONTEXT.md\`.

# <nom> — <ce qu’elle fait en une ligne>

## Mission

(Le résultat que cette skill produit, et pour qui.)

## Quand l’utiliser (déclencheurs)

(Les signaux qui font choisir CETTE skill — types de tâches, mots du
pilote, formats attendus. Et quand NE PAS l’utiliser.)

## Prérequis

(Ce qui doit exister avant : fichiers, dossiers, outils, connaissances.)

## Procédure

1. (Étape exacte — commande ou outil précis, entrée, sortie attendue.)
2. …

## Commandes & outils exacts

\`\`\`\nc’est ici que vivent les commandes shell éprouvées, les motifs
\`\`\`

## Pièges connus

- (Ce qui a coincé, et la parade — alimenté par la boucle
  d’amélioration.)

## Provenance

- (Sources consultées — reportées dans \`research/sources.md\` ; date.)

## Historique

- v1 (date) — créée parce que …
- (v2 (date) — améliorée après … : ce qui a coincé.)
`
}

/** One tool's rigorous reference — what the fiches are made of. */
interface ToolDoc {
  name: string
  role: string
  args: [name: string, required: boolean, what: string][]
  patterns: string[]
  parallel: string
  errors: string[]
  related: string
}

/** Renders one tool's fiche — same structure for the nine, rigor inside. */
function toolFiche(doc: ToolDoc): string {
  return [
    `# ${doc.name} — ${doc.role}`,
    '',
    `> Fiche de référence — arguments exacts, lancements corrects, erreurs`,
    `> courantes. Le contrat général (cinq phases, parallèle, format de`,
    `> réponse) vit dans \`tools/CONTEXT.md\`.`,
    '',
    '## Arguments',
    '',
    '| Argument | Requis | Description |',
    '|---|---|---|',
    ...doc.args.map(([n, req, what]) => `| \`${n}\` | ${req ? 'oui' : 'non'} | ${what} |`),
    '',
    '## Lancement correct',
    '',
    ...doc.patterns.flatMap((p) => ['```', p, '```', '']),
    '## Parallèle & arrière-plan',
    '',
    doc.parallel,
    '',
    '## Erreurs courantes',
    '',
    ...doc.errors.map((e) => `- ${e}`),
    '',
    '## À voir aussi',
    '',
    doc.related,
    '',
  ].join('\n')
}

/** The nine fiches — one per tool, in catalog order. */
function toolFiches(): Record<string, string> {
  const docs: ToolDoc[] = [
    {
      name: 'read',
      role: 'lire un fichier texte du workspace',
      args: [
        ['path', true, 'Chemin relatif à la racine du dossier de session — ex. `notes/plan.md`, `.workspace/CONTEXT.md`'],
        ['title', false, 'Titre court (≤ 60 caractères) de l’appel pour le pilote — ex. « Lire le plan »'],
      ],
      patterns: [
        'read {"path": ".workspace/notes/plan.md", "title": "Lire le plan"}',
        'read {"path": "README.md", "title": "Lire le readme du projet"}',
      ],
      parallel:
        'Totalement parallélisable : N fichiers à lire = N read dans la MÊME réponse — le engine les exécute ensemble. Ne lis JAMAIS en série ce qui peut l’être en parallèle.',
      errors: [
        '`fichier introuvable` — vérifie le chemin avec ls ou glob avant de réessayer autrement.',
        '`hors périmètre` — le chemin sort du dossier de session : le refus est définitif, ne réessaie pas ce chemin.',
        '`c’est un dossier` — pour lister un dossier, c’est ls, pas read.',
        'Relire un CONTEXT.md déjà chargé dans ton prompt est du gaspillage — son contenu est déjà sous tes yeux.',
      ],
      related: '`ls` (listé avant de lire), `glob` (trouver par motif), `write` (l’inverse).',
    },
    {
      name: 'write',
      role: 'écrire un fichier texte dans le workspace',
      args: [
        ['path', true, 'Chemin relatif du fichier — les dossiers parents sont créés s’ils manquent'],
        ['content', true, 'Contenu COMPLET du fichier (≤ 128 Kio) — l’écriture remplace tout le fichier'],
        ['title', false, 'Titre court pour le pilote — ex. « Écrire le livrable »'],
      ],
      patterns: [
        'write {"path": ".workspace/notes/journal.md", "content": "# Journal\\n\\n- entrée du jour", "title": "Journaliser le tour"}',
        'write {"path": ".workspace/outputs/rapport.md", "content": "# Rapport\\n…", "title": "Écrire le livrable"}',
      ],
      parallel:
        'Parallélisable entre appels indépendants (deux fichiers distincts). Sous sécurité « ask », chaque write attend l’approbation du pilote — c’est le flux normal : propose-le quand même. Un write qui DÉPEND d’un read attend le protocole suivant.',
      errors: [
        'N’écris JAMAIS un contenu improvisé là où une lecture s’impose — lis d’abord (protocole suivant), puis écris.',
        'Le contenu remplace INTÉGRALEMENT le fichier : pour modifier, relis-le d’abord (read), puis réécris-le complet.',
        'Trop volumineux (> 128 Kio) : découpe le livrable en fichiers, ou passe par shell + here-doc.',
        'Un refus du pilote n’est pas un échec du tour : propose une alternative ou demande la consigne.',
      ],
      related: '`read` (relire avant de réécrire), `mkdir` (l’arbre), `shell` (écrire via bash si besoin).',
    },
    {
      name: 'ls',
      role: 'lister un dossier du workspace',
      args: [
        ['path', false, 'Dossier relatif — `.` (défaut) pour la racine du dossier de session'],
        ['title', false, 'Titre court pour le pilote — ex. « Lister la racine »'],
      ],
      patterns: [
        'ls {"path": ".", "title": "Lister la racine"}',
        'ls {"path": ".workspace/notes", "title": "Lister les notes"}',
      ],
      parallel:
        'Totalement parallélisable : plusieurs dossiers à explorer = plusieurs ls dans la même réponse, avec read et glob.',
      errors: [
        '`dossier introuvable` — le chemin n’existe pas (ou c’est un fichier) : vérifie avec ls du parent ou glob.',
        'L’ICM charge déjà l’arbre du workspace dans ton prompt : ne liste pas ce que l’arbre montre déjà — liste pour voir le DÉTAIL d’un dossier ou après tes propres créations.',
      ],
      related: '`glob` (chercher par motif sur tout l’arbre), `read` (lire une entrée), `mkdir` (créer).',
    },
    {
      name: 'glob',
      role: 'chercher des fichiers par motif',
      args: [
        ['pattern', true, 'Motif relatif : `*` = un segment, `**` = toute profondeur, `?` = un caractère — ex. `**/*.md`'],
        ['title', false, 'Titre court pour le pilote — ex. « Cartographier les notes »'],
      ],
      patterns: [
        'glob {"pattern": "**/*.md", "title": "Cartographier les markdown"}',
        'glob {"pattern": "outputs/*.md", "title": "Voir les livrables"}',
      ],
      parallel:
        'Totalement parallélisable — combine plusieurs motifs dans une même réponse si la question l’exige.',
      errors: [
        'Un motif trop large (`**`) retourne beaucoup : préfère `**/*.md` ou cible un dossier.',
        'Le motif est RELATIF à la racine du dossier de session ; les dossiers cachés (`.workspace` inclus) ne sont pas matchés par `*` — nomme-les explicitement.',
      ],
      related: '`ls` (un dossier précis), `read` (lire les trouvés).',
    },
    {
      name: 'mkdir',
      role: 'créer un dossier (récursif)',
      args: [
        ['path', true, 'Chemin relatif du dossier à créer — les parents sont créés'],
        ['title', false, 'Titre court pour le pilote — ex. « Préparer le dossier de veille »'],
      ],
      patterns: [
        'mkdir {"path": ".workspace/research/veille", "title": "Préparer la veille"}',
        'mkdir {"path": ".workspace/archive/2026-11", "title": "Ouvrir l’archive du mois"}',
      ],
      parallel:
        'Parallélisable (dossiers indépendants) ; un dossier déjà existant n’est PAS une erreur — l’appel réussit sans rien casser.',
      errors: [
        'Organise-toi DANS `.workspace/` (ton ICM) ; à la racine, seul un livrable pour le pilote justifie un dossier.',
        'Un sous-dossier qui acquiert un rôle mérite son CONTEXT.md (max 12 chargés).',
      ],
      related: '`write` (poser un fichier dedans), `ls` (vérifier).',
    },
    {
      name: 'shell',
      role: 'exécuter une commande bash (cwd = racine du dossier de session)',
      args: [
        ['command', true, 'La commande à exécuter (≤ 4 000 caractères) — ex. `"ls -la | head -20"`'],
        ['background', false, '`true` = détaché : un jobId est rendu immédiatement (10 min max, suivi via shell_output)'],
        ['title', false, 'Titre court pour le pilote — ex. « Compiler le projet »'],
      ],
      patterns: [
        'shell {"command": "ls -la | head -20", "title": "Inspecter la racine"}',
        'shell {"command": "wc -l notes/*.md", "title": "Compter les lignes des notes"}',
        'shell {"command": "npm test 2>&1 | tail -30", "background": true, "title": "Lancer les tests en arrière-plan"}',
      ],
      parallel:
        'Avant-plan : 30 s max, sorties bornées — parallélisable. Arrière-plan (`"background": true`) : le jobId revient immédiatement, suis-le avec shell_output — c’est LE mode pour build, veille, sleep. Max 16 jobs simultanés par workspace.',
      errors: [
        'Une commande longue SANS `background` est tuée à 30 s : mets `"background": true` dès que ça peut durer.',
        'Le cwd est la RACINE du dossier de session — pour toucher ton ICM, préfixe par `.workspace/`.',
        'Sous sécurité « ask », chaque shell attend le pilote — propose-le quand même, c’est le flux normal.',
        'Sortie tronquée (bornée en avant-plan) : restreins la commande (`| tail`, `| head`) pour voir l’essentiel.',
      ],
      related: '`shell_output` / `shell_kill` (suivre/arrêter un job), `write` (écrire des fichiers).',
    },
    {
      name: 'websearch',
      role: 'recherche web (query) ou lecture de page nettoyée (url)',
      args: [
        ['query', false, 'Requête de recherche — retourne titres, URLs et snippets. Donne query OU url.'],
        ['url', false, 'URL http(s) à lire — retourne la page NETTOYÉE (scripts, styles et navigation partis, le contenu reste).'],
        ['title', false, 'Titre court pour le pilote — ex. « Chercher les références »'],
      ],
      patterns: [
        'websearch {"query": "Model Context Protocol best practices", "title": "Chercher MCP"}',
        'websearch {"url": "https://example.com/doc", "title": "Lire la doc"}',
      ],
      parallel:
        'Totalement parallélisable : une recherche ET la lecture de deux pages déjà connues = trois appels dans la même réponse. Chercher PUIS lire un résultat de la recherche = deux protocoles (le second dépend du premier).',
      errors: [
        'Donne query OU url, jamais les deux — la query prime, l’url serait ignorée.',
        'Consigne l’utile dans `.workspace/research/` (une fiche par sujet) et la source dans `research/sources.md` : une affirmation citée renvoie à une ligne du registre.',
        'Une page qui échoue : réessaie via query (le site bloque peut-être les lectures directes), puis consigne la leçon dans `memory/lessons.md`.',
      ],
      related: '`write` (consigner la lecture), `shell` (outils en ligne de commande si besoin).',
    },
    {
      name: 'shell_output',
      role: 'suivre un processus d’arrière-plan lancé par shell {"background":true}',
      args: [
        ['jobId', true, 'Identifiant rendu par le shell en arrière-plan'],
        ['title', false, 'Titre court pour le pilote — ex. « Voir où en sont les tests »'],
      ],
      patterns: [
        'shell_output {"jobId": "job-…", "title": "Suivre les tests"}',
      ],
      parallel:
        'Libre et parallélisable : plusieurs jobs à suivre = plusieurs appels dans la même réponse. Sondage honnête : rappelle shell_output au protocole suivant tant que `running` — mais pas à chaque tour si rien ne change.',
      errors: [
        'Le retour porte l’état (`running` / terminé), le code de sortie, et stdout/stderr accumulés (bornés à 64 Kio — `truncated: true` si coupés).',
        'Un jobId inconnu (job expiré après 10 min ou achevé et évacué) : relance la commande plutôt que de boucler.',
      ],
      related: '`shell` (lancer), `shell_kill` (arrêter).',
    },
    {
      name: 'shell_kill',
      role: 'arrêter un processus d’arrière-plan lancé par l’agent',
      args: [
        ['jobId', true, 'Identifiant du job à arrêter'],
        ['title', false, 'Titre court pour le pilote — ex. « Arrêter la veille »'],
      ],
      patterns: [
        'shell_kill {"jobId": "job-…", "title": "Arrêter la veille"}',
      ],
      parallel:
        'Libre et parallélisable. Arrête un job qui ne sert plus — c’est ton propre processus, l’hygiène est à toi.',
      errors: [
        'Un jobId déjà fini ou inconnu n’est pas une erreur fatale — le retour le dit, passe à la suite.',
        'Tuer n’efface pas ce qui a déjà été produit (fichiers écrits, sortie accumulée) : vérifie avec shell_output avant de conclure.',
      ],
      related: '`shell` (lancer), `shell_output` (voir ce qu’il a produit avant de tuer).',
    },
    {
      name: 'no_tool',
      role: 'signer la réponse finale sans outil (M21 — le contrat d’appels)',
      args: [
        ['title', false, 'Titre court pour le pilote — ex. « Réponse finale sans outil »'],
        ['reason', false, 'Pourquoi aucun outil n’est nécessaire ce tour (une ligne, ≤ 200 caractères)'],
      ],
      patterns: [
        '[TOOL_LISTING] no_tool',
        '{{tool {"name": "no_tool", "arguments": {"title": "Réponse finale sans outil", "reason": "La réponse vient de l’ICM déjà chargé"}} }}',
      ],
      parallel:
        'JAMAIS parallélisable : no_tool s’émet SEUL, comme unique tool_call de sa réponse — il accompagne la prose finale ([MESSAGE]) et signe la fin du tour. Sa « prose AVANT l’appel » est l’exception assumée du protocole : no_tool n’a aucun résultat à attendre.',
      errors: [
        'Mélanger no_tool à de vrais appels rompt le contrat — le groupe entier est refusé, tu dois le réémettre.',
        'Émettre no_tool SANS la prose finale laisse le tour sans réponse : l’appel accompagne ta réponse, dans la même réponse.',
        'Annoncer `[TOOL_LISTING] 2 tool_calls` puis émettre no_tool (ou l’inverse) rompt le contrat — le listing et le groupe doivent coïncider.',
      ],
      related: '`tools/CONTEXT.md` (le contrat d’appels [TOOL_LISTING]), le protocole de réponse du prompt système.',
    },
  ]
  const out: Record<string, string> = {}
  for (const doc of docs) out[`tools/${doc.name}.md`] = toolFiche(doc)
  return out
}

/** The full scaffold as a path → content map (pure: tests assert the bytes). */
export function scaffoldFiles(name: string): Record<string, string> {
  const files: Record<string, string> = {
    'CONTEXT.md': scaffoldContext(name),
    // M16 — the base ICM teaches the harness itself.
    'harness/CONTEXT.md': harnessContext(),
    'harness/ENGINE.md': harnessEngine(),
    'tools/CONTEXT.md': toolsContext(),
    ...toolFiches(),
    // M19 — the base ICM teaches the arsenal: evaluate, build, improve.
    'skills/CONTEXT.md': skillsContext(),
    'skills/_MODELE.md': skillsTemplate(),
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

/** Writes the complete ICM tree inside `<root>/.workspace/` (parents allowed). */
async function writeIcmTree(root: string): Promise<void> {
  const name = workspaceName(root)
  const files = scaffoldFiles(name)
  for (const rel of Object.keys(files).sort()) {
    const content = files[rel]
    if (content === undefined) continue // unreachable — rel comes from the map
    const target = join(root, ICM_DIR, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/**
 * Ensures the session folder carries its ICM:
 *
 *  - `.workspace/` ABSENT → the COMPLETE tree is created ('created');
 *  - `.workspace/` PRESENT and complete → untouched ('present') — a second
 *    session on the same folder CONTINUES the living memory;
 *  - `.workspace/` present but MISSING base files (a workspace scaffolded
 *    before M16) → the missing files are ADDED, nothing existing is ever
 *    overwritten ('upgraded') — the agent's work survives, the base
 *    contract (harness/, tools/ documentation) catches up with it.
 */
export async function ensureIcmTree(root: string): Promise<'created' | 'present' | 'upgraded'> {
  const files = scaffoldFiles(workspaceName(root))
  if (!existsSync(join(root, ICM_DIR))) {
    try {
      await mkdir(join(root, ICM_DIR), { recursive: true })
      await writeIcmTree(root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`droits insuffisants pour créer « ${join(root, ICM_DIR)} »`)
      }
      throw err
    }
    return 'created'
  }
  // Present — add the MISSING base files only (M16 upgrade): the living
  // memory (anything the agent wrote or changed) is never touched.
  let added = 0
  for (const rel of Object.keys(files).sort()) {
    const target = join(root, ICM_DIR, rel)
    if (existsSync(target)) continue
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, files[rel] as string, 'utf8')
      added++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`droits insuffisants pour créer « ${target} »`)
      }
      throw err
    }
  }
  return added > 0 ? 'upgraded' : 'present'
}

/**
 * Creates a fresh workspace folder with the COMPLETE ICM tree inside its
 * hidden `.workspace/`: refuses an existing folder (the scaffold never
 * overwrites), writes the charter, the six role folders and every
 * ready-to-use template.
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
    await writeIcmTree(root)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('le workspace')) throw err
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`droits insuffisants pour créer « ${root} »`)
    }
    throw err
  }
}
