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

  it('ligne outil réglée → appel assistant (tool_calls) + résultat tool au format protocole', () => {
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
      { role: 'tool', tool_call_id: 'call-2', content: '{"tool":"read","title":"","ok":true,"result":{"path":"CONTEXT.md","content":"# Carte"}}' },
      { role: 'assistant', content: 'Voici la carte.' },
    ])
  })

  it('M16 — groupe ADJACENT : UNE message assistant avec TOUS les appels, puis chaque résultat — le groupe revient ENTIER', () => {
    const input = [
      msg('1', 'user', 'lis tout'),
      toolRow('2', 'read', { path: 'a.md', title: 'Lire a' }, true, 'ok a', 'CONTENU A'),
      toolRow('3', 'ls', { path: '.', title: 'Lister' }, true, 'ok ls', ['a.md', 'b.md']),
      toolRow('4', 'write', { path: 'c.md', title: 'Écrire c' }, false, 'refusé par le pilote'),
      msg('5', 'assistant', 'Voilà.'),
    ]
    const out = toAgentMessages(input)
    // Une seule message assistant pour le groupe entier — les appels comme le modèle les a faits.
    expect(out).toHaveLength(6)
    expect(out[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call-2', type: 'function', function: { name: 'read', arguments: '{"path":"a.md","title":"Lire a"}' } },
        { id: 'call-3', type: 'function', function: { name: 'ls', arguments: '{"path":".","title":"Lister"}' } },
        { id: 'call-4', type: 'function', function: { name: 'write', arguments: '{"path":"c.md","title":"Écrire c"}' } },
      ],
    })
    // Puis chaque résultat, au format du protocole — l’écho outil+title permet la corrélation.
    expect(out[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call-2',
      content: '{"tool":"read","title":"Lire a","ok":true,"result":"CONTENU A"}',
    })
    expect(out[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call-3',
      content: '{"tool":"ls","title":"Lister","ok":true,"result":["a.md","b.md"]}',
    })
    expect(out[4]).toEqual({
      role: 'tool',
      tool_call_id: 'call-4',
      content: '{"tool":"write","title":"Écrire c","ok":false,"error":"refusé par le pilote"}',
    })
    // La prose finale suit le groupe.
    expect(out[5]).toEqual({ role: 'assistant', content: 'Voilà.' })
  })

  it('refus → résultat {tool,title,ok:false,error}, sans data', () => {
    const input = [toolRow('7', 'write', { path: 'a' }, false, 'refusé par l\'utilisateur : write « a »')]
    const out = toAgentMessages(input)
    expect(out[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call-7',
      content: '{"tool":"write","title":"","ok":false,"error":"refusé par l\'utilisateur : write « a »"}',
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
