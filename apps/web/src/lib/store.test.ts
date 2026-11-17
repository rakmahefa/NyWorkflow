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

describe('SessionStore — removeMessage', () => {
  it('retire uniquement le message visé', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const m1 = s.appendMessage(a.id, 'user', 'un')
    const m2 = s.appendMessage(a.id, 'assistant', 'deux')
    expect(s.removeMessage(m1.id)).toBe(true)
    expect(s.removeMessage('inconnu')).toBe(false)
    expect(s.listMessages(a.id).map((m) => m.id)).toEqual([m2.id])
  })
})

describe('SessionStore — hydratation et fork (M3)', () => {
  it('ingest remplace tout l’état (boot depuis les journaux)', () => {
    const s = new SessionStore()
    s.createSession('Ancienne')
    s.appendMessage(s.listSessions()[0]!.id, 'user', 'vieux')
    s.ingest(
      [{ id: '2026-11-17-a1b2', title: 'Rapport Q3', createdAt: 1 }],
      [
        { id: '2026-11-17-a1b2:0', sessionId: '2026-11-17-a1b2', role: 'user', text: 'salut', at: 2 },
        { id: '2026-11-17-a1b2:1', sessionId: '2026-11-17-a1b2', role: 'assistant', text: 'voici', at: 3 },
      ],
    )
    expect(s.listSessions().map((x) => x.title)).toEqual(['Rapport Q3'])
    expect(s.listMessages('2026-11-17-a1b2').map((m) => m.text)).toEqual(['salut', 'voici'])
  })

  it('addSession enregistre une session venue du serveur', () => {
    const s = new SessionStore()
    s.createSession('Une')
    const added = s.addSession({ id: '2026-11-17-b2c3', title: 'Une (fork)', createdAt: 5 })
    expect(added.id).toBe('2026-11-17-b2c3')
    expect(s.listSessions().map((x) => x.title)).toEqual(['Une', 'Une (fork)'])
  })

  it('copyMessages copie le chat user/assistant dans l’ordre, ignore système et vides', () => {
    const s = new SessionStore()
    const a = s.createSession('Source')
    const b = s.createSession('Cible')
    s.appendMessage(a.id, 'system', 'note')
    const u = s.appendMessage(a.id, 'user', 'un')
    s.appendMessage(a.id, 'assistant', '')
    s.appendMessage(a.id, 'assistant', 'deux')
    const n = s.copyMessages(a.id, b.id)
    expect(n).toBe(2)
    expect(s.listMessages(b.id).map((m) => [m.role, m.text])).toEqual([
      ['user', 'un'],
      ['assistant', 'deux'],
    ])
    // Ids frais : la copie n’entre pas en collision avec la source.
    const [first] = s.listMessages(b.id)
    expect(first!.id).not.toBe(u.id)
  })

  it('copyMessages sans rien à copier : 0', () => {
    const s = new SessionStore()
    const a = s.createSession()
    const b = s.createSession()
    expect(s.copyMessages(a.id, b.id)).toBe(0)
  })
})

describe('SessionStore — M12 (thinking, traces, renommage)', () => {
  it('appendThinking accumule la réflexion sans toucher au texte', () => {
    const store = new SessionStore()
    const s = store.createSession('S')
    const msg = store.appendMessage(s.id, 'assistant', '')
    store.appendThinking(msg.id, 'Je pense')
    store.appendThinking(msg.id, ' donc je suis.')
    const m = store.listMessages(s.id).find((x) => x.id === msg.id)
    expect(m?.thinking).toBe('Je pense donc je suis.')
    expect(m?.text).toBe('')
  })

  it('renameSession change le titre en place', () => {
    const store = new SessionStore()
    const s = store.createSession('Ancien')
    expect(store.renameSession(s.id, 'Nouveau')).toBe(true)
    expect(store.findSessionById(s.id)?.title).toBe('Nouveau')
    expect(store.renameSession('inconnu', 'x')).toBe(false)
  })

  it('appendTrace/settleTrace suivent les requêtes modèle, retirées avec la session', () => {
    const store = new SessionStore()
    const s = store.createSession('S')
    store.appendTrace({ id: 't1', sessionId: s.id, at: 1, model: 'gemini-3.6-flash@think=2', thinkLevel: 2, round: 1, messages: 3, tools: 9, ms: 0, outcome: 'ok', thinkingChars: 0, textChars: 0 })
    store.settleTrace('t1', { ms: 120, outcome: 'tool_calls', thinkingChars: 40, textChars: 10 })
    const traces = store.listTraces(s.id)
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ ms: 120, outcome: 'tool_calls', thinkingChars: 40 })
    store.removeSession(s.id)
    expect(store.listTraces(s.id)).toHaveLength(0)
  })
})
