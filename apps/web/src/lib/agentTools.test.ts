import { describe, expect, it } from 'vitest'
import { isDangerousTool, parseToolArgs, parseToolArgsStrict, titleOfArgs } from './agentTools'

/**
 * M17 — the STRICT arguments parse: a malformed tool call must stay VISIBLE
 * (ok:false + the raw string kept by the caller), instead of silently
 * collapsing into {} like parseToolArgs alone did.
 */
describe('parseToolArgsStrict', () => {
  it('du JSON propre → ok:true, les args telles quelles', () => {
    const res = parseToolArgsStrict('{"path": "a.md", "title": "Lire"}')
    expect(res.ok).toBe(true)
    expect(res.args).toEqual({ path: 'a.md', title: 'Lire' })
  })

  it('du JSON cassé → ok:false, args vides — le mauvais format est signalé', () => {
    const res = parseToolArgsStrict('{path: ".workspace/CONTEXT.md"')
    expect(res.ok).toBe(false)
    expect(res.args).toEqual({})
  })

  it('du JSON valide mais pas un objet (tableau, chaîne, null) → ok:false', () => {
    expect(parseToolArgsStrict('["a"]').ok).toBe(false)
    expect(parseToolArgsStrict('"texte"').ok).toBe(false)
    expect(parseToolArgsStrict('null').ok).toBe(false)
    expect(parseToolArgsStrict('').ok).toBe(false)
  })

  it('parseToolArgs reste le repli silencieux (rétrocompatible)', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArgs('pas du json')).toEqual({})
  })

  it('titleOfArgs lit le titre, borné et trimé', () => {
    expect(titleOfArgs({ title: '  Lire la charte  ' })).toBe('Lire la charte')
    expect(titleOfArgs({})).toBe('')
    expect(titleOfArgs(null)).toBe('')
  })

  it('isDangerousTool : write et shell demandent la porte humaine', () => {
    expect(isDangerousTool('write')).toBe(true)
    expect(isDangerousTool('shell')).toBe(true)
    expect(isDangerousTool('read')).toBe(false)
  })
})
