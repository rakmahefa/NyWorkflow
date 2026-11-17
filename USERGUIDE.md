# Guide utilisateur — NyWorkflow

> Le mode d'emploi complet du harness : installation, cookies Gemini, interface, workflows ICM, paramètres, passerelle et dépannage. Pour le « pourquoi » du projet et son architecture, voir le [README](README.md) et [ARCHITECTURE.md](ARCHITECTURE.md).

## Sommaire

1. [Démarrage rapide](#1-démarrage-rapide)
2. [Connecter Gemini (cookies)](#2-connecter-gemini-cookies)
3. [Tour de l'interface](#3-tour-de-linterface)
4. [Le menu Paramètres](#4-le-menu-paramètres)
5. [Créer son propre workflow](#5-créer-son-propre-workflow)
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

Deux onglets dans la barre latérale, deux visages du même harness.

### Sessions — la conversation

- Posez une question, la réponse arrive **en streaming** ; le modèle se choisit dans l'en-tête.
- **Tout est journalisé** en append-only sous `.nyworkflow/sessions/` (un fichier JSONL par session) : fermez l'UI, relancez `pnpm dev`, tout revient — titres, messages, forks.
- Le bouton **Fork** copie un journal pour explorer une variante sans toucher à l'original.

Commandes du chat (préfixées par `/`) :

| Commande | Effet |
|---|---|
| `/new [titre]` | Nouvelle session (titre optionnel) |
| `/help` | Liste des commandes |
| `/clear` | Vide l'affichage — **le journal reste intact** |

### Workflows — le pipeline ICM

1. Choisissez un workspace dans la barre latérale (ceux d'`examples/workspaces/`, ou votre dossier via `NYW_WORKSPACES`).
2. Donnez un **sujet** et cliquez **Nouveau run** — le sujet devient une session journalisée, visible aussi dans l'onglet Sessions.
3. Cliquez **Exécuter l'étape suivante** : le moteur assemble le contexte, interroge le modèle, écrit la réponse dans `output/`. L'étape passe à **Fait**, la suivante attend.
4. À chaque étape : prévisualisez les sorties (un clic — contenu actuel du fichier), **éditez-les si vous voulez** : l'étape suivante lira votre version.
5. Cochez **Outils** : le modèle peut `read` / `ls` / `glob` dans le workspace (automatiques) et `write` — mais **toute écriture met le run en pause** : une carte d'approbation s'affiche, vous décidez d'un clic (Approuver / Refuser), l'étape reprend. Refus et appels hors périmètre sont journalisés.

L'état d'un run **survit aux redémarrages** — il se reconstruit du journal.

## 4. Le menu Paramètres

Le bouton **Paramètres** (engrenage, bas de la barre latérale) ouvre une modale en trois sections :

- **Apparence** — thème **Auto (système) / Clair / Sombre**, appliqué à l'instant et persisté (localStorage). « Auto » suit la préférence du système.
- **Passerelle webapi** — le diagnostic vivant de la passerelle : état, version, modèle par défaut, **cookies présents/absents** (avec le chemin du fichier), session effective `/u/N` du compte actif, `bl` découvert, proxy configuré, et le **journal amont** — les derniers tours avec leur résultat : `ok`, ou l'erreur **typée** (`authentication`, `http 500`, `divergence`…) avec la durée et le nombre d'essais. Survolez un badge d'erreur pour le message complet. Depuis M9, deux tableaux de plus :
  - **Comptes & sessions** — un compte par ligne : libellé (du manifeste `accounts.json`) ou nom de fichier, session `/u/N`, validité des cookies, et **expiration vue d'avance** (« dans 6 j » en orange, « expiré depuis 3 j » en rouge) ;
  - **Statistiques par compte** — tours, réussites, échecs et dernier tour par compte (fenêtre du journal amont, 50 tours).
- **À propos** — versions et lien vers ce guide.

`Échap` ou le bouton ✕ ferment la modale.

## 5. Créer son propre workflow

Un workflow = un dossier d'étapes numérotées, posé dans `examples/workspaces/` (ou le dossier pointé par `NYW_WORKSPACES`) :

```
mon-workflow/
├── CONTEXT.md        # la carte : objectif, tableau des étapes, règles (max 80 lignes)
├── 01-recherche/
│   ├── CONTEXT.md    # le contrat : ## Entrées / ## Process / ## Sorties
│   └── output/       # la sortie de l'étape 1 devient l'entrée de l'étape 2
└── 02-redaction/
    ├── CONTEXT.md
    └── output/
```

Le contrat d'étape (format **figé en v1 jusqu'à v0.2.0**) :

```markdown
## Entrées
- `01-recherche/output/faits.md`        # un chemin = un fichier relu sur disque
- le sujet                              # une entrée sans backticks = le sujet du run

## Process
Ce que l'étape doit faire, en une à trois phrases.

## Sorties
- `output/fiche.md`                     # une seule sortie par étape
```

Exemple complet et commenté : `examples/workspaces/exemple-rapport/`. Le workspace apparaît dans l'onglet Workflows au rechargement (bouton ↻ Rafraîchir).

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

### L'API servie (OpenAI-compatible)

```
GET  /                     # diagnostic : version, modèles, cookies, comptes, proxy, journal
GET  /v1/models            # liste des modèles
POST /v1/chat/completions  # chat — stream SSE ("stream": true) ou complet
```

En direct : `curl -s http://127.0.0.1:8081/` (ou `http://127.0.0.1:3080/api/` à travers l'UI). Tout serveur OpenAI-compatible peut remplacer la passerelle : `W2A_URL=http://… pnpm dev`.

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
| « Aucun modèle dans la réponse » | Passerelle absente ou `W2A_URL` mort | Paramètres → Passerelle ; vérifiez `W2A_URL` si vous l'avez défini |
| Sessions disparues ? | Elles ne le sont pas : `.nyworkflow/sessions/` | `NYW_HOME` pointe ailleurs ? Le repli mémoire (API absente) affiche un message clair |

---

**Interface inspirée de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT) — nous gardons l'UX, pas le moteur. Licence NyWorkflow : MIT.
