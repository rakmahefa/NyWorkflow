import { describe, expect, it } from 'vitest'
import { toAgentMessages } from './history'
import type { ChatMsg } from './types'

function msg(id: string, role: ChatMsg['role'], text: string, streaming = false): ChatMsg {
  return { id, sessionId: 's1', role, text, at: 0, streaming }
}

function toolRow(id: string, tool: string, args: unknown, ok?: boolean, summary?: string, data?: unknown): ChatMsg {
  return { id, sessionId: 's1', role: 'tool', text: '', at: 0, tool, args, ok, summary, data }
}

describe('toAgentMessages (M11)', () => {
  it('chat : garde user/assistant, exclut system, streaming et vides', () => {
    const input = [
      msg('1', 'system', 'bienvenue'),
      msg('2', 'user', 'ping'),
      msg('3', 'assistant', ''),
      msg('4', 'assistant', 'en cours…', true),
      msg('5', 'assistant', 'pong'),
    ]
    expect(toAgentMessages(input)).toEqual([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ])
  })

  it('ligne outil réglée → appel assistant (tool_calls) + résultat tool (round-trip standard)', () => {
    const input = [
      msg('1', 'user', 'lis la carte'),
      toolRow('2', 'read', { path: 'CONTEXT.md' }, true, 'read « CONTEXT.md » — 10 caractères', { path: 'CONTEXT.md', content: '# Carte' }),
      msg('3', 'assistant', 'Voici la carte.'),
    ]
    expect(toAgentMessages(input)).toEqual([
      { role: 'user', content: 'lis la carte' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-2', type: 'function', function: { name: 'read', arguments: '{"path":"CONTEXT.md"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-2', content: '{"ok":true,"result":{"path":"CONTEXT.md","content":"# Carte"}}' },
      { role: 'assistant', content: 'Voici la carte.' },
    ])
  })

  it('refus → résultat {ok:false, error:summary}, sans data', () => {
    const input = [toolRow('7', 'write', { path: 'a' }, false, 'refusé par l\'utilisateur : write « a »')]
    const out = toAgentMessages(input)
    expect(out[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-7',
      content: '{"ok":false,"error":"refusé par l\'utilisateur : write « a »"}',
    })
  })

  it('ligne en attente (approbation) : non envoyée — son résultat n’existe pas', () => {
    const input = [msg('1', 'user', 'écris'), toolRow('2', 'write', { path: 'a.md' }, undefined)]
    expect(toAgentMessages(input)).toEqual([{ role: 'user', content: 'écris' }])
  })

  it('plafonne aux 24 dernières lignes', () => {
    const many: ChatMsg[] = []
    for (let i = 1; i <= 30; i++) many.push(msg(`u${i}`, 'user', `q${i}`))
    const out = toAgentMessages(many)
    expect(out).toHaveLength(24)
    expect(out[0]).toEqual({ role: 'user', content: 'q7' })
  })

  it('renvoie vide si tout est system', () => {
    expect(toAgentMessages([msg('1', 'system', 'x'), msg('2', 'system', 'y')])).toEqual([])
  })
})
