# Architecture

## Vue d'ensemble

```
┌───────────────────────────── NyWorkflow (ce repo) ─────────────────────────────┐
│                                                                                │
│  apps/web — UI React + Vite, port 3080 : les sessions ICM agentiques           │
│    │  (la boucle agentique vit dans le navigateur : ICM → modèle → tools)      │
│    │                                                                           │
│    ├── packages/core — l'ICM : arbre du workspace, CONTEXT.md, scaffold        │
│    │         │                                                                 │
│    │         ├── packages/session — journal append-only JSONL                  │
│    │         └── packages/tools — 7 outils + permissions + nettoyage web       │
│    │                                                                           │
│    ├── packages/adapter-llm — client OpenAI-compatible sous /v1beta            │
│    │                                                                           │
│    └── packages/webapi — passerelle : interface web Gemini ↔ OpenAI-compatible │
└──────┬─────────────────────────────────────────────────────────────────────────┘
       │ HTTPS (cookies de session, protocole batchexecute interne)
┌──────▼─────────────────────────────────────────────────────────────────────────┐
│  gemini.google.com — l'interface web Gemini (non officielle)                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

Le serveur web embarque deux API same-origin (plugin Vite, branchées en dev comme en preview) : `/sessions` (journaux — création avec workspace, événements de chat, fork, **suppression**) et `/workspaces` (surface ICM agentique — listing, **scaffold**, **ICM assemblée**, aperçu de fichiers, **exécution des outils**, **décisions d'approbation**). Les journaux vivent sous `.nyworkflow/` à la racine du repo, les workspaces sous `examples/workspaces/` — deux emplacements surchargeables par `NYW_HOME` et `NYW_WORKSPACES`.

La passerelle `packages/webapi` (`pnpm webapi`, 127.0.0.1:8081 par défaut) est la refonte moderne de ny-gemini-acp — directement dans le monorepo. Le proxy `/api` du serveur web la rejoint en same-origin ; `W2A_URL` permet de lui substituer n'importe quel serveur OpenAI-compatible.

## Les 5 règles

1. **Le système de fichiers est l'orchestrateur** (ICM). Le workspace est un arbre libre : chaque dossier a un rôle, chaque `CONTEXT.md` se lit avant d'agir, le journal est la vérité des échanges. Aucune séquence codée en dur — l'agent s'orchestre avec ses outils.
2. **Gemini n'est jamais touché directement.** Seul `packages/webapi` connaît Gemini (cookies, SAPISIDHASH, payload `f.req`, frames, `bl`). Gemini évolue → on patche ce package, le reste du monorepo ne bouge pas. Et si le protocole venait à casser durablement : `W2A_URL` pointe l'adaptateur vers n'importe quel serveur OpenAI-compatible.
3. **Tout est fichier plat.** Contrats en Markdown, sessions en JSONL, sorties en Markdown. Observable par défaut, diffable via Git.
4. **Pas de framework d'injection.** Des imports directs et des interfaces TypeScript. Zéro magie, zéro Cordis.
5. **Un milestone à la fois, testé.** Voir MILESTONES.md.

## Packages

| Package | Responsabilité | Ne fait pas |
|---|---|---|
| `apps/web` | UI : sessions ICM agentiques (dialogue de création, boucle agentique dans le navigateur, carte d'approbation) ; serveurs `/sessions` + `/workspaces` (plugin Vite, dev et preview) | logique métier des outils |
| `packages/core` | l'ICM : marche de l'arbre (bornée), chargement des `CONTEXT.md`, prompt système assemblé, scaffold du workspace agentique par défaut | appels réseau, exécution d'outils |
| `packages/session` | journalisation append-only, relecture, fork, **suppression**, dérivation (messages + activité d'outils) | transformations |
| `packages/adapter-llm` | client OpenAI-compatible **sous `/v1beta` par défaut** (`apiVersion` configurable — v2 demain), streaming SSE, `tools`/`tool_calls` standards, rôles `tool` | parsing Gemini |
| `packages/webapi` | passerelle : interface web Gemini servie en OpenAI-compatible (auth SAPISIDHASH, f.req, frames wrb.fr, `bl` auto-découvert, retries) — serveur HTTP + CLI `pnpm webapi` | orchestration, sessions, outils |
| `packages/tools` | read / write / ls / glob / **mkdir** / **shell** / **websearch** (nettoyage HTML), garde de périmètre (racine du workspace), bornes | politique d'approbation (elle vit côté serveur/app) |

## Le workspace ICM (ce que le modèle reçoit)

```
mon-projet/               ← le dossier de session (obligatoire, M14) — le terrain
├── .workspace/           ← l'ICM complète de l'agent (cachée, M14)
│   ├── CONTEXT.md        #   la charte agentique : mission, méthode (6 temps), arbre, outils, règles
│   ├── harness/          #   la doc du harness : charte chargée + ENGINE.md (M16)
│   ├── tools/            #   le protocole trois temps (chargé) + une fiche par outil (M16)
│   ├── skills/           #   L'ARSENAL : évaluation + registre (chargés), une skill = un dossier SKILL.md lu à la demande (M19)
│   ├── inbox/            #   ce que le pilote dépose
│   ├── notes/            #   plan, tâches, journal, décisions (l'atelier)
│   ├── research/         #   lectures web nettoyées (websearch) + registre des sources
│   ├── memory/           #   mémoire durable (core/lessons, façon MemGPT)
│   ├── outputs/          #   livrables finaux
│   └── archive/          #   le travail terminé
├── .logs/<sessionId>/    #   le quatuor de profilage DE chaque session (M14/M16)
└── …fichiers du pilote   #   le projet — l'agent y travaille, la racine reste sienne
```

À chaque tour, `core.loadIcm` remonte l'arbre (profondeur 6, 500 entrées, poubelles et `.logs` ignorés) : le sous-arbre `.workspace/` (la maison de l'agent) PUIS l'arbre visible du projet (le terrain), et les `CONTEXT.md` de l'ICM (racine d'abord, 12 fichiers, 32 Kio chacun — le scaffold M19 en dépense 10 : charte, harness, protocole d'outils, arsenal, six rôles) ; `buildIcmSystemPrompt` assemble le prompt système — identité harness (« agent du harness NyWorkflow, agir = appeler un outil »), protocole trois temps, environnement, méthode ICM, arbre, chartes, conventions. **Depuis M16, l'ICM documente le harness lui-même** : `harness/CONTEXT.md` (charte chargée à chaque tour) + `harness/ENGINE.md` (le moteur en profondeur, lu à la demande), `tools/CONTEXT.md` (le protocole trois temps + catalogue, chargé) + **une fiche rigoureuse par outil** (`tools/<outil>.md` : arguments exacts, lancements corrects, erreurs courantes — lues à la demande, le prompt reste borné). Les workspaces d'avant M14 (charte à la racine) se chargent comme avant (repli legacy) ; ceux d'avant M16 ou M19 sont **upgradés** à la session suivante (`ensureIcmTree` ajoute les fichiers de base manquants, ne touche JAMAIS l'existant — un registre de skills vivant n'est jamais écrasé). L'arbre est **libre** : le modèle le fait grandir (`mkdir`), un sous-dossier qui acquiert un rôle mérite son propre `CONTEXT.md`. **Depuis M19, l'ICM porte l'arsenal** : `skills/CONTEXT.md` (protocole d'évaluation + registre, chargés à chaque tour) et le gabarit `skills/_MODELE.md` — le prompt système porte la section « Évalue tes moyens — l'arsenal » et la méthode ICM compte 6 temps (Évaluer en 2e).

## Flux d'un tour agentique (M11, élargi M12, protocole M15/M16)

```
pilote ──message──► navigateur (boucle agentique, max 12 tours)
   ▲                     │ 1. GET /workspaces/:ws/icm — l'ICM fraîche (l'arbre a pu grandir)
   │                     │    + la méthode agentique : paralléliser, détacher, explorer sans demander
   │                     │ 2. messages = [system ICM] + historique (chat + tours d'outils)
   │                     │ 3. POST /api/v1beta/chat/completions { model[+@think=N], tools: 9 déclarations }
   │                     ▼
   │             passerelle webapi (outils → convention de blocs amont, décodage en flux)
   │                     │ thoughts (candidate[37][0][0]) → delta.reasoning_content — jamais dans le splitter
   │      ┌── texte ─────┤─ protocole M15/M16 : <thinking title="…"> DANS le contenu
   │      │              │  (ThinkingSplitter) ──┤── tool_calls (standard, titrés) ──┐
   │      ▼              ▼                        │                          │
   │   streaming   cartes thinking TITRÉES  bloc natif anonyme     pour chaque appel :
   │   (placeholder)  repliable (UI)        repliable (UI)          POST /workspaces/:ws/tool { sessionId, tool, args, → callId }
   │                                              ├─ read/ls/glob/mkdir/websearch/shell_output/shell_kill : AUTO
   │                                              │    → les SÛRS d'un tour partent EN PARALLÈLE (Promise.all)
   │                                              ├─ write/shell (background compris) : PAUSE — tool.call ouvert
   │                                              │    (carte d'approbation avec aperçu ; /tool/decision)
   │                                              ├─ shell {background:true} approuvé → jobId immédiat
   │                                              │    (registre mémoire : 16 jobs/ws, 10 min, 64 Kio/flux)
   │                                              └─ refus (hors périmètre, bornes) : journalisé, le modèle ajuste
   │                     │ résultat {"tool","title","ok",result|error} — apparié par callId
   │                     │ M16 : le groupe ENTIER revient AU MODÈLE — une seule message
   │                     │ assistant avec tous les appels, puis chaque résultat
   │                     │ M17 : CE payload circulant part aussi dans model.jsonl
   │                     │ (model.observation — le 3e temps journalisé, groupe
   │                     │  complet uniquement) aux côtés de model.response
   └─────────────────────┘ retour au modèle → nouveau protocole (thinking d’abord) → … jusqu’à la réponse finale (Stop = annulation propre)
```

- **Le protocole trois temps (M15/M16)** : chaque réponse du modèle ouvre par `<thinking title=“…”>…</thinking>` dans le CONTENU — le splitter de l’adaptateur le sépare du texte visible (balise coupée en plein chunk recousue, bloc non refermé auto-fermé : le dialogue interne ne fuit jamais). Chaque bloc devient une carte repliable TITRÉE ; les `tool_calls` d’un tour sont rendus dans UNE carte « Actions de l’agent » (groupement par adjacence — vaut aussi au rejeu du journal), chaque ligne portant le `title` rempli par le modèle (journalisé avec les arguments). **M16 — le troisième temps est explicite** : après les tool_calls la réponse S'ARRÊTE (le modèle attend), le harness exécute le groupe entier (parallèle + arrière-plan) puis le renvoie COMPLET au modèle — une seule message assistant avec tous les appels du groupe, suivie de chaque résultat au format `{"tool","title","ok","result"|"error"}` (l'écho outil + titre permet la corrélation) — et seulement alors un nouveau protocole démarre. Le contrat est enseigné par l'ICM (prompt système + `tools/CONTEXT.md` chargés à chaque tour).
- **La décision humaine survit aux redémarrages** : un `tool.call` **dangereux** sans `tool.result` au journal = approbation en attente — dérivée au rechargement, la carte se réaffiche. Un appel **sûr** orphelin (tour coupé en plein parallèle) est réglé « interrompu » à l'hydratation — pas de fausse carte.
- **Le 409 « un appel déjà en attente » ne porte que sur les appels dangereux ouverts** : deux POST d'outils sûrs concurrents sont légaux (M12). `callId` sur `tool.call`/`tool.result` (additif) apparie chaque résultat à SON appel — les journaux M4–M11 restent lisibles par repli positionnel.
- **Garde-fous** : périmètre lexical + realpath (un symlink ne sort pas du workspace), read 32 Kio, write 128 Kio, ls/glob 500 entrées, shell avant-plan 30 s + 16 Kio/flux + commande ≤ 4 000 caractères, shell arrière-plan 10 min + 64 Kio/flux + 16 jobs vivants par workspace, websearch 8 résultats / page nettoyée 64 Kio / URL http(s) ≤ 2 048.
- **websearch nettoie pour le modèle** : blocs `script/style/nav/header/footer/aside/form/…` et commentaires supprimés, attributs réduits à `href`/`src`/`alt` (URI `data:` virées), balises sémantiques **gardées**, espaces rabotés, contenu plafonné.

## Les workspaces : registre, manifeste, dossiers du disque (M12)

Un workspace est un **nom** résolu en racine : un sous-dossier du registre (`examples/workspaces/`, surchargé par `NYW_WORKSPACES`) ou une inscription du **manifeste** `workspaces.json` au pied du registre — un dossier quelconque du disque, enregistré depuis l'UI (**Dossier du disque**, navigateur `GET /workspaces/browse`, ou bouton **Explorer** M17) ou l'API (`POST /workspaces {name, path}`). Le manifeste est relu par mtime (comme les cookies et `accounts.json`) : l'éditer à la main ne redémarre rien. Le dossier registre gagne en conflit de nom ; une inscription dont le dossier a disparu est ignorée sans erreur. `POST /sessions` valide son `workspace` par le même canal (`workspaceExists`) — et le refuse s'il manque (**obligatoire, M14**). À l'enregistrement d'un dossier du disque (M14), le `.workspace/` caché de l'agent y est créé (idempotent — jamais réécrit) : les fichiers du pilote restent intacts, l'agent gagne son ICM complète dedans.

**Le pont du sélecteur natif (M17)** : la boîte de dialogue de dossier de l'OS (`showDirectoryPicker()`, Chromium détecté) ne rend qu'un **handle sans chemin** — le web cache le chemin par conception. Le harness retourne la contrainte : le handle donne le NOM du dossier, `GET /workspaces/locate?name=…` le cherche sur le disque du serveur (BFS borné : home + registre, profondeur ≤ 5, dossiers cachés/lourds sautés — `node_modules`, `.git`, `Library`… —, plafonds durs 4 000 dossiers parcourus / 20 candidats, compteurs `scanned`/`truncated` honnêtes dans la réponse). Un candidat → le dialogue se remplit seul ; plusieurs → le pilote tranche d'un clic ; zéro → l'erreur explique, le chemin manuel reste. La recherche est journalisée (`folder.locate` dans activity.jsonl).

## Frontières de maintenance

| Quand ça casse… | On touche… | Taille du patch |
|---|---|---|
| Gemini change son interface web | `packages/webapi` uniquement (modèles = une donnée via `NYW_WEBAPI_MODELS_FILE`) | petit |
| Google renomme ses modèles | un JSON de table de modèles, zéro code | trivial |
| On veut un autre modèle/serveur | `W2A_URL` de l'adaptateur | trivial |
| Google passe l'API en v2 | `apiVersion` de l'adaptateur + un chemin dans `OPENAI_CHAT_PATHS` (webapi) | trivial |
| Un nouvel outil pour l'agent | `packages/tools` + une déclaration dans `apps/web/src/lib/agentTools.ts` | petit |
| Le prompt ICM doit évoluer | `buildIcmSystemPrompt` (core) ou la charte du workspace | petit |

## Décisions clés

- **D1 — Projet neuf en TypeScript**, pas un fork de deepseek-harness : ses 45 packages Cordis sont exactement la dette que NyWorkflow veut éviter. On garde l'UX, pas le moteur.
- **D2 — Passerelle, pas portage** (phase 1) : réutiliser `gemini-web2api` (ny-gemini-acp) plutôt que réécrire auth/stream en TS. **Révisée en phase 2 (M7)** : la passerelle est **réimplémentée dans le repo** (`packages/webapi`), en inversant chaque cause de casse (`bl` auto-découvert, modèles data-driven, jetons rafraîchis avant retry). **Révisée en M8** : la passerelle est **intégrée au serveur web** (`apps/web/src/server/embed.ts`) — `pnpm dev` démarre tout. **Révisée en M9** : l'adresse de session devient **une donnée par compte** (manifeste `accounts.json`). **Révisée en M10** : la passerelle parle les **deux dialectes de clients** (OpenAI `/v1` avec `tools`, Google `/v1beta`) via une convention de blocs décodée en flux. **Révisée en M11** : le dialecte OpenAI est aussi servi **sous `/v1beta/chat/completions`** — la liste des namespaces est une donnée (`OPENAI_CHAT_PATHS`), l'app consomme v1beta par défaut.
- **D2bis — Zéro dépendance runtime** pour la passerelle : `node:http`, `node:crypto`, `fetch` natif — la chaîne de test ne dépend d'aucun serveur externe (maquette HTTP de l'interface Gemini).
- **D3 — ICM pur** : un agent, un workspace, des fichiers. **Révisée en M11 (pivot piloté)** : phase 1 disait « pas de chat libre » avec des workflows en étapes numérotées — le pilotage a inversé : **les sessions sont la seule surface**, chacune liée à un workspace **à arbre libre**, et le modèle orchestre lui-même avec ses outils guidé par l'ICM. Le moteur d'étapes (runs/advance/checkpoints) a été retiré avec ses endpoints ; ce qui reste de l'ICM (arbre, CONTEXT.md, journal) est le cœur. **Révisée en M12** : un workspace peut être **n'importe quel dossier du disque** (manifeste `workspaces.json`) — le dossier de l'utilisateur EST le contexte, et l'ICM enseigne la méthode agentique (parallélisme, arrière-plan) au-delà de la seule charte. **Révisée en M13** : le scaffold par défaut devient **l'ICM complète** (14 fichiers prêts : plan/tâches/journal/décisions, registre des sources, mémoire cœur/leçons — façonnés par l'état de l'art : MWP, scratchpads, MemGPT) et chaque session porte un **niveau de sécurité** (`ask | accept | no-tools`, journalisé — le serveur applique, le navigateur ne fait que refléter). **Révisée en M14 (premiers logs réels)** : le dossier de session est **obligatoire**, l'ICM vit dans le **`.workspace/` caché** dedans (le projet du pilote reste propre — pattern `.git`/`.claude` ; la mémoire vivante continue d'une session à l'autre), chaque session profile dans **`.logs/<sessionId>/`** au même endroit, et le prompt système porte l'**identité harness** (le modèle sait qu'il tourne dans NyWorkflow et que ses tool_calls sont réels — fin du « modèle confus »).
- **D4 — Sessions en JSONL append-only** : l'historique envoyé au modèle est toujours re-dérivé du journal — messages **et** tours d'outils. **Révisée en M13** : les **tours terminés** sont journalisés aussi (`turn.completed` — l'onglet Activité survit aux rechargements), et le harness profile son propre fonctionnement dans `.nyworkflow/.logs/` (engine/session/activity — JSONL daté, rotation 8 Mio, jamais fatal), pensé pour être partagé et affiné. **Révisée en M14** : le profilage est aussi **par session, dans son dossier** (`<dossier>/.logs/<sessionId>/` — la même mécanique `JsonlLog`, un cache par couple dossier/session) ; supprimer une session garde son `.logs/` : c'est l'histoire durable, à zipper et uploader.
- **D5 — Outils enfermés dans le workspace** : tout chemin sortant de la racine est refusé ; `write` et `shell` attendent une approbation humaine, tout est journalisé. **Précisée en M12** : les appels **sûrs** d'un même tour s'exécutent en parallèle (appariement journal par `callId`) — la porte d'approbation reste **une à la fois** ; un shell arrière-plan suit le même rite (approbation PUIS détachement), suivi et arrêt libres (`shell_output`/`shell_kill` ne touchent que les jobs de l'agent).

- **D6 — Le protocole vit dans le CONTENU, pas dans le modèle (M15, étendu M16)** : chaque réponse ouvre par son thought process dans un bloc **titré** `<thinking title=“…”>…</thinking>`, puis bascule vers le travail visible (prose et/ou `tool_calls` **titrés** par leur argument `title`). Le contrat est enseigné par le prompt système (ICM), parsé par l’adaptateur (`ThinkingSplitter` : incrémental, jamais perdant — balise coupée en plein chunk recousue, bloc non refermé auto-fermé en fin de flux, cap 256 Kio/bloc), rendu par l’UI (cartes titrées repliables, groupe « Actions de l’agent »). Pourquoi le contenu et pas le canal natif : **modèle-agnostique** — tout modèle qui sait écrire suit le même contrat, et le canal natif (`reasoning_content`, blocs anonymes « Réflexion ») **coexiste** sans collision. Les titres des appels sont journalisés AVEC les arguments (`tool.call`) : groupe et titres se rejouent fidèlement au rechargement — le groupement par **adjacence** (les appels d’un tour sont consécutifs dans le journal) ne coûte aucun champ supplémentaire. **Étendue en M16 — le protocole devient TROIS temps** : (1) thinking titré, (2) action — tool_calls parallèles et titrés puis la réponse S'ARRÊTE, (3) observation — le groupe ENTIER des résultats revient au modèle dans un format défini (`{"tool","title","ok","result"|"error"}`), puis un nouveau protocole démarre ; le retour se fait désormais en UNE message assistant par groupe (`toAgentMessages` regroupe par adjacence) — le modèle voit ses appels comme il les a faits, ensemble, avec l'écho outil+titre pour corréler chaque résultat.
- **D7 — L'ICM documente le harness, le profilage observe le modèle (M16)** : la base ICM s'auto-documente — `harness/` (charte chargée à chaque tour + `ENGINE.md` en profondeur) et `tools/` (protocole trois temps chargé + **une fiche rigoureuse par outil**, lue à la demande — le prompt reste borné) ; `ensureIcmTree` **upgrade** les workspaces existants (fichiers de base manquants ajoutés, mémoire vivante JAMAIS touchée — `'created' | 'present' | 'upgraded'`), le plafond du chargeur passe à 12 CONTEXT.md (le scaffold en dépense 9). En miroir, le 4e journal de profilage **`model.jsonl`** capte la réponse du modèle À CHAQUE round (thinking titré, texte, tool_calls titrés, `systemChars` — la taille du prompt ICM) avec la **conformité protocole calculée serveur** (`thinkingFirst`, `thinkingTitled`, `toolCallsTitled`) : le pilote cesse de vérifier à l'œil si le protocole est suivi — le journal le dit, prêt à être zippé et uploadé.
- **D8 — Le fil s'observe dans les deux sens, dans l'UI autant que sur disque (M17)** : piloté par le retour d'usage de la M16 (les journaux de session n'affichaient pas les réponses du modèle ; les mauvais formats devaient rester visibles). Quatre ajouts solidaires : (1) le quatuor DE LA SESSION devient une **API en lecture seule** (`GET /sessions/:id/logs` + `/:name?tail=N`) servie dans l'onglet Activité — `model.jsonl` de CETTE session se lit à côté d'elle, le global reste aux Paramètres ; (2) la **trace navigateur porte la réponse** (firstEvent, titres, extraits, appels + verdict, systemChars) — la carte requête montre la conformité protocole d'un regard, une trace ancienne le dit honnêtement ; (3) **`model.observation`** journalise le 3e temps : le payload EXACT qui circule vers le round suivant (`POST /sessions/:id/observation`, fire-and-forget comme /response, **groupe complet uniquement** — le payload reflète `toAgentMessages` byte pour byte) ; (4) chaque tool_call de `model.response` garde ses **arguments bruts** (`rawArgs`) et leur **verdict de parse** (`argsOk`, agrégé dans `protocol.argsOk`) — un JSON cassé émis par le modèle ne s'efface plus en `{}`. Et le pont du sélecteur natif : `showDirectoryPicker()` rend un handle sans chemin, `GET /workspaces/locate` résout le NOM en chemin serveur (BFS borné, plafonds durs, compteurs honnêtes) — l'astuce est documentée DANS l'UI, zéro candidat ne ment jamais.
- **D9 — L'arsenal : l'agent construit et améliore ses propres moyens (M19)** : piloté par la demande structurelle du pilote — le modèle doit pouvoir évaluer qu'une tâche réclame des compétences ou des outils spécifiques, les construire DEPUIS ses outils de base, et améliorer l'ICM elle-même ; harness + ICM deviennent un arsenal qui grandit. Trois pièces solidaires : (1) **le dossier `skills/`** dans le scaffold v5 — sa charte est chargée à chaque tour avec le **protocole d'évaluation** (besoin ? skill existante ? construction du manque) et le **registre** (la table que l'agent tient à jour : une ligne par skill, tout ce que le tour suivant doit savoir sans ouvrir le dossier) ; une skill est un dossier `skills/<nom>/SKILL.md` **lu à la demande** (jamais un CONTEXT.md — le prompt reste borné), copié depuis `skills/_MODELE.md`, enrichi de scripts et gabarits invoqués par `shell` — les « meilleurs outils spécifiques » sont des fichiers que l'agent écrit ; (2) **la boucle d'amélioration** : après usage la skill se raffine (l'étape qui a coincé se précise), l'échec nourrit `memory/lessons.md`, une leçon qui revient est une skill à écrire, l'obsolète part en `archive/` — et l'ICM elle-même est améliorable (chartes, mémoire, structure : tout ce qui est écrit dans `.workspace/` est rechargé au tour suivant, la garde reste la densité) ; (3) **le prompt système** porte la section « Évalue tes moyens — l'arsenal » et la méthode ICM passe à 6 temps (Évaluer en 2e). `ensureIcmTree` upgride les workspaces d'avant M19 en ajoutant `skills/` sans jamais toucher un registre vivant (testé).
