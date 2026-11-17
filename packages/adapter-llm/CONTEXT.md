# packages/adapter-llm — adaptateur modèle

Rôle : unique point de sortie vers les modèles. Parle OpenAI-compatible via fetch/SSE. Cible par défaut : la passerelle intégrée `@nyworkflow/webapi` (`pnpm webapi`, http://127.0.0.1:8081) qui porte tout le savoir-faire cookie/streaming Gemini — tout serveur OpenAI-compatible peut la remplacer via `W2A_URL`.

Entrées : requêtes de chat (messages, modèle, signal d'annulation).
Sorties : flux de tokens (`AsyncIterable<string>`).

Ne fait pas : parsing Gemini, auth cookie — c'est le travail de `@nyworkflow/webapi`.
Tâches : M2 ✅ (2026-11-17) — voir MILESTONES.md.
