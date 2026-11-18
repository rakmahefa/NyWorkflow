# shell_output — suivre un processus d’arrière-plan lancé par shell {"background":true}

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `jobId` | oui | Identifiant rendu par le shell en arrière-plan |
| `title` | non | Titre court pour le pilote — ex. « Voir où en sont les tests » |

## Lancement correct

```
shell_output {"jobId": "job-…", "title": "Suivre les tests"}
```

## Parallèle & arrière-plan

Libre et parallélisable : plusieurs jobs à suivre = plusieurs appels dans la même réponse. Sondage honnête : rappelle shell_output au protocole suivant tant que `running` — mais pas à chaque tour si rien ne change.

## Erreurs courantes

- Le retour porte l’état (`running` / terminé), le code de sortie, et stdout/stderr accumulés (bornés à 64 Kio — `truncated: true` si coupés).
- Un jobId inconnu (job expiré après 10 min ou achevé et évacué) : relance la commande plutôt que de boucler.

## À voir aussi

`shell` (lancer), `shell_kill` (arrêter).
