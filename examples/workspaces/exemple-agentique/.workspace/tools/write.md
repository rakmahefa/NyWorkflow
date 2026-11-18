# write — écrire un fichier texte dans le workspace

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `path` | oui | Chemin relatif du fichier — les dossiers parents sont créés s’ils manquent |
| `content` | oui | Contenu COMPLET du fichier (≤ 128 Kio) — l’écriture remplace tout le fichier |
| `title` | non | Titre court pour le pilote — ex. « Écrire le livrable » |

## Lancement correct

```
write {"path": ".workspace/notes/journal.md", "content": "# Journal\n\n- entrée du jour", "title": "Journaliser le tour"}
```

```
write {"path": ".workspace/outputs/rapport.md", "content": "# Rapport\n…", "title": "Écrire le livrable"}
```

## Parallèle & arrière-plan

Parallélisable entre appels indépendants (deux fichiers distincts). Sous sécurité « ask », chaque write attend l’approbation du pilote — c’est le flux normal : propose-le quand même. Un write qui DÉPEND d’un read attend le protocole suivant.

## Erreurs courantes

- N’écris JAMAIS un contenu improvisé là où une lecture s’impose — lis d’abord (protocole suivant), puis écris.
- Le contenu remplace INTÉGRALEMENT le fichier : pour modifier, relis-le d’abord (read), puis réécris-le complet.
- Trop volumineux (> 128 Kio) : découpe le livrable en fichiers, ou passe par shell + here-doc.
- Un refus du pilote n’est pas un échec du tour : propose une alternative ou demande la consigne.

## À voir aussi

`read` (relire avant de réécrire), `mkdir` (l’arbre), `shell` (écrire via bash si besoin).
