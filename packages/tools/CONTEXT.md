# packages/tools — outils + permissions

Rôle : outils que l'agent peut appeler (`read`, `write`, `ls`, `glob`, `shell` optionnel) et garde-fous. Règle de périmètre : tout chemin reste dans la racine du workspace ; tout le reste est refusé et journalisé.

Entrées : appels d'outils validés par `core`, approbations de l'UI.
Sorties : résultats + événements journalisés.

Tâches : M5 — voir MILESTONES.md.
