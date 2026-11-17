# Milestones — Phase 1 (v0.1.0) · ARCHIVÉ

> **Archivé le 2026-11-17** : M0..M6 livrés, v0.1.0 taggée, avancement 100 %.
> La phase 2 (passerelle webapi intégrée) vit dans [MILESTONES.md](MILESTONES.md),
> la numérotation y continue à partir de M7.

Un milestone = petit, testé, livrable. Le suivant ne démarre que si `pnpm test` est vert.

La somme des poids fait 100 %. L'avancement global est mis à jour dans le README à chaque livraison.

## M0 — Fondations · 10 % · ✅ Terminé (2026-11-17)

- [x] Docs : README, ARCHITECTURE, PLAN, MILESTONES
- [x] Squelette : monorepo pnpm, `apps/web` + 4 packages, `CONTEXT.md` par dossier
- [x] Workspace ICM d'exemple (`examples/workspaces/exemple-rapport`)

## M1 — UI web + tests · 20 % · ✅ Terminé (2026-11-17)

Objectif : une UI utilisable sans backend, fidèle à l'esprit deepseek-harness.

- [x] `pnpm dev` démarre `apps/web` sur `127.0.0.1:3080`
- [x] Sidebar sessions (liste, nouvelle session)
- [x] Zone de chat + streaming simulé (réponses factices, aucune API)
- [x] Commandes locales : `/new`, `/help`, `/clear`
- [x] Vitest : commandes + état des sessions — 22 tests
- [x] Playwright : ouvrir la page, envoyer un message, créer une session — 3 tests
- [x] CI GitHub Actions : typecheck + build + tests + artefacts (dist, rapports)

**Livré quand :** `pnpm test` vert et démo sans backend possible. ✔

## M2 — Adaptateur LLM · 15 % · ✅ Terminé (2026-11-17)

Objectif : parler à la passerelle `gemini-web2api` (OpenAI-compatible).

- [x] Interface `LlmAdapter` + implémentation fetch/SSE dans `packages/adapter-llm` (repli `/v1beta/models` sur 404, annulation mid-flux)
- [x] Sélecteur de modèle dans l'UI (via `/v1/models`), proxy same-origin `/api` — zéro CORS
- [x] Chat réel en streaming depuis l'UI
- [x] Message d'erreur clair si la passerelle est absente (+ repli simulé, jamais d'échec silencieux)
- [x] Tests : serveur mock OpenAI-compatible — 11 tests Vitest sans réseau
- [x] CI : capture d'écran README auto-actualisée (job dédié, artefact, commit `[skip ci]`)

**Livré quand :** une question posée dans l'UI obtient une vraie réponse Gemini streamée. ✔ (vérifié e2e contre une maquette SSE ; passerelle réelle à la première utilisation)

## M3 — Sessions persistantes · 15 % · ✅ Terminé (2026-11-17)

Objectif : fermer et rouvrir sans perdre l'historique.

- [x] Événements append-only en JSONL sous `.nyworkflow/sessions/` — un fichier par session, jamais réécrit (`session.created` avec titre, `user.message`, `assistant.message`, `session.forked`)
- [x] Rechargement d'une session au redémarrage — hydratation au boot via `GET /sessions` (plugin Vite, dev **et** preview, home `.nyworkflow/` surchargeable par `NYW_HOME`) ; repli mémoire avec message clair si l'API est absente
- [x] Fork de session (copie du journal) — copie octet pour octet + un événement `session.forked` ; bouton Fork dans la sidebar, historique hérité, la copie vit sa vie
- [x] Tests : écriture, relecture, fork du journal — 17 tests dans le package (ligne déchirée, journal corrompu, id invalide) + test d'intégration « redémarrage du serveur Vite » + 3 e2e (rechargement, fork, /clear append-only)

**Livré quand :** redémarrer le serveur restaure les sessions intactes. ✔ (prouvé par le test d'intégration : boot → échange → fork → arrêt/relance du serveur de dev → tout revient à l'identique ; e2e : rechargement de page, fork, /clear)

## M4 — Moteur ICM · 20 % · ✅ Terminé (2026-11-17)

Objectif : exécuter un workspace d'étapes — le cœur du projet.

- [x] Parsing du workspace : carte racine + contrats `CONTEXT.md` (Entrées / Process / Sorties)
- [x] Exécution d'une étape : contexte assemblé → LLM → sortie écrite dans `output/`
- [x] Chaînage : la sortie de l'étape N est proposée en entrée de l'étape N+1
- [x] Checkpoints : pause entre étapes, reprise manuelle
- [x] Tests : parsing + exécution sur le workspace d'exemple (LLM mocké)

**Livré quand :** `examples/workspaces/exemple-rapport` s'exécute de bout en bout. ✔ (prouvé en intégration sur le vrai serveur Vite : sujet → étape 1 → checkpoint → étape 2 → done, sorties sur disque, reprise après redémarrage du serveur ; LLM maquette OpenAI-compatible)

Détail de la livraison :

