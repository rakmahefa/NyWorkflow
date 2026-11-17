# Plan — Phase 2 : passerelle webapi intégrée

> La phase 1 (v0.1.0, M0..M6) est archivée dans [PLAN-old.md](PLAN-old.md) et [MILESTONES-old.md](MILESTONES-old.md). La numérotation des jalons continue à partir de M7.

## Vision

La passerelle qui parle à Gemini vit **dans ce repo** : `packages/webapi` (`@nyworkflow/webapi`). C'est la refonte moderne et maintenue de `ny-gemini-acp` (Rust, non maintenu, dont la méthode cassait à chaque évolution de l'interface web) — pour l'instant avec le provider Gemini, demain d'autres. NyWorkflow redevient auto-suffisant : un seul repo à cloner, un seul endroit à patcher.

## Pourquoi la refonte

`ny-gemini-acp` cassait tout le temps parce que le protocole instable y était **codé en dur** : version `bl` figée, table de modèles dans le code, jetons de page jamais rafraîchis en cas d'échec. La refonte inverse chaque cause :

| Ça cassait parce que… | La refonte répond… |
|---|---|
| `bl` (version du serveur web Gemini) périme | auto-découverte depuis la page `/app` à chaque démarrage + sur échec, constante de repli, surcharge env |
| Google renomme ses modèles / change les modes | table de modèles **data-driven** (`models.json` surchargeable sans toucher au code) |
| jetons de page (`at`, `push_id`, `pctx`) périmés | TTL 10 min **et** rafraîchissement forcé avant chaque retry HTTP 4xx |
| divergences du flux (snapshots non préfixes) tuent la réponse | détection de divergence + retry avec backoff exponentiel et jitter (rien de perdu tant que rien n'est émis) |
| diagnostics muets | erreurs typées (auth / réseau / amont / modèle inconnu / divergence), messages clairs en français, endpoint `/` d'état |

## Principes

1. **Simple d'abord** : si une feature n'est pas dans le milestone, elle n'existe pas.
2. **Isoler l'instable, à l'intérieur** : tout le savoir-faire Gemini vit dans `packages/webapi` ; le reste du monorepo ne le voit qu'à travers l'interface OpenAI-compatible de `adapter-llm`. Gemini évolue → on patche **ce repo**, dans un seul package.
3. **Zéro dépendance runtime** : `node:http`, `node:crypto`, `fetch` natif. Pas d'Express, pas d'Hono, pas d'SDK.
4. **Data-driven par défaut** : tout ce que Google peut changer (modèles, `bl`) est une donnée surchargeable, pas une constante cachée.
5. **Testé sans réseau** : maquette HTTP de l'interface Gemini (page + flux `StreamGenerate`) → toute la chaîne est prouvée en intégration, cookie expiré compris.
6. **Un milestone à la fois, testé** — et à chaque fin de milestone atteint, **les milestones futurs sont réécrits** (règle de gouvernance, voir MILESTONES.md).

## Ordre

```
M7 webapi cœur (client Gemini + serveur OpenAI-compatible) ──► M8 durcissement ✅
        │                                                   (intégration au démarrage, paramètres,
        ▼                                                    multi-comptes, proxy, journal, USERGUIDE)
   M9 stabilité & auth multi-sessions ✅ ──► M10 API élargie ✅ ──► M11 v0.2.0
        (/u/N par compte, expiration          (/v1beta Google-style,       (dégel du contrat, shell optionnel,
         vue d'avance, stats par compte)       tools OpenAI, splitter        multi-workspaces, tag et release)
                                             jamais perdant)
```

## Points de décision

- **Fin M7** : la maquette couvre-t-elle tous les cas d'échec observés historiquement (401, divergence, flux vide) ? Sinon, les cas manquants entrent dans M8. ✔ Couvert — M8 a ajouté la rotation multi-comptes sur 401 et le proxy.
- **Fin M8** : dégeler `/v1beta` et les outils dans l'API, ou garder le socle minimal ? ✔ Décision : **reporté** (M10) — aucun besoin réel exprimé ; M9 privilégie la stabilité des comptes (expiration visible, `/u/N` par compte), la douleur la plus fréquente à l'usage.
- **Fin M9** : le socle multi-comptes est-il assez stable pour servir de base à v0.2.0 ? ✔ Décision : **oui** (sessions par compte, expiration vue d'avance, stats — prouvés bout en bout contre la maquette, 322 tests) ; l'API élargie reste conditionnelle (M10) et v0.2.0 garde son périmètre d'origine (M11). Leçon actée : tout futur ajout sur `GET /` et `/v1/*` reste **additif** — les champs M8/M9 ne seront jamais renommés.
- **Fin M10** : le besoin d'API élargie a-t-il été exprimé, et la livraison a-t-elle déplacé les frontières ? ✔ Décision : le pilote a lancé M10 — livré (deux surfaces : `/v1beta` Google-style + `tools` OpenAI, 386 tests, vérifié bout en bout sur CLI réel). Les frontières n'ont pas bougé : Gemini reste confiné dans `packages/webapi`, les outils du client passent par le prompt (l'interface web ne sait pas faire autrement) et le décodage en flux ne perd jamais de texte. L'additivité est testée (chemins sans outils inchangés octet pour octet).
- Le format de contrat ICM v1 reste figé jusqu'à v0.2.0 (décision M4, inchangée).

## Risques

| Risque | Parade |
|---|---|
| Google change le protocole (payload, frames) | tout dans `packages/webapi`, tests de non-régression sur la forme du payload et le décodage des frames ; la parade ultime reste `W2A_URL` : n'importe quel serveur OpenAI-compatible remplace la passerelle |
| Compte Google bloqué / cookie expiré | erreur typée `authentication` avec message actionnable ; le cookie est un fichier local jamais commis |
| Exposition réseau accidentelle | boucle 127.0.0.1 par défaut, aucune clé API ni CORS tant que ce n'est pas un milestone |
| Scope creep | refuser toute feature hors milestone courant |

## Maintenance

- Changement Gemini → patch `packages/webapi` → un seul repo, un seul commit.
- L'avancement (% et cases) vit dans README.md et MILESTONES.md, mis à jour à chaque livraison.
- `ny-gemini-acp` reste en référence historique (`llm-provider` = source du protocole) ; plus aucune dépendance logicielle vers lui.
