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
│    │         └── packages/tools — outils fichier/shell + permissions           │
│    │                                                                           │
│  packages/adapter-llm — client OpenAI-compatible (unique sortie modèle)        │
└──────┬─────────────────────────────────────────────────────────────────────────┘
       │ HTTP OpenAI-compatible — http://127.0.0.1:8081
┌──────▼──────────────────── ny-gemini-acp (repo séparé) ────────────────────────┐
│  gemini-web2api ── cookie/OAuth ──► interface web Gemini ──► modèle            │
└────────────────────────────────────────────────────────────────────────────────┘
```

Le serveur web embarque aussi deux API same-origin (plugin Vite, branchées en dev comme en preview) : `/sessions` (journaux — le navigateur y lit et écrit les échanges, il ne touche jamais les fichiers) et `/workspaces` (moteur ICM — exécution des étapes côté serveur, l'état des runs dérivé des journaux). Les journaux vivent sous `.nyworkflow/` à la racine du repo, les workspaces sous `examples/workspaces/` — deux emplacements surchargeables par `NYW_HOME` et `NYW_WORKSPACES`.

## Les 5 règles

1. **Le système de fichiers est l'orchestrateur** (ICM). Numérotation = ordre, dossier = périmètre, fichier = état. Aucune séquence codée en dur.
2. **Gemini n'est jamais touché directement.** Seul `gemini-web2api` connaît Gemini. Gemini évolue → on patche ny-gemini-acp, NyWorkflow ne bouge pas.
3. **Tout est fichier plat.** Contrats en Markdown, sessions en JSONL, sorties en Markdown. Observable par défaut, diffable via Git.
4. **Pas de framework d'injection.** Des imports directs et des interfaces TypeScript. Zéro magie, zéro Cordis.
5. **Un milestone à la fois, testé.** Voir MILESTONES.md.

## Packages

| Package | Responsabilité | Ne fait pas |
|---|---|---|
| `apps/web` | UI : sessions, chat, vue étapes ; serveur de sessions `/sessions` (plugin Vite, dev et preview) | logique métier |
| `packages/core` | parsing workspace ICM, exécution des étapes | appels réseau |
| `packages/session` | journalisation append-only, relecture, fork, dérivation | transformations |
| `packages/adapter-llm` | client OpenAI-compatible, streaming SSE (appelé same-origin via le proxy `/api` du serveur web) | parsing Gemini |
| `packages/tools` | read / write / ls / glob / shell + permissions | politique d'exécution |

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

1. L'utilisateur crée un run (le sujet devient une session) et lance l'étape suivante via `/workspaces/.../advance`.
2. `core` lit la carte (CONTEXT.md racine) puis le contrat de l'étape, et charge les entrées **sur disque, à l'instant** — la sortie de l'étape N est l'entrée de l'étape N+1, version éditée comprise.
3. `core` assemble le contexte et l'envoie via le client LLM injecté (server-side, vers la passerelle).
4. La réponse est écrite telle quelle dans `output/` — vérifiable, éditable, versionnable — et chaque événement (`stage.started`, `stage.output`, `run.completed`) est journalisé par `session` (JSONL).
5. Pause au checkpoint : l'humain relit, édite, puis relance `advance`. L'état du run se dérive du journal — il survit aux redémarrages.
6. Les appels d'outils passeront par `tools` (M5) avec approbation dans l'UI.

## Frontières de maintenance

| Quand ça casse… | On touche… | Taille du patch |
|---|---|---|
| Gemini change son interface web | ny-gemini-acp uniquement | petit |
| On veut un autre modèle | URL de base de l'adaptateur | trivial |
| Nouveau workflow ou étape | un dossier + CONTEXT.md | zéro code |
| Nouvel outil | `packages/tools` | petit |

## Décisions clés

- **D1 — Projet neuf en TypeScript**, pas un fork de deepseek-harness : ses 45 packages Cordis sont exactement la dette que NyWorkflow veut éviter. On garde l'UX, pas le moteur.
- **D2 — Passerelle, pas portage** : réutiliser `gemini-web2api` tel quel plutôt que de réécrire auth/stream en TS. Le savoir-faire Gemini reste à un seul endroit.
- **D3 — ICM pur** : pas de chat libre, pas de multi-agents. Un agent, des étapes, des fichiers.
- **D4 — Sessions en JSONL append-only** : l'historique envoyé au modèle est toujours re-dérivé du journal.
- **D5 — Outils enfermés dans le workspace** : tout chemin sortant de la racine est refusé.
