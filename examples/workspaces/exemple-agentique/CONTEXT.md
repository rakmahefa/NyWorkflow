# exemple-agentique — workspace ICM agentique

## Mission

(Décris ici l’objectif de ce workspace — c’est la première chose que
l’agent lit. Remplace ce paragraphe, puis supprime cette parenthèse.)

## Méthode ICM

1. **Comprendre** — lire les CONTEXT.md, explorer l’arbre (ls, glob, read).
2. **Planifier** — écrire le plan dans `notes/plan.md`, les tâches dans `notes/tasks.md`.
3. **Agir** — outils : read, write, ls, glob, mkdir, shell, websearch.
4. **Livrer** — les livrables finaux dans `outputs/`, jamais ailleurs.
5. **Retenir** — mettre à jour `memory/` : ce qui est vrai reste, ce qui
   a été appris s’écrit.

## Carte de l’arbre

| Chemin | Rôle |
|---|---|
| `CONTEXT.md` | cette charte — mission, méthode, règles |
| `inbox/` | entrées déposées par le pilote (à lire, puis à vider) |
| `notes/plan.md` | le plan vivant : objectif, étapes, statut |
| `notes/tasks.md` | la file de tâches : à faire / en cours / fait |
| `notes/journal.md` | le journal de travail, chronologique |
| `notes/decisions.md` | les décisions prises, et pourquoi |
| `research/sources.md` | le registre des sources lues |
| `research/*` | les lectures web nettoyées (websearch) |
| `memory/core.md` | mémoire vive : ce qui est toujours vrai ici |
| `memory/lessons.md` | leçons apprises — à ne pas refaire |
| `outputs/` | livrables finaux, prêts à être lus |
| `archive/` | le travail terminé, sorti du chemin |

L’arbre est **libre** : crée les dossiers dont tu as besoin (mkdir).
Un sous-dossier qui acquiert un rôle mérite son propre `CONTEXT.md`
(au plus 8 sont chargés — ce scaffold en dépense 7).

## Outils

- `read {"path"}`, `ls {"path"}`, `glob {"pattern"}` — explorer (libre).
- `mkdir {"path"}` — créer un dossier (libre).
- `write {"path","content"}` — écrire un fichier (selon le niveau de
  sécurité de la session : approbation du pilote, ou accepté d’avance).
- `shell {"command"}` — commande bash, cwd = racine ; `"background": true`
  pour une commande longue — jobId rendu immédiat.
- `shell_output {"jobId"}` / `shell_kill {"jobId"}` — suivre / arrêter un
  processus d’arrière-plan (libre).
- `websearch {"query"}` — recherche ; `websearch {"url"}` — page nettoyée.

Les appels indépendants se lancent ENSEMBLE dans une même réponse.
Si les outils sont désactivés (sécurité « aucun outil »), réponds à partir
de l’ICM et de la conversation, sans tool_call.

Tout chemin reste dans le workspace. Les refus « hors périmètre » sont
définitifs : ne réessaie pas le même chemin.

## Règles

- **Écris d’abord, cite ensuite** : chaque affirmation vient d’un fichier
  lu ou d’une recherche — dis lequel (`research/sources.md`).
- **Plan avant action** : une tâche non triviale commence par une entrée
  dans `notes/plan.md` et `notes/tasks.md`.
- **Décisions notées** : un choix qui engage (architecture, méthode,
  périmètre) va dans `notes/decisions.md` — contexte, choix, raison.
- **Mémoire à jour** : un fait durable appris va dans `memory/core.md` ;
  une erreur évitable va dans `memory/lessons.md`.
- **Hygiène** : `inbox/` se vide, `outputs/` ne contient que du final,
  l’archivé va dans `archive/`.
- Les livrables sont des fichiers Markdown nommés clairement
  (`outputs/rapport.md`, pas `outputs/final_v2_CORRECT.md`).
