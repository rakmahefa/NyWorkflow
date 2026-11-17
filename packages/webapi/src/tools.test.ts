import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_BLOCK_BYTES,
  ToolStreamSplitter,
  ToolValidationError,
  normalizeTools,
  openAiArguments,
  parseToolChoice,
  scanJsonValue,
  solveToolBlock,
  toolsPreamble,
  TOOLS_CLOSE,
  TOOLS_OPEN,
} from './tools.ts'

const WEATHER = { type: 'function', function: { name: 'get_weather', description: 'Météo d’une ville', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }

describe('normalizeTools', () => {
  it('format OpenAI (type function + function) normalisé', () => {
    expect(normalizeTools([WEATHER])).toEqual([
      { name: 'get_weather', description: 'Météo d’une ville', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    ])
  })

  it('tolérance : entrée plate {name, description, parameters} (style Google) acceptée', () => {
    expect(normalizeTools([{ name: 'f', description: 'd' }])).toEqual([{ name: 'f', description: 'd' }])
    expect(normalizeTools([{ name: 'g', description: '', parameters: undefined }])).toEqual([{ name: 'g', description: '' }])
  })

  it('paramètres optionnels absents du résultat (jamais de undefined sérialisé)', () => {
    const parsed = JSON.parse(JSON.stringify(normalizeTools([{ name: 'f' }])))
    expect(parsed).toEqual([{ name: 'f', description: '' }])
  })

  it('rejets clairs : non-tableau, entrée sans nom, schéma non objet, doublon', () => {
    expect(() => normalizeTools('nope')).toThrow(ToolValidationError)
    expect(() => normalizeTools([{ type: 'function', function: {} }])).toThrow(/function.name/)
    expect(() => normalizeTools([{ name: 'f', parameters: 'schéma' }])).toThrow(/parameters/)
    expect(() => normalizeTools([{ name: 'f' }, { name: 'f' }])).toThrow(/dupliqué/)
  })
})

describe('parseToolChoice', () => {
  it('auto par défaut, none, required', () => {
    expect(parseToolChoice(undefined)).toEqual({ kind: 'auto' })
    expect(parseToolChoice('auto')).toEqual({ kind: 'auto' })
    expect(parseToolChoice('none')).toEqual({ kind: 'none' })
    expect(parseToolChoice('required')).toEqual({ kind: 'required' })
  })

  it('forçage par objet OpenAI ou entrée plate', () => {
    expect(parseToolChoice({ type: 'function', function: { name: 'f' } })).toEqual({ kind: 'forced', name: 'f' })
    expect(parseToolChoice({ name: 'g' })).toEqual({ kind: 'forced', name: 'g' })
  })

  it('valeurs invraisemblables → erreur claire', () => {
    expect(() => parseToolChoice('banana')).toThrow(ToolValidationError)
    expect(() => parseToolChoice({ type: 'function' })).toThrow(/tool_choice/)
  })
})

describe('toolsPreamble', () => {
  it('porte les outils, la convention exacte et les règles', () => {
    const text = toolsPreamble(normalizeTools([WEATHER]), { kind: 'auto' })
    expect(text).toContain('get_weather')
    expect(text).toContain('Météo d’une ville')
    expect(text).toContain('"required":["city"]')
    expect(text).toContain('{{tool {"name": "tool_name", "arguments": {"arg1": "value1"}} }}')
    expect(text).toContain('Never invent tool results')
    expect(text).not.toContain('MUST call')
  })

  it('required et forced ajoutent leur injonction', () => {
    expect(toolsPreamble(normalizeTools([WEATHER]), { kind: 'required' })).toContain('MUST call at least one tool')
    expect(toolsPreamble(normalizeTools([WEATHER]), { kind: 'forced', name: 'get_weather' })).toContain('MUST call the tool "get_weather"')
  })
})

describe('scanJsonValue — aware des chaînes et des accolades imbriquées', () => {
  it('trouve la fin exacte, `}}` structurels compris', () => {
    const value = '{"name":"f","arguments":{"a":{"b":1}}}'
    const s = `${value}}} suite` // le "}}" du bloc suit immédiatement l'objet
    expect(scanJsonValue(s, 0)).toEqual({ end: value.length })
    expect(s.slice(0, value.length)).toBe(value)
  })

  it('les `}}` DANS une chaîne ne ferment rien, les échappements respectés', () => {
    const s = '{"x":"a}}b","y":"q\\"}"}'
    expect(scanJsonValue(s, 0)).toEqual({ end: s.length })
  })

  it('incomplet → pending ; impossible → null ; primitives scannées', () => {
    expect(scanJsonValue('{"a":', 0)).toEqual({ pending: true })
    expect(scanJsonValue('"abc', 0)).toEqual({ pending: true })
    expect(scanJsonValue('', 0)).toEqual({ pending: true })
    expect(scanJsonValue('} x', 0)).toBeNull()
    expect(scanJsonValue('banana', 0)).toBeNull()
    expect(scanJsonValue('true false', 0)).toEqual({ end: 4 })
    expect(scanJsonValue('  [1,2]', 0)).toEqual({ end: 7 })
  })
})

describe('solveToolBlock', () => {
  const block = (inner: string): string => ` ${inner} ${TOOLS_CLOSE}`

  it('bloc valide complet', () => {
    const input = block('{"name":"f","arguments":{"city":"Paris"}}')
    expect(solveToolBlock(input)).toEqual({
      call: { name: 'f', args: { city: 'Paris' } },
      consumed: input.length,
    })
  })

  it('arguments imbriqués (}}) et fermeture collée', () => {
    // JSON = {"name":"f","arguments":{"a":{"b":1}}} (3 accolades finales) + fermeture }} collée
    expect(solveToolBlock('{"name":"f","arguments":{"a":{"b":1}}}}}}')).toMatchObject({ call: { name: 'f', args: { a: { b: 1 } } } })
    // un seul '}' après le JSON : la fermeture est peut-être en route — on attend, jamais de texte perdu
    expect(solveToolBlock('{"name":"f","arguments":{"a":{"b":1}}}}')).toBe('incomplete')
  })

  it('fence ```json tolérée autour du JSON', () => {
    expect(solveToolBlock('```json\n{"name":"f","arguments":{}}\n``` ' + TOOLS_CLOSE)).toMatchObject({ call: { name: 'f', args: {} } })
  })
  it('incomplet → incomplete (JSON ouvert, fermeture absente, fence partielle)', () => {
    expect(solveToolBlock('{"name":"f"')).toBe('incomplete')
    expect(solveToolBlock('{"name":"f","arguments":{}}')).toBe('incomplete') // JSON complet, fermeture pas encore arrivée
    expect(solveToolBlock('``')).toBe('incomplete')
    expect(solveToolBlock('  ')).toBe('incomplete')
  })

  it('prose et faux positifs → not-a-block', () => {
    expect(solveToolBlock('calls}} et du texte')).toBe('not-a-block')
    expect(solveToolBlock('{"x":1} pas de fermeture mais du texte')).toBe('not-a-block')
    expect(solveToolBlock('{"name":"f","arguments":{}} texte au lieu de fermer}}')).toBe('not-a-block')
  })
})

describe('ToolStreamSplitter — jamais perdant', () => {
  const full = `Voici le plan.\n${TOOLS_OPEN} {"name": "get_weather", "arguments": {"city": "Paris"}} ${TOOLS_CLOSE}\nMerci.`

  it('bloc entier en un push', () => {
    const s = new ToolStreamSplitter()
    const out = s.push(full)
    expect(out.text).toBe('Voici le plan.\n\nMerci.')
    expect(out.toolCalls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
    expect(s.finish()).toEqual({ text: '', toolCalls: [] })
  })

  it('COUPÉ PARTOUT : chaque point de césure du flux donne le même résultat', () => {
    for (let cut = 1; cut < full.length; cut++) {
      const s = new ToolStreamSplitter()
      const a = s.push(full.slice(0, cut))
      const b = s.push(full.slice(cut))
      const tail = s.finish()
      const text = a.text + b.text + tail.text
      const calls = [...a.toolCalls, ...b.toolCalls, ...tail.toolCalls]
      expect(text).toBe('Voici le plan.\n\nMerci.')
      expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
    }
  })

  it('caractère par caractère', () => {
    const s = new ToolStreamSplitter()
    let text = ''
    const calls: unknown[] = []
    for (const ch of full) {
      const out = s.push(ch)
      text += out.text
      calls.push(...out.toolCalls)
    }
    const tail = s.finish()
    text += tail.text
    calls.push(...tail.toolCalls)
    expect(text).toBe('Voici le plan.\n\nMerci.')
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }])
  })

  it('deux blocs à la suite', () => {
    const s = new ToolStreamSplitter()
    const out = s.push(
      `${TOOLS_OPEN} {"name": "a", "arguments": {}} ${TOOLS_CLOSE}${TOOLS_OPEN} {"name": "b", "arguments": {"x": 1}} ${TOOLS_CLOSE}`,
    )
    expect(out.text).toBe('')
    expect(out.toolCalls).toEqual([
      { name: 'a', args: {} },
      { name: 'b', args: { x: 1 } },
    ])
  })

  it('prose avec faux positifs : tout ressort en texte, intact', () => {
    const prose = `Les {{tool calls}} sont utiles, {{tooltip}} aussi, et {{tool {"sans": "nom"} }} pareil.`
    const s = new ToolStreamSplitter()
    let text = ''
    for (const ch of prose) text += s.push(ch).text
    text += s.finish().text
    expect(text).toBe(prose)
  })

  it('bloc jamais refermé → finish() le rend en texte', () => {
    const s = new ToolStreamSplitter()
    const out = s.push(`${TOOLS_OPEN} {"name": "f", "arg`)
    expect(out).toEqual({ text: '', toolCalls: [] })
    expect(s.finish().text).toBe(`${TOOLS_OPEN} {"name": "f", "arg`)
  })

  it('bloc démesuré (garde-fou) → redevient du texte', () => {
    const s = new ToolStreamSplitter()
    const huge = `${TOOLS_OPEN} ` + 'x'.repeat(MAX_TOOL_BLOCK_BYTES + 10)
    const out = s.push(huge)
    expect(out.text).toBe(huge) // faux positif immédiat : 'x' ne peut pas commencer un JSON
    expect(out.toolCalls).toEqual([])

    const s2 = new ToolStreamSplitter()
    const part1 = `${TOOLS_OPEN} {"name": "f", "arguments": ` + '{'.repeat(MAX_TOOL_BLOCK_BYTES + 10)
    const out2a = s2.push(part1) // JSON ouvert, jamais refermé → rien d'émis, on attend
    expect(out2a).toEqual({ text: '', toolCalls: [] })
    const out2b = s2.push(' et encore du texte') // dépassement du garde-fou → tout redevient du texte
    expect(out2b.text).toBe(part1 + ' et encore du texte')
    expect(out2b.toolCalls).toEqual([])
  })

  it('fence autour du bloc (le réflexe Gemini)', () => {
    const fenced = `${TOOLS_OPEN} \`\`\`json\n{"name": "f", "arguments": {"city": "Paris"}}\n\`\`\` ${TOOLS_CLOSE}`
    const s = new ToolStreamSplitter()
    const out = s.push(fenced)
    expect(out.toolCalls).toEqual([{ name: 'f', args: { city: 'Paris' } }])
    expect(out.text).toBe('')
  })
})

describe('openAiArguments', () => {
  it('objet → chaîne JSON ; chaîne JSON → telle quelle ; autre chaîne → encapsulée', () => {
    expect(openAiArguments({ name: 'f', args: { a: 1 } })).toBe('{"a":1}')
    expect(openAiArguments({ name: 'f', args: '{"a":1}' })).toBe('{"a":1}')
    expect(openAiArguments({ name: 'f', args: 'du texte' })).toBe('{"value":"du texte"}')
    expect(openAiArguments({ name: 'f', args: undefined })).toBe('{}')
  })
})
