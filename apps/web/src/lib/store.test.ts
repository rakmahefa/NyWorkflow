import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

describe('SessionStore — sessions', () => {
  it('creates sessions with unique ids and sane titles', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const b = s.createSession('  Démo  ')
    expect(a.id).not.toBe(b.id)
    expect(a.title).toBe('Session 1')
    expect(b.title).toBe('Démo')
    expect(s.listSessions().map((x) => x.title)).toEqual(['Session 1', 'Démo'])
  })

  it('falls back to a numbered title when args are empty', () => {
    const s = new SessionStore()
    s.createSession('Un')
    const third = s.createSession('   ')
    expect(third.title).toBe('Session 2')
  })
})

describe('SessionStore — messages', () => {
  it('appends and lists messages per session', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const b = s.createSession()
    s.appendMessage(a.id, 'user', 'salut')
    s.appendMessage(b.id, 'system', 'bienvenue')
    expect(s.listMessages(a.id).map((m) => m.text)).toEqual(['salut'])
    expect(s.listMessages(b.id)).toHaveLength(1)
  })

  it('clears only the targeted session and returns the count', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const b = s.createSession()
    s.appendMessage(a.id, 'user', 'un')
    s.appendMessage(a.id, 'assistant', 'deux')
    s.appendMessage(b.id, 'user', 'reste')
    expect(s.clearMessages(a.id)).toBe(2)
    expect(s.listMessages(a.id)).toHaveLength(0)
    expect(s.listMessages(b.id)).toHaveLength(1)
    expect(s.clearMessages(a.id)).toBe(0)
  })

  it('streams text into a message and toggles the streaming flag', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const m = s.appendMessage(a.id, 'assistant', '')
    s.setStreaming(m.id, true)
    s.appendText(m.id, 'Bon')
    s.appendText(m.id, 'jour')
    const stored = s.listMessages(a.id).find((x) => x.id === m.id)
    expect(stored?.text).toBe('Bonjour')
    expect(stored?.streaming).toBe(true)
    s.setStreaming(m.id, false)
    expect(s.listMessages(a.id).find((x) => x.id === m.id)?.streaming).toBe(false)
  })

  it('appendText on a vanished message is a no-op (mid-stream /clear)', () => {
    const s = new SessionStore()
    expect(s.appendText('inconnu', 'x')).toBe(false)
  })
})

describe('SessionStore — snapshot & subscription', () => {
  it('notifies subscribers once per mutation', () => {
    const s = new SessionStore()
    let calls = 0
    const unsubscribe = s.subscribe(() => {
      calls++
    })
    s.createSession()
    expect(calls).toBe(1)
    unsubscribe()
    s.createSession()
    expect(calls).toBe(1)
  })

  it('rebuilds an immutable snapshot on each change', () => {
    const s = new SessionStore()
    s.createSession()
    const snap1 = s.getSnapshot()
    s.createSession()
    const snap2 = s.getSnapshot()
    expect(snap2).not.toBe(snap1)
    expect(snap1.sessions).toHaveLength(1) // old snapshot untouched
    expect(snap2.sessions).toHaveLength(2)
  })
})
