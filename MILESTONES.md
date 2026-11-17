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

## M8 — Durcissement & diagnostics · 20 % · ✅ Terminé (2026-11-17)

Objectif : la passerelle **vit avec l'application** (plus de « passerelle absente »), l'utilisateur voit tout (menu Paramètres), et les casses historiques ont une parade de plus (multi-comptes, proxy).

- [x] **Passerelle intégrée au démarrage** (`apps/web/src/server/embed.ts`) : `pnpm dev` / `pnpm preview` démarrent la webapi dans le même processus — règles d'engagement explicites (W2A_URL externe respecté, `NYW_WEBAPI_EMBED=0` coupe, port occupé = passerelle externe utilisée telle quelle, jamais sous Vitest), le proxy `/api` suit `NYW_WEBAPI_HOST/PORT`
- [x] **Menu Paramètres dans l'UI** : modale en 3 sections — Apparence (thème Auto/Clair/Sombre persisté, appliqué via `data-theme`, le CSS garde `prefers-color-scheme` pour Auto), Passerelle (diagnostic vivant), À propos — bouton engrenage en bas de sidebar, `Échap` ferme
- [x] **Page d'état détaillée** : `GET /` étendu de façon additive — cookies (présents/absents + fichier), **comptes** (fichier, validité, erreur de format, compte actif), `bl`, proxy (identifiants masqués), **journal amont** (50 derniers tours : modèle, durée, essais, compte, erreur typée) — rendu dans Paramètres, rafraîchissable
- [x] **Multi-comptes cookies** (`packages/webapi/src/accounts.ts`) : `NYW_WEBAPI_COOKIE_FILE` accepte un répertoire (un compte par fichier, trié) ; rotation sur erreur d'authentification **sans jamais dupliquer du texte déjà émis** ; relecture à chaud fichier par fichier (mtime conservée même pour un fichier malformé — le corriger suffit)
- [x] **Proxy sortant** (`packages/webapi/src/proxy.ts`) : `NYW_WEBAPI_PROXY` > `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` + `NO_PROXY` ; cibles http en URI absolue, cibles https par tunnel CONNECT + TLS maison (`node:tls`), `NYW_WEBAPI_TLS_CA` pour les proxy qui rechiffrent — zéro dépendance, tunnels jetables (teardown à la fin de réponse, pas de fuite de socket)
- [x] **Journal amont** (`packages/webapi/src/journal.ts`) : tampon circulaire en mémoire, branché dans la boucle de tours du client Gemini (succès, échec typé, annulation)
- [x] **USERGUIDE.md** : guide utilisateur complet — démarrage en une commande, cookies (3 formats + multi-comptes), tour de l'interface, paramètres, format de workflow, config env exhaustive, table de dépannage

**Livré quand :** `pnpm test` vert sur tout le monorepo, et le programme s'ouvre avec la webapi intégrée sans commande séparée. ✔ (vérifié bout en bout : serveur réel démarré comme un utilisateur, `/api/` répond, l'UI affiche la passerelle UP, aucun message « absente », sélecteur de modèles actif)

Détail de la livraison :

- **Embed** : le plugin Vite démarre la passerelle via `startEmbeddedGateway()` — la fonction ne lève jamais (échec dégradé en raison lisible), rend ses sockets à l'arrêt du serveur ; 5 tests dédiés dont la chaîne complète intégrée (diagnostic + modèles + chat SSE) contre la maquette Gemini.
- **Anti-casseur proxy** : la première implémentation passait `agent: false` à `https.request` — Node IGNORE alors `createConnection` et contourne le tunnel (leçon consignée : laisser `agent` indéfini) ; les tunnels sont détruits sur `end`/`close` de la réponse (close_notify à travers les pipes d'un proxy = jamais garanti).
- **Tests** : +50 webapi (137 au total : comptes, journal, proxy http/CONNECT/TLS avec CA de test auto-générée, rotation 401→compte 2, journal typé, `GET /` étendu) ; +11 apps/web (5 embed + 6 thème) → **287 unitaires** au total ; **16 e2e** (4 nouveaux : ouverture/fermeture Paramètres, thème persisté au rechargement, journal amont peuplé après un tour réel, clic overlay/ modale).
- Docs : README (démarrage en une commande, paramètres, table de config), USERGUIDE.md (nouveau), ARCHITECTURE (D2 révisée), PLAN, ce fichier, CONTEXT.md d'apps/web et packages/webapi.

## Milestones futurs

> Réécrits à chaque fin de milestone atteint (règle de gouvernance ci-dessus).

- **M9 — Stabilité & auth multi-sessions** (20 %) : validation proactive des cookies (date d'expiration au diagnostic, pas seulement présent/absent — le pilote voit venir l'expiration), `/u/N` par compte multi-comptes (un fichier = un compte Google ET son index de session), statistiques d'utilisation par compte dans le journal amont.
- **M10 — API élargie** (20 %) : routes Google-style `/v1beta/models` + `generateContent`, et `tools` dans `/v1/chat/completions` (blocs `tool_call` façon OpenAI) — si un besoin réel apparaît, sinon reporté.
- **M11 — v0.2.0** (20 %) : dégel du format de contrat ICM si les usages le réclament, `shell` optionnel sous approbation, multi-workspaces à la volée, tag et release.

> Ces jalons sont une intention, pas un engagement : chacun sera réévalué — et réécrit — au milestone précédent.
