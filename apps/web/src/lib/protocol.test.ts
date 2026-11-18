import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESPONSE_NUDGE,
  NO_TOOL_EMPTY_PROSE_NUDGE,
  UNSIGNED_FINAL_NUDGE,
  TOOL_CALL_FORMAT,
  normalizeIcmPath,
  parseCallPlan,
  parseRoundPhases,
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

/** A compliant M22 round — thinking first, titled, the [TOOL_LISTING]
 * section, a [MESSAGE] section, one titled valid call (contract held). */
const round = (over: Partial<RoundProtocol> = {}): RoundProtocol => {
  const r = {
    round: 1,
    firstEvent: 'thinking' as const,
    thinkingChars: 250,
    thinkingTitles: ['Explorer la racine'],
    thinking: 'Je liste la racine pour comprendre le workspace.',
    text: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]\n\n[MESSAGE]\nJe regarde la racine.',
    toolCalls: [call()],
    ...over,
  }
  return { ...r, phases: parseRoundPhases(r.text) }
}

describe('parseRoundPhases — le découpage M22 par en-têtes exacts', () => {
  it('lit le listing, le message, et rend la prose hors sections', () => {
    const p = parseRoundPhases(
      '[TOOL_LISTING] 2 tool_calls — [Lire la charte] [Lister inbox]\n\nUne prose avant le message.\n\n[MESSAGE]\nJe prépare le tour.',
    )
    expect(p.listing).toEqual({ kind: 'calls', count: 2, titles: ['Lire la charte', 'Lister inbox'] })
    expect(p.listingPresent).toBe(true)
    expect(p.message).toBe('Je prépare le tour.')
    expect(p.droppedText).toBe('Une prose avant le message.')
    expect(p.droppedChars).toBe('Une prose avant le message.'.length)
    expect(p.brokenToolBlocks).toBe(0)
  })

  it('lit la signature no_tool', () => {
    const p = parseRoundPhases('[TOOL_LISTING] no_tool\n\n[MESSAGE]\nVoilà le bilan.')
    expect(p.listing).toEqual({ kind: 'no_tool' })
    expect(p.message).toBe('Voilà le bilan.')
  })

  it('rend listing null sans en-tête — la phase est REJETÉE', () => {
    const p = parseRoundPhases('Je vais lire deux fichiers.\n\n[MESSAGE]\nBonjour')
    expect(p.listing).toBeNull()
    expect(p.listingPresent).toBe(false)
    expect(p.message).toBe('Bonjour')
    expect(p.droppedText).toBe('Je vais lire deux fichiers.')
  })

  it('compte les blocs d’appel mal formés restés dans le texte (droppés par le décodage)', () => {
    const p = parseRoundPhases(
      '[TOOL_LISTING] 2 tool_calls — [A] [B]\n\n{{tool {"name": "ls" }\n{{tool {"name": "read", "arguments": }',
    )
    expect(p.listing?.kind).toBe('calls')
    expect(p.brokenToolBlocks).toBe(2)
    expect(p.message).toBe('')
  })

  it('la prose sans AUCUN en-tête est entièrement droppée (le miss ne s’affiche pas)', () => {
    const p = parseRoundPhases('Bonjour ! Voici la réponse finale du travail.')
    expect(p.listing).toBeNull()
    expect(p.message).toBe('')
    expect(p.droppedChars).toBe('Bonjour ! Voici la réponse finale du travail.'.length)
  })

  it('le PREMIER listing gagne ; un second [MESSAGE] prolonge la prose', () => {
    const p = parseRoundPhases('[TOOL_LISTING] 1 tool_calls — [A]\n[TOOL_LISTING] 5 tool_calls\n[MESSAGE]\nUn.\n[MESSAGE]\nDeux.')
    expect(p.listing).toEqual({ kind: 'calls', count: 1, titles: ['A'] })
    expect(p.message).toBe('Un.\nDeux.')
  })

  it('tolère les variations d’espacement et la casse de l’en-tête', () => {
    const p = parseRoundPhases('   [tool_listing]   3 tool_calls — [A] [B] [C]  \n[message]\nAllo')
    expect(p.listing?.kind === 'calls' ? p.listing.count : null).toBe(3)
    expect(p.message).toBe('Allo')
  })

  it('texte vide ou flux partiel : rien ne casse, rien ne s’affiche', () => {
    expect(parseRoundPhases('')).toEqual({
      listing: null,
      listingRaw: '',
      listingPresent: false,
      message: '',
      droppedText: '',
      droppedChars: 0,
      brokenToolBlocks: 0,
    })
    const half = parseRoundPhases('[TOOL_LI')
    expect(half.listing).toBeNull()
    expect(half.droppedText).toBe('[TOOL_LI')
  })
})

