# packages/tools — outils + permissions

Rôle : les mains de l'agent, et leur laisse. **Sept outils** (`read`, `write`, `ls`, `glob`, `mkdir`, `shell`, `websearch`) appelés par l'API `/workspaces/:name/tool` du serveur web, avec une seule permission qui compte : tout chemin reste dans la racine du workspace — garde lexicale (chemins absolus, `..`, antislashs) **et** realpath (un symlink ne sort pas du workspace). Dangereux : `write` et `shell` — le serveur met l'appel en pause jusqu'à l'approbation humaine (carte dans l'UI). `mkdir` est libre (le modèle façonne son arbre), `websearch` est lecture seule.

Entrées : appels d'outils validés (via `checkToolCall` avant exécution), décision d'approbation de l'UI (via le serveur : `executeToolCall` approuvé, ou `refusedByUser`).
Sorties : résultats structurés (`ToolOutcome` : ok + résumé français + `data` exacte renvoyée au modèle, ou refus codé `out_of_scope` / `invalid_args` / `approval_required` / `refused_by_user` / `io_error`) — le journal les trace tels quels, refus compris, jamais de silence.

Bornes : read 32 Kio, write 128 Kio, ls/glob 500 entrées, glob profondeur 8 (motifs `*` `**` `?`), shell commande ≤ 4 000 caractères / 30 s / 16 Kio par flux (tué à l'échéance, dit honnêtement), websearch requête ≤ 400 / URL http(s) ≤ 2 048 / 8 résultats / page **nettoyée** 64 Kio.

**websearch nettoie pour le modèle** (`websearch.ts`, zéro dépendance, `fetch` injectable) : recherche DuckDuckGo Lite (`{"query"}` → titres/URLs/snippets, pubs et doublons virés, redirections `uddg` résolues) ou lecture de page (`{"url"}`) — blocs script/style/nav/header/footer/aside/form… et commentaires supprimés, attributs réduits à href/src/alt (URI `data:` virées), balises sémantiques **gardées**, espaces rabotés, contenu plafonné.

Ne fait pas : HTTP vers Gemini, journalisation (c'est `session` via le serveur web), politique de pause (le serveur décide).

Tâches : M5 livré (quatre outils + garde). M11 (2026-11-17) : +`mkdir`, +`shell`, +`websearch`, `isDangerous` = write/shell. Pure Node, aucune dépendance aux autres packages — voir MILESTONES.md.
