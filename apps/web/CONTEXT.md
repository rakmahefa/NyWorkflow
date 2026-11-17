# apps/web — UI

Rôle : interface web du harness (React + Vite, port 3080). Inspiration : deepseek-harness, en plus simple. Aucune logique métier ici — tout passe par les packages. Le serveur web embarque aussi deux API same-origin (plugin Vite, dev et preview) : `/sessions` (journaux M3) et `/workspaces` (moteur ICM M4 + outils M5 — exécution des étapes côté serveur, le navigateur ne touche jamais les fichiers).

Entrées : types et moteur de `packages/core`, journaux de `packages/session`, client de `packages/adapter-llm`.
Sorties : application web servie sur `127.0.0.1:3080` ; API `/sessions` et `/workspaces` (advance avec `tools`, approval des appels en pause).

Tâches : M1 ✅, M2 ✅ (sélecteur de modèles, streaming réel), M3 ✅ (sessions), M4 ✅ (API /workspaces : listing, runs, advance avec checkpoints — l'exemple s'exécute de bout en bout, l'état survit aux redémarrages), M5 ✅ (endpoint `/approval`, `RunDto.tools`, carte d'approbation + activité d'outils pour la session de run active), M6 (vue workflow dans l'UI) — voir MILESTONES.md.
