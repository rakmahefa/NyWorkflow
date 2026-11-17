# Milestones — Phase 2 : passerelle webapi intégrée

> Phase 1 (M0..M6, v0.1.0) archivée dans [MILESTONES-old.md](MILESTONES-old.md). La numérotation continue à partir de M7.

Un milestone = petit, testé, livrable. Le suivant ne démarre que si `pnpm test` est vert.

**Règle de gouvernance (phase 2) : à chaque fin de milestone atteint, les milestones futurs sont écrits (ou réécrits) en fin de ce fichier.** Les jalons futurs ne sont jamais gravés dans le marbre plus d'un milestone à l'avance : ils affinent au fil des leçons de livraison. L'avancement global de la phase vit dans le README.

## M7 — Passerelle webapi · 20 % · ✅ Terminé (2026-11-17)

Objectif : la refonte moderne de `ny-gemini-acp`, directement dans le monorepo — pour l'instant Gemini, prouvé sans réseau.

- [x] `packages/webapi` (`@nyworkflow/webapi`), zéro dépendance runtime : client web Gemini (auth `SAPISIDHASH`, cookies 3 formats, payload `f.req`, décodage des frames `wrb.fr`, deltas par snapshots avec détection de divergence, retry backoff + jitter)
- [x] Anti-casseurs : **`bl` auto-découvert** depuis la page `/app` (+ repli constant, surcharge env), **table de modèles data-driven** (`models.json` surchargeable via `NYW_WEBAPI_MODELS_FILE`), **jetons de page rafraîchis sur échec HTTP 4xx** avant retry, erreurs typées
- [x] Serveur HTTP OpenAI-compatible (`node:http`, SSE) : `GET /` (état), `GET /v1/models`, `POST /v1/chat/completions` (stream **et** complet) — drop-in du port 8081, `adapter-llm` inchangé
- [x] CLI : `pnpm webapi` (bin `nyworkflow-webapi`), config par env `NYW_WEBAPI_*`
- [x] Tests : 98 dans le package, dont l'intégration full-chain contre une maquette HTTP de l'interface Gemini (page + `StreamGenerate`, échecs 400/401, divergence, flux vide, cookie expiré, rafraîchissement de jetons entre retries)
- [x] Docs : README (section passerelle, avancement phase 2), ARCHITECTURE, PLAN, ce fichier

**Livré quand :** `pnpm test` vert sur tout le monorepo, l'UI et l'exécution d'étapes consomment la passerelle sans changer une ligne de `adapter-llm`. ✔ (port 8081 par défaut = remplacement direct de `gemini-web2api` ; protocole prouvé contre la maquette, cookie réel à la première utilisation)

Détail de la livraison :

- **Client** (`src/gemini.ts`) — tour de force anti-casseurs : `refreshPage()` extrait `at`/`push_id`/`pctx` **et** le `bl` (regex `boq_assistant-bard-web-server_…`) ; le tour d'exécution réessaie (3×, backoff exponentiel 2 s → 30 s, jitter ±25 %) tant que rien n'a été émis, rafraîchit les jetons de page sur HTTP 4xx avant de réessayer, refuse de réessayer les erreurs fatales (cookie expiré, amont rejeté, modèle inconnu, blocage sécurité). Les snapshots divergents sont ignorés jusqu'à compatibilité ; la divergence résiduelle en fin de flux n'est retentée que si rien n'a été émis (délibéré : chaque tentative est une nouvelle conversation, réémettre dupliquerait la réponse).
- **Frames** (`src/frames.ts`) — port défensif du décodeur Rust : lignes, `)]}'` ignoré, `wrb.fr` uniquement, candidat le plus long de `inner[4]`, nettoyage des blocs `code_reference` et `card_content`, détection `BardErrorInfo [n]` sur métadonnées décodées uniquement (la prose qui cite le marqueur reste de la prose).
- **Serveur** (`src/server.ts`) — SSE écrit à la main sur `node:http` : chunk initial vide, deltas, `finish_reason` `stop`… ou chunk d'erreur `error` + `[DONE]` (jamais un `stop` déguisé), ping 15 s, annulation propagée à l'amont quand le client coupe.
- **Bornes** : corps de requête 4 Mio, frame 8 Mio, accumulateur brut 64 Kio — plafonds explicites, pas de confiance aveugle en l'amont.
- Tests : 237 unitaires au total (21 session + 11 adapter + 16 tools + 43 core + 48 web + **98 webapi**) + 12 e2e inchangés, tous verts.

## Milestones futurs

> Réécrits à chaque fin de milestone atteint (règle de gouvernance ci-dessus).

- **M8 — Durcissement & diagnostics** (20 %) : page d'état détaillée de la passerelle dans l'UI (cookie présent/expiré, `bl` découvert, derniers échecs typés) ; multi-comptes cookies (rotation sur erreur d'authentification) ; support proxy sortant ; journal structuré des requêtes amont.
- **M9 — API élargie** (20 %) : routes Google-style `/v1beta/models` (list + generateContent) et `tools` dans `/v1/chat/completions` (blocs `tool_call` façon OpenAI) — si un besoin réel apparaît, sinon reporté.
- **M10 — Provider suivant** (20 %) : l'abstraction `Provider` reçoit son deuxième implémentateur (à définir fin M8 : interface web d'un autre modèle, ou API officielle) — NyWorkflow choisit son provider par simple env.
- **M11 — v0.2.0** (20 %) : dégel du format de contrat ICM si les usages le réclament, `shell` optionnel sous approbation, multi-workspaces à la volée, tag et release.

> Ces jalons sont une intention, pas un engagement : chacun sera réévalué — et réécrit — au milestone précédent.
