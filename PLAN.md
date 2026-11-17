# Plan

## Vision

Un harness web minimal où les workflows IA sont des dossiers lisibles (ICM), exécutés par un seul agent Gemini — et simple à maintenir même quand Gemini évolue.

## Principes

1. **Simple d'abord** : si une feature n'est pas dans un milestone, elle n'existe pas.
2. **Fichiers plats** : Markdown et JSONL, pas de base de données.
3. **Isoler l'instable** : Gemini derrière `gemini-web2api`, jamais dans le cœur.
4. **Testé à chaque milestone** : `pnpm test` vert = milestone livré.

## Ordre

```
M0 fondations ──► M1 UI web + tests ──► M2 adaptateur LLM ──► M3 sessions
                                                              │
   v0.1.0 ◄── M6 vue workflow ◄── M5 outils ◄── M4 moteur ICM ◄┘
```

Logique : d'abord ce qui se voit et se teste (M1), puis la plomberie (M2–M3), puis le cœur métier (M4–M5), puis la finition (M6).

## Points de décision

- **Fin M2** : la passerelle web2api tient-elle la charge en usage quotidien ? Sinon, portage TS de l'adaptateur (option documentée, jamais pressentie).
- **Fin M4** : le format de contrat CONTEXT.md v1 est figé jusqu'à v0.2.0.

## Risques

| Risque | Parade |
|---|---|
| Gemini casse son interface web | isolé dans ny-gemini-acp ; NyWorkflow continue avec tout serveur OpenAI-compatible |
| Scope creep | refuser toute feature hors milestone courant |
| UI trop ambitieuse | M1 = chat simulé, rien de plus |
| Perte d'historique | sessions append-only JSONL sous Git |

## Maintenance

- Changement Gemini → patch ny-gemini-acp → aucun commit ici.
- L'avancement (% et cases) vit dans README.md et MILESTONES.md, mis à jour à chaque livraison.
