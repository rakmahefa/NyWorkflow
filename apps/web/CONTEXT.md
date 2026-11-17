# apps/web — UI

Rôle : interface web du harness (React + Vite, port 3080). Le langage visuel est calqué sur DeepSeek Harness (dsh) : tokens repris de `dsh/packages/client/ui-theme` dans `src/styles.css` (palette neutral-bluish, bleu DeepSeek `#4176E6`, boutons primaires noirs, rayons 8/12/16, survols rgba(38,49,72,.06), thème sombre automatique via préférence système, ascenseurs 5px). Aucune logique métier ici — tout passe par les packages. Le serveur web embarque aussi deux API same-origin (plugin Vite, dev et preview) : `/sessions` (journaux M3) et `/workspaces` (moteur ICM M4 + outils M5 + aperçu de fichiers M6 — exécution des étapes côté serveur, le navigateur ne touche jamais les fichiers directement).

Entrées : types et moteur de `packages/core`, journaux de `packages/session`, client de `packages/adapter-llm`, garde de périmètre de `packages/tools` (pour l'aperçu `/file`).
Sorties : application web servie sur `127.0.0.1:3080` — deux vues : Sessions (chat, fork) et Workflows (étapes, progression, prévisualisation des sorties, exécution, approbation) ; API `/sessions` et `/workspaces` (runs, advance avec `tools`, approval, file).

Tâches : M1 ✅, M2 ✅ (sélecteur de modèles, streaming réel), M3 ✅ (sessions), M4 ✅ (API /workspaces), M5 ✅ (endpoint `/approval`, `RunDto.tools`, carte d'approbation + activité d'outils), M6 ✅ (vue workflow complète : onglets, `lib/progress.ts`, `RunDto.outputs`, `GET /workspaces/:name/file`, capture README jouée sur la vue) — voir MILESTONES.md.
