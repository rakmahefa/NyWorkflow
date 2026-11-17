# Architecture

## Vue d'ensemble

```
┌───────────────────────────── NyWorkflow (ce repo) ─────────────────────────────┐
│                                                                                │
│  apps/web — UI React + Vite, port 3080                                         │
│    │                                                                           │
│  packages/core — moteur ICM : lit le workspace, exécute les étapes             │
│    │         │                                                                 │
│    │         ├── packages/session — journal append-only JSONL                  │
│    │         └── packages/tools — outils fichier + permissions                 │
│    │                                                                           │
│  packages/adapter-llm — client OpenAI-compatible (unique sortie modèle)        │
│    │                                                                           │
│  packages/webapi — passerelle : interface web Gemini ↔ OpenAI-compatible       │
└──────┬─────────────────────────────────────────────────────────────────────────┘
       │ HTTPS (cookies de session, protocole batchexecute interne)
┌──────▼────────────────────────────────────────────────────────────────────────┐
│  gemini.google.com — l'interface web Gemini (non officielle)                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

Le serveur web embarque aussi deux API same-origin (plugin Vite, branchées en dev comme en preview) : `/sessions` (journaux — le navigateur y lit et écrit les échanges, il ne touche jamais les fichiers) et `/workspaces` (moteur ICM — exécution des étapes côté serveur, état des runs, approbations d'outils et aperçu des fichiers sous garde de périmètre). Les journaux vivent sous `.nyworkflow/` à la racine du repo, les workspaces sous `examples/workspaces/` — deux emplacements surchargeables par `NYW_HOME` et `NYW_WORKSPACES`.

La passerelle `packages/webapi` (`pnpm webapi`, 127.0.0.1:8081 par défaut) est la refonte moderne de ny-gemini-acp — directement dans le monorepo. Le proxy `/api` du serveur web la rejoint en same-origin ; `W2A_URL` permet de lui substituer n'importe quel serveur OpenAI-compatible.

## Les 5 règles

1. **Le système de fichiers est l'orchestrateur** (ICM). Numérotation = ordre, dossier = périmètre, fichier = état. Aucune séquence codée en dur.
2. **Gemini n'est jamais touché directement.** Seul `packages/webapi` connaît Gemini (cookies, SAPISIDHASH, payload `f.req`, frames, `bl`). Gemini évolue → on patche ce package, le reste du monorepo ne bouge pas. Et si le protocole venait à casser durablement : `W2A_URL` pointe l'adaptateur vers n'importe quel serveur OpenAI-compatible.
3. **Tout est fichier plat.** Contrats en Markdown, sessions en JSONL, sorties en Markdown. Observable par défaut, diffable via Git.
4. **Pas de framework d'injection.** Des imports directs et des interfaces TypeScript. Zéro magie, zéro Cordis.
5. **Un milestone à la fois, testé.** Voir MILESTONES.md.

## Packages

| Package | Responsabilité | Ne fait pas |
|---|---|---|
| `apps/web` | UI : sessions, chat, vue workflow (étapes, progression, sorties) ; serveurs `/sessions` + `/workspaces` (plugin Vite, dev et preview) | logique métier |
| `packages/core` | parsing workspace ICM, exécution des étapes, boucle d'agent (outils) | appels réseau |
| `packages/session` | journalisation append-only, relecture, fork, dérivation (messages + activité d'outils) | transformations |
| `packages/adapter-llm` | client OpenAI-compatible, streaming SSE (appelé same-origin via le proxy `/api` du serveur web) | parsing Gemini |
| `packages/webapi` | passerelle : interface web Gemini servie en OpenAI-compatible (auth SAPISIDHASH, f.req, frames wrb.fr, `bl` auto-découvert, retries) — serveur HTTP + CLI `pnpm webapi` | orchestration, sessions, outils |
| `packages/tools` | read / write / ls / glob, garde de périmètre (racine du workspace) | politique d'exécution |

## Workspace ICM (ce que le moteur exécute)

```
mon-workflow/
├── CONTEXT.md        # la carte : étapes, règles (max 80 lignes)
├── 01-recherche/
│   ├── CONTEXT.md    # le contrat : Entrées / Process / Sorties
│   └── output/       # la sortie devient l'entrée de l'étape 2
└── 02-redaction/
    ├── CONTEXT.md
    └── output/
