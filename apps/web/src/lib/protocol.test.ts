import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESPONSE_NUDGE,
  normalizeIcmPath,
  ProtocolMemory,
  protocolFeedback,
  type RoundProtocol,
  type RoundToolCall,
} from './protocol'

/** A compliant call — the baseline the variations mutate. */
const call = (over: Partial<RoundToolCall> = {}): RoundToolCall => ({
  tool: 'ls',
  title: 'Lister la racine',
  argsOk: true,
  args: { path: '.', title: 'Lister la racine' },
  rawArgs: '{"path":"."}',
  ...over,
})

/** A compliant round — thinking first, titled, one titled valid call. */
const round = (over: Partial<RoundProtocol> = {}): RoundProtocol => ({
  round: 1,
  firstEvent: 'thinking',
  thinkingChars: 250,
  thinkingTitles: ['Explorer la racine'],
  text: '',
  toolCalls: [call()],
  ...over,
})

describe('protocolFeedback — le mentor M20', () => {
  it('se tait quand le protocole est suivi (aucun sermon pour un modèle conforme)', () => {
    const memory = new ProtocolMemory()
    memory.remember(1, [call()])
    expect(protocolFeedback(round(), memory, [])).toBeNull()
  })

  it('se tait pour une réponse finale propre (prose seule, thinking titré en tête)', () => {
    expect(
      protocolFeedback(round({ toolCalls: [], text: 'Voilà le bilan : outputs/rapport.md.' }), new ProtocolMemory(), []),
    ).toBeNull()
  })

  it('réclame le thinking quand la réponse commence par les tool_calls (le cas des logs, rounds 3 et 5)', () => {
    const fb = protocolFeedback(round({ firstEvent: 'tool_calls', thinkingChars: 0, thinkingTitles: [] }), new ProtocolMemory(), [])
    expect(fb).toContain('[HARNESS — protocole, round 1]')
    expect(fb).toContain('S’OUVRIR par un bloc <thinking> titré')
    expect(fb).toContain('tool_calls')
  })

  it('réclame le thinking quand la réponse commence par du texte visible', () => {
    const fb = protocolFeedback(round({ firstEvent: 'text', toolCalls: [], text: 'Bonjour !' }), new ProtocolMemory(), [])
    expect(fb).toContain('commencé par du texte visible')
  })

  it('signale un thinking sans title', () => {
    const fb = protocolFeedback(round({ thinkingTitles: [] }), new ProtocolMemory(), [])
    expect(fb).toContain('pas de title')
  })

  it('signale les tool_calls sans title et les arguments mal formés', () => {
    const fb = protocolFeedback(
      round({
        toolCalls: [
          call({ title: '', tool: 'read', args: {}, argsOk: false, rawArgs: '{"path": ' }),
          call({ title: '', tool: 'read', args: { path: 'a.md' }, rawArgs: '{"path":"a.md"}' }),
        ],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('2 tool_calls sont sans argument `title`')
    expect(fb).toContain('ne sont pas un JSON objet valide')
    expect(fb).toContain('read « {"path": ')
  })

  it('signale un outil inconnu et cite les outils déclarés', () => {
    const fb = protocolFeedback(round({ toolCalls: [call({ tool: 'delete_everything' })] }), new ProtocolMemory(), [])
    expect(fb).toContain('Outil inconnu : « delete_everything »')
    expect(fb).toContain('shell_output')
  })

  it('signale la prose qui accompagne les tool_calls (la réponse doit s’arrêter après les appels)', () => {
    const fb = protocolFeedback(round({ text: 'Je lance les lectures.' }), new ProtocolMemory(), [])
    expect(fb).toContain('Du texte visible accompagne tes tool_calls')
  })

  it('signale les appels dupliqués DANS le groupe', () => {
    const fb = protocolFeedback(round({ toolCalls: [call(), call()] }), new ProtocolMemory(), [])
    expect(fb).toContain('dupliqué dans ton groupe')
  })

  it('signale l’appel déjà exécuté à un round précédent du MÊME tour (le « hi » : ls . ×3)', () => {
    const memory = new ProtocolMemory()
    memory.remember(1, [call()])
    const fb = protocolFeedback(round({ round: 3 }), memory, [])
    expect(fb).toContain('Tu as déjà appelé ls « . » au round 1 de CE tour')
  })

  it('ne signale pas la répétition venue d’un tour précédent (la mémoire vit par tour)', () => {
    const memory = new ProtocolMemory() // tour neuf — mémoire vide
    expect(protocolFeedback(round(), memory, [])).toBeNull()
  })

  it('signale la relecture d’un CONTEXT.md déjà chargé dans le prompt (chemins normalisés)', () => {
    const fb = protocolFeedback(
      round({ toolCalls: [call({ tool: 'read', args: { path: '.workspace/notes/CONTEXT.md' }, rawArgs: '{"path":".workspace/notes/CONTEXT.md"}' })] }),
      new ProtocolMemory(),
      ['notes/CONTEXT.md'],
    )
    expect(fb).toContain('« .workspace/notes/CONTEXT.md » est DÉJÀ chargé')
  })

  it('accumule les écarts : chaque violation a sa ligne, la structure reste [HARNESS] + puces + reprise', () => {
    const memory = new ProtocolMemory()
    memory.remember(1, [call()])
    const fb = protocolFeedback(
      round({ round: 2, firstEvent: 'tool_calls', thinkingChars: 0, thinkingTitles: [], text: 'Voilà.', toolCalls: [call({ title: '' }), call()] }),
      memory,
      [],
    )
    expect(fb).toContain('S’OUVRIR')
    expect(fb).toContain('sans argument `title`')
    expect(fb).toContain('Du texte visible accompagne')
    expect(fb).toContain('au round 1 de CE tour')
    expect(fb!.split('\n')[0]).toBe('[HARNESS — protocole, round 2]')
    expect(fb!.split('\n').at(-1)).toContain('Reprends le protocole')
  })
})

describe('normalizeIcmPath', () => {
  it('ramène chaque variante d’écriture au chemin ICM canonique', () => {
    expect(normalizeIcmPath('notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('./notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('.workspace/notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('')).toBe('')
  })
})

describe('EMPTY_RESPONSE_NUDGE', () => {
  it('est un message HARNESS qui exige texte OU tool_calls', () => {
    expect(EMPTY_RESPONSE_NUDGE.startsWith('[HARNESS — protocole]')).toBe(true)
    expect(EMPTY_RESPONSE_NUDGE).toContain('VIDE')
    expect(EMPTY_RESPONSE_NUDGE).toContain('tool_calls')
  })
})
