# packages/session — journal de session

Rôle : journaliser chaque événement (message, appel d'outil, changement d'étape) en append-only JSONL sous `.nyworkflow/sessions/`. L'historique envoyé au modèle est toujours re-dérivé du journal — rien d'autre n'est source de vérité.

Entrées : événements émis par `core` et `apps/web`.
Sorties : fichiers `.jsonl` (un par session), relecture, fork.

Tâches : M3 livré (2026-11-17) — `journal.ts` (append/lecture/fork/ids), `derive.ts` (titre, date, messages). Deux champs additifs ont rejoint le contrat gelé : `title` sur `session.created` et l'événement `session.forked` (provenance) ; les journaux antérieurs restent lisibles. M4 (2026-11-17) : le champ additif `workspace` sur `DerivedSession` (lu depuis `session.created`) permet à l'API `/workspaces` de lister les runs d'un workspace ; les événements `stage.started` / `stage.output` / `run.completed`, déclarés dès le contrat initial, sont désormais écrits par le moteur de `packages/core`. Le navigateur ne touche jamais ces fichiers : il passe par l'API `/sessions` et `/workspaces` du serveur web.
