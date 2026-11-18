# Guide utilisateur — NyWorkflow

> Le mode d'emploi complet du harness : installation, cookies Gemini, interface, sessions ICM agentiques, workspaces, paramètres, passerelle et dépannage. Pour le « pourquoi » du projet et son architecture, voir le [README](README.md) et [ARCHITECTURE.md](ARCHITECTURE.md).

## Sommaire

1. [Démarrage rapide](#1-démarrage-rapide)
2. [Connecter Gemini (cookies)](#2-connecter-gemini-cookies)
3. [Tour de l'interface](#3-tour-de-linterface)
4. [Le menu Paramètres](#4-le-menu-paramètres)
5. [Créer son propre workspace](#5-créer-son-propre-workspace)
6. [La passerelle webapi](#6-la-passerelle-webapi)
7. [Dépannage](#7-dépannage)

---

## 1. Démarrage rapide

Prérequis : **Node.js 22.18+** et **pnpm 12+** (`corepack enable` l'installe).

```sh
git clone https://github.com/rakmahefa/NyWorkflow.git
cd NyWorkflow
pnpm install
pnpm dev
```

Ouvrez **http://127.0.0.1:3080** — c'est tout. Depuis la M8, `pnpm dev` démarre **tout** : l'interface web **et** la passerelle webapi intégrée, dans le même processus. Dans la console du serveur :

```
[nyworkflow:webapi] passerelle intégrée sur http://127.0.0.1:8081 · modèle gemini-3.6-flash · cookies absents (…) — voir USERGUIDE.md
```

- **Sans cookies** (premier lancement) : l'interface marche, le sélecteur de modèles affiche la table (8 modèles), mais chaque message renverra une erreur d'authentification claire jusqu'à ce que vous posiez vos cookies (section 2). Aucune réponse n'est jamais simulée tant que la passerelle est là.
- **Passerelle absente** (rare — voir [dépannage](#7-dépannage)) : l'UI bascule en mode simulé avec un message explicite, jamais d'échec silencieux.

Autres commandes utiles :

| Commande | Effet |
|---|---|
| `pnpm dev` | UI + passerelle intégrée (développement, port 3080) |
| `pnpm build` puis `pnpm --filter @nyworkflow/web preview` | idem, sur le build de production (port 4173) |
| `pnpm webapi` | passerelle **seule** en processus autonome (port 8081) — utile pour une passerelle dédiée, un autre port, etc. |
| `pnpm test` / `pnpm test:e2e` | tests unitaires (sans réseau) / tests d'interface |
| `pnpm typecheck` | vérification TypeScript de tout le monorepo |

## 2. Connecter Gemini (cookies)

La passerelle parle à l'interface web Gemini **avec vos cookies de session** — aucun compte développeur, aucune clé API.

### Récupérer ses cookies

1. Connectez-vous à [gemini.google.com](https://gemini.google.com) dans votre navigateur.
2. Exportez les cookies Google, au choix :
   - **Extension** type *EditThisCookie* : exportez le JSON du domaine `google.com` ;
   - **DevTools** : onglet Réseau, requête vers `gemini.google.com`, copiez l'en-tête `Cookie` complet.

### Les poser

Créez le fichier `.nyworkflow/cookies/gemini.json` (dossier déjà gitignoré). **Trois formats sont acceptés** :

```jsonc
// 1. Export EditThisCookie (tel quel)
[
  { "name": "SAPISID", "value": "…", "domain": ".google.com", "expirationDate": 1790000000 },
  { "name": "HSID", "value": "…", "domain": ".google.com" }
]
```

```jsonc
// 2. Objet gemini-web2api
{ "cookie": "SAPISID=…; HSID=…; SID=…", "sapisid": "…" }
```

```jsonc
// 3. Chaîne brute
"SAPISID=…; HSID=…; SID=…"
```

C'est tout. **Le fichier est relu à chaud** : changer ou remplacer le cookie ne redémarre rien — la prochaine requête utilise le nouveau fichier.

### Multi-comptes (rotation automatique)

Pointez `NYW_WEBAPI_COOKIE_FILE` vers un **répertoire** : chaque fichier dedans devient un compte (ordre alphabétique). Quand un compte est refusé (cookie expiré, 401), la passerelle **passe au suivant** et rejoue la requête — sans rien dupliquer de ce qui a déjà été diffusé.

```
.nyworkflow/cookies/
├── compte-a.json
├── compte-b.json
├── compte-c.json
└── accounts.json     ← optionnel : le manifeste des sessions (M9)
```

L'état de chaque compte (fichier, cookies valides, erreur de format) est visible dans **Paramètres → Passerelle**.

### Sessions Google par compte — `accounts.json` (M9)

Chaque fichier de cookies est un compte Google **et son index de session**. L'index, c'est le `/u/N` qui apparaît dans la barre d'adresse de Gemini quand vous êtes connecté à ce compte : `gemini.google.com/u/1/app` → index `1` (le compte par défaut du navigateur est presque toujours `/u/0`).

Posez un fichier `accounts.json` à côté des cookies pour dire à la passerelle qui est qui :

```jsonc
{
  "accounts": [
    { "file": "compte-a.json", "authUser": 0, "label": "Perso" },
    { "file": "compte-b.json", "authUser": 1, "label": "Pro" }
  ]
}
```

- **Pourquoi c'est important** : sans manifeste, la rotation M8 envoyait le compte 2 avec l'adresse de session du compte 1 — Google répondait 401. Avec le manifeste, le préfixe `/u/N`, le referer et l'en-tête `x-goog-authuser` suivent le compte **actif** : la rotation change de session toute seule.
- Le `label` est purement cosmétique — il s'affiche dans les Paramètres et les stats à la place du nom de fichier.
- Pas d'entrée pour un compte ? La passerelle replie sur `NYW_WEBAPI_AUTH_USER` (entier ≥ 0), sinon pas de préfixe.
- Le manifeste est **relu à chaud** (changer un index ne redémarre rien) ; entrées invalides ignorées une par une, jamais fatal. Surcharge : `NYW_WEBAPI_ACCOUNTS_FILE` pointe un manifeste ailleurs.

### Voir venir l'expiration des cookies (M9)

L'export EditThisCookie porte les dates d'expiration : la passerelle montre **la plus proche** par compte, **avant** qu'elle ne devienne un 401 —

- dans **Paramètres → Passerelle**, table « Comptes & sessions » : « dans 6 j » (orange, à ≤ 7 jours), la date seule au-delà, « expiré depuis 3 j » (rouge) ;
- au démarrage de `pnpm webapi` : `expiration : Perso — cookies expirés dans ~5 j`.

Une chaîne brute n'a pas de date : rien ne s'affiche pour elle (on ne peut pas prédire). Un compte « expiré depuis » se recharge comme n'importe quel cookie — le fichier est relu à chaud.

## 3. Tour de l'interface

Une seule surface : **les sessions** — et chaque session est un agent ICM qui vit dans **son dossier** (obligatoire). La barre latérale **groupe les sessions par dossier workspace** (groupes repliables — l'état est retenu, compteur de sessions, bouton « + » par groupe pour démarrer directement dedans).

### Nouvelle session — le dialogue (dossier OBLIGATOIRE, M14)

Le bouton **Nouvelle session** (ou `/new`) ouvre un dialogue avec **trois onglets** pour lier **le dossier de la session** — obligatoire : plus de session sans dossier, l'ICM et les logs de la session vivent dedans.

- **Existant** — un workspace déjà connu (ceux d'`examples/workspaces/`, ou votre dossier via `NYW_WORKSPACES`, ou un dossier déjà enregistré — badge « dossier ») ;
- **Créer** — un workspace neuf : l'ICM complète naît dans son `.workspace/` caché (voir §5) ;
- **Dossier du disque** (M12) — **l'un de vos propres dossiers**, navigué (chemin collable, dossiers seuls, départ au home) puis enregistré : le dossier caché **`.workspace/`** (l'ICM de l'agent) y est créé — **vos fichiers restent intacts**. L'inscription vit dans `examples/workspaces/workspaces.json` (une donnée — éditable à la main, relue à chaud).

Le dernier workspace utilisé est retenu pour la prochaine fois. Le dialogue choisit aussi le **niveau de sécurité** de la session (voir ci-dessous — le défaut se règle dans les Paramètres, et le nom du workspace créé se propose automatiquement à partir du titre). Le bandeau sous l'en-tête rappelle le workspace de la session active (`ICM · nom — API v1beta`) porte le **sélecteur de sécurité** et les **onglets Conversation / Activité**.

> Sans serveur (API indisponible), aucune session ne peut être créée : le dossier étant obligatoire, le dialogue affiche « Serveur requis » — lancez `pnpm dev` puis réessayez.

### La boucle agentique

À chaque message :

1. **L'ICM part vers le modèle — et il sait OÙ il tourne** — le prompt système (M14) commence par l'identité : « Tu es un agent exécuté DANS le harness NyWorkflow — pas un chatbot », **agir = appeler un outil** (ses `tool_calls` sont réels, exécutés dans le dossier de la session), la racine est le projet du pilote, `.workspace/` est son ICM, `.logs/` est interdit. Puis l'arbre (`.workspace/` + le projet visible) et les `CONTEXT.md` de l'ICM, **rechargés à chaque tour** — avec la consigne de **ne pas relire** ce qui est déjà chargé (leçon des premiers logs réels : le modèle gaspillait 10 tool_calls à relire la charte) et la **méthode agentique** : quand paralléliser, quand détacher une commande, quand explorer sans demander.
2. **Le modèle réfléchit visiblement — et le protocole est le même pour tous (M15/M16)** : chaque réponse du modèle OUVERT par son thought process, dans un bloc **titré** `<thinking title=“…”>…</thinking>` que le harness sépare du texte visible. Dans l’UI, chaque bloc devient une **carte repliable portant son titre** (« Comprendre la demande », « Planifier le tour »…) : ouverte pendant que le dialogue coule, **repliée d’un rang une fois la réponse partie** (le titre + le nombre de caractères restent lisibles), rouvrable d’un clic. Le titre vient du modèle lui-même — c’est le contrat du prompt système, pas une capacité native : **tout modèle chargé suit le même protocole** ; un modèle doté d’un canal de réflexion natif (`reasoning_content`) produit des blocs anonymes « Réflexion » qui coexistent. Le **niveau de réflexion** se règle dans l’en-tête (Auto = défaut du modèle, ou 0–4 — envoyé comme suffixe `@think=N` à la passerelle) ; il est mémorisé et visible dans l’onglet Activité. Le protocole complet est en **trois temps** (M16) : thinking d’abord, puis l’action (tool_calls parallèles et titrés — la réponse s’arrête là), puis l’observation : le harness renvoie au modèle le groupe ENTIER des résultats dans un format défini (`{"tool", "title", "ok", "result"|"error"}`) et un nouveau protocole démarre — le modèle sait qu’il doit attendre, jamais improviser un résultat.
3. **Le modèle agit avec ses outils — groupés et titrés (M15)** — `tool_calls` standard (façon OpenAI) : il lit, liste, cherche, crée des dossiers, propose des écritures. Les appels **indépendants d’un même tour partent en parallèle et en arrière-plan** (le harness les exécute ensemble et les regroupe) ; dans le flux du chat, le tour d’actions apparaît comme **UNE carte « Actions de l’agent »** repliable — compteur en direct (N appels · X ✓ · Y ⏳ · Z ✗) — contenant une **ligne par appel, chacune portant le titre que le modèle lui a donné** (`title` ≤ 60 caractères, ex. « Relire la charte ») suivi de l’outil, de sa cible et du résultat ; cliquez une ligne pour voir les arguments exacts et le payload renvoyé au modèle. Un appel seul reste une ligne nue. **La carte et les titres survivent au rechargement** (ils se rejouent du journal).
4. **Vous décidez — selon le niveau de sécurité (M13)** — trois niveaux par session, dans le bandeau, modifiables **en direct** (le journal garde chaque changement) :
   - **Demander toujours** (défaut) — toute **écriture** (`write`, `shell` — arrière-plan compris) met le tour en pause : la **carte d'approbation** s'affiche **avec l'aperçu du contenu ou de la commande**, un clic **Approuve** (exécution) ou **Refuse** (l'agent continue sans) — et la boucle reprend toute seule. Un appel en attente **survit aux redémarrages** (il se dérive du journal) : rechargez la page, la carte est toujours là.
   - **Accepter automatiquement** — les outils s'exécutent **sans approbation**, et **tous en parallèle** (shells compris) : le mode confiance, pour les sessions jetables ou les workspaces de test.
   - **Aucun outil** — l'ICM charge toujours (le modèle connaît le contexte), mais **aucun outil n'est déclaré ni exécuté** : conversation pure sur le workspace. Un appel malgré tout est refusé côté serveur par un refus **tracé** (`tools_disabled`) — le modèle le voit et s'adapte.
5. **Vous gardez la main** — le bouton **Stop** (à la place de l’envoi pendant un tour) interrompt proprement : le texte déjà reçu est conservé et journalisé, une approbation en attente est refusée. Le composer reste **actif** pendant un tour : un message tapé à ce moment part **dès la fin du tour** (message « mis en file ») — jamais perdu.

Les **neuf outils** (tous fonctionnels, périmètre = la racine du dossier de session, garde lexicale **et** realpath — un symlink ne s’échappe pas) :

| Outil | Arguments | Exécution |
|---|---|---|
| `read` | `{"path"}` | auto (32 Kio max) |
| `write` | `{"path","content"}` | **approbation** (128 Kio max) |
| `ls` | `{"path"}` | auto |
| `glob` | `{"pattern"}` (`*`, `**`, `?`) | auto |
| `mkdir` | `{"path"}` | auto — l'arbre est libre, le modèle le façonne |
| `shell` | `{"command", "background"?}` | **approbation** — bash, cwd = racine, 30 s max en avant-plan ; `background: true` détache (voir ci-dessous) |
| `shell_output` | `{"jobId"}` | auto — sortie d’un processus d’arrière-plan (stdout/stderr, code, en cours ?) |
| `shell_kill` | `{"jobId"}` | auto — arrête un processus d’arrière-plan |
| `websearch` | `{"query"}` ou `{"url"}` | auto — recherche (titres/URLs/snippets) ou page **nettoyée** |

**L'argument `title` (M15)** : chaque outil accepte en plus un argument `title` (optionnel, ≤ 60 caractères) — le titre court que le modèle donne à son appel (« Relire la charte »), affiché sur la ligne dans le chat et journalisé avec l'appel. Le prompt système ICM demande au modèle de le remplir à chaque appel ; un appel sans `title` reste pleinement valide.

**Arrière-plan, à la Claude (M12)** : `shell {"command": "make watch", "background": true}` rend un **jobId immédiat** (après votre approbation — c’est un shell) ; le modèle le suit avec `shell_output` et l’arrête avec `shell_kill`. Bornes : 16 jobs vivants par workspace, 10 minutes de durée de vie, 64 Kio par flux. Le registre vit en mémoire : après un redémarrage du serveur, un jobId est « processus inconnu » — le modèle le voit et relance si besoin.

**websearch nettoie pour le modèle** (demande du pilote) : scripts, styles, navigation, en-têtes/pieds de page, formulaires, commentaires et attributs inutiles sont retirés ; les URI `data:` (mégaoctets de base64) sautent ; les **balises sémantiques restent** (`h1..h6`, `p`, `li`, `table`, `pre/code`, `a href`…) — le contenu arrive structuré et lisible, plafonné à 64 Kio.

Tout est journalisé : messages, appels d'outils, refus (`tool.call` / `tool.result` en append-only sous `.nyworkflow/sessions/`, un JSONL par session) — **appariés par `callId`** depuis la M12, pour que les appels parallèles gardent chacun son résultat (les anciens journaux se lisent pareil). Un chemin hors workspace est refusé **et tracé**, jamais silencieux.

### L'onglet Activité — le tracking façon harness (M12)

Le bandeau de la session porte deux onglets : **Conversation** (le chat) et **Activité** — la trace complète, chronologique :

- chaque **requête modèle** : horodatage, modèle demandé (suffixe de réflexion compris), nombre de messages et de déclarations d'outils envoyées, durée, résultat (réponse / appels d'outils / erreur / interrompu), caractères de réflexion et de réponse reçus — dépliable pour le détail ;
- chaque **appel d'outil** : arguments et résultat exact renvoyé au modèle (payload JSON dépliable), statut ok/refusé/en approbation.

Depuis la M13, **tout l'onglet survit au rechargement** : les tours terminés sont journalisés (`turn.completed` — modèle, tours, durée, résultat) et ré-hydratés au démarrage, aux côtés des appels d'outils du journal ; les requêtes en cours restent tracées en direct par le navigateur.

### Modèle et niveau de réflexion (M12)

L'en-tête porte le sélecteur de modèle **groupé et étiqueté** (Raisonnement / Flash / Pro / Auto / Lite — les modèles « réflexion » portent une étoile ; les libellés viennent de la passerelle, un serveur externe garde ses ids purs) et le **niveau de réflexion** (Auto = défaut du modèle, 0 · minimal … 4 · maximum). Le choix est mémorisé d'une session à l'autre ; le suffixe `@think=N` part tel quel vers la passerelle, qui le borne (0–4).

### Sessions — gestion

- **Renommer** (crayon au survol d'une session, double-clic sur son titre, ou `/rename <titre>`) — le nouveau titre survit aux rechargements (événement `session.renamed` au journal).
- **Fork** copie un journal (avec son historique d'outils) pour explorer une variante sans toucher à l'original.
- **Supprimer** (icône corbeille, deux clics — armer puis confirmer) efface la session : son journal disparaît du disque, l'UI bascule sur la session précédente. Une suppression est une décision, pas une édition.
- Sessions anciennes (M4–M10) : elles restent lisibles ; une session liée à un ancien workspace d'étapes devient agentique telle quelle (l'arbre se lit pareil), une session sans workspace converse simplement sans outils — elles se regroupent sous « Sans workspace ».

Commandes du chat (préfixées par `/`) :

| Commande | Effet |
|---|---|
| `/new [titre]` | Ouvre le dialogue de nouvelle session (titre prérempli) |
| `/rename <titre>` | Renomme la session active |
| `/delete` | Supprime la session active (même garde-fou que le bouton) |
| `/help` | Liste les commandes |
| `/clear` | Vide l'affichage — **le journal reste intact** |

## 4. Le menu Paramètres

Le bouton **Paramètres** (engrenage, bas de la barre latérale) ouvre une modale en cinq sections :

- **Apparence** — thème **Auto (système) / Clair / Sombre**, appliqué à l'instant et persisté (localStorage). « Auto » suit la préférence du système.
- **Sécurité** (M13) — le **niveau par défaut des nouvelles sessions** (Demander toujours / Accepter automatiquement / Aucun outil), persisté. Le niveau de CHAQUE session se règle dans son bandeau (et à la création) : le journal garde la vérité.
- **Passerelle webapi** — le diagnostic vivant de la passerelle : état, version, modèle par défaut, **cookies présents/absents** (avec le chemin du fichier), session effective `/u/N` du compte actif, `bl` découvert, proxy configuré, et le **journal amont** — les derniers tours avec leur résultat : `ok`, ou l'erreur **typée** (`authentication`, `http 500`, `divergence`…) avec la durée et le nombre d'essais. Survolez un badge d'erreur pour le message complet. Depuis M9, deux tableaux de plus :
  - **Comptes & sessions** — un compte par ligne : libellé (du manifeste `accounts.json`) ou nom de fichier, session `/u/N`, validité des cookies, et **expiration vue d'avance** (« dans 6 j » en orange, « expiré depuis 3 j » en rouge) ;
  - **Statistiques par compte** — tours, réussites, échecs et dernier tour par compte (fenêtre du journal amont, 50 tours).
- **Profiling & logs** (M13, élargi M16) — le quatuor de journaux JSONL qui pousse dans `.nyworkflow/.logs/` (vue engine globale) : `engine.jsonl` (démarrages, passerelle, **chaque requête HTTP** de l'app, tours amont avec modèle/durée/essais/erreur), `session.jsonl` (cycle de vie : création, messages, renommages, forks, suppressions, changements de sécurité), `activity.jsonl` (chaque appel d'outil, chaque résultat, chaque décision humaine, chaque tour terminé) et **`model.jsonl` (M16)** — **la réponse du modèle à chaque round** : thinking titré, texte, tool_calls titrés, durée, taille du prompt ICM (`systemChars`), et **conformité au protocole calculée serveur** (`protocol.thinkingFirst`, `thinkingTitled`, `toolCallsTitled`) — le journal qui dit si le protocole trois temps est suivi en vrai. Lignes et tailles d'un coup d'œil, queue de 50 lignes d'un clic, rotation automatique à 8 Mio (trois rotations gardées). **Et depuis la M14, chaque session a SON quatuor dans son dossier** : `<dossier de la session>/.logs/<sessionId>/` (mêmes quatre journaux, l'histoire complète de CETTE session — cycle de vie, chat, tours, tool_calls, réponses du modèle) ; supprimer la session garde son `.logs/`, c'est l'histoire durable. **Zippez et copiez ces dossiers dans le dépôt** pour partager un profil avec le développement — c'est fait pour améliorer et peaufiner le harness.
- **À propos** — versions et lien vers ce guide.

`Échap` ou le bouton ✕ ferment la modale.

## 5. Créer son propre workspace

Un workspace = **un dossier** — le terrain de la session. Trois portes :

- **scaffold** — l'onglet **Créer** du dialogue, ou `curl -s -X POST http://127.0.0.1:3080/workspaces -H 'content-type: application/json' -d '{"name": "missions"}'` ;
- **dossier du disque** (M12) — l'onglet **Dossier du disque** du dialogue (navigateur intégré), ou `curl -s -X POST http://127.0.0.1:3080/workspaces -H 'content-type: application/json' -d '{"name": "mes-docs", "path": "/home/moi/mes-documents"}'` — le dossier caché `.workspace/` (l'ICM de l'agent) y est créé, idempotent, vos fichiers intacts ; inscription dans `examples/workspaces/workspaces.json` ;
- **dossier de workspaces entier** — `NYW_WORKSPACES=/chemin/vers/mes/workspaces pnpm dev` (le registre devient votre dossier).

Avec le scaffold (M14, élargi M16), l'**ICM complète** naît dans le dossier caché **`.workspace/`** — 26 fichiers prêts à l'emploi (charte, doc du harness, protocole d'outils + 9 fiches rigoureuses, et l'atelier complet), façonnés par l'état de l'art (contrats de rôles par dossier façon Model Workspace Protocol, quatuor plan/tâches/journal/décisions des scratchpads structurés, mémoire cœur/leçons à la MemGPT, registre de sources pour la traçabilité) — pendant que **votre projet reste propre à la racine** (le pattern des dossiers cachés, comme `.git` ou `.claude`) :

```
mon-projet/                    # le dossier de session — votre terrain
├── .workspace/                # L'ICM complet de l'agent (caché)
│   ├── CONTEXT.md             #   la charte : Mission, Méthode ICM, Carte, Outils, Règles
│   ├── harness/               #   la doc du harness : charte chargée à chaque tour + ENGINE.md (le moteur expliqué)
│   ├── tools/                 #   le protocole trois temps (chargé) + une fiche rigoureuse par outil
│   ├── inbox/CONTEXT.md       #   vos entrées — la boîte qui se vide
│   ├── notes/                 #   l'atelier : plan, tâches, journal, décisions
│   ├── research/              #   les lectures du web + registre des sources
│   ├── memory/                #   mémoire durable (core/lessons, façon MemGPT)
│   ├── outputs/CONTEXT.md     #   les livrables finaux
│   └── archive/CONTEXT.md     #   le travail terminé
├── .logs/<sessionId>/         # le quatuor de profilage DE chaque session (M14/M16)
└── …vos fichiers à vous        # le projet du pilote — l'agent y travaille
```

**Éditez le `.workspace/CONTEXT.md`** : c'est la première chose que le modèle lit à chaque tour. Remplacez la section Mission par l'objectif réel du workspace, ajustez les conventions — tout le reste (arbre, outils, approbations, méthode agentique) est déjà enseigné au modèle par la charte et le prompt système. Une seconde session sur le même dossier **continue la mémoire vivante** : le `.workspace/` existant n'est jamais réécrit.

Le chargeur lit **9 `CONTEXT.md`** avec ce scaffold (racine + harness + protocole d'outils + six dossiers — trois de marge sous le plafond de 12, 32 Kio chacun) : le modèle voit toute la carte dès le premier tour. **Depuis la M16, l'ICM documente le harness lui-même** : `harness/CONTEXT.md` (ce qu'est NyWorkflow, les trois piliers, ce que le moteur fait à chaque tour — chargé) et `harness/ENGINE.md` (la boucle de tour en profondeur — lu à la demande) ; `tools/CONTEXT.md` (le protocole trois temps et le catalogue — chargé) et **une fiche rigoureuse par outil** (`tools/read.md`… : arguments exacts, lancements corrects, erreurs courantes — lues à la demande, le prompt reste borné). L'arbre est **libre** : le modèle crée les dossiers dont il a besoin (`mkdir` — dans `.workspace/` pour son organisation, à la racine pour vos livrables), et un sous-dossier qui acquiert un rôle mérite son propre `CONTEXT.md` (relu comme les autres, jusqu'à 12 fichiers de 32 Kio). Les workspaces d'avant M14 (charte à la racine) se chargent comme avant — repli legacy automatique ; les workspaces d'avant M16 sont **upgradés** à la session suivante (fichiers de base manquants ajoutés, mémoire vivante intacte).

Exemple complet et commenté : `examples/workspaces/exemple-agentique/.workspace/`.

## 6. La passerelle webapi

### Intégrée ou autonome

| Mode | Comment | Quand |
|---|---|---|
| **Intégrée** (défaut) | `pnpm dev` ou `pnpm preview` | Le cas normal : un seul processus, un seul terminal |
| **Autonome** | `pnpm webapi` | Passerelle dédiée, autre port, plusieurs passerelles |

Règles d'engagement de l'intégration (dans cet ordre) :

1. `W2A_URL` défini → **pas d'intégration** : la cible externe est respectée (autre serveur OpenAI-compatible, maquette de test…).
2. `NYW_WEBAPI_EMBED=0` → intégration coupée explicitement.
3. Le port est déjà occupé → une passerelle externe (ex. `pnpm webapi`) est détectée et **utilisée telle quelle**.
4. Sinon → la passerelle démarre avec le serveur web et le proxy `/api` la vise automatiquement.

### Configuration par environnement

Toute la config vit dans des variables `NYW_WEBAPI_*` (12 facteurs, rien de caché) :

| Variable | Défaut | Rôle |
|---|---|---|
| `NYW_WEBAPI_EMBED` | `1` | `0` = ne pas démarrer la passerelle intégrée avec l'UI |
| `NYW_WEBAPI_HOST` / `NYW_WEBAPI_PORT` | `127.0.0.1` / `8081` | Adresse d'écoute (le proxy `/api` suit automatiquement) |
| `NYW_WEBAPI_COOKIE_FILE` | `.nyworkflow/cookies/gemini.json` | Fichier de cookies — **ou répertoire multi-comptes** (M8) |
| `NYW_WEBAPI_ACCOUNTS_FILE` | `accounts.json` à côté des cookies | **Manifeste des comptes (M9)** : `{"file", "authUser", "label"}` — session `/u/N` par compte + libellé, relu à chaud |
| `NYW_WEBAPI_COOKIES` | — | Chaîne de cookies directe (gagne sur le fichier) |
| `NYW_WEBAPI_MODEL` | `gemini-3.6-flash` | Modèle par défaut |
| `NYW_WEBAPI_MODELS_FILE` | table interne | Table de modèles JSON de remplacement (le réflexe « Google a renommé ses modèles ») |
| `NYW_WEBAPI_GEMINI_BL` | auto-découvert | Force la version de l'interface Gemini |
| `NYW_WEBAPI_AUTH_USER` | — | Index de session **de repli** (entier ≥ 0) — le manifeste `accounts.json` gagne par compte (M9) |
| `NYW_WEBAPI_PROXY` | — | **Proxy sortant** (`http://user:pass@proxy:3128`) ; à défaut `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` sont respectés, `NO_PROXY` exclut des hôtes |
| `NYW_WEBAPI_TLS_CA` | — | CA PEM additionnel (fichier ou chaîne) — indispensable derrière un proxy qui rechiffre |
| `NYW_WEBAPI_TIMEOUT_MS` | `180000` | Délai maximal d'une requête amont |
| `NYW_WEBAPI_RETRY_ATTEMPTS` / `NYW_WEBAPI_RETRY_DELAY_MS` | `3` / `2000` | Retries avec backoff + jitter |
| `NYW_WEBAPI_GEMINI_BASE_URL` | `https://gemini.google.com` | Pour les tests (maquette locale) |

### L'API servie (deux dialectes, deux namespaces — M10 + M11)

```
# OpenAI-compatible — sous v1 ET v1beta (M11 : l'app consomme v1beta par défaut)
GET  /                                  # diagnostic : version, modèles, cookies, comptes, proxy, journal
GET  /v1/models                         # liste des modèles (forme OpenAI)
POST /v1/chat/completions               # chat — stream SSE ("stream": true) ou complet, avec tools
POST /v1beta/chat/completions           # le MÊME dialecte OpenAI sous le namespace v1beta

# Google-style (v1beta)
GET  /v1beta/models                     # liste (forme Google)
GET  /v1beta/models/{nom}               # un modèle
POST /v1beta/models/{modèle}:generateContent          # chat (candidates/parts/usageMetadata)
POST /v1beta/models/{modèle}:streamGenerateContent    # stream : ?alt=sse → SSE, sinon tableau JSON
```

La liste des namespaces est **une donnée** côté passerelle (`OPENAI_CHAT_PATHS`) : le jour où Google sert un `v2`, il s'ajoute sans toucher au moteur ; côté client, l'adaptateur expose `apiVersion` (défaut `v1beta`). En direct : `curl -s http://127.0.0.1:8081/` (ou `http://127.0.0.1:3080/api/` à travers l'UI). Tout serveur OpenAI-compatible peut remplacer la passerelle : `W2A_URL=http://… pnpm dev` (l'adaptateur retombe sur `/v1/models` si `/v1beta/models` répond 404). Le suffixe `@think=N` marche partout.

**Les tools façon OpenAI** — déclarez vos fonctions, la passerelle enseigne la convention au modèle et décode ses appels :

```sh
curl -s http://127.0.0.1:8081/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "gemini-3.6-flash",
  "messages": [{"role": "user", "content": "Météo à Paris ?"}],
  "tools": [{"type": "function", "function": {
    "name": "get_weather",
    "description": "Météo d'une ville",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
  }}]
}'
# → choices[0].message.tool_calls = [{id: "call-…", type: "function",
#     function: {name: "get_weather", arguments: "{\"city\":\"Paris\"}"}}]
#   choices[0].finish_reason = "tool_calls"   (en streaming : delta.tool_calls, même final)
```

La boucle complète : renvoyez le résultat en `{"role": "tool", "tool_call_id": "…", "content": "…"}` dans l'historique — la passerelle le transmet au modèle avec la même convention, il se reconnaît. `tool_choice` accepte `"auto"` (défaut), `"none"` (pas de préambule), `"required"`, ou `{"type": "function", "function": {"name": "…"}}` (forcé).

Côté Google (`:generateContent`), c'est symétrique : `tools: [{"functionDeclarations": […]}]` en entrée, `{functionCall: {name, args}}` dans les parts de la réponse, `toolConfig.functionCallingConfig` pour le mode (`AUTO`/`ANY`/`NONE` + `allowedFunctionNames`), et l'historique d'outils se renvoie en parts `functionCall` / `functionResponse`.

Comment ça marche (et pourquoi c'est robuste) : l'interface web Gemini ne connaît pas les outils du client — la passerelle les décrit dans le prompt avec une convention de blocs `{{tool {…} }}`, puis décode la réponse **en flux**. Tout ce qui ne respecte pas la convention (prose, JSON invalide, bloc non refermé) ressort en texte tel quel — jamais perdu, jamais transformé. En SSE `/v1beta`, un échec amont est un événement `error` Google en fin de flux — jamais un `STOP` déguisé.

### Anti-casseurs (héritage ny-gemini-acp, corrigé)

- `bl` **auto-découvert** sur la page `/app` (plus de version figée qui périmait) ;
- jetons de page **rafraîchis avant chaque retry** HTTP 4xx ;
- table de modèles **data-driven** ;
- retries avec backoff borné + jitter, **seulement si rien n'a été diffusé** ;
- erreurs **typées** : `authentication`, `network`, `upstream`, `unknown-model`, `divergence`, `safety`, `empty`, `http`.

## 7. Dépannage

| Symptôme | Cause | Quoi faire |
|---|---|---|
| Message « Passerelle webapi absente » | `NYW_WEBAPI_EMBED=0`, ou le port est occupé par autre chose qu'une passerelle | Retirez `NYW_WEBAPI_EMBED=0` ; vérifiez le port (`NYW_WEBAPI_PORT`) ; ouvrez Paramètres → Passerelle pour le diagnostic |
| Badge « cookies absents » dans Paramètres | `.nyworkflow/cookies/gemini.json` absent ou vide | Section [2](#2-connecter-gemini-cookies) — le fichier est relu à chaud, pas de redémarrage. Un compte peut aussi être **expiré** : la table Comptes & sessions l'affiche (« expiré depuis N j ») avant même le premier 401 — rechargez ce fichier-là |
| La rotation passe au compte suivant mais tout échoue | Sessions mal adressées : le compte 2 parle avec l'index du compte 1 | Posez un `accounts.json` (section [2](#2-connecter-gemini-cookies)) — un fichier = un compte **et** son `/u/N` |
| `Cookies Gemini expirés ou refusés (HTTP 401/403)` | Session Google expirée | Re-connectez-vous à gemini.google.com et **remplacez** le fichier de cookies ; avec un répertoire multi-comptes, la rotation passe au compte suivant automatiquement |
| `Gemini a refusé de répondre (blockReason…)` | Politique de sécurité Google | Reformulez le prompt — ce n'est pas un bug |
| `le flux Gemini a divergé` | Snapshots incompatibles (interface en évolution) | Réessayez ; si ça persiste, forcez `NYW_WEBAPI_GEMINI_BL` récent ou vérifiez la table de modèles |
| `requête Gemini impossible` | Réseau / proxy | Vérifiez `NYW_WEBAPI_PROXY`, `NO_PROXY`, `NYW_WEBAPI_TLS_CA` (proxy d'entreprise) — le badge Proxy dans Paramètres montre la config active (identifiants masqués) |
| L'étape d'un run échoue | Erreur passerelle typée (voir badge dans le journal amont) | Corrigez la cause (souvent les cookies), puis re-cliquez **Exécuter l'étape suivante** — le run reprend du checkpoint |
| `{{tool …}}` apparaît en clair dans une réponse au lieu d'un `tool_call` | La passerelle n'a pas reconnu le bloc du modèle (JSON invalide ou fermeture absente) — par conception, le texte n'est JAMAIS perdu ni altéré | Reformulez ou resserrez la description de l'outil ; en `"tool_choice": "none"` c'est le comportement attendu (pas de décodage) |
| Un client Google échoue sur `/v1beta/…` | Modèle inconnu dans le chemin, ou méthode non servie (`countTokens`…) | Vérifiez le nom dans `GET /v1beta/models` ; la passerelle sert `generateContent` et `streamGenerateContent` — c'est affiché par modèle dans `supportedGenerationMethods` |
| « Aucun modèle dans la réponse » | Passerelle absente ou `W2A_URL` mort | Paramètres → Passerelle ; vérifiez `W2A_URL` si vous l'avez défini |
| Sessions disparues ? | Elles ne le sont pas : `.nyworkflow/sessions/` | `NYW_HOME` pointe ailleurs ? Le repli mémoire (API absente) affiche un message clair |

---

**Interface inspirée de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT) — nous gardons l'UX, pas le moteur. Licence NyWorkflow : MIT.
