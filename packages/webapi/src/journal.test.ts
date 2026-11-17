import { describe, expect, it } from 'vitest'
import { TurnJournal, DEFAULT_JOURNAL_CAPACITY, accountUsage, type TurnRecord } from './journal.ts'

const rec = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  at: '2026-11-17T00:00:00.000Z',
  model: 'gemini-3.6-flash',
  ok: true,
  attempts: 1,
  ms: 12,
  ...over,
})

describe('TurnJournal', () => {
  it('enregistre et rejoue dans l’ordre', () => {
    const journal = new TurnJournal()
    journal.record(rec({ model: 'un' }))
    journal.record(rec({ model: 'deux' }))
    const recent = journal.recent()
    expect(recent.map((r) => r.model)).toEqual(['un', 'deux'])
    expect(recent[0]?.ok).toBe(true)
  })

  it('capacité bornée : les plus anciens tombent', () => {
    const journal = new TurnJournal(3)
    for (let i = 0; i < 6; i++) journal.record(rec({ model: `m${i}` }))
    expect(journal.recent().map((r) => r.model)).toEqual(['m3', 'm4', 'm5'])
  })

  it('par défaut : capacité ' + DEFAULT_JOURNAL_CAPACITY, () => {
    const journal = new TurnJournal()
    for (let i = 0; i < DEFAULT_JOURNAL_CAPACITY + 10; i++) journal.record(rec({ model: `m${i}` }))
    expect(journal.recent()).toHaveLength(DEFAULT_JOURNAL_CAPACITY)
  })

  it('recent() retourne une copie — muter la vue ne touche pas le journal', () => {
    const journal = new TurnJournal()
    journal.record(rec())
    const view = [...journal.recent()]
    view.push(rec())
    expect(journal.recent()).toHaveLength(1)
  })

  it('échecs typés conservés tels quels', () => {
    const journal = new TurnJournal()
    journal.record(rec({ ok: false, error: { kind: 'authentication', message: 'Cookies expirés', status: 401 } }))
    expect(journal.recent()[0]?.error).toEqual({ kind: 'authentication', message: 'Cookies expirés', status: 401 })
  })
})

describe('accountUsage (M9 — statistiques par compte)', () => {
  it('agrège tours, réussites, échecs, durée cumulée, dernier tour', () => {
    const usage = accountUsage([
      rec({ account: 0, ok: true, ms: 100, at: '2026-11-17T10:00:00.000Z' }),
      rec({ account: 1, ok: false, ms: 900, at: '2026-11-17T10:01:00.000Z' }),
      rec({ account: 0, ok: true, ms: 50, at: '2026-11-17T10:02:00.000Z' }),
    ])
    expect(usage).toEqual([
      { account: 0, turns: 2, ok: 2, failed: 0, totalMs: 150, lastAt: '2026-11-17T10:02:00.000Z' },
      { account: 1, turns: 1, ok: 0, failed: 1, totalMs: 900, lastAt: '2026-11-17T10:01:00.000Z' },
    ])
  })

  it('ignore les tours sans compte, trie par index de compte', () => {
    const usage = accountUsage([
      rec({ account: 2, ok: true }),
      rec({ ok: true }), // sans compte — jamais arrivé à la rotation
      rec({ account: 0, ok: true }),
    ])
    expect(usage.map((u) => u.account)).toEqual([0, 2])
    expect(usage.every((u) => u.turns === 1)).toBe(true)
  })

  it('TurnJournal.usage() suit la fenêtre du journal', () => {
    const journal = new TurnJournal(2)
    journal.record(rec({ account: 0, ok: true, ms: 10 }))
    journal.record(rec({ account: 1, ok: false, ms: 20 }))
    journal.record(rec({ account: 0, ok: true, ms: 30 })) // pousse le 1er hors fenêtre
    expect(journal.usage()).toEqual([
      { account: 0, turns: 1, ok: 1, failed: 0, totalMs: 30, lastAt: '2026-11-17T00:00:00.000Z' },
      { account: 1, turns: 1, ok: 0, failed: 1, totalMs: 20, lastAt: '2026-11-17T00:00:00.000Z' },
    ])
  })

  it('journal vide → usage vide', () => {
    expect(accountUsage([])).toEqual([])
    expect(new TurnJournal().usage()).toEqual([])
  })
})
