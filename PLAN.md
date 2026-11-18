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
   M9 stabilité & auth multi-sessions ✅ ──► M10 API élargie ✅ ──► M11 sessions ICM agentiques ✅
        (/u/N par compte, expiration          (/v1beta Google-style,        (PILOTÉ : workflows retirés, workspace
         vue d'avance, stats par compte)       tools OpenAI, splitter        à arbre libre par session, 7 outils
                                             jamais perdant)                avec tool_calls standards, v1beta
                                                                            de base, suppression, v0.2.0)
```

M18 (usages réels & export) et M19 (selon les logs par session — le quatuor, model.jsonl enrichi en tête) sont écrits en fin de MILESTONES.md — réévalués avant chaque démarrage.

## Points de décision

- **Fin M7** : la maquette couvre-t-elle tous les cas d'échec observés historiquement (401, divergence, flux vide) ? Sinon, les cas manquants entrent dans M8. ✔ Couvert — M8 a ajouté la rotation multi-comptes sur 401 et le proxy.
- **Fin M8** : dégeler `/v1beta` et les outils dans l'API, ou garder le socle minimal ? ✔ Décision : **reporté** (M10) — aucun besoin réel exprimé ; M9 privilégie la stabilité des comptes (expiration visible, `/u/N` par compte), la douleur la plus fréquente à l'usage.
- **Fin M9** : le socle multi-comptes est-il assez stable pour servir de base à v0.2.0 ? ✔ Décision : **oui** (sessions par compte, expiration vue d'avance, stats — prouvés bout en bout contre la maquette, 322 tests) ; l'API élargie reste conditionnelle (M10) et v0.2.0 garde son périmètre d'origine (M11). Leçon actée : tout futur ajout sur `GET /` et `/v1/*` reste **additif** — les champs M8/M9 ne seront jamais renommés.
- **Fin M10** : le besoin d'API élargie a-t-il été exprimé, et la livraison a-t-elle déplacé les frontières ? ✔ Décision : le pilote a lancé M10 — livré (deux surfaces : `/v1beta` Google-style + `tools` OpenAI, 386 tests, vérifié bout en bout sur CLI réel). Les frontières n'ont pas bougé : Gemini reste confiné dans `packages/webapi`, les outils du client passent par le prompt (l'interface web ne sait pas faire autrement) et le décodage en flux ne perd jamais de texte. L'additivité est testée (chemins sans outils inchangés octet pour octet).
- **Fin M11** : le pivot piloté (sessions ICM agentiques) tient-il ses promesses à l'usage, et le retrait du moteur de workflows a-t-il laissé des orphelins ? ✔ Décision : livré (19 e2e, 375 tests, capture rejouée). Le format de contrat étapes/`## Entrées` est **obsolète** — le workspace est un arbre libre dont les `CONTEXT.md` sont de la prose lue par le modèle (plus de format figé) ; les journaux anciens restent lisibles (dérivation tolérante). La boucle agentique vit dans le navigateur : le serveur n'a plus de client LLM — si un jour l'exécution doit devenir serveur (agents longs), ce sera un M12+ explicite, jamais une improvisation.
- **Fin M13** : sécurité par session (ask/accept/no-tools), scaffold ICM complet à la création et trio de logs de profilage livrés (428 tests, 30 e2e). ✔ Décision : le niveau de sécurité vit dans le JOURNAL (le serveur applique — le navigateur ne déclare simplement plus d'outils sous no-tools) ; les logs vivent sous `.nyworkflow/.logs/` (gitignorés — le pilote les copie dans le dépôt quand il veut partager un profil) ; le registre des jobs d'arrière-plan reste en mémoire et la réflexion reste non journalisée (choix M12 intacts).
- **Fin M14** : dossier de session obligatoire, ICM dans le `.workspace/` caché, logs par session dans `.logs/<sessionId>/` et prompt système harness — piloté par les PREMIERS LOGS réels (434 tests, 30 e2e). ✔ Décision : la garantie du dossier vit côté SERVEUR (400 sans workspace — l'UI ne fait que refléter) ; `ensureIcmTree` est idempotent et ne touche JAMAIS un `.workspace/` existant (la mémoire vivante continue d'une session à l'autre) ; le prompt système enseigne l'identité harness ET l'interdiction de relire les CONTEXT.md déjà chargés (leçon des logs : 10 tool_calls perdus à relire la charte pour un « hi »). Constat ouvert pour M16 : `thinkingChars: 0` malgré think=4 — la remontée du reasoning est à élucider côté webapi. M15 garde son cap : cookies réels sur la boucle complète + découverte dynamique des modèles + export de workspace, désormais guidés par les logs PAR SESSION.
- **Fin M15** : protocole deux temps livré (453 tests, 33 e2e) — thought process titré ouvrant chaque réponse, tool_calls groupés et titrés, parallèle/arrière-plan enseignés comme faits du harness. ✔ Décision : le protocole vit dans le CONTENU (`<thinking title="…">`) parsé par l'adaptateur — PAS dans une capacité native — donc **modèle-agnostique** ; le canal natif `reasoning_content` coexiste (blocs anonymes) ; le `title` des appels est journalisé avec les arguments (le rejeu reconstruit groupe + titres sans champ supplémentaire, groupement par adjacence). Constat ouvert pour M16 : valider le suivi du protocole sur l'interface Gemini réelle (thinking en premier ? titles remplis ?) — les logs par session le diront.
- **Fin M16** : protocole trois temps, ICM auto-documentée et journal du modèle livrés (457 tests, 33 e2e, v0.7.0). ✔ Décision : le troisième temps (OBSERVATION) est désormais EXPLICITE dans le contrat — le modèle sait qu'il doit attendre le groupe entier, et le groupe lui revient en UNE message assistant (fini les paires éclatées) avec l'écho `{tool, title, ok, result|error}` pour corréler ; la documentation rigoureuse vit DANS l'ICM (`harness/` chargé + `ENGINE.md` à la demande, `tools/CONTEXT.md` chargé + fiches à la demande — le prompt reste borné) et `ensureIcmTree` UPGRADE les workspaces existants sans jamais toucher la mémoire vivante ; le 4e journal `model.jsonl` observe le modèle lui-même (réponse complète par round + conformité protocole calculée serveur) — la vérification à l'œil est finie, M17 lit le journal. Constat ouvert pour M17 : valider le suivi du protocole sur l'interface Gemini réelle (`protocol.thinkingFirst` ? `toolCallsTitled` ? `systemChars` qui dérive ?).
- **Fin M17** : profilage observable et sélecteur natif livrés (468 tests, 36 e2e, v0.8.0) — pilotés par le retour du pilote : les journaux de session n'affichaient pas les réponses du modèle, et les mauvais formats devaient rester visibles. ✔ Décision : le quatuor DE LA SESSION devient lisible depuis l'UI (`GET /sessions/:id/logs` + tail, section dédiée de l'onglet Activité — `model.jsonl` de CETTE session, plus le global) ; la carte requête porte la RÉPONSE elle-même (trace étendue : firstEvent, titres, extraits, appels + verdict — la conformité protocole se lit d'un regard) ; `model.observation` journalise le 3e temps (le payload EXACT qui circule vers le round suivant, groupe complet uniquement — les deux sens du fil sont désormais sur disque) ; `rawArgs`/`argsOk` gardent le mauvais format BYTE POUR BYTE (un JSON cassé ne s'efface plus en `{}`) ; le bouton Explorer ouvre la boîte de navigation NATIVE (`showDirectoryPicker`, détectée) et `GET /workspaces/locate` résout le nom en chemin serveur (BFS borné home+registre, profondeur ≤ 5, plafonds durs — le web cache le chemin par conception, le pont est honnête : zéro candidat = erreur claire). Constat ouvert pour M18 : valider sur l'interface Gemini réelle — `protocol.argsOk` dira si les arguments cassés existent en vrai, `model.observation` si le modèle corrige après une erreur renvoyée.
- Le format de contrat ICM v1 (décision M4) est **caduc** depuis M11 : remplacé par l'ICM libre (arbre + CONTEXT.md prose) — pas de rétromigration prévue, les journaux anciens restent dérivables.

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
