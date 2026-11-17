import { describe, expect, it } from 'vitest'
import { baseModelOf, groupByFamily, thinkLevelOf, withFallbackInfo, withThinkLevel } from './modelMeta'

describe('modelMeta (M12)', () => {
  it('withFallbackInfo : métadonnées passerelle d’abord, repli honnête par id', () => {
    const info = withFallbackInfo(
      ['gemini-3.6-flash', 'autre-modele'],
      [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', family: 'flash', thinking: false, defaultThink: 4 }],
    )
    expect(info[0]).toMatchObject({ label: 'Gemini 3.6 Flash', family: 'flash' })
    expect(info[1]).toMatchObject({ label: 'Autre Modele', family: 'autre', thinking: false })
  })

  it('groupByFamily : ordre des familles du sélecteur, libellés propres', () => {
    const groups = groupByFamily([
      { id: 'a', label: 'A', family: 'lite', thinking: false, defaultThink: 4 },
      { id: 'b', label: 'B', family: 'thinking', thinking: true, defaultThink: 0 },
      { id: 'c', label: 'C', family: 'flash', thinking: false, defaultThink: 4 },
      { id: 'd', label: 'D', family: 'autre', thinking: false, defaultThink: 4 },
    ])
    expect(groups.map((g) => g.family)).toEqual(['thinking', 'flash', 'lite', 'autre'])
    expect(groups[0]?.label).toBe('Raisonnement')
  })

  it('withThinkLevel : suffixe composé, borné, décomposé', () => {
    expect(withThinkLevel('gemini-3.6-flash', 'auto')).toBe('gemini-3.6-flash')
    expect(withThinkLevel('gemini-3.6-flash', '2')).toBe('gemini-3.6-flash@think=2')
    expect(withThinkLevel('gemini-3.6-flash@think=1', '3')).toBe('gemini-3.6-flash@think=3')
    expect(withThinkLevel('gemini-3.6-flash', '9')).toBe('gemini-3.6-flash@think=4')
    expect(thinkLevelOf('gemini-3.6-flash@think=2')).toBe('2')
    expect(thinkLevelOf('gemini-3.6-flash')).toBe('auto')
    expect(baseModelOf('gemini-3.6-flash@think=2')).toBe('gemini-3.6-flash')
  })
})
