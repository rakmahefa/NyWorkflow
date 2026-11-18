# Audit du code — post-M23 (v0.14.1)

> Demandé par le pilote à la livraison du M23 : « auditer le code (bugs, incohérences, UI et code) ». Trois revues parallèles ont couvert le dépôt entier — (1) la boucle de tour et l'état UI (`App.tsx`, `store.ts`, `history.ts`), (2) le protocole et les composants (`protocol.ts`, `ChatView`, `ActivityPanel`, `Composer`, `NewSessionDialog`), (3) les packages et le serveur (`handler.ts`, `workspaces.ts`, `logs.ts`, `scope.ts`, `shelljobs.ts`, `icm.ts`, `journal.ts`, `embed.ts`). Chaque constat a été vérifié à la main avant correction ; les correctifs retenus sont livrés dans cette version, les autres sont documentés ci-dessous avec leur rationale.

**Verdict global** : aucune vulnérabilité critique du côté du rendu (aucun `dangerouslySetInnerHTML` dans tout `apps/web/src` — l'injection de balises par le contenu du modèle est impossible par construction), pas de ReDoS (aucun quantificateur imbriqué ambigu ; la seule construction exotique de `CAPITULATION_PATTERNS` est une laziness bornée), et une discipline de terminaison solide dans la boucle de tour (chaque garde anti-boucle garantit une sortie honnête). Les risques se concentraient sur : le drive-by navigateur sur les routes mutantes, deux états serveur orphelins (approbation en attente, jobs d'arrière-plan), la traçabilité partielle du feedback M23, et les faux positifs de l'anti-renoncement. Tout cela est corrigé ci-dessous.

## 1. Correctifs livrés (v0.14.1)

### Sécurité

| # | Constat | Correctif |
|---|---|---|
| S1 | **Aucun contrôle d'origine sur les routes mutantes** (`handler.ts`, `workspaces.ts`) : une page web malveillante visitée pendant que `pnpm dev` tourne peut poster des requêtes « simples » (no-cors, `text/plain`) — enregistrer un dossier, créer une session en « accept », lancer un shell — sans préflight CORS. | Nouveau `originGuard.ts` : un navigateur envoie toujours `Origin` sur ces requêtes ; on refuse (403) celles dont l'origine n'est pas le serveur lui-même. curl, les tests serveur et tout client non-navigateur n'envoient pas `Origin` : ils passent — l'outil local reste un outil local. Ce n'est pas une authentification, c'est la fermeture de la porte drive-by. |
| S4 | **Fuite inter-sessions possible via `.logs/`** : le prompt enseigne « ne lis ni ne modifie jamais ce dossier » (`icm.ts`) mais `resolveInScope` ne l'excluait pas — la session B pouvait `read` le `model.jsonl` de la session A (thinking et prose compris) du même workspace. | `scope.ts` : nouveau code de refus `forbidden` — `.logs` et `.logs/…` sont refusés aux outils fichiers, raison en français journalisée. |
| I5 | **`DELETE /sessions/:id/<n'importe-quoi>` supprimait la session** : le fallback DELETE du routeur attrapait toutes les sous-ressources — `DELETE /sessions/:id/logs` détruisait le journal au lieu de répondre 405. | Routage strict : le fallback ne matche que les sous-ressources connues, et pour un message explicite ; les chemins inconnus tombent dans le 404 général. |
| P2 | **`filePreview` lisait le fichier ENTIER avant de borner** (`workspaces.ts`) : un fichier de 2 Go dans le workspace passait par la mémoire avant son 413. | `stat` d'abord, refus 413 immédiat au-delà de la borne (×4 octets), puis lecture. |

### Robustesse — états orphelins et races

