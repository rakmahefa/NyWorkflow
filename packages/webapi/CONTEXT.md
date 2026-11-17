# packages/webapi — la passerelle du monorepo

Rôle : servir l'interface web Gemini (et demain d'autres providers) en **deux dialectes** — OpenAI-compatible (`/v1`) et Google-style (`/v1beta`, M10) — **dans le repo**. C'est la refonte moderne et maintenue de `ny-gemini-acp` (Rust, non maintenu). C'est le seul endroit du monorepo qui connaît Gemini : cookies, SAPISIDHASH, payload `f.req`, frames `wrb.fr`, version `bl`.

Entrées : requêtes OpenAI-compatible (`/v1/models`, `/v1/chat/completions` — avec `tools`/`tool_choice` depuis M10) et Google-style (`/v1beta/models`, `:generateContent`, `:streamGenerateContent` — `functionDeclarations`/`toolConfig`), cookies Gemini dans `.nyworkflow/cookies/gemini.json` (3 formats : EditThisCookie, objet `{"cookie","sapisid"}`, chaîne brute), un **répertoire de fichiers cookies = multi-comptes** (`NYW_WEBAPI_COOKIE_FILE`), un **manifeste `accounts.json` = un `/u/N` et un libellé par compte** (M9, auto à côté des cookies ou `NYW_WEBAPI_ACCOUNTS_FILE`), ou `NYW_WEBAPI_COOKIES`.
Sorties : JSON et SSE au format OpenAI — exactement ce qu'`adapter-llm` consomme déjà (port 8081 par défaut = remplacement direct de l'ancienne passerelle) — et au format Google (candidates/parts/functionCall, M10) ; diagnostic `GET /` (cookies, **expiration par compte**, sessions `/u/N`, `bl`, proxy masqué, journal amont, **stats par compte** — M9, tous les champs M9 sont additifs, les consommateurs antérieurs ne bougent pas). Les outils du client passent par une **convention de blocs dans le prompt** (`tools.ts` : préambule + décodage en flux jamais perdant) — l'interface web Gemini ne connaît pas les function declarations.

Ne fait pas : orchestration, sessions, ni les outils du workspace (ça vit dans `packages/tools`, M5) — jamais. Les « tools » servis ici (M10) sont ceux **du client API**, passés par le prompt et décodés dans la réponse. Ne touche pas au reste du monorepo : Gemini évolue → le patch reste ici.

## Pourquoi ça cassait avant, et ce qui y répond

| ny-gemini-acp (Rust) | ici |
|---|---|
| `bl` constant qui périmait | auto-découvert sur la page `/app` (regex), repli constant, surcharge `NYW_WEBAPI_GEMINI_BL` |
| modèles dans le code | `DEFAULT_MODEL_TABLE` + remplacement par `NYW_WEBAPI_MODELS_FILE` (JSON) — Google renomme, on édite une donnée |
| jetons de page jamais rafraîchis sur échec | TTL 10 min **et** invalidés + rafraîchis avant chaque retry HTTP 4xx |
| retry à l'identique | backoff exponentiel + jitter, retry seulement si rien n'a été émis |
| flux vide = échec immédiat | flux vide retenté (délibéré : échec souvent transitoire), puis erreur typée `empty` |
| divergences retryées même après émission | on ne réessaie jamais après avoir émis — le consommateur voit l'erreur, pas un texte dupliqué |
| un seul compte = tout tombe à la première expiration | **multi-comptes** (`accounts.ts`) : répertoire de cookies, rotation sur erreur d'authentification, jamais après émission — et depuis M9, **`/u/N` par compte** (`accounts.json`) : la rotation change de session toute seule, l'index n'est plus global |
| expiration découverte en 401, jamais vue venir | **expiration au diagnostic** (M9, `cookies.ts` `earliestExpiry`) : la plus proche des cookies vivants par compte, avertissement CLI ≤ 7 j |
| pas de proxy sortant | **tunnel CONNECT + TLS maison** (`proxy.ts`) : `NYW_WEBAPI_PROXY`/`HTTPS_PROXY` + `NO_PROXY`, `NYW_WEBAPI_TLS_CA` pour les proxy qui rechiffrent |
| diagnostics muets | **journal amont** (`journal.ts`) : 50 derniers tours (modèle, durée, essais, compte, erreur typée) sur `GET /` — et depuis M9, **stats par compte** (`accountUsage` : tours, ok, échecs, dernier tour) |

