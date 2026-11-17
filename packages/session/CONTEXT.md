# packages/session — journal de session

Rôle : journaliser chaque événement (message, appel d'outil, changement d'étape) en append-only JSONL sous `.nyworkflow/sessions/`. L'historique envoyé au modèle est toujours re-dérivé du journal — rien d'autre n'est source de vérité.

Entrées : événements émis par `core` et `apps/web`.
Sorties : fichiers `.jsonl` (un par session), relecture, fork.

Tâches : M3 livré (2026-11-17) — `journal.ts` (append/lecture/fork/ids), `derive.ts` (titre, date, messages). Deux champs additifs ont rejoint le contrat gelé : `title` sur `session.created` et l'événement `session.forked` (provenance) ; les journaux antérieurs restent lisibles. M4 (2026-11-17) : le champ additif `workspace` sur `DerivedSession` (lu depuis `session.created`) permet à l'API `/workspaces` de lister les runs d'un workspace ; les événements `stage.started` / `stage.output` / `run.completed`, déclarés dès le contrat initial, sont désormais écrits par le moteur de `packages/core`. Le navigateur ne touche jamais ces fichiers : il passe par l'API `/sessions` et `/workspaces` du serveur web.

M5 (2026-11-17) : deux champs additifs de plus — `data` sur `tool.result` (la charge exacte renvoyée au modèle, pour rejouer la conversation d'un run en pause à l'identique) et `model` sur `stage.started` (l'approbation n'a pas à redemander le modèle). Les événements `tool.call` / `tool.result`, déclarés dès le contrat initial, sont désormais écrits par la boucle d'outils de `packages/core` ; `deriveSession` les expose en activité d'outils (un appel sans résultat = en attente d'approbation).


M11 (2026-11-17) : `deleteJournal` — la suppression de session (le journal disparaît entier : une suppression est une décision, pas une édition) ; les événements `tool.call` / `tool.result` sont désormais écrits par le serveur web (l'API des outils de `/workspaces`), et le DTO `/sessions` expose les événements bruts ordonnés — le navigateur en dérive messages, lignes d'outils et historique modèle. Les événements `stage.*` / `run.completed` ne sont plus écrits (moteur retiré) mais restent déclarés : les journaux M4–M10 se lisent toujours.