- `packages/core` — `parse.ts` (carte + contrats, format v1 **figé** jusqu'à v0.2.0 : sections Entrées/Process/Sorties, chemins entre backticks, une entrée non-fichier = le sujet, une sortie par étape), `prompt.ts` (assemblage pur), `engine.ts` (`runStage`, `createRun` avec pause à chaque étape, `runStateFromEvents` — l'état dérivé du journal, donc survivant aux redémarrages). Le LLM est injecté (`StageLlm`) : core ne fait aucun HTTP.
- Le chaînage est déclaratif : les entrées sont relues sur disque à chaque exécution — un humain peut éditer une sortie au checkpoint, l'étape suivante lit la version éditée.
- `apps/web` — API `/workspaces` (plugin Vite, dev et preview) : listing, détail + contrats + runs, création de run (le sujet devient une session journalisée), `advance` pour exécuter l'étape suivante côté serveur (garde anti-double-exécution 409). La vue workflow dans l'UI arrive en M6 ; l'API est pilotable aujourd'hui.

## M5 — Outils + permissions · 10 % · ✅ Terminé (2026-11-17)

Objectif : laisser l'agent lire/écrire dans le workspace, sous contrôle.

- [x] Outils : `read`, `write`, `ls`, `glob` (`shell` reste optionnel — hors périmètre v0.1.0)
- [x] Permissions : périmètre = racine du workspace, approbation via l'UI
- [x] Appels d'outils journalisés dans la session
- [x] Tests : exécution + refus hors périmètre

**Livré quand :** un outil hors périmètre est refusé et journalisé. ✔ (prouvé en unitaire dans `packages/tools` et `packages/core`, en intégration sur le vrai serveur Vite — journal JSONL relu ligne à ligne — et en e2e : la carte d'approbation s'affiche dans l'UI, l'humain décide, l'étape reprend)

Détail de la livraison :

- `packages/tools` — garde de périmètre lexicale **et** realpath (un symlink ne sort pas du workspace), `read`/`ls`/`glob` auto-exécutés, `write` seul outil dangereux. Bornes : read 32 Kio, write 128 Kio, ls/glob 500 entrées, glob profondeur 8. Tout refus est un résultat structuré avec résumé français — jamais une exception silencieuse.
- `packages/core` — la boucle d'agent dans `runStage` (`tools: true`) : protocole JSON une-ligne strict (`{"tool":"…","args":{…}}`, toute autre réponse = l'artefact final, comportement M4 inchangé), 8 appels max par tentative. Un write valide et dans le périmètre **met l'étape en pause** (état `approval`), `resolve('approve'|'refuse')` exécute ou refuse puis poursuit la boucle ; `resumeStage` rejoue la conversation depuis le journal (`tool.result.data`, champ additif) — la reprise est identique après un redémarrage serveur.
- `packages/session` — contrat gelé étendu de façon additive : `data` sur `tool.result`, `model` sur `stage.started` (l'approbation n'a pas à redemander le modèle). Les journaux antérieurs restent lisibles ; `deriveSession` expose l'activité d'outils (appel apparié à son résultat, en attente = sans résultat).
- `apps/web` — API : `advance` accepte `tools`, nouvel endpoint `POST /workspaces/:name/runs/:id/approval` (garde 409 anti double-exécution partagée, `advance` pendant une approbation = 409 clair) ; `RunDto` porte l'activité d'outils. UI : carte d'approbation (Approuver / Refuser) et activité d'outils pour la session de run active — la décision se prend dans l'UI, plus besoin de curl.
- Tests : 131 unitaires (21 session + 11 adapter + 16 tools + 43 core + 40 web dont 4 intégration outils) + 10 e2e (2 nouveaux : approbation et refus depuis l'UI).

## M6 — Vue workflow + v0.1.0 · 10 % · ✅ Terminé (2026-11-17)

Objectif : voir le pipeline, livrer.

- [x] Vue workflow : étapes, progression, prévisualisation des sorties
- [x] README final (captures, guide utilisateur)
- [x] Nettoyage et tag `v0.1.0`

**Livré quand :** tag `v0.1.0` poussé et docs à jour. ✔

Détail de la livraison :

- `apps/web` — onglets Sessions / Workflows dans la barre latérale ; la vue workflow affiche la carte du workspace (dépliable), le pipeline d'étapes (Fait / En cours / À venir, dérivé de l'état du run — `lib/progress.ts`, pur et testé), la liste des runs, la création de run et l'exécution d'étape depuis l'UI (modèle piloté par le sélecteur d'en-tête), la carte d'approbation M5 rejouée dans la vue, et la prévisualisation des sorties — un clic, le contenu **actuel** du fichier, lu sur disque.
- API additive : `GET /workspaces/:name/file?path=…` (aperçu en lecture seule sous la même garde de périmètre que les outils — lexicale **et** realpath, 128 Kio max) ; `RunDto.outputs` (fichiers écrits par étape, dérivés du journal, ordre de première écriture). Le run créé dans l'UI apparaît aussitôt dans l'onglet Sessions (store synchronisé) — un run EST une session.
- Capture README : la scène joue désormais la vue workflow (run créé, étape exécutée, sortie prévisualisée) sur un vrai Chromium en CI.
- Nettoyage : versions 0.1.0 partout (racine + 5 packages + `APP_VERSION`), guide utilisateur dans le README, avancement 100 %.
- Tests : 139 unitaires (21 session + 11 adapter + 16 tools + 43 core + 48 web dont 4 intégration /workspaces) + 12 e2e (2 nouveaux : pipeline complet depuis l'UI — progression, prévisualisation, session synchronisée — et approbation d'un write depuis la vue workflow). Le spec e2e travaille sur une copie dédiée du workspace (créée puis supprimée) : aucune course avec les autres specs.
