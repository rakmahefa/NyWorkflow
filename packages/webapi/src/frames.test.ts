import { describe, expect, it } from 'vitest'
import { FrameDecoder, bardErrorCode, cleanText, isEmptyStream, type FrameEvent } from './frames.ts'
import { textFrame } from './mock-gemini.ts'

function wireLine(inner: unknown): string {
  return JSON.stringify([['wrb.fr', [62, 0], typeof inner === 'string' ? inner : JSON.stringify(inner)], ['di', 72]])
}

describe('FrameDecoder', () => {
  it('décode une ligne wrb.fr et prend le candidat le plus long', () => {
    const inner = [null, ['tok'], 'padding'.repeat(8), [], [['short', ['Bonjour']], ['long', ['Bonjour, ', 'le monde']]], [], [], []]
    const events = new FrameDecoder().feed(wireLine(inner) + '\n')
    expect(events).toContainEqual({ type: 'text', text: 'Bonjour, le monde' })
  })

  it('la dernière ligne sans \\n est décodée par finish()', () => {
    const decoder = new FrameDecoder()
    expect(decoder.feed(textFrame('abc'))).toEqual([])
    expect(decoder.finish()).toContainEqual({ type: 'text', text: 'abc' })
  })

  it('ignore )]}\' , les lignes vides et les préfixes de longueur non-JSON', () => {
    const decoder = new FrameDecoder()
    const events = decoder.feed(")]}'\n\n125\n" + textFrame('ok') + '\n')
    expect(events).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('ignore les lignes non wrb.fr (di, etc.)', () => {
    const decoder = new FrameDecoder()
    expect(decoder.feed(JSON.stringify([['di', 72]]) + '\n')).toEqual([])
  })

  it('inner invalide → métadonnée bornée unparsed_frame, pas d’exception', () => {
    const events = new FrameDecoder().feed('[[\"wrb.fr\",[62,0],"{not-json"],["di",72]]\n'.replace(/\\"/g, '"'))
    expect(events).toEqual([{ type: 'metadata', kind: 'unparsed_frame', value: { bytes: 9, preview: '{not-json' } }])
  })

  it('tool_call structuré détecté, doublon émis une seule fois', () => {
    const inner = { functionCall: { id: 'c1', name: 'glob', arguments: { pattern: '*.rs' } } }
    const line = wireLine(inner)
    const decoder = new FrameDecoder()
    const first = decoder.feed(line + '\n').filter((e) => e.type === 'toolCall')
    const second = decoder.feed(line + '\n').filter((e) => e.type === 'toolCall')
    expect(first).toEqual([{ type: 'toolCall', id: 'c1', name: 'glob', arguments: { pattern: '*.rs' } }])
    expect(second).toEqual([])
  })

  it('un tool_call sans id reçoit un id généré', () => {
    const events = new FrameDecoder().feed(wireLine({ toolCall: { name: 'read', arguments: {} } }) + '\n')
    const call = events.find((e): e is Extract<FrameEvent, { type: 'toolCall' }> => e.type === 'toolCall')
    expect(call?.id).toMatch(/^gemini_call_\d+$/)
  })

  it('métadonnées connues (usageMetadata, finishReason, blockReason) remontent', () => {
    const events = new FrameDecoder().feed(wireLine({ finishReason: 'STOP', usageMetadata: { total: 3 } }) + '\n')
    const kinds = events.filter((e) => e.type === 'metadata').map((e) => (e as { kind: string }).kind)
    expect(kinds).toEqual(expect.arrayContaining(['finishReason', 'usageMetadata']))
  })

  it('les caractères multi-octets coupés entre deux chunks ne se corrompent pas', () => {
    const decoder = new FrameDecoder()
    const whole = textFrame('héllo 🎉') + '\n'
    const mid = Math.floor(whole.length / 2)
    decoder.feed(whole.slice(0, mid))
    const events = [...decoder.feed(whole.slice(mid)), ...decoder.finish()]
    expect(events).toContainEqual({ type: 'text', text: 'héllo 🎉' })
  })

  it('pending() expose la ligne incomplète en attente', () => {
    const decoder = new FrameDecoder()
    decoder.feed('{"a":1')
    expect(decoder.pending()).toBe('{"a":1')
  })
})

describe('cleanText', () => {
  it('retire les blocs code_reference et les card_content', () => {
    const input = 'avant\n```python?code_reference&code_event_index=12\nligne 1\nligne 2\n```\nmilieu\nhttp://googleusercontent.com/card_content/7\nfin\n'
    expect(cleanText(input, true)).toBe('avant\nmilieu\nfin')
  })

  it('trim optionnel', () => {
    expect(cleanText('  x  ', true)).toBe('x')
    expect(cleanText('  x  ', false)).toBe('  x  ')
  })
})

describe('bardErrorCode', () => {
  it('détecte BardErrorInfo [n] et son code', () => {
    expect(bardErrorCode('blah {"error":"BardErrorInfo [401]"} end')).toBe(401)
    expect(bardErrorCode('BardErrorInfo [1033]')).toBe(1033)
  })

  it('sans marqueur → undefined', () => {
    expect(bardErrorCode('rien')).toBeUndefined()
  })
})

describe('isEmptyStream', () => {
  it('wrb.fr sans texte ni outil → true', () => {
    const raw = ")]}'\n" + wireLine({ finishReason: 'STOP' }) + '\n'
    expect(isEmptyStream(raw)).toBe(true)
  })

  it('avec texte → false ; avec outil → false', () => {
    expect(isEmptyStream(")]}'\n" + textFrame('salut') + '\n')).toBe(false)
    expect(isEmptyStream(")]}'\n" + wireLine({ functionCall: { name: 'read', arguments: {} } }) + '\n')).toBe(false)
  })

  it('sans wrb.fr du tout → false (ce n’est pas un flux de conversation)', () => {
    expect(isEmptyStream('{"autre": 1}')).toBe(false)
  })
})
