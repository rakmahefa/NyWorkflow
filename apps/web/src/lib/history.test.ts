import { describe, expect, it } from 'vitest'
import { toLlmHistory } from './history'
import type { ChatMsg } from './types'

function msg(id: string, role: ChatMsg['role'], text: string, streaming = false): ChatMsg {
  return { id, sessionId: 's1', role, text, at: 0, streaming }
}

describe('toLlmHistory', () => {
  it('garde user/assistant, exclut system, streaming et vides', () => {
    const input = [
      msg('1', 'system', 'bienvenue'),
      msg('2', 'user', 'ping'),
      msg('3', 'assistant', ''),
      msg('4', 'assistant', 'en cours…', true),
      msg('5', 'assistant', 'pong'),
    ]
    expect(toLlmHistory(input)).toEqual([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ])
  })

  it('plafonne l’historique aux 20 derniers messages', () => {
    const many: ChatMsg[] = []
    for (let i = 1; i <= 25; i++) {
      many.push(msg(`u${i}`, 'user', `q${i}`), msg(`a${i}`, 'assistant', `r${i}`))
    }
    const out = toLlmHistory(many)
    expect(out).toHaveLength(20)
    expect(out[0]).toEqual({ role: 'user', content: 'q16' })
    expect(out.at(-1)).toEqual({ role: 'assistant', content: 'r25' })
  })

  it('renvoie vide si tout est system', () => {
    expect(toLlmHistory([msg('1', 'system', 'x'), msg('2', 'system', 'y')])).toEqual([])
  })

  it('préserve l’ordre d’origine', () => {
    const out = toLlmHistory([msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c')])
    expect(out.map((m) => m.content)).toEqual(['a', 'b', 'c'])
  })
})
