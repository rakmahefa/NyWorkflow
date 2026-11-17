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

describe('runCommand', () => {
  /** Store-backed factory — the memory-mode wiring the app falls back to. */
  function depsFor(s: SessionStore, activeId: string): CommandDeps {
    return {
      store: s,
      activeSessionId: activeId,
      createSession: (title) => Promise.resolve(s.createSession(title)),
    }
  }

  it('new: creates a session and asks the UI to switch to it', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'new', 'Rapport Q3')
    expect(out.newActiveId).toBeDefined()
    expect(out.newActiveId).not.toBe(active.id)
    expect(out.systemText).toContain('Rapport Q3')
    expect(s.listSessions()).toHaveLength(2)
    expect(s.findSessionById(out.newActiveId!)?.title).toBe('Rapport Q3')
  })

  it('new without args: numbered title', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'new', '')
    expect(out.systemText).toContain('Session 2')
  })

  it('new: passes the title to the injected factory (server path)', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    let asked: string | undefined
    const deps: CommandDeps = {
      store: s,
      activeSessionId: active.id,
      createSession: async (title) => {
        asked = title
        return s.createSession('Réponse serveur')
      },
    }
    const out = await runCommand(deps, 'new', 'Titre passé')
    expect(asked).toBe('Titre passé')
    expect(out.systemText).toContain('Réponse serveur')
    expect(out.newActiveId).toBeDefined()
  })

  it('clear: reports the count and keeps the journal', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    s.appendMessage(active.id, 'user', 'un')
    const out = await runCommand(depsFor(s, active.id), 'clear', '')
    expect(out.systemText).toBe('1 message(s) effacé(s) — journal conservé (append-only).')
    expect(s.listMessages(active.id)).toHaveLength(0)
  })

  it('clear on an empty session: nothing to erase', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    expect((await runCommand(depsFor(s, active.id), 'clear', '')).systemText).toBe('Rien à effacer.')
  })

  it('help: lists the commands', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'help', '')
    expect(out.systemText).toBe(HELP_TEXT)
    expect(out.systemText).toContain('/new')
    expect(out.systemText).toContain('/clear')
    expect(out.systemText).toContain('journal est conservé')
  })

  it('unknown command: explains and never reaches a model', async () => {
    const s = new SessionStore()
    const active = s.createSession()
    const out = await runCommand(depsFor(s, active.id), 'grognon', '')
    expect(out.systemText).toContain('Commande inconnue')
    expect(s.listMessages(active.id)).toHaveLength(0) // nothing appended by runCommand
  })
})
