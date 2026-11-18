# skills/ — ton arsenal : les compétences que tu construis

Tes neuf outils de base sont fixes — mais COMPLETS : avec read, write,
ls, glob, mkdir, shell et websearch, tu construis ce qui manque à la
tâche. Une **skill** est cette construction : un dossier
`skills/<nom>/` avec un `SKILL.md` (mission, déclencheurs, procédure,
commandes exactes, pièges) et, au besoin, des scripts ou gabarits — tes
outils spécialisés, faits par toi, réutilisables. Le gabarit d’une
skill vit dans `skills/_MODELE.md`.

## Le protocole d’évaluation — avant toute tâche non triviale

1. **De quoi la tâche a-t-elle besoin ?** — compétence métier, format de
   livrable, recherche, outillage spécifique.
2. **Une skill du registre la couvre-t-elle ?** — lis son `SKILL.md` et
   suis-la ; elle ne se réinvente pas.
3. **Manque ?** — CONSTRUIS la compétence avant d’improviser :
   - cherche ce qu’il faut savoir (websearch, read sur le projet) ;
   - crée `skills/<nom>/SKILL.md` sur le modèle de `_MODELE.md` ;
   - écris les scripts et gabarits utiles, teste-les (shell) ;
   - INSCRIS-la au registre ci-dessous, consigne les sources dans
     `research/sources.md` et la décision dans `notes/decisions.md`.
4. **Jamais deux fois** — la même procédure improvisée deux fois est une
   skill qui manque : écris-la.

## La boucle d’amélioration — après chaque usage

- **Ça a marché** — renforce la skill : précise l’étape qui a coincé, la
  commande exacte qui a passé.
- **Ça a échoué** — corrige la skill ET consigne la leçon dans
  `memory/lessons.md` : une leçon qui revient est une skill à écrire.
- **C’est obsolète** — la skill part en `archive/` et quitte le
  registre.

## L’ICM elle-même s’améliore

Les chartes (CONTEXT.md) sont des FICHIERS que tu écris : ce que tu
améliores dedans est chargé au tour suivant. Une règle fausse se
corrige, une information manquante s’ajoute (dense — tout ce qui est
chargé se relit à chaque tour), un rôle récurrent mérite son dossier
avec son CONTEXT.md. Note ce que tu changes dans `notes/journal.md` :
l’arsenal est vivant, pas figé.

## Registre des skills

> LA table à tenir à jour : une ligne par skill, tout ce que le tour
> suivant doit savoir sans ouvrir le dossier. Un dossier de skill ne
> porte PAS de CONTEXT.md (il serait chargé à chaque tour) — son
> SKILL.md se lit à la demande.

| Skill | Ce qu’elle fait | Statut |
|---|---|---|
| (aucune — la première que tu construis s’inscrit ici) | | |
