import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  appendEvent,
  deriveSession,
  forkJournal,
  isSessionId,
  journalPath,
  newSessionId,
  parseJournal,
  readEvents,
} from './index'
import type { SessionEvent } from './index'

const homes: string[] = []

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'nyw-session-'))
  homes.push(home)
  return home
}

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

const T1 = '2026-11-17T10:00:00.000Z'
const T2 = '2026-11-17T10:01:00.000Z'

const createdEvent: SessionEvent = { type: 'session.created', at: T1, title: ' Rapport Q3 ' }
const userEvent: SessionEvent = { type: 'user.message', at: T2, text: 'Présente le projet' }

describe('ids & chemins', () => {
  it('newSessionId : format date + 4 hexa, uniques', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/)
    expect(b).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/)
    expect(a).not.toBe(b)
  })

  it('isSessionId accepte les ids du journal, refuse le reste', () => {
    expect(isSessionId('2026-11-17-a1b2')).toBe(true)
    expect(isSessionId('2026-11-17-9f3c21')).toBe(true)
    expect(isSessionId('../etc/passwd')).toBe(false)
    expect(isSessionId('foo')).toBe(false)
    expect(isSessionId('2026-11-17-A1B2')).toBe(false) // majuscules refusées
    expect(isSessionId('')).toBe(false)
  })

  it('journalPath : sous-dossier sessions, suffixe .jsonl', () => {
    expect(journalPath('/tmp/nyw', '2026-11-17-a1b2')).toBe(join('/tmp/nyw', 'sessions', '2026-11-17-a1b2.jsonl'))
  })
})

describe('journal — écriture et relecture', () => {
  it('roundtrip : append crée l’arborescence, relit dans l’ordre, fichier terminé par \\n', async () => {
    const home = tmpHome()
    const file = journalPath(home, '2026-11-17-a1b2')
    await appendEvent(file, createdEvent)
    await appendEvent(file, userEvent)
    await appendEvent(file, { type: 'assistant.message', at: T2, text: 'Voici…' })

    expect(await readEvents(file)).toEqual([createdEvent, userEvent, { type: 'assistant.message', at: T2, text: 'Voici…' }])
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
  })

  it('appendEvent refuse un événement sans type ni date', async () => {
    const home = tmpHome()
    const file = journalPath(home, '2026-11-17-c1d2')
    await expect(appendEvent(file, { at: T1 } as unknown as SessionEvent)).rejects.toThrow(TypeError)
    // Rien n'a été écrit : la relecture échoue (fichier absent).
    await expect(readEvents(file)).rejects.toThrow()
  })

  it('readEvents propage l’absence du journal (ENOENT)', async () => {
    const home = tmpHome()
    await expect(readEvents(journalPath(home, '2026-11-17-dead'))).rejects.toThrow(/ENOENT/i)
  })
})

describe('parseJournal — robustesse', () => {
  it('ignore une dernière ligne déchirée (écriture interrompue)', () => {
    const raw = `${JSON.stringify(createdEvent)}\n${JSON.stringify(userEvent).slice(0, 20)}`
    expect(parseJournal(raw)).toEqual([createdEvent])
  })

  it('jette sur une ligne complète illisible', () => {
    const raw = `${JSON.stringify(createdEvent)}\ngarbage\n`
    expect(() => parseJournal(raw)).toThrow(/Journal corrompu/)
  })

  it('jette sur une ligne complète sans type', () => {
    const raw = `${JSON.stringify(createdEvent)}\n${JSON.stringify({ at: T1 })}\n`
    expect(() => parseJournal(raw)).toThrow(/sans type/)
  })

  it('renvoie [] pour un fichier vide ou blanc', () => {
    expect(parseJournal('')).toEqual([])
    expect(parseJournal('\n\n')).toEqual([])
  })
})

describe('forkJournal', () => {
  it('copie le journal octet pour octet puis ajoute session.forked, sans toucher la source', async () => {
    const home = tmpHome()
    const srcId = '2026-11-17-a1b2'
    const src = journalPath(home, srcId)
    await appendEvent(src, createdEvent)
    await appendEvent(src, userEvent)
    const before = await readEvents(src)

    const forkId = '2026-11-17-b2c3'
    await forkJournal(home, srcId, forkId)

    const forked = await readEvents(journalPath(home, forkId))
    const last = forked[forked.length - 1]
    expect(last).toMatchObject({ type: 'session.forked', from: srcId })
    expect(typeof (last as { at?: unknown }).at).toBe('string')
    expect(forked.slice(0, -1)).toEqual(before)

    // La source est intacte.
    expect(await readEvents(src)).toEqual(before)
  })

  it('propage l’absence de la source (id inconnu)', async () => {
    const home = tmpHome()
    await expect(forkJournal(home, '2026-11-17-404a', '2026-11-17-b2c3')).rejects.toThrow(/ENOENT/i)
  })
})

describe('deriveSession', () => {
  const toolCall: SessionEvent = { type: 'tool.call', at: T2, tool: 'read', args: {} }
  const stageEvent: SessionEvent = { type: 'stage.started', at: T2, stage: '01-recherche' }

  it('titre depuis created.title (trim), messages chat uniquement, createdAt', () => {
    const events: SessionEvent[] = [
      createdEvent,
      userEvent,
      { type: 'assistant.message', at: T2, text: 'Voici…' },
      toolCall,
      stageEvent,
    ]
    const d = deriveSession(events)
    expect(d.title).toBe('Rapport Q3')
    expect(d.baseTitle).toBe('Rapport Q3')
    expect(d.createdAt).toBe(T1)
    expect(d.forkedFrom).toBeUndefined()
    expect(d.messages).toEqual([
      { role: 'user', text: 'Présente le projet', at: T2 },
      { role: 'assistant', text: 'Voici…', at: T2 },
    ])
  })

  it('sans titre : premier message utilisateur tronqué à 60', () => {
    const long = 'x'.repeat(80)
    const d = deriveSession([
      { type: 'session.created', at: T1 },
      { type: 'user.message', at: T2, text: long },
    ])
    expect(d.baseTitle).toBe('x'.repeat(60))
    expect(d.title).toBe('x'.repeat(60))
  })

  it('rien de connu : fallback « Session », createdAt du premier événement', () => {
    const d = deriveSession([toolCall])
    expect(d.title).toBe('Session')
    expect(d.createdAt).toBe(T2)
    expect(d.messages).toEqual([])
  })

  it('journal sans created : createdAt du premier événement', () => {
    const d = deriveSession([userEvent, { type: 'assistant.message', at: T2, text: 'ok' }])
    expect(d.createdAt).toBe(T2)
    expect(d.title).toBe('Présente le projet')
  })

  it('fork : suffixe (fork) et provenance', () => {
    const d = deriveSession([
      { type: 'session.created', at: T1, title: 'Démo' },
      { type: 'session.forked', at: T2, from: '2026-11-17-0000' },
      userEvent,
    ])
    expect(d.title).toBe('Démo (fork)')
    expect(d.baseTitle).toBe('Démo')
    expect(d.forkedFrom).toBe('2026-11-17-0000')
  })

  it('workspace M4 : présent quand session.created le porte, absent sinon', () => {
    const run = deriveSession([
      { type: 'session.created', at: T1, title: 'Rapport', workspace: 'exemple-rapport' },
      userEvent,
    ])
    expect(run.workspace).toBe('exemple-rapport')

    const chat = deriveSession([createdEvent, userEvent])
    expect(chat.workspace).toBeUndefined()
  })
})