describe('parseCallPlan — le contenu du listing', () => {
  it('lit le compte et les titres entre crochets', () => {
    expect(parseCallPlan('3 tool_calls — [Lire le plan] [Lister inbox] [Vérifier uv]')).toEqual({
      kind: 'calls',
      count: 3,
      titles: ['Lire le plan', 'Lister inbox', 'Vérifier uv'],
    })
  })

  it('lit la signature sans outil', () => {
    expect(parseCallPlan('no_tool')).toEqual({ kind: 'no_tool' })
  })

  it('tolère les variations d’écriture (espaces, « appels », tirets, majuscules)', () => {
    expect(parseCallPlan('  2 appels - [A] [B] ')).toEqual({ kind: 'calls', count: 2, titles: ['A', 'B'] })
    expect(parseCallPlan('NO_TOOL')).toEqual({ kind: 'no_tool' })
  })

  it('rend null sur un contenu vide ou illisible', () => {
    expect(parseCallPlan('')).toBeNull()
    expect(parseCallPlan('des appels peut-être')).toBeNull()
  })
})

describe('protocolFeedback — le feedback engine M22', () => {
  it('se tait quand le protocole est suivi (aucun sermon pour un modèle conforme)', () => {
    const memory = new ProtocolMemory()
    memory.remember(1, [call()])
    expect(protocolFeedback(round(), memory, [])).toBeNull()
  })

  it('se tait pour une réponse finale propre (prose en-têtée, thinking titré, sans appels)', () => {
    expect(
      protocolFeedback(
        round({ toolCalls: [], text: '[TOOL_LISTING] no_tool\n\n[MESSAGE]\nVoilà le bilan : outputs/rapport.md.' }),
        new ProtocolMemory(),
        [],
      ),
    ).toBeNull()
  })

  it('réclame le thinking quand la réponse commence par les tool_calls (le cas des logs, rounds 3 et 5)', () => {
    const fb = protocolFeedback(round({ firstEvent: 'tool_calls', thinkingChars: 0, thinkingTitles: [], thinking: '' }), new ProtocolMemory(), [])
    expect(fb).toContain('[HARNESS — feedback, round 1]')
    expect(fb).toContain('S’OUVRIR par un bloc <thinking title=')
    expect(fb).toContain('commencé par des tool_calls')
  })

  it('réclame le thinking quand la réponse commence par du texte visible', () => {
    const fb = protocolFeedback(round({ firstEvent: 'text', toolCalls: [], text: '[MESSAGE]\nBonjour !' }), new ProtocolMemory(), [])
    expect(fb).toContain('commencé par du texte visible')
  })

  it('signale un thinking sans title', () => {
    const fb = protocolFeedback(round({ thinkingTitles: [] }), new ProtocolMemory(), [])
    expect(fb).toContain('thinking n’a pas de title')
  })

  it('réclame la section [TOOL_LISTING] absente (le contrat ne peut pas être vérifié)', () => {
    const fb = protocolFeedback(
      round({ text: 'Je lis la racine.' }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('Ta section [TOOL_LISTING] est absente')
  })

  it('signale le compte non tenu (annoncé 3, émis 2)', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 3 tool_calls — [A] [B] [C]',
        toolCalls: [call(), call({ tool: 'read', title: 'Lire', args: { path: 'a.md', title: 'Lire' } })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('annonçait 3 tool_calls et tu en as émis 2')
  })

  it('signale le no_tool annoncé puis trahi par de vrais appels', () => {
    const fb = protocolFeedback(round({ text: '[TOOL_LISTING] no_tool' }), new ProtocolMemory(), [])
    expect(fb).toContain('no_tool puis émis 1 tool_call')
  })

  it('signale le no_tool mélangé à de vrais appels', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 2 tool_calls — [A] [B]',
        toolCalls: [call(), call({ tool: 'no_tool', title: 'fin', args: { reason: 'fin' } })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('no_tool` est mélangé à de vrais appels')
  })

  it('signale le listing sans titres entre crochets', () => {
    const fb = protocolFeedback(round({ text: '[TOOL_LISTING] 1 tool_calls' }), new ProtocolMemory(), [])
    expect(fb).toContain('ne liste pas les titres')
  })

  it('signale la prose droppée : le miss ne s’affiche pas, mais le feedback le dit', () => {
    const fb = protocolFeedback(
      round({ text: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]\n\nUne prose perdue hors section.' }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('caractères de prose sans en-tête [MESSAGE] ont été DROPPÉS')
    expect(fb).toContain('jamais affichés au pilote')
  })

  it('signale les blocs d’appel mal formés avec le FORMAT EXACT (la leçon des tours cassés)', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]\n\n{{tool {"name": "ls" }}',
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('1 bloc d’appel mal formé a été DROPPÉ')
    expect(fb).toContain(TOOL_CALL_FORMAT)
  })

  it('signale les tool_calls sans title et les arguments mal formés', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 2 tool_calls — [A] [B]',
        toolCalls: [call({ title: '' }), call({ tool: 'write', argsOk: false, args: {}, rawArgs: '{path: x}' })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('sans argument `title`')
    expect(fb).toContain('ne sont pas un JSON objet valide')
  })

  it('signale un outil inconnu et cite les outils déclarés', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 1 tool_calls — [A]',
        toolCalls: [call({ tool: 'rm_rf', args: {}, rawArgs: '{}' })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb).toContain('Outil inconnu : « rm_rf »')
    expect(fb).toContain('les outils déclarés sont')
  })

  it('signale les appels dupliqués DANS le groupe', () => {
    const fb = protocolFeedback(round({ text: '[TOOL_LISTING] 2 tool_calls — [A] [A]', toolCalls: [call(), call()] }), new ProtocolMemory(), [])
    expect(fb).toContain('dupliqué dans ton groupe')
  })

  it('signale l’appel déjà exécuté à un round précédent du MÊME tour (le « hi » : ls . ×3)', () => {
    const memory = new ProtocolMemory()
    memory.remember(1, [call()])
    const fb = protocolFeedback(round({ round: 3 }), memory, [])
    expect(fb).toContain('déjà appelé ls « . » au round 1')
  })

  it('ne signale pas la répétition venue d’un tour précédent (la mémoire vit par tour)', () => {
    const memory = new ProtocolMemory()
    expect(protocolFeedback(round(), memory, [])).toBeNull()
  })

  it('signale la relecture d’un CONTEXT.md déjà chargé dans le prompt (chemins normalisés)', () => {
    const fb = protocolFeedback(
      round({
        text: '[TOOL_LISTING] 1 tool_calls — [Relire]',
        toolCalls: [call({ tool: 'read', title: 'Relire', args: { path: '.workspace/notes/CONTEXT.md', title: 'Relire' } })],
      }),
      new ProtocolMemory(),
      ['notes/CONTEXT.md'],
    )
    expect(fb).toContain('DÉJÀ chargé dans ton prompt système (ICM)')
  })

  it('accumule les écarts : chaque violation a sa ligne, la structure reste [HARNESS] + puces + reprise', () => {
    const fb = protocolFeedback(
      round({
        round: 2,
        firstEvent: 'text',
        thinkingChars: 0,
        thinkingTitles: [],
        thinking: '',
        text: 'Prose perdue.\n[TOOL_LISTING] 3 tool_calls',
        toolCalls: [call({ title: '' })],
      }),
      new ProtocolMemory(),
      [],
    )
    expect(fb!.split('\n')[0]).toBe('[HARNESS — feedback, round 2]')
    expect(fb).toContain('- Ta réponse doit S’OUVRIR')
    expect(fb).toContain('- Ton listing annonçait 3 tool_calls et tu en as émis 1')
    expect(fb).toContain('- 13 caractères de prose sans en-tête [MESSAGE] ont été DROPPÉS')
    expect(fb!.split('\n').at(-1)).toContain('Reprends le protocole cinq phases')
  })
})

describe('planRedoNote — le refus du groupe non conforme', () => {
  it('porte l’en-tête HARNESS feedback, les écarts du round, et l’ordre de réémettre', () => {
    const note = planRedoNote(2, ['Ton listing annonçait 3 tool_calls et tu en as émis 1'])
    expect(note.split('\n')[0]).toBe('[HARNESS — feedback, round 2]')
    expect(note).toContain('- Ton listing annonçait 3 tool_calls et tu en as émis 1')
    expect(note).toContain('n’a PAS été exécuté')
    expect(note).toContain('RÉÉMETS le groupe complet')
    expect(note).toContain(TOOL_CALL_FORMAT)
  })
})

describe('Les nudges de fin de tour (le harness décide de la suite)', () => {
  it('EMPTY_RESPONSE_NUDGE exige texte OU tool_calls', () => {
    expect(EMPTY_RESPONSE_NUDGE).toContain('[HARNESS — feedback]')
    expect(EMPTY_RESPONSE_NUDGE).toContain('VIDE')
  })

  it('NO_TOOL_EMPTY_PROSE_NUDGE réclame la prose en-têtée qui accompagne no_tool', () => {
    expect(NO_TOOL_EMPTY_PROSE_NUDGE).toContain('[HARNESS — feedback]')
    expect(NO_TOOL_EMPTY_PROSE_NUDGE).toContain('[MESSAGE]')
  })

  it('UNSIGNED_FINAL_NUDGE réclame la signature : une prose seule ne termine jamais un tour', () => {
    expect(UNSIGNED_FINAL_NUDGE).toContain('[HARNESS — feedback]')
    expect(UNSIGNED_FINAL_NUDGE).toContain('n’est pas SIGNÉE')
    expect(UNSIGNED_FINAL_NUDGE).toContain('[TOOL_LISTING] no_tool')
    expect(UNSIGNED_FINAL_NUDGE).toContain('[MESSAGE]')
  })
})

describe('normalizeIcmPath', () => {
  it('ramène chaque variante d’écriture au chemin ICM canonique', () => {
    expect(normalizeIcmPath('notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('./notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('.workspace/notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
    expect(normalizeIcmPath('/notes/CONTEXT.md')).toBe('notes/CONTEXT.md')
  })
})
