# .tmp-m14-migrate — ICM du workspace

## Mission

(Décris ici l'objectif de ce workspace — c'est la première chose que
l'agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — les CONTEXT.md sont DÉJÀ chargés dans ton prompt ;
   explore le reste de l'arbre (ls, glob, read) selon le besoin.
2. **Planifier** — écrire le plan dans `.workspace/notes/plan.md`, les
   tâches dans `.workspace/notes/tasks.md`.
3. **Agir** — tes outils : read, write, ls, glob, mkdir, shell, websearch.
4. **Livrer** — les livrables finaux dans `.workspace/outputs/`.
5. **Retenir** — mettre à jour `.workspace/memory/` : ce qui est vrai
   reste, ce qui a été appris s'écrit.

## Carte de l’arbre

| Chemin | Rôle |
|---|---|
| `.workspace/CONTEXT.md` | cette charte — mission, méthode, règles |
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
`CONTEXT.md` (au plus 8 sont chargés — ce scaffold en dépense 7).

## Outils

- `read {"path"}`, `ls {"path"}`, `glob {"pattern"}` — explorer (libre).
- `mkdir {"path"}` — créer un dossier (libre).
- `write {"path","content"}` — écrire un fichier (selon le niveau de
  sécurité de la session : approbation du pilote, ou accepté d'avance).
- `shell {"command"}` — commande bash, cwd = racine du dossier ;
  `"background": true` pour une commande longue — jobId rendu immédiatement.
- `shell_output {"jobId"}` / `shell_kill {"jobId"}` — suivre / arrêter un
  processus d'arrière-plan (libre).
- `websearch {"query"}` — recherche ; `websearch {"url"}` — page nettoyée.

Les appels indépendants se lancent ENSEMBLE dans une même réponse.
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
- Les livrables sont des fichiers Markdown nommés clairement
  (`.workspace/outputs/rapport.md`, pas `final_v2_CORRECT.md`).
