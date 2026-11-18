import type { ToolDeclaration } from '@nyworkflow/adapter-llm'

/**
 * The agent's tools, declared the modern standard way (OpenAI function
 * declarations) and sent with every agentic request. The gateway teaches
 * the call format upstream (M10 preamble); the ICM system prompt teaches
 * the workspace conventions (M12: parallelism, background; M15: the
 * two-phase response protocol and titled calls); these declarations say
 * WHAT each tool does.
 *
 * M15 — every tool accepts a `title` argument: the short line the pilot
 * reads on the call's row (the ICM protocol asks for one on each call;
 * optional, so a model that omits it stays functional).
 *
 * All nine are available and functional (M12): read, write, ls, glob,
 * mkdir, shell (+ background), websearch, shell_output, shell_kill.
 */

/** The M15 `title` argument, shared by every declaration (optional). */
const TITLE_ARG = {
  type: 'string',
  description: 'Titre court (≤ 60 caractères) de cet appel pour le pilote — ex. « Lire la charte », « Chercher les références ».',
} as const

export const AGENT_TOOLS: readonly ToolDeclaration[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: "Lit un fichier texte du workspace (chemin relatif à la racine). Retourne le contenu, tronqué à 32 Kio.",
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          path: { type: 'string', description: 'Chemin relatif au workspace, ex. CONTEXT.md ou notes/plan.md' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: "Écrit un fichier texte dans le workspace (crée les dossiers parents). Demande l'approbation du pilote avant exécution.",
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          path: { type: 'string', description: 'Chemin relatif du fichier à écrire' },
          content: { type: 'string', description: 'Contenu textuel complet du fichier' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: 'Liste un dossier du workspace (nom + type, trié).',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          path: { type: 'string', description: 'Dossier relatif — "." pour la racine' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Cherche des fichiers par motif : * (un segment), ** (toute profondeur), ? (un caractère).',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          pattern: { type: 'string', description: 'Motif relatif au workspace, ex. **/*.md' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mkdir',
      description: 'Crée un dossier (récursif) dans le workspace — façonne ton arbre librement.',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          path: { type: 'string', description: 'Chemin relatif du dossier à créer, ex. research/ddg' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description:
        "Exécute une commande bash avec la racine du workspace pour cwd (30 s max en avant-plan, sorties bornées). Demande l'approbation du pilote. Pour une commande longue, passe background: true — un jobId est rendu immédiatement, suis-le avec shell_output.",
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          command: { type: 'string', description: 'La commande à exécuter, ex. "ls -la | head -20"' },
          background: { type: 'boolean', description: 'true = détaché : rend un jobId immédiat, 10 min max (suivi via shell_output)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'websearch',
      description:
        'Recherche web (query) ou lecture de page (url). Le contenu est NETTOYÉ : scripts, styles, navigation et attributs retirés, balises sémantiques gardées. Donne query OU url.',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          query: { type: 'string', description: 'Requête de recherche — retourne titres, URLs et snippets' },
          url: { type: 'string', description: 'URL http(s) à lire — retourne la page nettoyée' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_output',
      description:
        "Suit un processus d'arrière-plan lancé par shell {background:true} : stdout/stderr accumulés, code de sortie, en cours ou fini. Libre d'accès.",
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          jobId: { type: 'string', description: 'Identifiant rendu par le shell en arrière-plan' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_kill',
      description: "Arrête un processus d'arrière-plan lancé par l'agent. Libre d'accès (c'est ton propre processus).",
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          jobId: { type: 'string', description: 'Identifiant rendu par le shell en arrière-plan' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'no_tool',
      description:
        'M21 — le garde-fou du contrat d’appels : quand ta réponse est la prose finale et qu’AUCUN outil n’est nécessaire, émets CE tool_call unique (jamais mélangé à d’autres appels). Il signe la fin du tour sans rien exécuter — le format « thinking puis tool_calls » reste constant.',
      parameters: {
        type: 'object',
        properties: {
          title: TITLE_ARG,
          reason: { type: 'string', description: 'Pourquoi aucun outil n’est nécessaire ce tour (une ligne, optionnel)' },
        },
      },
    },
  },
]

/** Parses the arguments string of a tool call (JSON) — {} when unreadable. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  return parseToolArgsStrict(raw).args
}

/**
 * M17 — the STRICT parse: the args AND the verdict. A model emitting
 * malformed JSON arguments is a protocol failure the profiling must SHOW
 * (rawArgs stays, argsOk: false) — parseToolArgs alone swallowed it into
 * {}, hiding the bad format the pilot wants to see.
 */
export function parseToolArgsStrict(raw: string): { ok: boolean; args: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> }
    }
  } catch {
    // unreadable JSON — the caller keeps the raw string for the log
  }
  return { ok: false, args: {} }
}

/** M15 — the `title` argument of a call, when the model filled it ('' otherwise). */
export function titleOfArgs(args: unknown): string {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>).title
    if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 60)
  }
  return ''
}

/** The tools a human must approve before they run (write, shell — the
 * background shells included). Client mirror of the server's isDangerous. */
export function isDangerousTool(name: string): boolean {
  return name === 'write' || name === 'shell'
}

/** M21 — the contract sentinel: the call that signs a tool-less final
 * answer. Alone in its group, it ends the turn; mixed with real calls it
 * is a protocol violation the mentor corrects. */
export const NO_TOOL = 'no_tool'
