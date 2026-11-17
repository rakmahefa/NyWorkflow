# packages/session — journal de session

Rôle : journaliser chaque événement (message, appel d'outil, changement d'étape) en append-only JSONL sous `.nyworkflow/sessions/`. L'historique envoyé au modèle est toujours re-dérivé du journal — rien d'autre n'est source de vérité.

Entrées : événements émis par `core` et `apps/web`.
Sorties : fichiers `.jsonl` (un par session), relecture, fork.

Tâches : M3 — voir MILESTONES.md.