```

Exemple complet : `examples/workspaces/exemple-rapport/`.

## Flux d'une exécution

1. L'utilisateur crée un run dans l'onglet Workflows (le sujet devient une session journalisée) et lance l'étape suivante — depuis l'UI ou via `/workspaces/.../advance`.
2. `core` lit la carte (CONTEXT.md racine) puis le contrat de l'étape, et charge les entrées **sur disque, à l'instant** — la sortie de l'étape N est l'entrée de l'étape N+1, version éditée comprise.
3. `core` assemble le contexte et l'envoie via le client LLM injecté (server-side, vers la passerelle).
4. La réponse est écrite telle quelle dans `output/` — vérifiable, éditable, versionnable — et chaque événement (`stage.started`, `stage.output`, `run.completed`) est journalisé par `session` (JSONL).
5. Pause au checkpoint : l'humain relit (la vue workflow prévisualise le contenu actuel des sorties via `/workspaces/:name/file`, même garde de périmètre que les outils), édite, puis relance l'étape suivante. L'état du run se dérive du journal — il survit aux redémarrages.

## Outils et permissions (M5)

Avec `"tools": true` dans `advance`, l'étape devient une petite boucle d'agent :

```
modèle ──► {"tool":"read","args":{…}}   (JSON une-ligne strict)
   ▲                │
   │                ▼
   │      tools : garde de périmètre (racine du workspace)
   │        ├─ read / ls / glob : exécution auto, résultat renvoyé au modèle
   │        ├─ write : PAUSE — l'UI montre la carte d'approbation
   │        └─ hors périmètre : REFUS — journalisé (tool.call + tool.result ok:false)
   └── résultat ou refus, en JSON {"ok":true,"result":…} / {"ok":false,"error":…}
```

- **La décision humaine** passe par `POST /workspaces/:name/runs/:id/approval` (`{"decision":"approve"|"refuse"}`) : approuvé, le write s'exécute et l'étape reprend ; refusé, le modèle est informé et continue sans l'écriture.
- **Le journal est la vérité** : `tool.call` / `tool.result` à chaque tour, l'appel en attente = `tool.call` sans `tool.result`. L'état `approval` se dérive du journal (redémarrage inclus), et `tool.result.data` permet de rejouer la conversation à l'identique lors de la reprise.
- **Garde-fous** : périmètre lexical + realpath (un symlink ne sort pas du workspace), 8 appels d'outils max par tentative, read borné à 32 Kio, write à 128 Kio, ls/glob à 500 entrées. `shell` reste hors périmètre en v0.1.0.

## Frontières de maintenance

| Quand ça casse… | On touche… | Taille du patch |
|---|---|---|
| Gemini change son interface web | `packages/webapi` uniquement (modèles = une donnée via `NYW_WEBAPI_MODELS_FILE`) | petit |
| Google renomme ses modèles | un JSON de table de modèles, zéro code | trivial |
| On veut un autre modèle/serveur | `W2A_URL` de l'adaptateur | trivial |
| Nouveau workflow ou étape | un dossier + CONTEXT.md | zéro code |
| Nouvel outil | `packages/tools` | petit |

## Décisions clés

- **D1 — Projet neuf en TypeScript**, pas un fork de deepseek-harness : ses 45 packages Cordis sont exactement la dette que NyWorkflow veut éviter. On garde l'UX, pas le moteur.
- **D2 — Passerelle, pas portage** (phase 1) : réutiliser `gemini-web2api` (ny-gemini-acp) plutôt que réécrire auth/stream en TS. **Révisée en phase 2 (M7)** : ny-gemini-acp est non maintenu et cassait à chaque évolution — la passerelle est désormais **réimplémentée dans le repo** (`packages/webapi`), en portant le protocole mais en inversant chaque cause de casse (`bl` auto-découvert, modèles data-driven, jetons rafraîchis avant retry). L'isolement demeure : un seul package connaît Gemini. **Révisée en M8** : la passerelle est de surcroît **intégrée au serveur web** (`apps/web/src/server/embed.ts`) — `pnpm dev` démarre tout ; le CLI autonome (`pnpm webapi`) reste pour les usages dédiés, et `W2A_URL` continue de désigner n'importe quel serveur OpenAI-compatible externe. **Révisée en M9** : l'adresse de session devient **une donnée par compte** (manifeste `accounts.json`, data-driven et relu à chaud) — chaque fichier de cookies porte son `/u/N`, la rotation change de session toute seule, et l'expiration des cookies est visible au diagnostic avant l'échec. **Révisée en M10** : la passerelle parle les **deux dialectes de clients** (OpenAI `/v1` avec `tools`, Google `/v1beta` `generateContent`) — les outils du client passent par une convention de blocs dans le prompt (l'interface web ne connaît pas les function declarations), décodée en flux par un splitter jamais perdant ; les extensions natives de Gemini restent volontairement non exposées. Tout ajout reste **additif** sur `GET /` et `/v1/*`.
- **D2bis — Zéro dépendance runtime** pour la passerelle : `node:http`, `node:crypto`, `fetch` natif — la chaîne de test ne dépend d'aucun serveur externe (maquette HTTP de l'interface Gemini).
- **D3 — ICM pur** : pas de chat libre, pas de multi-agents. Un agent, des étapes, des fichiers.
- **D4 — Sessions en JSONL append-only** : l'historique envoyé au modèle est toujours re-dérivé du journal.
- **D5 — Outils enfermés dans le workspace** : tout chemin sortant de la racine est refusé.
