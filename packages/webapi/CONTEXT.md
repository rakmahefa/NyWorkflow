# packages/webapi — la passerelle du monorepo

Rôle : servir l'interface web Gemini (et demain d'autres providers) en OpenAI-compatible, **dans le repo** — la refonte moderne et maintenue de `ny-gemini-acp` (Rust, non maintenu). C'est le seul endroit du monorepo qui connaît Gemini : cookies, SAPISIDHASH, payload `f.req`, frames `wrb.fr`, version `bl`.

Entrées : requêtes OpenAI-compatible (`/v1/models`, `/v1/chat/completions`), cookies Gemini dans `.nyworkflow/cookies/gemini.json` (3 formats : EditThisCookie, objet `{"cookie","sapisid"}`, chaîne brute), un **répertoire de fichiers cookies = multi-comptes** (`NYW_WEBAPI_COOKIE_FILE`), ou `NYW_WEBAPI_COOKIES`.
Sorties : JSON et SSE au format OpenAI — exactement ce qu'`adapter-llm` consomme déjà (port 8081 par défaut = remplacement direct de l'ancienne passerelle) ; diagnostic `GET /` (cookies, comptes, `bl`, proxy masqué, journal amont).

Ne fait pas : orchestration, sessions, outils — jamais. Ne touche pas au reste du monorepo : Gemini évolue → le patch reste ici.

## Pourquoi ça cassait avant, et ce qui y répond

| ny-gemini-acp (Rust) | ici |
|---|---|
| `bl` constant qui périmait | auto-découvert sur la page `/app` (regex), repli constant, surcharge `NYW_WEBAPI_GEMINI_BL` |
| modèles dans le code | `DEFAULT_MODEL_TABLE` + remplacement par `NYW_WEBAPI_MODELS_FILE` (JSON) — Google renomme, on édite une donnée |
| jetons de page jamais rafraîchis sur échec | TTL 10 min **et** invalidés + rafraîchis avant chaque retry HTTP 4xx |
| retry à l'identique | backoff exponentiel + jitter, retry seulement si rien n'a été émis |
| flux vide = échec immédiat | flux vide retenté (délibéré : échec souvent transitoire), puis erreur typée `empty` |
| divergences retryées même après émission | on ne réessaie jamais après avoir émis — le consommateur voit l'erreur, pas un texte dupliqué |
| un seul compte = tout tombe à la première expiration | **multi-comptes** (`accounts.ts`) : répertoire de cookies, rotation sur erreur d'authentification, jamais après émission |
| pas de proxy sortant | **tunnel CONNECT + TLS maison** (`proxy.ts`) : `NYW_WEBAPI_PROXY`/`HTTPS_PROXY` + `NO_PROXY`, `NYW_WEBAPI_TLS_CA` pour les proxy qui rechiffrent |
| diagnostics muets | **journal amont** (`journal.ts`) : 50 derniers tours (modèle, durée, essais, compte, erreur typée) sur `GET /` |

## Déviations assumées par rapport au port (documentées dans les tests)

- flux vide **retenté** (ny-gemini-acp échouait immédiatement) ;
- divergence en fin de flux **non retentie** si du texte a déjà été émis (ny-gemini-acp réessayait en vain : chaque tentative est une nouvelle conversation) ;
- un flux sans **aucune** sortie exploitable (même sans `wrb.fr`) est une erreur `empty`, pas un succès muet.

## Bornes de sécurité

Corps de requête 4 Mio · frame 8 Mio · accumulateur brut 64 Kio · 256 tool-events max par flux · jetons de page TTL 10 min · timeout amont 180 s (configurable). Le cookie est un secret : fichier gitignoré, jamais dans les logs.

## Démarrer

```sh
pnpm webapi          # autonome : 127.0.0.1:8081 — voir NYW_WEBAPI_* dans src/config.ts
pnpm dev             # intégré : le serveur web démarre la passerelle (apps/web/src/server/embed.ts)
```

Leçons Node (consignées) : avec `agent: false`, `https.request` IGNORE `createConnection` et contourne le tunnel — laisser `agent` indéfini ; un tunnel CONNECT se détruit à la main sur `end`/`close` de la réponse, la propagation de `close_notify` à travers les pipes n'est pas garantie.

Tâches : M7 ✅, M8 ✅ (multi-comptes, proxy, journal amont, diagnostic étendu — 2026-11-17) — voir MILESTONES.md.
