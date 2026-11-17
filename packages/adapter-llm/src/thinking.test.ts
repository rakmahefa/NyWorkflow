/**
 * ThinkingSplitter tests (M15) — the two-phase protocol parser: titled
 * blocks split from visible text, chunk boundaries, tolerances.
 */
import { describe, expect, it } from 'vitest'
import { parseTagTitle, ThinkingSplitter } from './thinking.ts'

const feed = (chunks: string[]): { text: string; blocks: { title: string; text: string }[] } => {
  const sp = new ThinkingSplitter()
  let text = ''
  const blocks: { title: string; text: string }[] = []
  for (const c of chunks) {
    for (const p of sp.push(c)) {
      if (p.kind === 'text') text += p.delta
      else if (p.title !== undefined) blocks.push({ title: p.title, text: p.delta })
      else if (blocks.length > 0) blocks[blocks.length - 1]!.text += p.delta
    }
  }
  for (const p of sp.finish()) {
    if (p.kind === 'text') text += p.delta
    else if (p.title !== undefined) blocks.push({ title: p.title, text: p.delta })
    else if (blocks.length > 0) blocks[blocks.length - 1]!.text += p.delta
  }
  return { text, blocks }
}

describe('parseTagTitle', () => {
  it('lit title="…" et title=\'…\', sinon chaîne vide', () => {
    expect(parseTagTitle(' title="Analyse de la demande" ')).toBe('Analyse de la demande')
    expect(parseTagTitle(" title='Plan' ")).toBe('Plan')
    expect(parseTagTitle('')).toBe('')
    expect(parseTagTitle(' other=1 ')).toBe('')
  })
})

describe('ThinkingSplitter — cas simples', () => {
  it('un bloc titré puis du texte visible', () => {
    const r = feed(['<thinking title="Comprendre">Je parcours l’ICM.</thinking>Voilà le travail.'])
    expect(r.blocks).toEqual([{ title: 'Comprendre', text: 'Je parcours l’ICM.' }])
    expect(r.text).toBe('Voilà le travail.')
  })

  it('sans balise : tout est du texte', () => {
    const r = feed(['Une réponse', ' tout à fait', ' normale.'])
    expect(r.blocks).toEqual([])
    expect(r.text).toBe('Une réponse tout à fait normale.')
  })

  it('balise sans titre : bloc avec titre vide', () => {
    const r = feed(['<thinking>interne</thinking>visible'])
    expect(r.blocks).toEqual([{ title: '', text: 'interne' }])
    expect(r.text).toBe('visible')
  })

  it('deux blocs successifs, chacun son titre', () => {
    const r = feed(['<thinking title="A">a</thinking>milieu<thinking title="B">b</thinking>fin'])
    expect(r.blocks).toEqual([
      { title: 'A', text: 'a' },
      { title: 'B', text: 'b' },
    ])
    expect(r.text).toBe('milieufin')
  })
})

describe('ThinkingSplitter — frontières de chunks', () => {
  it('la balise coupée en plein milieu tient bon', () => {
    const r = feed(['<thi', 'nking ti', 'tle="Étape"', '>le dialo', 'gue</thin', 'king>le travail'])
    expect(r.blocks).toEqual([{ title: 'Étape', text: 'le dialogue' }])
    expect(r.text).toBe('le travail')
  })

  it('un « < » orphelin en fin de chunk reste du texte (rendu à la fin)', () => {
    const r = feed(['a < b et ', 'c <thinking title="T">x</thinking>y'])
    expect(r.text).toBe('a < b et c y')
    expect(r.blocks).toEqual([{ title: 'T', text: 'x' }])
  })

  it('le texte AVANT une tête incomplète n’est pas retenu', () => {
    const sp = new ThinkingSplitter()
    const p1 = sp.push('visible <thin')
    expect(p1.map((p) => p.delta).join('')).toBe('visible ')
    const p2 = sp.push('king title="T">interne</thinking>fin')
    const text = p2.filter((p) => p.kind === 'text').map((p) => p.delta).join('')
    expect(text).toBe('fin')
  })

  it('bloc jamais refermé : auto-fermé au finish, jamais fui en texte', () => {
    const r = feed(['<thinking title="Sans fin">tout se passe bien…'])
    expect(r.blocks).toEqual([{ title: 'Sans fin', text: 'tout se passe bien…' }])
    expect(r.text).toBe('')
  })

  it('« <thinkingX » n’est pas une balise : prose', () => {
    const r = feed(['<thinkingX>du texte</thinkingX>encore'])
    expect(r.blocks).toEqual([])
    expect(r.text).toBe('<thinkingX>du texte</thinkingX>encore')
  })
})

describe('ThinkingSplitter — honnêteté du flux', () => {
  it('aucun octet perdu : texte + thinking recomposés = entrée (hors balises)', () => {
    const raw = 'Avant <thinking title="T">une ' + 'longue réflexion'.repeat(50) + '</thinking> Après'
    const r = feed([raw])
    const consumed = `<thinking title="T">${'une ' + 'longue réflexion'.repeat(50)}</thinking>`
    expect(r.text + consumed + r.text).toContain('Après')
    expect(r.blocks[0]!.text).toBe('une ' + 'longue réflexion'.repeat(50))
  })

  it('un bloc délirant est plafonné (THINKING_TAG_MAX), le mode repart en texte', () => {
    const sp = new ThinkingSplitter()
    sp.push('<thinking title="Runaway">')
    const huge = 'x'.repeat(300_000)
    const pieces = sp.push(huge)
    const emitted = pieces.filter((p) => p.kind === 'thinking').map((p) => p.delta).join('')
    expect(emitted.length).toBeLessThanOrEqual(262_144)
    const after = sp.push('suite</thinking>visible')
    // over-cap: the block dropped the rest, mode is text again
    expect(after.some((p) => p.kind === 'text' && p.delta.includes('visible'))).toBe(true)
  })
})
