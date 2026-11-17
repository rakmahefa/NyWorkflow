# packages/core — moteur ICM

Rôle : lire un workspace (carte racine + contrats `CONTEXT.md`), exécuter les étapes dans l'ordre des numéros, écrire les sorties. Le système de fichiers est l'orchestrateur — ce package se contente de lire, appeler le LLM (injecté, jamais importé), écrire.

Entrées : un dossier workspace (voir `examples/workspaces/`), un client LLM conforme à `StageLlm`, le sujet de la requête.
Sorties : fichiers `output/` par étape, événements `stage.started` / `stage.output` / `run.completed` vers le journal de session, états `RunState` (idle, running, checkpoint, done, error).

Ne fait pas : HTTP direct vers Gemini, UI, persistance autre que fichiers plats.

Tâches : M4 livré (2026-11-17) — `parse.ts` (carte + contrats, format v1 figé), `prompt.ts` (assemblage pur du contexte), `engine.ts` (`runStage` une étape, `createRun` checkpoints + reprise manuelle, `runStateFromEvents` reprise après redémarrage depuis le journal). Deux champs additifs ont rejoint le contrat gelé sur `InputRef` : `origin` et `why` ; le format des contrats CONTEXT.md est figé en v1 jusqu'à v0.2.0 (point de décision fin M4, PLAN.md).

M5 livré (2026-11-17) — `protocol.ts` (protocole JSON une-ligne strict : toute réponse non-outil est l'artefact), la boucle d'agent dans `runStage` (`tools: true` : read/ls/glob auto via `@nyworkflow/tools`, 8 appels max par tentative), la pause d'approbation (`ToolApprovalPause` → état `RunState` `approval`), `resumeStage` + `createRun.resolve(decision)` — la conversation est rejouée depuis le journal, donc la reprise après redémarrage est identique. `pendingToolCall` / `stageModelFromEvents` servent la dérivation d'état et l'endpoint d'approbation.

Le chaînage est déclaratif : la sortie de l'étape N est l'entrée de l'étape N+1 parce que le contrat la déclare ; les entrées sont relues sur disque à chaque exécution — un humain peut éditer un fichier entre deux étapes, l'étape suivante lit la version éditée.
