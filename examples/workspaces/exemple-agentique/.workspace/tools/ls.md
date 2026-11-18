# ls — lister un dossier du workspace

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `path` | non | Dossier relatif — `.` (défaut) pour la racine du dossier de session |
| `title` | non | Titre court pour le pilote — ex. « Lister la racine » |

## Lancement correct

```
ls {"path": ".", "title": "Lister la racine"}
```

```
ls {"path": ".workspace/notes", "title": "Lister les notes"}
```

## Parallèle & arrière-plan

Totalement parallélisable : plusieurs dossiers à explorer = plusieurs ls dans la même réponse, avec read et glob.

## Erreurs courantes

- `dossier introuvable` — le chemin n’existe pas (ou c’est un fichier) : vérifie avec ls du parent ou glob.
- L’ICM charge déjà l’arbre du workspace dans ton prompt : ne liste pas ce que l’arbre montre déjà — liste pour voir le DÉTAIL d’un dossier ou après tes propres créations.

## À voir aussi

`glob` (chercher par motif sur tout l’arbre), `read` (lire une entrée), `mkdir` (créer).
