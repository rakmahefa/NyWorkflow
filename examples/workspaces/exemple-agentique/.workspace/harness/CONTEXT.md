# harness/ — le harness NyWorkflow, ton moteur d’exécution

Tu ne t’exécutes pas seul : un **harness** te porte. Le connaître, c’est
travailler avec lui plutôt que contre lui — quel que soit le modèle qui
te pilote, ce contrat est le même.

## Les trois piliers d’une session

1. **Le modèle — toi.** Tu raisonnes (thought process titré), tu décides,
   tu agis (tool_calls). Tu ne vois le monde QUE par tes outils.
2. **Le harness (engine) — NyWorkflow.** Il exécute : il charge l’ICM dans
   ton prompt, dispatch tes tool_calls (en parallèle et en arrière-plan),
   te renvoie leurs résultats groupés, journalise tout, et applique la
   sécurité. C’est lui qui détient la vérité de ce qui s’est réellement
   passé.
3. **L’ICM — ton contexte interprétable.** L’arbre `.workspace/` : charte,
   plan, journal, mémoire. Chargée dans ton prompt à chaque tour, entretenue
   par tes écritures — c’est TOI qui la fais vivre.

## Ce que le engine fait pour toi, à chaque tour

- Il **recharge l’ICM** (l’arbre a pu grandir depuis le tour précédent).
- Il **exécute tes tool_calls en parallèle et en arrière-plan**, puis te
  renvoie le groupe ENTIER des résultats, dans un format défini — voir
  `tools/CONTEXT.md` (le protocole trois temps).
- Il **journalise** chaque appel, chaque résultat, chaque décision — le
  journal est la vérité des échanges.
- Il **garde la sécurité** : selon le niveau de la session, tes écritures
  et tes shells attendent l’approbation du pilote (c’est le flux normal,
  propose-les quand même) ou sont acceptées d’avance.

## Ce que le harness attend de toi

- Le **protocole trois temps** à chaque réponse (thinking titré → action →
  observation) — le détail dans `tools/CONTEXT.md`.
- Des **tool_calls corrects** : lis la fiche d’un outil
  (`tools/<outil>.md`) avant ta première utilisation ou quand un appel
  échoue.
- **Jamais de contournement** : n’improvise pas un résultat, ne prétends
  pas avoir agi — le journal sait, le pilote lit.

## Pour aller plus loin

`harness/ENGINE.md` — la boucle de tour en profondeur (rounds, dispatch,
journal, logs, plafonds). `harness/CONTEXT.md` (ce fichier) suffit pour
travailler ; ENGINE.md explique le pourquoi.
