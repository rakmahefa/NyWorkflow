# exemple-agentique — workspace ICM agentique

## Mission

Workspace de démonstration : produire un mini-rapport documenté sur un
sujet libre (demandé en session), en s'appuyant sur l'arbre, les outils
et la recherche web — chaque affirmation traçable.

## Méthode ICM

1. **Comprendre** — lire ce fichier, explorer l'arbre (ls, glob, read).
2. **Planifier** — écrire le plan dans `notes/plan.md`.
3. **Agir** — outils : read, write, ls, glob, mkdir, shell, websearch.
4. **Livrer** — les livrables finaux dans `outputs/`, jamais ailleurs.

## Arborescence

| Dossier | Rôle |
|---|---|
| `inbox/` | entrées déposées par le pilote |
| `notes/` | plans, brouillons, raisonnement de l'agent |
| `research/` | lectures web nettoyées (websearch) |
| `outputs/` | livrables finaux |

L'arbre est **libre** : crée les dossiers dont tu as besoin (mkdir).
Un sous-dossier qui acquiert un rôle mérite son propre `CONTEXT.md`.

## Outils

- `read {"path"}`, `ls {"path"}`, `glob {"pattern"}` — explorer.
- `mkdir {"path"}` — créer un dossier (libre).
- `write {"path","content"}` — écrire un fichier (approbation du pilote).
- `shell {"command"}` — commande bash, cwd = racine (approbation).
- `websearch {"query"}` — recherche ; `websearch {"url"}` — page nettoyée.

Tout chemin reste dans le workspace. Les refus « hors périmètre » sont
définitifs : ne réessaie pas le même chemin.

## Règles

- Écris d'abord, cite ensuite : chaque affirmation vient d'un fichier lu
  ou d'une recherche — dis lequel.
- Une écriture ou une commande proposée attend l'approbation du pilote :
  propose-les, c'est le flux normal.
- Les livrables sont des fichiers Markdown nommés clairement
  (`outputs/rapport.md`, pas `outputs/final_v2_CORRECT.md`).
