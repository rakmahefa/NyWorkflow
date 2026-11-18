# websearch — recherche web (query) ou lecture de page nettoyée (url)

> Fiche de référence — arguments exacts, lancements corrects, erreurs
> courantes. Le contrat général (trois temps, parallèle, format de
> réponse) vit dans `tools/CONTEXT.md`.

## Arguments

| Argument | Requis | Description |
|---|---|---|
| `query` | non | Requête de recherche — retourne titres, URLs et snippets. Donne query OU url. |
| `url` | non | URL http(s) à lire — retourne la page NETTOYÉE (scripts, styles et navigation partis, le contenu reste). |
| `title` | non | Titre court pour le pilote — ex. « Chercher les références » |

## Lancement correct

```
websearch {"query": "Model Context Protocol best practices", "title": "Chercher MCP"}
```

```
websearch {"url": "https://example.com/doc", "title": "Lire la doc"}
```

## Parallèle & arrière-plan

Totalement parallélisable : une recherche ET la lecture de deux pages déjà connues = trois appels dans la même réponse. Chercher PUIS lire un résultat de la recherche = deux protocoles (le second dépend du premier).

## Erreurs courantes

- Donne query OU url, jamais les deux — la query prime, l’url serait ignorée.
- Consigne l’utile dans `.workspace/research/` (une fiche par sujet) et la source dans `research/sources.md` : une affirmation citée renvoie à une ligne du registre.
- Une page qui échoue : réessaie via query (le site bloque peut-être les lectures directes), puis consigne la leçon dans `memory/lessons.md`.

## À voir aussi

`write` (consigner la lecture), `shell` (outils en ligne de commande si besoin).
