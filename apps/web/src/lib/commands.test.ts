import { describe, expect, it } from 'vitest'
import { HELP_TEXT, parseInput, runCommand } from './commands'
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

describe('runCommand', () => {
  it('new: creates a session and asks the UI to switch to it', () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = runCommand(s, 'new', 'Rapport Q3', active.id)
    expect(out.newActiveId).toBeDefined()
    expect(out.newActiveId).not.toBe(active.id)
    expect(out.systemText).toContain('Rapport Q3')
    expect(s.listSessions()).toHaveLength(2)
    expect(s.findSessionById(out.newActiveId!)?.title).toBe('Rapport Q3')
  })

  it('new without args: numbered title', () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = runCommand(s, 'new', '', active.id)
    expect(out.systemText).toContain('Session 2')
  })

  it('clear: reports the number of erased messages', () => {
    const s = new SessionStore()
    const active = s.createSession()
    s.appendMessage(active.id, 'user', 'un')
    const out = runCommand(s, 'clear', '', active.id)
    expect(out.systemText).toBe('1 message(s) effacé(s).')
    expect(s.listMessages(active.id)).toHaveLength(0)
  })

  it('clear on an empty session: nothing to erase', () => {
    const s = new SessionStore()
    const active = s.createSession()
    expect(runCommand(s, 'clear', '', active.id).systemText).toBe('Rien à effacer.')
  })

  it('help: lists the three commands', () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = runCommand(s, 'help', '', active.id)
    expect(out.systemText).toBe(HELP_TEXT)
    expect(out.systemText).toContain('/new')
    expect(out.systemText).toContain('/clear')
  })

  it('unknown command: explains and never reaches a model', () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = runCommand(s, 'grognon', '', active.id)
    expect(out.systemText).toContain('Commande inconnue')
    expect(s.listMessages(active.id)).toHaveLength(0) // nothing appended by runCommand
  })
})
