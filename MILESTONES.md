# Milestones

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

## M5 — Outils + permissions · 10 %

Objectif : laisser l'agent lire/écrire dans le workspace, sous contrôle.

- [ ] Outils : `read`, `write`, `ls`, `glob` (`shell` en option)
- [ ] Permissions : périmètre = racine du workspace, approbation via l'UI
- [ ] Appels d'outils journalisés dans la session
- [ ] Tests : exécution + refus hors périmètre

**Livré quand :** un outil hors périmètre est refusé et journalisé.

## M6 — Vue workflow + v0.1.0 · 10 %

Objectif : voir le pipeline, livrer.

- [ ] Vue workflow : étapes, progression, prévisualisation des sorties
- [ ] README final (captures, guide utilisateur)
- [ ] Nettoyage et tag `v0.1.0`

**Livré quand :** tag `v0.1.0` poussé et docs à jour.