| # | Constat | Correctif |
|---|---|---|
| C1 | **Stop laissait la porte d'approbation serveur en suspens** : `handleStop` résolvait le waiter localement sans refuser côté serveur — l'appel dangereux restait `pending` (409 aux prochains appels de la session, carte d'approbation zombie au rechargement). | `handleStop` envoie aussi `decideTool('refuse')` au serveur (best-effort, jamais bloquant). |
| M1 | **Race Stop/`runTool`** : un Stop pendant le `runTool` d'un appel dangereux en vol installait un waiter que plus personne ne résoudrait — tour suspendu, composer bloqué jusqu'à un second Stop. | Garde `aborted()` après le `await runTool` et avant l'installation du waiter : la ligne est soldée localement, l'approbation serveur refusée au passage. |
| R1 | **`jobs.killAll()` n'était jamais câblé** : à l'arrêt du dev/preview server, les jobs d'arrière-plan survivaient en processus orphelins, injoignables (registre perdu, plus de SIGKILL à 10 min). | `createWorkspacesHandler` expose `close()` (killAll) ; le plugin l'appelle dans le cleanup de `configureServer`/`configurePreviewServer`. |
| R5 | **`evict` pouvait évincer un job EN COURS** : la boucle comparait la taille GLOBALE du registre à la limite PAR WORKSPACE et ne s'arrêtait pas sur les jobs vivants — un processus actif sortait de la Map et devenait « processus inconnu ». | Compteur d'excédent par workspace, arrêt au premier job vivant (tri fini-d'abord : aucun candidat ne reste derrière un vivant). |
| R2 | **Erreurs `realpath` non-ENOENT propagées en 500** (`scope.ts`) : boucle de symlinks (ELOOP) ou ancêtre illisible (EACCES) jetaient à travers `checkToolCall` → « Erreur interne » au lieu d'un refus propre. | Nouveau code `unresolvable` : toute erreur fs qui n'est pas ENOENT devient un refus journalisé, avec le code errno dans la raison. |
| m1 | **Repli positionnel inversé** (journaux pré-M12 sans `callId`) : le résultat d'un appel ouvert était apparié au DERNIER appel non résolu (LIFO) au lieu du premier (FIFO). | `out.find(...)` — l'ordre du journal est l'ordre d'émission. |
| m5 | **Round final vide : fin totalement silencieuse** : à `round === MAX_ROUNDS`, la réponse vide ne déclenchait ni nudge ni message — le tour s'arrêtait sans explication. | Message de clôture systématique (« Réponse vide au dernier round — tour terminé. »). |

### Traçabilité du model control (M23 durci)

| # | Constat | Correctif |
|---|---|---|
| M5 | **Le refus de contrat ÉCRASAIT la note de model control** : un round qui capitulait ET dont le listing ne tenait pas le contrat ne renvoyait au modèle que la note de refus — la détection de renoncement était perdue (`capNudged` jamais consommé). | `mentorNote = capNote + redoNote` fusionnés — une seule carte de feedback (phase 5), jamais deux, jamais l'une sans l'autre. |
| M6 | **Le feedback journalisé n'était pas le feedback envoyé** : la trace UI et `model.jsonl` (`model.response` refusée + `model.observation`) enregistraient la seule partie mentor, sans le capNote — la traçabilité M20/M23 était faussée. | `feedback: mentorNote` partout (trace, réponse refusée, observation) — la note exacte que le round suivant lit. |

### Anti-renoncement — faux positifs resserrés (`protocol.ts`)

| # | Constat | Correctif |
|---|---|---|
| P-a | « **xargs** n'a pas été conçu pour parser du JSON » — une limite d'outil tiers honnête — déclenchait la note « C'est FAUX dans ce harness ». | Les patterns 1-2 exigent un sujet à la première personne. |
| P-b | « Je ne suis pas **autorisé** à écrire ici » après un refus d'approbation du pilote — l'ÉTAT réel — déclenchait la note. | « autorisé » quitte le pattern 1. |
| P-c | « Je ne suis pas **concerné** » matchait `con[çc][\wÀ-ÿ]*` (« concerné »). | Lexème fermé : `con[çc]u…`. |
| P-d | « En tant **que** modèle de langage… » ne matchait pas : le pattern exigeait « qu' » (apostrophe) — « que » passait entre les gouttes. | `qu(?:e\b|['’])?` — les deux graphies. |
| P-e | Fenêtre « En tant qu'IA … je ne peux » trop courte (60) : une clause longue entre les deux échappait à la détection. | Fenêtre portée à 120. |
| P-f | « Je ne suis qu'un **simple** modèle » (adjectif inséré) ne matchait pas. | Jusqu'à 2 mots de remplis entre l'article et le nom. |

Chaque resserrage est couvert par des tests négatifs (« laisse passer l'impossibilité locale honnête » étendu aux limites d'outils tiers, aux états réels et à « concerné ») et positifs (les familles détectées, dont la clause longue).

### Briefing EXIGENCE — tolérance de parse

| # | Constat | Correctif |
|---|---|---|
| P-g | « `**EXIGENCE:** …` » (markdown gras, fréquent chez les modèles) n'était pas attrapé — le briefing était réclamé à tort. | Le parse tolère la mise en forme : `**EXIGENCE:**`, `__EXIGENCE__`, `> EXIGENCE`, `- EXIGENCE`… avec lookahead (et non `\b`, que `_` casse) pour refuser « EXIGENCEUX ». |

### UI

| # | Constat | Correctif |
|---|---|---|
| U-a | **Clé de round instable** (`ChatView.tsx`) : le round naissait avec la clé de son head, puis la première rangée d'outil la remplaçait — remontage complet du bloc en plein stream (carte thinking réouverte en flash, état de repli et scroll perdus), à chaque round de chaque tour. | Le head est l'invariant : `head?.id ?? rows[0]?.id`. |
| U-b | **`no_tool` invisible dans l'activité** : le 10e outil manquait à `TOOL_GLYPH` et `TOOL_GROUP_LABEL` — un tour clos par la signature affichait « 1 no_tool » avec l'icône générique, contre « aucun outil — réponse finale » dans le chat. | Glyphe 🚫 et libellé « aucun outil — réponse finale » alignés sur le chat. |
| U-c | **Le message de sélection contredisait la navigation** (`NewSessionDialog`) : « Dossier sélectionné : /a/b — il sera utilisé » persistait pendant que l'écran listait /c/d — le pilote pouvait soumettre /a/b en croyant avoir pris /c/d. | Le message suit la navigation : « Sélection actuelle : /a/b — vous naviguez dans /c/d ; “Utiliser ce dossier” appliquera celui-ci. » |

### Documentation interne alignée

- **I1** : le commentaire de `runNoTool` (`tools.ts`) parlait encore du compte « PLAN: no_tool » (M21) — aligné sur « [TOOL_LISTING] no_tool » (M22).
- **I3** : l'en-tête de `logs.ts` ne décrivait `model.jsonl` que jusqu'à M17 — les champs réels `phases` (M22) et `feedback` (M20/M21/M23, sur la réponse refusée comme sur l'observation) sont documentés.

## 2. Constats documentés, non corrigés (et pourquoi)

| # | Constat | Décision |
|---|---|---|
| S2 | `browse` liste n'importe quel dossier absolu du disque (énumération de l'arborescence si le serveur est exposé au LAN via `--host`). | **Atténué par S1** (le garde d'origine bloque le drive-by navigateur). Une restriction à `homedir()` + registre casserait le parcours des disques externes — usage réel du pilote (logs 2026-11-18 : workspace sous `/run/media/…`). À réévaluer si le serveur devient distant. |
| S3 | `shell` sous « accept » = exécution non confinée (le scope ne s'applique pas au shell ; `cat ~/.ssh/id_rsa` passe). | **Risque assumé et documenté** : c'est la sémantique même du niveau « accept » (approbation préalable du pilote). Un mode sandbox (groupe de processus dédié, allowlist) est un milestone à part entière, pas un correctif. |
| M2 | Le chemin « plain » (session sans workspace) ne participe ni à `agentRun` ni à la propriété de `stopRef` : basculer de session pendant un flux plain peut neutraliser le Stop du tour agentique suivant. | **Reporté** (M24+) : keyer l'état de tour par session touche au cœur de la boucle ; le flux plain est un repli sans outils (faible risque opérationnel). Le correctif est spécifié dans l'audit d'origine (`Map` par sessionId). |
| M3 | Le message mis en file part à la session active au moment du dequeue, pas à celle où il a été tapé ; un second message en file écrase le premier. | **Reporté** (M24+) avec M2 — même zone. |
| M4 | Échec du scaffold du premier workspace → page blanche (le dialogue promis est rendu APRÈS la garde `!active`). | **Reporté** : fenêtre étroite (serveur up, FS en lecture seule) ; restructurer le rendu du dialogue hors de la garde est un changement de layout à valider visuellement. |
| m2 | Le niveau de sécurité est figé au lancement du tour (un passage à « aucun outil » mi-tour ne s'applique qu'au suivant). | **Comportement acceptable** (le serveur refuse déjà tout) ; relire la sécurité en tête de round est trivial si le pilote le demande. |
| m7 | Un `no_tool` SEUL avec un listing « N appels » incohérent clôt le tour sans refus (asymétrie avec le cas mixte). | **Choix de design M22 tenu** : `no_tool` signe la fin — le refus de contrat ne s'applique qu'aux groupes qui s'exécutent ; `listingOk:false` reste journalisé. |
| m10 | `history.ts` tranche à `MAX_ROWS` au risque de couper un groupe d'appels en deux. | **Reporté** : étendre la coupe au groupe entier est correct mais délicat (re-synthèse du contexte modèle) — à faire avec des logs réels longs en M25. |
| P1 | Relecture + re-dérivation du journal complet à chaque événement/appel (coût croissant avec la session). | **Reporté** (M25, performance) : cache de dérivation par `(file, mtime, size)` — aucun symptôme dans les logs actuels (sessions courtes). |
| Divers | a11y (aria-live sur le stream, focus trap dans la modale), `uid()` sur 32 bits, `ChatMsg` interface-dieu (union discriminée suggérée), `LAST_WS_KEY` écrit avant la réussite de création, `setStreaming` commit sans changement. | **Inventoriés pour M25** — aucun ne casse un utilisateur aujourd'hui ; l'union discriminée est le seul refactoring d'envergure. |

## 3. Points forts confirmés par l'audit

1. **Le store snapshot** (`store.ts`) : mutations immutables, un `commit` = un rendu via `useSyncExternalStore` — simple, prévisible, testable.
2. **Le double garde de périmètre** (`scope.ts`) : passe lexicale puis passe realpath avec remontée au premier ancêtre existant — couvre la symlink-escape ET le fichier pas-encore-écrit ; chaque refus porte un code et une raison en français, journalisés.
3. **La cohérence prompt/implémentation** : les 10 outils de `TOOL_NAMES` correspondent exactement à ceux enseignés dans l'ICM, les noms d'arguments sont alignés, et le comportement ask/accept/no-tools documenté est bien celui appliqué — l'audit n'a trouvé AUCUNE divergence de contrat outil.
4. **L'observabilité de la boucle** : chaque round laisse une trace riche ET un journal serveur sur tous les chemins de sortie (`finally`) — y compris erreur, abort, session supprimée.

## 4. Vérification

- `pnpm typecheck` vert sur les 6 workspace projects.
- `pnpm test` : **533 tests** verts (28 core · 35 adapter-llm · 30 session · 50 tools · 244 webapi · 146 web — +2 par rapport au M23 : la tolérance markdown du briefing et les négatifs de l'anti-renoncement).
- `pnpm test:e2e` : **48 tests** verts — dont les deux M23 (renoncement refusé-repris, briefing réclamé) rejoués après correctifs.
- `pnpm build` vert.
- CI complet (Build & tests · Playwright · Capture README) sur le commit de livraison.
