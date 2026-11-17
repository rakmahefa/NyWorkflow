# packages/adapter-llm — adaptateur modèle

Rôle : unique point de sortie vers les modèles. Parle le dialecte chat OpenAI **sous le namespace `/v1beta` par défaut** (`apiVersion` — le `v2` de demain sera une option), avec la chaîne de repli v1beta → v1 pour les serveurs externes (`W2A_URL`), et les deux formes de liste de modèles (OpenAI `data[].id`, Google `models[].name`). La moitié agentique (M11) : déclarations `tools` standard en entrée, `delta.tool_calls` réassemblés par index en sortie, rôles `tool` (avec `tool_call_id`) round-trip — le tout en événements de flux typés (`text` / `tool_calls` / `finish`).

Entrées : requêtes de chat (messages system/user/assistant/tool, modèle, tools, signal d'annulation).
Sorties : `AsyncIterable<ChatStreamEvent>` — deltas de texte, appels d'outils réassemblés, fin (finish_reason) ; erreurs `AdapterError` typées (unreachable / http / bad-shape, chunk d'erreur amont compris — jamais un stop déguisé).

Ne fait pas : parsing Gemini, auth cookie — c'est le travail de `@nyworkflow/webapi`.
Tâches : M2 ✅, M11 ✅ (v1beta + tools, 2026-11-17) — voir MILESTONES.md.
