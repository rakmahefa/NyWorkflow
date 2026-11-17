# packages/webapi — la passerelle du monorepo

Rôle : servir l'interface web Gemini (et demain d'autres providers) en OpenAI-compatible, **dans le repo** — la refonte moderne et maintenue de `ny-gemini-acp` (Rust, non maintenu). C'est le seul endroit du monorepo qui connaît Gemini : cookies, SAPISIDHASH, payload `f.req`, frames `wrb.fr`, version `bl`.

Entrées : requêtes OpenAI-compatible (`/v1/models`, `/v1/chat/completions`), cookies Gemini dans `.nyworkflow/cookies/gemini.json` (3 formats : EditThisCookie, objet `{"cookie","sapisid"}`, chaîne brute) ou `NYW_WEBAPI_COOKIES`.
Sorties : JSON et SSE au format OpenAI — exactement ce qu'`adapter-llm` consomme déjà (port 8081 par défaut = remplacement direct de l'ancienne passerelle).

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

## Déviations assumées par rapport au port (documentées dans les tests)

- flux vide **retenté** (ny-gemini-acp échouait immédiatement) ;
- divergence en fin de flux **non retentie** si du texte a déjà été émis (ny-gemini-acp réessayait en vain : chaque tentative est une nouvelle conversation) ;
- un flux sans **aucune** sortie exploitable (même sans `wrb.fr`) est une erreur `empty`, pas un succès muet.

## Bornes de sécurité

Corps de requête 4 Mio · frame 8 Mio · accumulateur brut 64 Kio · 256 tool-events max par flux · jetons de page TTL 10 min · timeout amont 180 s (configurable). Le cookie est un secret : fichier gitignoré, jamais dans les logs.

## Démarrer

```sh
pnpm webapi          # 127.0.0.1:8081 — voir NYW_WEBAPI_* dans src/config.ts
```

Tâches : M7 ✅ (2026-11-17) — voir MILESTONES.md.
