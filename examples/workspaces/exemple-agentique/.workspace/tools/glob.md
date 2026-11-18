# glob — chercher des fichiers par motif

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `pattern` | oui | Motif relatif : `*` = un segment, `**` = toute profondeur, `?` = un caractère — ex. `**/*.md` |
| `title` | non | Titre court pour le pilote — ex. « Cartographier les notes » |

## Lancement correct

```
glob {"pattern": "**/*.md", "title": "Cartographier les markdown"}
```

```
glob {"pattern": "outputs/*.md", "title": "Voir les livrables"}
```

## Parallèle & arrière-plan

Totalement parallélisable — combine plusieurs motifs dans une même réponse si la question l’exige.

## Erreurs courantes

- Un motif trop large (`**`) retourne beaucoup : préfère `**/*.md` ou cible un dossier.
- Le motif est RELATIF à la racine du dossier de session ; les dossiers cachés (`.workspace` inclus) ne sont pas matchés par `*` — nomme-les explicitement.

## À voir aussi

`ls` (un dossier précis), `read` (lire les trouvés).
