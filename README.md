# NyWorkflow

[![CI](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/rakmahefa/NyWorkflow/actions/workflows/ci.yml)

NyWorkflow est un harness web qui exécute des workflows IA à partir de simples dossiers — la méthode ICM (Interpretable Context Methodology) — propulsé par Gemini via votre passerelle locale `gemini-web2api`.

> Un agent. Des dossiers. Pas de framework d'orchestration.

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

L'UI M1 tourne sans backend : chat à réponses simulées, commandes `/new`, `/help`, `/clear`.

CI : à chaque push/PR — typecheck, build, Vitest, Playwright, puis artefacts (UI construite, rapports de tests). Voir l'onglet [Actions](https://github.com/rakmahefa/NyWorkflow/actions).

Pour les réponses Gemini réelles (dès M2) : démarrer la passerelle `gemini-web2api` du repo ny-gemini-acp sur `http://127.0.0.1:8081`.

## Avancement — 30 %

| Milestone | Contenu | Poids | État |
|---|---|---:|---|
| M0 | Fondations : docs, architecture, squelette | 10 % | ✅ Terminé |
| M1 | UI web + tests + CI (chat simulé) | 20 % | ✅ Terminé |
| M2 | Adaptateur LLM (passerelle web2api) | 15 % | ⬜ À faire |
| M3 | Sessions persistantes (JSONL) | 15 % | ⬜ À faire |
| M4 | Moteur ICM (étapes, CONTEXT.md) | 20 % | ⬜ À faire |
| M5 | Outils + permissions | 10 % | ⬜ À faire |
| M6 | Vue workflow + v0.1.0 | 10 % | ⬜ À faire |

Détail et critères de livraison : [MILESTONES.md](MILESTONES.md) · Plan : [PLAN.md](PLAN.md)

## Structure

```
apps/web              UI web (React + Vite, port 3080)
packages/core         moteur ICM : étapes, contrats, exécution
packages/session      sessions = journal append-only JSONL
packages/adapter-llm  client OpenAI-compatible (→ gemini-web2api)
packages/tools        outils fichier/shell + permissions
examples/workspaces   workspace ICM d'exemple
```

Chaque dossier de code contient son `CONTEXT.md` (rôle, entrées, sorties) — le repo pratique lui-même la méthode qu'il exécute.

## Licence

MIT — voir [LICENSE](LICENSE).
