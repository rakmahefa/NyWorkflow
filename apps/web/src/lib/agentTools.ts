import type { ToolDeclaration } from '@nyworkflow/adapter-llm'

/**
 * The agent's tools, declared the modern standard way (OpenAI function
 * declarations) and sent with every agentic request. The gateway teaches
 * the call format upstream (M10 preamble); the ICM system prompt teaches
 * the workspace conventions; these declarations say WHAT each tool does.
 *
 * All seven are available and functional (M11): the four file tools from
 * M5, plus mkdir (the model shapes its tree), shell (approval, cwd =
 * workspace) and websearch (search + cleaned page reads).
 */
export const AGENT_TOOLS: readonly ToolDeclaration[] = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: "Lit un fichier texte du workspace (chemin relatif à la racine). Retourne le contenu, tronqué à 32 Kio.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Chemin relatif au workspace, ex. CONTEXT.md ou notes/plan.md' } },
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
        properties: { path: { type: 'string', description: 'Dossier relatif — "." pour la racine' } },
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
        properties: { pattern: { type: 'string', description: 'Motif relatif au workspace, ex. **/*.md' } },
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
        properties: { path: { type: 'string', description: 'Chemin relatif du dossier à créer, ex. research/ddg' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell',
      description: "Exécute une commande bash avec la racine du workspace pour cwd (30 s max, sorties bornées). Demande l'approbation du pilote.",
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'La commande à exécuter, ex. "ls -la | head -20"' } },
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
          query: { type: 'string', description: 'Requête de recherche — retourne titres, URLs et snippets' },
          url: { type: 'string', description: 'URL http(s) à lire — retourne la page nettoyée' },
        },
      },
    },
  },
]

/** Parses the arguments string of a tool call (JSON) — {} when unreadable. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // unreadable JSON — empty args, the server refuses with a clear reason
  }
  return {}
}
