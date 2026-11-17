import { describe, expect, it } from 'vitest'
import { applyTheme, loadTheme, saveTheme, type ThemePreference } from './theme.ts'

/** Faux document : localStorage en mémoire + dataset d'élément. */
function fakeDoc() {
  const store = new Map<string, string>()
  return {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    dataset: {} as Record<string, string>,
    store,
  }
}

describe('theme — préférence persistée', () => {
  it('défaut : auto quand rien en stock', () => {
    const doc = fakeDoc()
    expect(loadTheme(doc.localStorage)).toBe<ThemePreference>('auto')
  })

  it('save puis load : aller-retour', () => {
    const doc = fakeDoc()
    saveTheme('dark', doc.localStorage)
    expect(loadTheme(doc.localStorage)).toBe('dark')
    saveTheme('light', doc.localStorage)
    expect(loadTheme(doc.localStorage)).toBe('light')
    saveTheme('auto', doc.localStorage)
    expect(loadTheme(doc.localStorage)).toBe('auto')
  })

  it('valeur inconnue en stock : repli auto', () => {
    const doc = fakeDoc()
    doc.store.set('nyw-theme', 'inversé-arc-en-ciel')
    expect(loadTheme(doc.localStorage)).toBe('auto')
  })
})

describe('theme — application sur <html>', () => {
  it('auto : pas d\'attribut (préférence système)', () => {
    const el = { dataset: {} as Record<string, string> }
    applyTheme('auto', el)
    expect(el.dataset.theme).toBeUndefined()
  })

  it('clair/sombre : attribut data-theme', () => {
    const el = { dataset: {} as Record<string, string> }
    applyTheme('dark', el)
    expect(el.dataset.theme).toBe('dark')
    applyTheme('light', el)
    expect(el.dataset.theme).toBe('light')
  })

  it('retour à auto : attribut retiré', () => {
    const el = { dataset: { theme: 'dark' } }
    applyTheme('auto', el)
    expect('theme' in el.dataset).toBe(false)
  })
})
