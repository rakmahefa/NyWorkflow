import type { SessionStore } from './store'
import type { SessionInfo } from './types'

export interface ParsedInput {
  kind: 'chat' | 'command'
  text: string
  /** Command name without '/', lowercase. Only for kind='command'. */
  name?: string
  /** Remaining text after the command name. */
  args?: string
}

/** Plain text is chat; anything starting with '/' is a local command. */
export function parseInput(raw: string): ParsedInput {
  const t = raw.trim()
  if (!t.startsWith('/')) return { kind: 'chat', text: t }
  const spaceAt = t.search(/\s/)
  const name = (spaceAt === -1 ? t.slice(1) : t.slice(1, spaceAt)).toLowerCase()
  const args = spaceAt === -1 ? '' : t.slice(spaceAt + 1).trim()
  return { kind: 'command', text: t, name, args }
}

export const HELP_TEXT = [
  'Commandes disponibles :',
  '  /new — ouvrir la boîte de nouvelle session (titre + workspace ICM)',
  '  /rename <titre> — renommer la session active',
  '  /delete — supprimer la session active (confirmation demandée)',
  '  /clear — vider l’affichage de la session courante (le journal est conservé)',
  '  /help — cette aide',
  'Une commande inconnue n’est jamais envoyée au modèle.',
].join('\n')

export interface CommandOutcome {
  /** System message to append (in newActiveId's session if given). */
  systemText: string
  /** Set by /new: the new-session dialog opens with this title prefilled. */
  openNewDialog?: boolean
  /** Set by /delete: the active session to remove. */
  deleteActive?: boolean
  /** M12 — set by /rename: the title change to apply (server + store). */
  renameTo?: string
}

export interface CommandDeps {
  store: SessionStore
  activeSessionId: string
}

/** Executes a local command. Never calls any model. */
export async function runCommand(deps: CommandDeps, name: string, args: string): Promise<CommandOutcome> {
  switch (name) {
    case 'new':
      // The dialog needs a workspace choice — the App opens it (args = title prérempli).
      return { systemText: '', openNewDialog: true }
    case 'delete':
      return { systemText: '', deleteActive: true }
    case 'rename': {
      const title = args.trim().slice(0, 60)
      if (title === '') return { systemText: 'Usage : /rename <titre>' }
      return { systemText: '', renameTo: title }
    }
    case 'clear': {
      // The journal is append-only: /clear empties the view, nothing more.
      const removed = deps.store.clearMessages(deps.activeSessionId)
      return {
        systemText:
          removed > 0 ? `${removed} message(s) effacé(s) — journal conservé (append-only).` : 'Rien à effacer.',
      }
    }
    case 'help':
      return { systemText: HELP_TEXT }
    default:
      return { systemText: `Commande inconnue : /${name} — tapez /help pour la liste.` }
  }
}
