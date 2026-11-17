# packages/core — l'ICM

Rôle : ce que « charger l'ICM vers le modèle » veut dire. Marche l'arbre du workspace (bornée : profondeur 6, 500 entrées, dossiers cachés/poubelles ignorés), lit tous les `CONTEXT.md` (racine d'abord, 8 fichiers, 32 Kio chacun), assemble le prompt système de la session agentique (`buildIcmSystemPrompt` : méthode ICM, arbre, chartes, conventions) et pose le **scaffold du workspace agentique par défaut** (`CONTEXT.md` charter + `inbox/ notes/ research/ outputs/`, jamais d'écrasement).

Entrées : un dossier workspace quelconque (arbre libre — l'exemple vit dans `examples/workspaces/exemple-agentique/`).
Sorties : `IcmWorkspace` (arbre rendu + chartes), prompt système assemblé, arbre scaffoldé sur disque.

Ne fait pas : HTTP, exécution d'outils, journalisation — zéro dépendance, pur Node.

Tâches : pivot M11 (2026-11-17) — le moteur de workflows de phase 1 (`engine.ts`, `parse.ts`, `prompt.ts`, `protocol.ts` : étapes numérotées, contrats figés, runs/checkpoints, protocole JSON une-ligne) est **retiré** : les sessions sont la seule surface et le modèle s'orchestre avec ses outils guidé par l'ICM. Restent `icm.ts` (walkTree, renderTree, loadIcm, buildIcmSystemPrompt) et `scaffold.ts` (scaffoldAgenticWorkspace, scaffoldContext). M4–M6 : archivés dans MILESTONES-old/ MILESTONES.md.

**M12** (2026-11-17) : `buildIcmSystemPrompt` gagne la section **Méthode agentique (M12)** (paralléliser les appels indépendants, arrière-plan + jobId/shell_output/shell_kill, explorer sans demander, boucle honnête, conclure par les chemins) ; la charte scaffold (`scaffoldContext`) liste les **9 outils** avec le drapeau background et le parallélisme.
