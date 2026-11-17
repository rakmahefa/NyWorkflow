import { describe, expect, it } from 'vitest'
import { HELP_TEXT, parseInput, runCommand } from './commands'
import type { CommandDeps } from './commands'
import { SessionStore } from './store'

describe('parseInput', () => {
  it('classifies plain text as chat', () => {
    expect(parseInput('Bonjour M1')).toEqual({ kind: 'chat', text: 'Bonjour M1' })
  })

  it('parses a command with args', () => {
    expect(parseInput('/new Démo ICM')).toEqual({
      kind: 'command',
      text: '/new Démo ICM',
      name: 'new',
      args: 'Démo ICM',
    })
  })

  it('lowercases the command name and trims args', () => {
    expect(parseInput('/HELP   ')).toEqual({ kind: 'command', text: '/HELP', name: 'help', args: '' })
  })
})

describe('runCommand (M11 — la boîte de dialogue porte la création)', () => {
  function depsFor(s: SessionStore, activeId: string): CommandDeps {
    return { store: s, activeSessionId: activeId }
  }

  it('new : ouvre la boîte de dialogue, sans toucher au store', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'new', 'Rapport Q3')
    expect(out.openNewDialog).toBe(true)
    expect(out.systemText).toBe('')
    expect(s.listSessions()).toHaveLength(1)
  })

  it('delete : demande la suppression de la session active', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'delete', '')
    expect(out.deleteActive).toBe(true)
  })

  it('clear : vide l’affichage, le journal (store) est conservé hors messages', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    s.appendMessage(active.id, 'user', 'q')
    s.appendMessage(active.id, 'assistant', 'r')
    const out = await runCommand(depsFor(s, active.id), 'clear', '')
    expect(out.systemText).toContain('2 message(s) effacé(s)')
    expect(s.listMessages(active.id)).toHaveLength(0)
  })

  it('clear sans rien : rien à effacer', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'clear', '')
    expect(out.systemText).toBe('Rien à effacer.')
  })

  it('help : la liste des commandes, avec /delete (M11)', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'help', '')
    expect(out.systemText).toBe(HELP_TEXT)
    expect(HELP_TEXT).toContain('/delete')
    expect(HELP_TEXT).toContain('/new')
  })

  it('commande inconnue : jamais envoyée au modèle', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'banana', 'x')
    expect(out.systemText).toContain('Commande inconnue : /banana')
  })
})
