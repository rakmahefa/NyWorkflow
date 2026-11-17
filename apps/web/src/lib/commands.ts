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
  '  /new [titre] — créer une session (et basculer dessus)',
  '  /clear — vider l’affichage de la session courante (le journal est conservé)',
  '  /help — cette aide',
  'Une commande inconnue n’est jamais envoyée au modèle.',
].join('\n')

export interface CommandOutcome {
  /** System message to append (in newActiveId's session if given). */
  systemText: string
  /** Set by /new: the freshly created session to switch to. */
  newActiveId?: string
}

export interface CommandDeps {
  store: SessionStore
  /** Session factory — server journal in server mode, local in memory mode. */
  createSession: (title?: string) => Promise<SessionInfo>
  activeSessionId: string
}

/** Executes a local command. Never calls any model. */
export async function runCommand(deps: CommandDeps, name: string, args: string): Promise<CommandOutcome> {
  switch (name) {
    case 'new': {
      const s = await deps.createSession(args || undefined)
      return { systemText: `Session « ${s.title} » créée.`, newActiveId: s.id }
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
