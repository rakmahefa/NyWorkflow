# Milestones

Un milestone = petit, testé, livrable. Le suivant ne démarre que si `pnpm test` est vert.

La somme des poids fait 100 %. L'avancement global est mis à jour dans le README à chaque livraison.

## M0 — Fondations · 10 % · ✅ Terminé (2026-11-17)

- [x] Docs : README, ARCHITECTURE, PLAN, MILESTONES
- [x] Squelette : monorepo pnpm, `apps/web` + 4 packages, `CONTEXT.md` par dossier
- [x] Workspace ICM d'exemple (`examples/workspaces/exemple-rapport`)

## M1 — UI web + tests · 20 %

Objectif : une UI utilisable sans backend, fidèle à l'esprit deepseek-harness.

- [ ] `pnpm dev` démarre `apps/web` sur `127.0.0.1:3080`
- [ ] Sidebar sessions (liste, nouvelle session)
- [ ] Zone de chat + streaming simulé (réponses factices, aucune API)
- [ ] Commandes locales : `/new`, `/help`, `/clear`
- [ ] Vitest : commandes + état des sessions (≥ 5 tests)
- [ ] Playwright : ouvrir la page, envoyer un message, créer une session

**Livré quand :** `pnpm test` vert et démo sans backend possible.

## M2 — Adaptateur LLM · 15 %

Objectif : parler à la passerelle `gemini-web2api` (OpenAI-compatible).

- [ ] Interface `LlmAdapter` + implémentation fetch/SSE dans `packages/adapter-llm`
- [ ] Sélecteur de modèle dans l'UI (via `/v1/models`)
- [ ] Chat réel en streaming depuis l'UI
- [ ] Message d'erreur clair si la passerelle est absente
- [ ] Tests : serveur mock OpenAI-compatible (Vitest, sans réseau)

**Livré quand :** une question posée dans l'UI obtient une vraie réponse Gemini streamée.

## M3 — Sessions persistantes · 15 %

Objectif : fermer et rouvrir sans perdre l'historique.

- [ ] Événements append-only en JSONL sous `.nyworkflow/sessions/`
- [ ] Rechargement d'une session au redémarrage
- [ ] Fork de session (copie du journal)
- [ ] Tests : écriture, relecture, fork du journal

**Livré quand :** redémarrer le serveur restaure les sessions intactes.

## M4 — Moteur ICM · 20 %

Objectif : exécuter un workspace d'étapes — le cœur du projet.

- [ ] Parsing du workspace : carte racine + contrats `CONTEXT.md` (Entrées / Process / Sorties)
- [ ] Exécution d'une étape : contexte assemblé → LLM → sortie écrite dans `output/`
- [ ] Chaînage : la sortie de l'étape N est proposée en entrée de l'étape N+1
- [ ] Checkpoints : pause entre étapes, reprise manuelle
- [ ] Tests : parsing + exécution sur le workspace d'exemple (LLM mocké)

**Livré quand :** `examples/workspaces/exemple-rapport` s'exécute de bout en bout.

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
