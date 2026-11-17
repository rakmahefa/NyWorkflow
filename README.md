# NyWorkflow

[![CI](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml)

NyWorkflow est un harness web qui exécute des workflows IA à partir de simples dossiers — la méthode ICM (Interpretable Context Methodology) — propulsé par Gemini via votre passerelle locale `gemini-web2api`.

> Un agent. Des dossiers. Pas de framework d'orchestration.

## Aperçu

![UI NyWorkflow — sessions, chat streamé, sélecteur de modèle](docs/assets/screenshot.png)

*Capture jouée par la CI sur un vrai Chromium et actualisée à chaque push sur main.*

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

L'UI fonctionne avec ou sans passerelle. Sans `gemini-web2api` : chat en mode simulé (réponses factices, `/new`, `/help`, `/clear`) avec un message clair. Avec la passerelle lancée sur `http://127.0.0.1:8081` (repo ny-gemini-acp) : streaming réel, sélecteur de modèles, le tout same-origin via le proxy `/api` du serveur web — zéro CORS.

Les sessions sont journalisées en append-only sous `.nyworkflow/sessions/` (JSONL, un fichier par session). Fermez l'UI, relancez `pnpm dev` : tout revient — titres, messages, forks. Le bouton **Fork** copie un journal pour explorer une variante sans toucher à l'original ; `/clear` vide l'affichage, jamais le journal. Les messages système (retours de commandes, état de la passerelle) restent éphémères : seuls les échanges user/assistant sont journalisés — c'est exactement l'historique renvoyé au modèle.

### Exécuter un workflow ICM

Le moteur est opérationnel : un workspace (carte racine + étapes numérotées + contrats `CONTEXT.md`) s'exécute étape par étape via l'API `/workspaces`, sans écrire une ligne de code —

```sh
# lister les workspaces (ceux d'exemples, ou NYW_WORKSPACES=votre-dossier)
curl -s http://127.0.0.1:3080/workspaces

# créer un run : le sujet devient une session journalisée
RUN=$(curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs \
  -H 'content-type: application/json' -d '{"subject": "Les loutres de Madagascar"}' | jq -r .id)

# exécuter l'étape suivante (checkpoint après chaque étape, reprise manuelle)
curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs/$RUN/advance \
  -H 'content-type: application/json' -d '{"model": "gemini-2.5-flash"}'
# → 01-recherche/output/faits.md, puis 02-redaction/output/rapport.md
```

Chaque étape relit ses entrées sur disque : éditez `faits.md` au checkpoint, l'étape suivante travaille votre version. L'état d'un run survit aux redémarrages (dérivé du journal). Le format de contrat `CONTEXT.md` est figé en v1 jusqu'à v0.2.0.

### Les outils de l'agent, sous contrôle humain (M5)

Ajoutez `"tools": true` à `advance` : l'étape devient une petite boucle d'agent. Le modèle peut `read` / `ls` / `glob` dans le workspace (exécution automatique, résultat renvoyé au modèle) et `write` — mais toute écriture **met le run en pause** et attend votre décision :

```sh
# étape avec outils — le modèle demande un write, l'étape se met en pause
curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs/$RUN/advance \
  -H 'content-type: application/json' \
  -d '{"model": "gemini-2.5-flash", "tools": true}'
# → {"state":{"status":"approval","tool":"write","args":{"path":"…"}}}

# la décision humaine (ou cliquez Approuver dans l'UI)
curl -s -X POST http://127.0.0.1:3080/workspaces/exemple-rapport/runs/$RUN/approval \
  -H 'content-type: application/json' -d '{"decision": "approve"}'
```

Dans l'UI, la session du run affiche la carte d'approbation et l'activité d'outils — approuver ou refuser se fait d'un clic, l'étape reprend toute seule. Tout appel et tout refus sont journalisés (`tool.call` / `tool.result`) : un chemin hors workspace est refusé et tracé, jamais silencieux. La garde est lexicale **et** realpath — un symlink ne s'échappe pas. `shell` reste volontairement hors périmètre en v0.1.0.

CI à chaque push/PR : typecheck, build, Vitest, Playwright, puis artefacts (UI construite, rapports de tests, capture README). Voir l'onglet [Actions](https://github.com/rakmahefa/NyWorkflow/actions).

## Avancement — 90 %

| Milestone | Contenu | Poids | État |
|---|---|---:|---|
| M0 | Fondations : docs, architecture, squelette | 10 % | ✅ Terminé |
| M1 | UI web + tests + CI (chat simulé) | 20 % | ✅ Terminé |
| M2 | Adaptateur LLM (passerelle web2api) | 15 % | ✅ Terminé |
| M3 | Sessions persistantes (JSONL, fork) | 15 % | ✅ Terminé |
| M4 | Moteur ICM (étapes, CONTEXT.md) | 20 % | ✅ Terminé |
| M5 | Outils + permissions (approbation UI) | 10 % | ✅ Terminé |
| M6 | Vue workflow + v0.1.0 | 10 % | ⬜ À faire |

Détail et critères de livraison : [MILESTONES.md](MILESTONES.md) · Plan : [PLAN.md](PLAN.md)

## Structure

```
apps/web              UI web (React + Vite, port 3080)
packages/core         moteur ICM : étapes, contrats, exécution, boucle d'agent
packages/session      sessions = journal append-only JSONL
packages/adapter-llm  client OpenAI-compatible (→ gemini-web2api)
packages/tools        outils fichier + garde de périmètre + approbation
examples/workspaces   workspace ICM d'exemple
```

Chaque dossier de code contient son `CONTEXT.md` (rôle, entrées, sorties) — le repo pratique lui-même la méthode qu'il exécute.

## Licence

MIT — voir [LICENSE](LICENSE).
