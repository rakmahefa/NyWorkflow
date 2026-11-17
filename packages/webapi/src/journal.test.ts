import { describe, expect, it } from 'vitest'
import { TurnJournal, DEFAULT_JOURNAL_CAPACITY, type TurnRecord } from './journal.ts'

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
