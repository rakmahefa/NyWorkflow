# tools/ — le protocole d’utilisation des outils

Neuf outils, un seul contrat. Le protocole trois temps ci-dessous régit
CHAQUE réponse ; les fiches (`read.md`, `write.md`, …) documentent chaque
outil rigoureusement — lis une fiche avant ta première utilisation de
l’outil, ou quand un appel échoue.

## Le protocole trois temps — à CHAQUE réponse

1. **Thinking** — d’abord, toujours : tu dialogues avec toi-même dans ton
   thought process titré (ce que l’ICM sait, ce qui manque, le plan de CE
   tour). Voir le protocole de réponse dans le prompt système.
2. **Action** — tu émets tes tool_calls : les appels **indépendants
   ENSEMBLE** dans la même réponse (le engine les exécute en parallèle),
   chacun avec son `title`. Puis tu **TERMINES ta réponse** — jamais de
   texte après les tool_calls, jamais de résultat annoncé avant de
   l’avoir reçu.
3. **Observation** — tu **ATTENDS**. Le engine exécute le groupe entier
   et te renvoie, à la fin du protocole, TOUTES les réponses du groupe,
   une par appel, dans ce format :

```
{"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}
{"tool": "shell", "title": "Compiler le projet", "ok": false, "error": "…refusé par le pilote"}
```

C’est en recevant ces réponses qu’un **NOUVEAU protocole démarre** :
retour au temps 1 — thinking, puis la suite (nouveaux tool_calls, ou la
réponse finale si le travail est fini).

## Règles de lancement

- **Indépendants → ensemble** : trois fichiers à lire ? TROIS read dans
  la même réponse. C’est plus rapide et le engine est fait pour ça.
- **Dépendants → attendre** : un appel qui a besoin du résultat d’un autre
  (lire PUIS écrire, chercher PUIS lire l’URL trouvée) attend le protocole
  suivant.
- **Un groupe = une étape** : les tool_calls d’une même réponse forment un
  groupe cohérent, affiché groupé au pilote — un groupe par intention.
- **Titres partout** : le `title` (≤ 60 caractères) dit l’étape au pilote ;
  il te revient dans la réponse — exploite-le pour te repérer.
- **Erreur = signal** : un refus (arguments invalides, hors périmètre,
  refusé par le pilote) se corrige, ne se répète pas à l’identique.

## Catalogue

| Outil | Rôle | Libre ? | Fiche |
|---|---|---|---|
| read | lire un fichier (≤ 32 Kio) | oui | `tools/read.md` |
| write | écrire un fichier (≤ 128 Kio) | approbation | `tools/write.md` |
| ls | lister un dossier | oui | `tools/ls.md` |
| glob | chercher par motif | oui | `tools/glob.md` |
| mkdir | créer un dossier | oui | `tools/mkdir.md` |
| shell | commande bash (30 s / 10 min bg) | approbation | `tools/shell.md` |
| websearch | recherche ou page nettoyée | oui | `tools/websearch.md` |
| shell_output | suivre un job d’arrière-plan | oui | `tools/shell_output.md` |
| shell_kill | arrêter un job d’arrière-plan | oui | `tools/shell_kill.md` |

« Libre » = sans approbation du pilote. Le niveau de sécurité de la
session (ask / accept / no-tools) prime — voir `harness/ENGINE.md`.
