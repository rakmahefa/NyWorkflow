import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESPONSE_NUDGE,
  NO_TOOL_EMPTY_PROSE_NUDGE,
  normalizeIcmPath,
  parseCallPlan,
  planRedoNote,
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

/** A compliant round — thinking first, titled, one titled valid call, and
 * the M21 PLAN announcement closing the thinking (contract held). */
const round = (over: Partial<RoundProtocol> = {}): RoundProtocol => ({
  round: 1,
  firstEvent: 'thinking',
  thinkingChars: 250,
  thinkingTitles: ['Explorer la racine'],
  thinking: 'Je liste la racine pour comprendre le workspace.\nPLAN: 1 tool_calls — [Lister la racine]',
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
    const fb = protocolFeedback(round({ firstEvent: 'tool_calls', thinkingChars: 0, thinkingTitles: [], thinking: '' }), new ProtocolMemory(), [])
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
      round({ round: 2, firstEvent: 'tool_calls', thinkingChars: 0, thinkingTitles: [], thinking: '', text: 'Voilà.', toolCalls: [call({ title: '' }), call()] }),
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

describe('parseCallPlan — le contrat d’appels M21', () => {
  it('lit l’annonce en fin de thinking : compte + titres entre crochets', () => {
    const plan = parseCallPlan('Analyse.\nPLAN: 3 tool_calls — [Lire le plan] [Lister inbox] [Vérifier uv]')
    expect(plan).toEqual({ kind: 'calls', count: 3, titles: ['Lire le plan', 'Lister inbox', 'Vérifier uv'] })
  })

  it('lit l’annonce sans outil', () => {
    expect(parseCallPlan('Réflexion.\nPLAN: no_tool')).toEqual({ kind: 'no_tool' })
  })

  it('tolère les variations d’écriture (espaces, « appels », tirets, majuscules)', () => {
    expect(parseCallPlan('PLAN : 2 appels - [A] [B]')).toEqual({ kind: 'calls', count: 2, titles: ['A', 'B'] })
    expect(parseCallPlan('plan: No_Tool — réponse finale')).toEqual({ kind: 'no_tool' })
    expect(parseCallPlan('PLAN:1 tool_calls—[Seul]')).toEqual({ kind: 'calls', count: 1, titles: ['Seul'] })
  })

  it('prend la DERNIÈRE ligne PLAN: du thinking (une annonce corrigée gagne)', () => {
    const plan = parseCallPlan('PLAN: 2 tool_calls — [A] [B]\nFinalement.\nPLAN: 1 tool_calls — [A]')
    expect(plan).toEqual({ kind: 'calls', count: 1, titles: ['A'] })
  })

  it('rend null sans annonce, sur un thinking vide ou une annonce illisible', () => {
    expect(parseCallPlan('')).toBeNull()
    expect(parseCallPlan('Aucun plan ici.')).toBeNull()
    expect(parseCallPlan('PLAN: bientôt')).toBeNull()
  })
})

describe('protocolFeedback — le contrat d’appels M21', () => {
  it('se tait quand l’annonce tient le groupe (compte exact, titres listés)', () => {
    const memory = new ProtocolMemory()
    const fb = protocolFeedback(
      round({ thinking: 'Deux lectures.\nPLAN: 2 tool_calls — [Lister la racine] [Lister inbox]', toolCalls: [call(), call({ title: 'Lister inbox', args: { path: 'inbox' }, rawArgs: '{"path":"inbox"}' })] }),
      memory,
      [],
    )
    expect(fb).toBeNull()
  })

  it('se tait pour un no_tool SEUL (la signature de la réponse finale)', () => {
    const fb = protocolFeedback(
      round({
        thinking: 'La réponse vient de l’ICM.\nPLAN: no_tool',
        toolCalls: [call({ tool: 'no_tool', title: 'Réponse finale', args: { reason: 'ICM déjà chargé' }, rawArgs: '{"reason":"ICM déjà chargé"}' })],
        text: 'Voilà la réponse finale.',
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toBeNull()
  })

  it('réclame l’annonce absente (thinking sans ligne PLAN:)', () => {
    const fb = protocolFeedback(round({ thinking: 'Je réfléchis sans annoncer.' }), new ProtocolMemory(), [])
    expect(fb).toContain('ne se termine pas par l’annonce du plan')
    expect(fb).toContain('PLAN: 3 tool_calls')
  })

  it('signale le compte non tenu (annoncé 3, émis 2)', () => {
    const fb = protocolFeedback(
      round({ thinking: 'PLAN: 3 tool_calls — [A] [B] [C]', toolCalls: [call(), call({ title: 'B', args: { path: 'b' }, rawArgs: '{"path":"b"}' })] }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('annonçait 3 tool_calls et tu en as émis 2')
  })

  it('signale le no_tool annoncé puis trahi par de vrais appels', () => {
    const fb = protocolFeedback(round({ thinking: 'PLAN: no_tool' }), new ProtocolMemory(), [])
    expect(fb).toContain('no_tool » puis émis 1 tool_call')
  })

  it('signale le no_tool mélangé à de vrais appels', () => {
    const fb = protocolFeedback(
      round({
        thinking: 'PLAN: 2 tool_calls — [Lister] [Signer]',
        toolCalls: [call(), call({ tool: 'no_tool', title: 'Signer', args: {}, rawArgs: '{}' })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('no_tool` est mélangé')
  })

  it('signale l’annonce sans titres entre crochets', () => {
    const fb = protocolFeedback(round({ thinking: 'PLAN: 1 tool_calls' }), new ProtocolMemory(), [])
    expect(fb).toContain('ne liste pas les titres')
  })
})

describe('planRedoNote — le refus du groupe non conforme', () => {
  it('porte l’en-tête HARNESS, les écarts du round, et l’ordre de réémettre', () => {
    const note = planRedoNote(2, ['Ton plan annonçait 3 tool_calls et tu en as émis 2.', '1 tool_call est sans argument `title`'])
    expect(note.split('\n')[0]).toBe('[HARNESS — protocole, round 2]')
    expect(note).toContain('- Ton plan annonçait 3 tool_calls')
    expect(note).toContain('n’a PAS été exécuté')
    expect(note).toContain('RÉÉMETS le groupe complet')
  })
})

describe('NO_TOOL_EMPTY_PROSE_NUDGE', () => {
  it('réclame la prose finale qui doit accompagner no_tool', () => {
    expect(NO_TOOL_EMPTY_PROSE_NUDGE.startsWith('[HARNESS — protocole]')).toBe(true)
    expect(NO_TOOL_EMPTY_PROSE_NUDGE).toContain('SANS la prose finale')
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
