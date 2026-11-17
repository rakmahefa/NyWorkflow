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

## M9 — Stabilité & auth multi-sessions · 20 % · ✅ Terminé (2026-11-17)

Objectif : la douleur la plus fréquente à l'usage, mise à jour en fin de M8 — **le pilote voit venir l'expiration**, chaque compte porte **sa propre session Google**, et le journal dit **qui a servi quoi**.

- [x] **Expiration des cookies au diagnostic** (`cookies.ts` `earliestExpiry`) : la plus proche des dates des cookies vivants ; tout expiré → la date passée (« expiré depuis ») — distinguable d'un compte sans cookies. Visible par compte dans `GET /` (`expiresAt`), en avertissement au démarrage du CLI (`expiration : … — dans ~N j`), et dans les Paramètres (table + `formatExpiry` : « dans 6 j » en warn ≤ 7 j, date seule au-delà, « expiré depuis 3 j » en err). Les chaînes brutes sans date restent imprévisibles (pas de champ).
- [x] **`/u/N` par compte** (`accounts.ts` + `gemini.ts`) : la rotation M8 laissait l'index de session GLOBAL (NYW_WEBAPI_AUTH_USER) — après rotation, le compte 2 parlait avec l'adresse de session du compte 1. Désormais chaque fichier porte son index dans un manifeste `accounts.json` (auto-découvert à côté du répertoire de cookies, surchargeable par `NYW_WEBAPI_ACCOUNTS_FILE`, relu à chaud par mtime, entrées invalides ignorées une par une — jamais fatal) : `{ "accounts": [{ "file": "a.json", "authUser": 0, "label": "Perso" }, …] }`. Précédence : entrée du manifeste > `NYW_WEBAPI_AUTH_USER` (repli, entier ≥ 0 seulement) > pas de préfixe. Le préfixe, le referer, `x-goog-authuser` et la page de jetons suivent le compte ACTIF — la rotation change d'adresse toute seule (page réinitialisée, déjà le cas M8).
- [x] **Statistiques d'utilisation par compte** (`journal.ts` `accountUsage`) : agrégation des tours du journal par index de compte (tours, ok, échecs, durée cumulée, dernier tour) — fenêtre du journal (50), tri par compte. Exposé additivement sur `GET /` (`gateway.accountUsage`) et rendu dans les Paramètres (table « Statistiques par compte », jointure par index avec les libellés du manifeste).

