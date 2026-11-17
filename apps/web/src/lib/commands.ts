import type { SessionStore } from './store'

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
  '  /clear — effacer les messages de la session courante',
  '  /help — cette aide',
  'Une commande inconnue n\'est jamais envoyée au modèle.',
].join('\n')

export interface CommandOutcome {
  /** System message to append (in newActiveId's session if given). */
  systemText: string
  /** Set by /new: the freshly created session to switch to. */
  newActiveId?: string
}

/** Executes a local command against the store. Never calls any model. */
export function runCommand(
  store: SessionStore,
  name: string,
  args: string,
  activeSessionId: string,
): CommandOutcome {
  switch (name) {
    case 'new': {
      const s = store.createSession(args || undefined)
      return { systemText: `Session « ${s.title} » créée.`, newActiveId: s.id }
    }
    case 'clear': {
      const removed = store.clearMessages(activeSessionId)
      return { systemText: removed > 0 ? `${removed} message(s) effacé(s).` : 'Rien à effacer.' }
    }
    case 'help':
      return { systemText: HELP_TEXT }
    default:
      return { systemText: `Commande inconnue : /${name} — tapez /help pour la liste.` }
  }
}
