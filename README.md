# NyWorkflow

[![CI](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml)

NyWorkflow est un harness web qui exécute des workflows IA à partir de simples dossiers — la méthode ICM (Interpretable Context Methodology) — propulsé par Gemini via votre passerelle locale `gemini-web2api`.

> Un agent. Des dossiers. Pas de framework d'orchestration.

## Aperçu

![UI NyWorkflow — vue workflow : étapes, progression, sortie prévisualisée](docs/assets/screenshot.png)

*Capture jouée par la CI sur un vrai Chromium et actualisée à chaque push sur main : un run créé dans l'onglet Workflows, la première étape exécutée (checkpoint), sa sortie prévisualisée depuis le disque.*

## Pourquoi

- **Simple** — un workflow = un dossier d'étapes numérotées, chaque étape a un `CONTEXT.md` (Entrées / Process / Sorties).
- **Robuste** — la logique fragile Gemini (cookie/OAuth, streaming) reste isolée dans [ny-gemini-acp](https://github.com/rakmahefa/ny-gemini-acp). Gemini évolue ? On patche la passerelle, jamais le harness.
- **Agnostique** — l'adaptateur parle OpenAI-compatible : n'importe quel serveur de modèle convient.

## Architecture en 10 secondes

```
UI web (apps/web) ──► core (moteur ICM) ──► adapter-llm ──► gemini-web2api ──► Gemini
      │                   │                                     (repo ny-gemini-acp)
      └──── session (journal JSONL) ◄──── tools (permissions)
```

Détails : [ARCHITECTURE.md](ARCHITECTURE.md)

## Démarrage

Prérequis : Node.js 20+, pnpm 12+.

```sh
pnpm install
pnpm dev          # UI sur http://127.0.0.1:3080
pnpm test         # Vitest — unitaires
pnpm test:e2e     # Playwright — UI réelle (télécharge Chromium au besoin)
pnpm typecheck    # TypeScript
```

L'UI fonctionne avec ou sans passerelle. Sans `gemini-web2api` : chat en mode simulé (réponses factices, `/new`, `/help`, `/clear`) avec un message clair, et l'exécution des étapes attend une passerelle. Avec la passerelle lancée sur `http://127.0.0.1:8081` (repo ny-gemini-acp) : streaming réel, sélecteur de modèles, exécution des workflows — le tout same-origin via le proxy `/api` du serveur web, zéro CORS.

## Guide utilisateur

Deux onglets, deux visages du même harness.

**Sessions** — la conversation. Posez une question, la réponse arrive en streaming ; `/new` crée, `/help` liste les commandes, `/clear` vide l'affichage sans toucher au journal. Tout est persisté en append-only sous `.nyworkflow/sessions/` (JSONL, un fichier par session) : fermez l'UI, relancez `pnpm dev`, tout revient — titres, messages, forks. Le bouton **Fork** copie un journal pour explorer une variante sans toucher à l'original.

**Workflows** — le pipeline ICM, du premier clic au rapport final :

1. Choisissez un workspace dans la barre latérale (ceux d'`examples/workspaces/`, ou pointez `NYW_WORKSPACES` vers votre dossier). La carte du workspace se déplie, les étapes s'affichent.
2. Donnez un sujet et cliquez **Nouveau run** — le sujet devient une session journalisée, visible aussi dans l'onglet Sessions.
3. Cliquez **Exécuter l'étape suivante** : le moteur assemble le contexte (carte + entrées lues sur disque à l'instant), interroge le modèle sélectionné dans l'en-tête, écrit la réponse dans `output/`. L'étape passe à **Fait**, la suivante attend.
4. À chaque checkpoint : relisez, prévisualisez les sorties (un clic, le contenu actuel du fichier), éditez-les si vous voulez — l'étape suivante lira votre version. Poursuivez jusqu'à **Terminé**.
5. Cochez **Outils** avant d'exécuter : l'étape devient une petite boucle d'agent. Le modèle peut `read` / `ls` / `glob` dans le workspace (exécution automatique) et `write` — mais toute écriture **met le run en pause** : la carte d'approbation s'affiche, vous décidez d'un clic, l'étape reprend toute seule. Tout appel et tout refus sont journalisés (`tool.call` / `tool.result`) : un chemin hors workspace est refusé et tracé, jamais silencieux — la garde est lexicale **et** realpath, un symlink ne s'échappe pas. `shell` reste volontairement hors périmètre en v0.1.0.

L'état d'un run survit aux redémarrages — il se dérive du journal, jamais d'une mémoire volatile.

### Piloter à l'API (optionnel)

Tout ce qui se fait dans l'UI se fait aussi en HTTP same-origin :

```sh
curl -s http://127.0.0.1:3080/workspaces            # listing
RUN=$(curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs \
  -H 'content-type: application/json' -d '{"subject": "Les loutres de Madagascar"}' | jq -r .id)
curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs/$RUN/advance \
  -H 'content-type: application/json' -d '{"model": "gemini-2.5-flash", "tools": true}'
curl -s "http://127.0.0.1:3080/workspaces/exemple-rapport/file?path=01-recherche/output/faits.md"
```

### Le format d'un workspace

```
mon-workflow/
├── CONTEXT.md        # la carte : objectif, tableau des étapes, règles (max 80 lignes)
├── 01-recherche/
│   ├── CONTEXT.md    # le contrat : ## Entrées / ## Process / ## Sorties
│   └── output/       # la sortie de l'étape 1 devient l'entrée de l'étape 2
└── 02-redaction/
    ├── CONTEXT.md
    └── output/
```

Le format de contrat est figé en v1 jusqu'à v0.2.0 : sections `## Entrées` / `## Process` / `## Sorties`, chemins entre backticks, une entrée non-fichier = le sujet, une sortie par étape. Exemple complet : `examples/workspaces/exemple-rapport/`.

CI à chaque push/PR : typecheck, build, Vitest, Playwright, puis artefacts (UI construite, rapports de tests, capture README). Voir l'onglet [Actions](https://github.com/rakmahefa/NyWorkflow/actions).

## Avancement — 100 % · v0.1.0

| Milestone | Contenu | Poids | État |
|---|---|---:|---|
| M0 | Fondations : docs, architecture, squelette | 10 % | ✅ Terminé |
| M1 | UI web + tests + CI (chat simulé) | 20 % | ✅ Terminé |
| M2 | Adaptateur LLM (passerelle web2api) | 15 % | ✅ Terminé |
| M3 | Sessions persistantes (JSONL, fork) | 15 % | ✅ Terminé |
| M4 | Moteur ICM (étapes, CONTEXT.md) | 20 % | ✅ Terminé |
| M5 | Outils + permissions (approbation UI) | 10 % | ✅ Terminé |
| M6 | Vue workflow + v0.1.0 | 10 % | ✅ Terminé |

Détail et critères de livraison : [MILESTONES.md](MILESTONES.md) · Plan : [PLAN.md](PLAN.md)

## Structure

```
apps/web              UI web (React + Vite, port 3080) : sessions, chat, vue workflow
packages/core         moteur ICM : étapes, contrats, exécution, boucle d'agent
packages/session      sessions = journal append-only JSONL
packages/adapter-llm  client OpenAI-compatible (→ gemini-web2api)
packages/tools        outils fichier + garde de périmètre + approbation
examples/workspaces   workspace ICM d'exemple
```

Chaque dossier de code contient son `CONTEXT.md` (rôle, entrées, sorties) — le repo pratique lui-même la méthode qu'il exécute.

## Licence

MIT — voir [LICENSE](LICENSE).