**Livré quand :** `pnpm test` vert sur tout le monorepo, et la chaîne complète vérifiée sur un serveur réel démarré comme un utilisateur. ✔ (script de vérification : 2 comptes dont un expiré la veille + `accounts.json`, `vite preview` avec passerelle intégrée contre la maquette Gemini — 13/13 checks verts : sessions `/u/0` et `/u/1`, « expiré depuis 3 j » visible AVANT tout 401, préfixe `/u/0` dans l'URL amont + `x-goog-authuser`, stats peuplées après le tour réel ; capture `download/m9-verif/settings-m9.png` côté repo de travail)

Détail de la livraison :

- **Diagnostic additif** : `AccountStatus` gagne `authUser?`, `label?`, `expiresAt?` (jamais présents quand non définis — les journaux et DTO antérieurs restent valides) ; `GeminiDescribe` gagne `authUser: number | null` (session effective du compte actif) et `accountUsage`. `GET /` : `gateway.authUser` + `gateway.accountUsage`. Le CLI affiche les sessions (`Perso → /u/0 · Pro → /u/1`) et prévient des expirations à ≤ 7 jours.
- **Anti-casseurs, fidèle au projet** : le manifeste est une donnée (jamais codée en dur), relu à chaud par mtime comme les cookies — changer un index ou un libellé ne redémarre rien ; `accounts.json` n'est pas compté comme compte (exclu du listing par chemin exact) ; `NYW_WEBAPI_AUTH_USER` est validé entier ≥ 0 (`-1`/`2.5` → ignoré, plus de `/u/-1` dans la nature).
- **Tests** : +29 webapi (166 : `earliestExpiry` 5, manifeste 6 + `activeAuthUser`/rotation/expiration 6, `accountUsage` 4, `/u/N` client 5 dont la rotation-qui-change-de-préfixe, `GET /` M9 1, config 3) ; +6 apps/web (`formatExpiry` 4 + `timeOf` 2) → **322 unitaires** au total ; **17 e2e** (+1 : sessions `/u/N`, expiration vue d'avance, stats par compte dans les Paramètres). Typecheck/build verts.
- Pièges rencontrés et corrigés : (1) `accounts.json` était compté comme un compte — le manifeste est exclu du listing (par chemin exact, un cookie homonyme ailleurs n'est pas touché) ; (2) `earliestExpiry` sur un compte tout-expiré ne doit regarder que les cookies qui SERAIENT servis sans l'expiration (un domaine hors Google n'a jamais été candidat) ; (3) le parseur EditThisCookie lit `expirationDate`, pas `expiresAt` — le helper de test doit traduire ; (4) `toLocaleDateString` suit la locale du runner (CI en-US) — les assertions de test comparent via le même formatage, jamais une chaîne figée.
- Docs : README (avancement 60 %, table de config, Paramètres M9), USERGUIDE (§2 accounts.json + où lire son `/u/N`, §4 Paramètres, §6 env, §7 dépannage), ARCHITECTURE (D2 révisée M9), PLAN (point de décision fin M9), ce fichier, CONTEXT.md × 2.

## M10 — API élargie · 20 % · ✅ Terminé (2026-11-17)

Objectif (réécrit fin M9 — le besoin a été exprimé par le pilote) : la passerelle parle les **deux dialectes** des clients LLM — routes Google-style et `tools` à la OpenAI — sans bouger d'un octet la surface existante.

- [x] **Routes Google-style** (`v1beta.ts`) : `GET /v1beta/models` + `GET /v1beta/models/{name}` (forme Google, `supportedGenerationMethods` honnête), `POST :generateContent` (candidates/parts/finishReason/usageMetadata), `POST :streamGenerateContent` — `?alt=sse` en SSE (comme le SDK Google, sans `[DONE]`) ou tableau JSON par défaut (REST). Erreurs à l'enveloppe Google (`{error:{code,message,status}}`), 404 « models/x is not found for API version v1beta » compris
- [x] **`tools` dans `/v1/chat/completions`** (`tools.ts`) : déclarations à la OpenAI (tolérance : entrée plate Google acceptée), `tool_choice` auto/none/required/forcé, réponse `message.tool_calls` + `finish_reason: "tool_calls"` — en complétion comme en streaming (`delta.tool_calls`) ; `role: "tool"` accepté dans l'historique, round-trip complet
- [x] **Outils v1beta symétriques** : `tools: [{functionDeclarations}]` + `toolConfig` (AUTO/ANY/NONE, `allowedFunctionNames`) → `functionCall` dans les parts de réponse — le même moteur que /v1
- [x] **La mécanique anti-casseur** (le cœur) : l'interface web Gemini ne connaît pas les outils du client — la passerelle les passe par le prompt (préambule + convention de blocs), puis décode le texte **en flux** : marqueurs coupés entre deltas, arguments imbriqués (`}}` structurels), fences ```json, prose qui imite le marqueur → texte intact, bloc jamais refermé → texte, garde-fou 64 Kio. Zéro perte : ce qui n'est pas un appel ressort en texte
- [x] **Chemins sans outils inchangés** octet pour octet (complétion = `chatComplete` historique, streaming = boucle historique) ; `GET /` et `/v1/*` non touchés — la contrainte additive M9 est tenue et testée

**Livré quand :** `pnpm test` vert sur tout le monorepo, et la chaîne vérifiée sur la passerelle réelle démarrée comme un utilisateur (CLI). ✔ (script de vérification : maquette Gemini + CLI réel — **18/18 checks verts** : v1beta complet, tool_calls en complétion ET streaming, round-trip des résultats d'outils dans le `f.req` amont, SSE Google sans `[DONE]`, régressions v1/M8/M9 ; transcript `download/m10-verif/transcript.txt` côté repo de travail)

Détail de la livraison :

- **Convention de blocs** (`tools.ts`) : `{{tool {"name": "get_weather", "arguments": {"city": "Paris"}} }}` — marqueur rare en prose, JSON strict à l'intérieur. Le décodage s'appuie sur un scanner aware des chaînes (`scanJsonValue`) : les `}}` structurels ou à l'intérieur d'une chaîne ne ferment pas le bloc ; la fermeture peut être collée au JSON, entourée d'une fence, ou coupée entre deux deltas. Le préambule (anglais, face au modèle) impose « only the tool call blocks, never invent tool results » ; `tool_choice` required/forced ajoute son injonction, none supprime le préambule.
- **Splitter jamais perdant** : tout ce qui ne respecte pas la convention (prose avec `{{tool calls}}`, JSON invalide, bloc jamais refermé, dépassement 64 Kio) redevient du texte — testé caractère par caractère ET à chaque point de césure possible du flux.
- **Honnêteté des erreurs** : `/v1` garde son `finish_reason: "error"` ; `/v1beta` en SSE termine par un événement `error` Google (UNAVAILABLE) — jamais un STOP déguisé. `generationConfig` est accepté et ignoré (rien de simulé, jamais d'erreur sur ce qu'on ne sert pas).
- **Leçons** : (1) la fermeture `}}` coupée entre deux deltas doit être ATTENDUE (préfixe propre du marqueur = incomplete), pas rejetée en prose — le premier scanner rejetait un bloc pourtant valide en route ; (2) le test « à chaque point de césure du flux » a attrapé ce bug là où le cas « un seul push » passait — ce réflexe devient la règle pour tout décodage incrémental ; (3) les extensions natives de Gemini (YouTube, Maps…) restent volontairement non exposées : ce sont les outils de Google, pas ceux du client.
- **Tests** : +64 webapi (**230** : tools 26, v1beta 14, convert +3, server +21 dont l'intégration full-chain des deux surfaces contre la maquette) → **386 unitaires** au total ; **17 e2e** inchangés et verts. Typecheck/build verts.
- Docs : README (API élargie, avancement 80 %), USERGUIDE (§6 les deux surfaces + guide tools, §7 dépannage), ARCHITECTURE (D2 révisée M10), PLAN (point de décision fin M10), ce fichier, CONTEXT.md webapi.

## M11 — Sessions ICM agentiques (ajustements pilotés) · 40 % · ✅ Terminé (2026-11-17)

Objectif (**réécrit par le pilote en fin de M10** — le v0.2.0 prévu (dégel du contrat, shell optionnel, multi-workspaces) a été remplacé par un pivot : les ajustements demandés à l'usage) : **sessions uniquement** — le concept de workflow (étapes numérotées, runs, advance) est retiré ; chaque session vit dans un **workspace à arbre libre** dont l'ICM est chargée vers le modèle, qui agit avec des **tool_calls standards**.

- [x] **Sessions ICM agentiques** : chaque session est créée (dialogue titre + workspace) avec un workspace lié ; à chaque tour, l'arborescence + tous les `CONTEXT.md` sont assemblés en prompt système (`core.loadIcm` + `buildIcmSystemPrompt` — profondeur 6, 500 entrées, 8 CONTEXT.md, 32 Kio chacun), rechargé à chaque tour car **l'arbre grandit pendant la session**
- [x] **Boucle agentique dans le navigateur, tool_calls modernes standard** : déclarations OpenAI (`tools`) → `delta.tool_calls` réassemblés → exécution → résultats en `role:"tool"` → modèle… (max 12 tours) ; l'UI affiche l'activité d'outils dans le flux du chat
- [x] **Les 7 outils, disponibles et fonctionnels** : `read`, `write`, `ls`, `glob` (M5) + **`mkdir`** (libre — le modèle façonne son arbre, demande explicite du pilote), **`shell`** (bash, cwd = racine, 30 s, 16 Kio/flux, approbation), **`websearch`** (recherche DDG Lite `{"query"}` → titres/URLs/snippets ; lecture `{"url"}` → page **nettoyée** : scripts, styles, nav, header/footer, commentaires et attributs partis, URI data: virées, balises sémantiques gardées, 64 Kio max) — zéro dépendance, `fetch` injectable pour les tests
- [x] **Suppression de session** : `DELETE /sessions/:id` (le journal disparaît entier — une suppression est une décision, pas une édition), bouton deux-temps dans la sidebar, `/delete` en commande ; une boucle en pause sur la session supprimée se termine proprement
- [x] **v1beta de base** : l'adaptateur consomme `/v1beta/chat/completions` et `/v1beta/models` par défaut (`apiVersion` — le `v2` de demain sera une option), la liste des formes de liste (OpenAI/Google) parseée indifféremment, repli sur l'autre namespace ; côté passerelle, le dialecte OpenAI est servi sous `/v1/chat/completions` **et** `/v1beta/chat/completions` — la liste des namespaces est une **donnée** (`OPENAI_CHAT_PATHS`)
- [x] **Scaffold du workspace agentique par défaut** : `POST /workspaces {name}` crée la charte (`CONTEXT.md` : Mission, Méthode ICM, Arborescence, Outils, Règles) + `inbox/ notes/ research/ outputs/` ; créable depuis le dialogue de session, jamais d'écrasement (refus si existant)
- [x] **Le moteur de workflows est retiré** : `engine.ts`, `parse.ts`, `prompt.ts`, `protocol.ts` (protocole JSON une-ligne M5), les endpoints runs/advance/approval, la vue Workflows — `packages/core` devient le paquet ICM (arbre, contexte, scaffold), sans dépendance

**Livré quand :** `pnpm test` vert sur tout le monorepo, et le pivot vérifié bout en bout. ✔ (19 e2e : dialogue de création, lecture auto-exécutée + réponse finale, mkdir sur disque, write approuvé/refusé depuis la carte avec reprise de boucle et survie au rechargement, suppression en deux temps ; capture README rejouée sur la scène agentique — `docs/assets/screenshot.png`)

Détail de la livraison :

- **Le journal reste la vérité, plus que jamais** : les événements `tool.call` / `tool.result` sont écrits par le **serveur qui exécute** (`POST /workspaces/:name/tool` journalise l'appel à l'arrivée, le résultat à la fin) ; un appel dangereux en attente = `tool.call` sans `tool.result` — dérivé au rechargement, la carte se réaffiche, la décision (`POST /workspaces/:name/tool/decision`) reprend la boucle si elle vit encore. Le DTO `/sessions` expose maintenant les **événements bruts ordonnés** — le navigateur en dérive messages, lignes d'outils et historique modèle (le journal EST le protocole).
- **Sessions anciennes** : les journaux M4–M10 (runs, stage.*) restent lisibles — leurs événements inconnus sont ignorés à la dérivation, leurs `tool.call`/`tool.result` rejouent en lignes d'outils ; une session sans workspace converse sans outils.
- **Anti-casseurs, fidèle au projet** : la carte d'approbation garde le motif M5 sans le moteur (busy set par session, un seul appel en attente, 409 clairs) ; `websearch` échoue en refus français journalisé, jamais en exception ; le shell est tué à 30 s et le dit honnêtement (`timedOut` dans le résultat) ; l'ICM inatteignable dégrade le tour avec un message système, jamais une boucle muette.
- **Leçons** : (1) le mock e2e comptait les résultats d'outils **n'importe où** dans l'historique — au deuxième tour, le résultat du premier tour bloquait le scénario : la fenêtre compte désormais **après le dernier message utilisateur** ; (2) les boutons d'action de la sidebar vivent DANS la rangée mais HORS du bouton de session — les sélecteurs e2e doivent viser `.session-row` ; (3) un POST de journalisation en vol au moment d'un `reload` meurt avec la page — les specs laissent la marge déjà prévue ailleurs.
- **Tests** : 375 unitaires (12 core — l'ICM et le scaffold, 18 adapter — v1beta/tools, 23 session, 35 tools — dont mkdir/shell/websearch scripté sans réseau, 234 webapi — dont l'alias v1beta, 53 web) ; **19 e2e** (4 agentic, 2 tools/approbation, 4 gateway, 3 persistence, 5 settings, 1 simulated). Typecheck/build verts.
- Docs : README (pivot complet, capture rejouée, API v1beta), ARCHITECTURE (D2/D3 révisées, flux du tour agentique, frontières), USERGUIDE (réécrit §3 sessions agentiques, §6 API), PLAN (point de décision), ce fichier, CONTEXT.md × 4, exemple `exemple-agentique`.

## Milestones futurs

> Réécrits à chaque fin de milestone atteint (règle de gouvernance ci-dessus).

- **M12 — Confort & clarté du pilotage** (poids à définir) : lire/éditer les fichiers du workspace depuis l'UI (l'aperçu `/file` existe côté serveur), renommer une session, changement de modèle en cours de tour, annulation d'un tour en vol. Le socle M11 (journal-vérité, boucle navigateur, outils bornés) est la base stable.
- **M13 — v0.2.x : durcissement des usages réels** : cookies réels sur la boucle agentique complète (multi-tours avec tools sur l'interface Gemini réelle), plafonds de contexte ajustés aux retours, export/livraison d'un workspace (archive), tag & release.

> Ces jalons sont une intention, pas un engagement : chacun sera réévalué — et réécrit — au milestone précédent.
