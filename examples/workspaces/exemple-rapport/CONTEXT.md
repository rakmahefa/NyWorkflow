# Carte du workspace — exemple-rapport

Objectif : produire un rapport Markdown court à partir d'un sujet donné.

| Étape | Dossier | Rôle |
|---|---|---|
| 1 | `01-recherche/` | Collecter les faits sur le sujet |
| 2 | `02-redaction/` | Rédiger le rapport final |

Règles :

- Chaque étape lit son `CONTEXT.md` et écrit uniquement dans son `output/`.
- La sortie de l'étape 1 est l'entrée de l'étape 2.
- Un humain peut éditer n'importe quel fichier entre deux étapes : l'étape suivante lit la version éditée.
- Max 80 lignes par `CONTEXT.md`.
