# packages/adapter-llm — adaptateur modèle

Rôle : unique point de sortie vers les modèles. Parle OpenAI-compatible via fetch/SSE. Cible par défaut : `gemini-web2api` (http://127.0.0.1:8081), la passerelle du repo ny-gemini-acp qui porte tout le savoir-faire cookie/OAuth Gemini.

Entrées : requêtes de chat (messages, modèle, signal d'annulation).
Sorties : flux de tokens (`AsyncIterable<string>`).

Ne fait pas : parsing Gemini, auth cookie — c'est le travail de la passerelle.
Tâches : M2 ✅ (2026-11-17) — voir MILESTONES.md.
