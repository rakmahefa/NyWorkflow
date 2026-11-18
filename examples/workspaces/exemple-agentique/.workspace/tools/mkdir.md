# mkdir — créer un dossier (récursif)

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `path` | oui | Chemin relatif du dossier à créer — les parents sont créés |
| `title` | non | Titre court pour le pilote — ex. « Préparer le dossier de veille » |

## Lancement correct

```
mkdir {"path": ".workspace/research/veille", "title": "Préparer la veille"}
```

```
mkdir {"path": ".workspace/archive/2026-11", "title": "Ouvrir l’archive du mois"}
```

## Parallèle & arrière-plan

Parallélisable (dossiers indépendants) ; un dossier déjà existant n’est PAS une erreur — l’appel réussit sans rien casser.

## Erreurs courantes

- Organise-toi DANS `.workspace/` (ton ICM) ; à la racine, seul un livrable pour le pilote justifie un dossier.
- Un sous-dossier qui acquiert un rôle mérite son CONTEXT.md (max 12 chargés).

## À voir aussi

`write` (poser un fichier dedans), `ls` (vérifier).
