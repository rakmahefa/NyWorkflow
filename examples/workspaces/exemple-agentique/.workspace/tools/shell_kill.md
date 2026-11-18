# shell_kill — arrêter un processus d’arrière-plan lancé par l’agent

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `jobId` | oui | Identifiant du job à arrêter |
| `title` | non | Titre court pour le pilote — ex. « Arrêter la veille » |

## Lancement correct

```
shell_kill {"jobId": "job-…", "title": "Arrêter la veille"}
```

## Parallèle & arrière-plan

Libre et parallélisable. Arrête un job qui ne sert plus — c’est ton propre processus, l’hygiène est à toi.

## Erreurs courantes

- Un jobId déjà fini ou inconnu n’est pas une erreur fatale — le retour le dit, passe à la suite.
- Tuer n’efface pas ce qui a déjà été produit (fichiers écrits, sortie accumulée) : vérifie avec shell_output avant de conclure.

## À voir aussi

`shell` (lancer), `shell_output` (voir ce qu’il a produit avant de tuer).
