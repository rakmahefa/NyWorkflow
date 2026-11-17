# packages/tools — outils + permissions

Rôle : les mains de l'agent, et leur laisse. Quatre outils (`read`, `write`, `ls`, `glob`) appelés par la boucle d'agent de `core` (protocole JSON une-ligne), avec une seule permission qui compte : tout chemin reste dans la racine du workspace — garde lexicale (chemins absolus, `..`, antislashs) **et** realpath (un symlink ne sort pas du workspace). `write` est le seul outil dangereux : le moteur met l'étape en pause jusqu'à l'approbation humaine (UI). `shell` reste hors périmètre en v0.1.0.

Entrées : appels d'outils validés par `core` (via `checkToolCall` avant exécution), décision d'approbation de l'UI (via `core` : `executeToolCall` approuvé, ou `refusedByUser`).
Sorties : résultats structurés (`ToolOutcome` : ok + résumé français + `data` exacte renvoyée au modèle, ou refus codé `out_of_scope` / `invalid_args` / `approval_required` / `refused_by_user` / `io_error`) — le journal les trace tels quels, refus compris, jamais de silence.

Bornes : read 32 Kio, write 128 Kio, ls/glob 500 entrées, glob profondeur 8, motifs `*` `**` `?` (pas de classes de caractères en v1).

Ne fait pas : HTTP, journalisation (c'est `session` via `core`), politique d'exécution (c'est `core` qui décide de la pause).

Tâches : M5 livré (2026-11-17) — `scope.ts` (la garde), `tools.ts` (les quatre outils + `checkToolCall` / `executeToolCall` / `refusedByUser`). Pure Node, aucune dépendance aux autres packages (core importe tools, jamais l'inverse). Voir MILESTONES.md.
