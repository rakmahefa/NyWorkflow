# ENGINE — le moteur NyWorkflow en profondeur

La boucle d’un tour, telle que le engine la vit. Utile pour comprendre
pourquoi le protocole trois temps existe, et ce que deviennent tes appels.

## La boucle de tour (round par round)

1. **Message du pilote** — enregistré dans le journal.
2. **Rechargement de l’ICM** — l’arbre `.workspace/` est re-walké, les
   CONTEXT.md (max 12, 32 Kio chacun) rechargés dans ton prompt système.
   Conséquence : ce que tu écris dans l’ICM est VU au round suivant.
3. **Ton protocole trois temps** — thinking titré, action (tool_calls),
   puis STOP : tu attends les résultats.
4. **Dispatch du groupe** — le engine exécute TOUS les appels du groupe :
   les indépendants en parallèle (Promise.all), les shells longs en
   arrière-plan (jobId rendu immédiat). Sous sécurité « ask », les appels
   dangereux (write, shell) attendent le pilote UNE PAR UNE.
5. **Retour du groupe ENTIER** — chaque appel reçoit sa réponse, au format
   `{"tool":…, "title":…, "ok":…, "result"|"error":…}`. Le groupe complet
   te revient avant qu’un nouveau round démarre.
6. **Nouveau round** — retour à 1 (avec l’ICM rechargé et les résultats
   dans l’historique) : nouveau protocole, jusqu’à la réponse finale
   (une réponse sans tool_call termine le tour).

## Le journal — la vérité des échanges

Chaque événement (messages, tool_calls, résultats, décisions, sécurité)
est append-only dans le journal de la session. Le rechargement de l’UI le
rejoue à l’identique. Un appel non journalisé n’a pas existé ; un résultat
improvisé contredit le journal — le pilote le voit.

## La sécurité — trois niveaux

- **ask** (défaut) : write et shell attendent l’approbation du pilote.
  C’est le flux NORMAL : propose l’appel, la carte d’approbation s’affiche.
- **accept** : tout s’exécute sans demande (sessions de confiance).
- **no-tools** : aucun tool_call n’est exécuté — tous refusés avec la
  raison. Réponds alors à partir de l’ICM et de la conversation.

## Les logs de profilage — `.logs/`, interdits

`<dossier>/.logs/<sessionId>/` contient quatre journaux JSONL (engine,
session, activity, model — dont TES réponses, pour améliorer le harness).
Ils sont pour le PILOTE : ne les lis ni ne les modifie jamais. L’arbre de
l’ICM ne les montre même pas.

## Les plafonds — honnêtes et constants

- read : 32 Kio par fichier ; write : 128 Kio ; ls : 500 entrées ;
  glob : motif ≤ 256 caractères.
- shell avant-plan : 30 s max, sorties bornées ; arrière-plan : 10 min
  max, 16 jobs simultanés par workspace, sorties accumulées bornées.
- Les refus « hors périmètre » sont DÉFINITIFS : tout chemin reste dans le
  dossier de la session.
