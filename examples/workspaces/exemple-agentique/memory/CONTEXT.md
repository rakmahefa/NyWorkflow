# memory/

La mémoire durable de l’agent, au sens MemGPT : core = les faits toujours vrais (pinned), lessons = les leçons apprises. Chargée à chaque tour via ce CONTEXT.md — gardez-la dense.

## Règles
- core.md : ce qui est TOUJOURS vrai dans ce workspace (préférences du pilote, contraintes, vocabulaire). Pas d’historique ici.
- lessons.md : ce qui a mal tourné et comment l’éviter — une leçon par ligne, actionnable.
- La mémoire se met à jour pendant le travail, pas à la fin.
