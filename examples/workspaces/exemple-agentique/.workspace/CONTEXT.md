# exemple-agentique — ICM du workspace

## Mission

(Décris ici l'objectif de ce workspace — c'est la première chose que
l'agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — les CONTEXT.md sont DÉJÀ chargés dans ton prompt ;
   explore le reste de l'arbre (ls, glob, read) selon le besoin.
2. **Évaluer** — la tâche nécessite-t-elle une compétence ou un outillage
   spécifique ? Le registre des skills (chargé) dit ce qui existe ; ce
   qui manque se CONSTRUIT — le protocole d'évaluation vit dans
   `.workspace/skills/CONTEXT.md`.
3. **Planifier** — écrire le plan dans `.workspace/notes/plan.md`, les
   tâches dans `.workspace/notes/tasks.md`.
4. **Agir** — tes outils : read, write, ls, glob, mkdir, shell, websearch.
5. **Livrer** — les livrables finaux dans `.workspace/outputs/`.
6. **Retenir** — mettre à jour `.workspace/memory/` : ce qui est vrai
   reste, ce qui a été appris s'écrit — et l'arsenal aussi : une leçon
   qui revient devient une skill.

## Carte de l’arbre

| Chemin | Rôle |
|---|---|
| `.workspace/CONTEXT.md` | cette charte — mission, méthode, règles |
| `.workspace/harness/` | la doc du harness : charte chargée à chaque tour + le moteur en profondeur |
| `.workspace/tools/` | le protocole trois temps (chargé) + une fiche rigoureuse par outil |
| `.workspace/skills/` | ton arsenal : le protocole d'évaluation + le registre des skills (chargés) ; une skill = un dossier lu à la demande |
| `.workspace/inbox/` | entrées déposées par le pilote (à lire, puis à vider) |
| `.workspace/notes/plan.md` | le plan vivant : objectif, étapes, statut |
| `.workspace/notes/tasks.md` | la file de tâches : à faire / en cours / fait |
| `.workspace/notes/journal.md` | le journal de travail, chronologique |
| `.workspace/notes/decisions.md` | les décisions prises, et pourquoi |
| `.workspace/research/sources.md` | le registre des sources lues |
| `.workspace/research/*` | les lectures web nettoyées (websearch) |
| `.workspace/memory/core.md` | mémoire vive : ce qui est toujours vrai ici |
| `.workspace/memory/lessons.md` | leçons apprises — à ne pas refaire |
| `.workspace/outputs/` | livrables finaux, prêts à être lus |
| `.workspace/archive/` | le travail terminé, sorti du chemin |
| (racine du dossier) | TON projet — les fichiers du pilote, à toi d'agir dessus |

L'arbre est **libre** : crée les dossiers dont tu as besoin (mkdir), dans
`.workspace/` pour ton organisation, à la racine pour les livrables du
pilote. Un sous-dossier qui acquiert un rôle mérite son propre
`CONTEXT.md` (au plus 12 sont chargés — ce scaffold en dépense 10 ;
une skill, elle, se lit à la demande : son dossier porte un SKILL.md,
jamais un CONTEXT.md).

## Outils

Neuf outils, un contrat — le **protocole trois temps** : thinking titré
d'abord, action (tool_calls parallèles et titrés), puis ATTENTE du groupe
entier des résultats. Le contrat et le catalogue vivent dans
`.workspace/tools/CONTEXT.md` (chargé à chaque tour) ; la fiche
rigoureuse de chaque outil (arguments exacts, lancements corrects,
erreurs courantes) est dans `.workspace/tools/<outil>.md` — lis-la avant
ta première utilisation. Ton harness lui-même est documenté dans
`.workspace/harness/`.

Résumé : `read`, `write`, `ls`, `glob`, `mkdir`, `shell`,
`websearch`, `shell_output`, `shell_kill` — les appels indépendants
se lancent ENSEMBLE dans une même réponse, puis on attend les résultats.
Si les outils sont désactivés (sécurité « aucun outil »), réponds à partir
de l'ICM et de la conversation, sans tool_call.

Tout chemin reste dans le dossier de la session. Les refus « hors
périmètre » sont définitifs : ne réessaie pas le même chemin.

## Règles

- **Écris d'abord, cite ensuite** : chaque affirmation vient d'un fichier
  lu ou d'une recherche — dis lequel (`.workspace/research/sources.md`).
- **Plan avant action** : une tâche non triviale commence par une entrée
  dans `.workspace/notes/plan.md` et `.workspace/notes/tasks.md`.
- **Décisions notées** : un choix qui engage (architecture, méthode,
  périmètre) va dans `.workspace/notes/decisions.md` — contexte, choix, raison.
- **Mémoire à jour** : un fait durable appris va dans
  `.workspace/memory/core.md` ; une erreur évitable va dans
  `.workspace/memory/lessons.md`.
- **Hygiène** : `.workspace/inbox/` se vide, `.workspace/outputs/` ne
  contient que du final, l'archivé va dans `.workspace/archive/`.
- **L'arsenal grandit** : une procédure refaite deux fois devient une
  skill inscrite au registre ; l'ICM elle-même s'améliore (chartes plus
  justes, mémoire plus dense) — chaque changement s'explique dans
  `.workspace/notes/journal.md`.
- Les livrables sont des fichiers Markdown nommés clairement
  (`.workspace/outputs/rapport.md`, pas `final_v2_CORRECT.md`).
