# packages/core — moteur ICM

Rôle : lire un workspace (carte racine + contrats `CONTEXT.md`), exécuter les étapes dans l'ordre des numéros, écrire les sorties. Le système de fichiers est l'orchestrateur — ce package se contente de lire, appeler le LLM, écrire.

Entrées : un dossier workspace (voir `examples/workspaces/`), `adapter-llm`, `tools`.
Sorties : fichiers `output/` par étape, événements vers `session`.

Ne fait pas : HTTP direct vers Gemini, UI, persistance autre que fichiers plats.
Tâches : M4 — voir MILESTONES.md.
