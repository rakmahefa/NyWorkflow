# shell — exécuter une commande bash (cwd = racine du dossier de session)

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `command` | oui | La commande à exécuter (≤ 4 000 caractères) — ex. `"ls -la | head -20"` |
| `background` | non | `true` = détaché : un jobId est rendu immédiatement (10 min max, suivi via shell_output) |
| `title` | non | Titre court pour le pilote — ex. « Compiler le projet » |

## Lancement correct

```
shell {"command": "ls -la | head -20", "title": "Inspecter la racine"}
```

```
shell {"command": "wc -l notes/*.md", "title": "Compter les lignes des notes"}
```

```
shell {"command": "npm test 2>&1 | tail -30", "background": true, "title": "Lancer les tests en arrière-plan"}
```

## Parallèle & arrière-plan

Avant-plan : 30 s max, sorties bornées — parallélisable. Arrière-plan (`"background": true`) : le jobId revient immédiatement, suis-le avec shell_output — c’est LE mode pour build, veille, sleep. Max 16 jobs simultanés par workspace.

## Erreurs courantes

- Une commande longue SANS `background` est tuée à 30 s : mets `"background": true` dès que ça peut durer.
- Le cwd est la RACINE du dossier de session — pour toucher ton ICM, préfixe par `.workspace/`.
- Sous sécurité « ask », chaque shell attend le pilote — propose-le quand même, c’est le flux normal.
- Sortie tronquée (bornée en avant-plan) : restreins la commande (`| tail`, `| head`) pour voir l’essentiel.

## À voir aussi

`shell_output` / `shell_kill` (suivre/arrêter un job), `write` (écrire des fichiers).