## Déviations assumées par rapport au port (documentées dans les tests)

- flux vide **retenté** (ny-gemini-acp échouait immédiatement) ;
- divergence en fin de flux **non retentie** si du texte a déjà été émis (ny-gemini-acp réessayait en vain : chaque tentative est une nouvelle conversation) ;
- un flux sans **aucune** sortie exploitable (même sans `wrb.fr`) est une erreur `empty`, pas un succès muet.

## Bornes de sécurité

Corps de requête 4 Mio · frame 8 Mio · accumulateur brut 64 Kio · bloc d'appel d'outil 64 Kio (au-delà : redevient du texte, jamais perdu) · 256 tool-events max par flux · jetons de page TTL 10 min · timeout amont 180 s (configurable). Le cookie est un secret : fichier gitignoré, jamais dans les logs.

## Démarrer

```sh
pnpm webapi          # autonome : 127.0.0.1:8081 — voir NYW_WEBAPI_* dans src/config.ts
pnpm dev             # intégré : le serveur web démarre la passerelle (apps/web/src/server/embed.ts)
```

Leçons Node (consignées) : avec `agent: false`, `https.request` IGNORE `createConnection` et contourne le tunnel — laisser `agent` indéfini ; un tunnel CONNECT se détruit à la main sur `end`/`close` de la réponse, la propagation de `close_notify` à travers les pipes n'est pas garantie.

Tâches : M7 ✅, M8 ✅ (multi-comptes, proxy, journal amont, diagnostic étendu), M9 ✅ (auth multi-sessions `/u/N`, expiration vue d'avance, stats par compte — 2026-11-17), M10 ✅ (API élargie : `/v1beta` Google-style + `tools` OpenAI, splitter jamais perdant — 2026-11-17) — voir MILESTONES.md.


M11 (2026-11-17) : le dialecte OpenAI est aussi servi sous **`/v1beta/chat/completions`** — l'app consomme v1beta par défaut. La liste des namespaces est une donnée (`OPENAI_CHAT_PATHS` dans `server.ts`) : le futur `v2` s'ajoutera sans toucher au moteur. Les chemins sans outils restent inchangés octet pour octet.

**M12** (2026-11-17) : la **réflexion traverse** — `frames.ts` décode les thoughts du candidat porteur du texte (`candidate[37][0][0]`, snapshots) ; `gemini.ts` émet des deltas `thought` tolérants (re-base silencieuse si la réflexion se réécrit ; `canRetry` et la rotation comptent la réflexion émise) ; `provider.ts` transporte deux canaux (`{kind:'text'|'thought'}`) et `chatComplete` rend `{text, reasoning}` ; `server.ts` diffuse `delta.reasoning_content` en SSE (**jamais à travers le splitter d'outils**) et `message.reasoning_content` en complétion ; v1beta : parts `thought: true` (`generateThoughtChunk`, complétion/SSE/tableau). `models.ts` : `ModelInfo` (`label`, `famille`, `thinking` = mode 2/5, `defaultThink`) via `listModelInfo`, exposé additivement sur `GET /` (`modelInfo`) ; `GeminiDescribe.modelTable`.


**M13** (2026-11-18) : `TurnJournal` accepte un **onRecord** optionnel (chaque tour amont part aussi vers un sink externe) et `webApiProviderFromConfig(config, onTurn?)` le câble — c'est ainsi que les tours amont (modèle, tentatives, durée, compte, erreur typée) atterrissent dans le **engine log** de l'app (`.nyworkflow/.logs/engine.jsonl`) via l'intégration de `embed.ts`. Additif pur : sans sink, comportement inchangé.
