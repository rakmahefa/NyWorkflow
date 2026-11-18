# read — lire un fichier texte du workspace

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `path` | oui | Chemin relatif à la racine du dossier de session — ex. `notes/plan.md`, `.workspace/CONTEXT.md` |
| `title` | non | Titre court (≤ 60 caractères) de l’appel pour le pilote — ex. « Lire le plan » |

## Lancement correct

```
read {"path": ".workspace/notes/plan.md", "title": "Lire le plan"}
```

```
read {"path": "README.md", "title": "Lire le readme du projet"}
```

## Parallèle & arrière-plan

Totalement parallélisable : N fichiers à lire = N read dans la MÊME réponse — le engine les exécute ensemble. Ne lis JAMAIS en série ce qui peut l’être en parallèle.

## Erreurs courantes

- `fichier introuvable` — vérifie le chemin avec ls ou glob avant de réessayer autrement.
- `hors périmètre` — le chemin sort du dossier de session : le refus est définitif, ne réessaie pas ce chemin.
- `c’est un dossier` — pour lister un dossier, c’est ls, pas read.
- Relire un CONTEXT.md déjà chargé dans ton prompt est du gaspillage — son contenu est déjà sous tes yeux.

## À voir aussi

`ls` (listé avant de lire), `glob` (trouver par motif), `write` (l’inverse).
