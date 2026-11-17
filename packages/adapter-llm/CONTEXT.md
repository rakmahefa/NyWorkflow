# packages/adapter-llm — adaptateur modèle

Rôle : unique point de sortie vers les modèles. Parle le dialecte chat OpenAI **sous le namespace `/v1beta` par défaut** (`apiVersion` — le `v2` de demain sera une option), avec la chaîne de repli v1beta → v1 pour les serveurs externes (`W2A_URL`), et les deux formes de liste de modèles (OpenAI `data[].id`, Google `models[].name`). La moitié agentique (M11) : déclarations `tools` standard en entrée, `delta.tool_calls` réassemblés par index en sortie, rôles `tool` (avec `tool_call_id`) round-trip — le tout en événements de flux typés (`text` / `tool_calls` / `finish`).

Entrées : requêtes de chat (messages system/user/assistant/tool, modèle, tools, signal d'annulation).
Sorties : `AsyncIterable<ChatStreamEvent>` — deltas de texte, appels d'outils réassemblés, fin (finish_reason) ; erreurs `AdapterError` typées (unreachable / http / bad-shape, chunk d'erreur amont compris — jamais un stop déguisé).

Ne fait pas : parsing Gemini, auth cookie — c'est le travail de `@nyworkflow/webapi`.
Tâches : M2 ✅, M11 ✅ (v1beta + tools, 2026-11-17) — voir MILESTONES.md.

**M12** (2026-11-17) : événement de flux additif `{ type: 'thinking'; delta }` — décodé de `delta.reasoning_content` (dialecte DeepSeek servi par la passerelle) avant le texte ; jamais renvoyé au modèle (affichage seul). `tool_calls` et `finish` inchangés.


**M15** (2026-11-18) : le protocole deux temps — `ThinkingSplitter` (`thinking.ts`) découpe le FLUX de contenu : les blocs `<thinking title="…">…</thinking>` deviennent des événements thinking TITRÉS (un titre ouvre un bloc, sans titre il continue le bloc en cours), le reste est du texte visible. Incrémental et jamais perdant (balise coupée en plein chunk recousue par préfixe retenu, bloc non refermé auto-fermé en fin de flux — le dialogue interne ne fuit jamais), cap 256 Kio par bloc. Modèle-agnostique : le contrat vit dans le contenu, le canal natif `reasoning_content` (M12) coexiste en blocs anonymes. Le `title` des tool_calls est l'affaire des déclarations et du prompt (ICM), pas de l'adaptateur — il transite tel quel dans `arguments`.