import { describe, expect, it } from 'vitest'
import { buildGenerateResponse, generateCallChunk, generateFinalChunk, generateTextChunk, parseGenerateRequest, usageMetadata, v1betaModelInfo, callToText } from './v1beta.ts'
import { TOOLS_CLOSE, TOOLS_OPEN } from './tools.ts'

describe('v1betaModelInfo', () => {
  it('forme Google : models/<id>, méthodes supportées honnêtes', () => {
    expect(v1betaModelInfo('gemini-3.6-flash')).toEqual({
      name: 'models/gemini-3.6-flash',
      displayName: 'gemini-3.6-flash',
      description: 'Gemini served through the NyWorkflow webapi gateway',
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    })
  })
})

describe('parseGenerateRequest', () => {
  it('contents : user nu, model avec marqueur, roles joints', () => {
    const r = parseGenerateRequest({
      contents: [
        { role: 'user', parts: [{ text: 'Bonjour' }] },
        { role: 'model', parts: [{ text: 'Salut' }] },
        { role: 'user', parts: [{ text: 'Va-t’en' }] },
      ],
    })
    expect(r.prompt).toBe('Bonjour\n\n[Assistant]: Salut\n\nVa-t’en')
    expect(r.tools).toEqual([])
  })

  it('systemInstruction : chaîne directe ou {parts}', () => {
    const a = parseGenerateRequest({ systemInstruction: 'Sois bref.', contents: [{ role: 'user', parts: [{ text: 'ok' }] }] })
    expect(a.prompt).toBe('[System instruction]: Sois bref.\n\nok')
    const b = parseGenerateRequest({ systemInstruction: { parts: [{ text: 'Sois bref.' }] }, contents: [{ role: 'user', parts: [{ text: 'ok' }] }] })
    expect(b.prompt).toBe(a.prompt)
  })

  it('rôle system dans contents accepté aussi', () => {
    const r = parseGenerateRequest({ contents: [{ role: 'system', parts: [{ text: 'bref' }] }, { role: 'user', parts: [{ text: 'ok' }] }] })
    expect(r.prompt).toBe('[System instruction]: bref\n\nok')
  })

  it('historique d’outils : functionCall rendu en bloc, functionResponse en résultat', () => {
    const r = parseGenerateRequest({
      contents: [
        { role: 'user', parts: [{ text: 'Météo à Paris ?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 12 } } }] },
      ],
    })
    expect(r.prompt).toContain(`${TOOLS_OPEN} {"name":"get_weather","arguments":{"city":"Paris"}} ${TOOLS_CLOSE}`)
    expect(r.prompt).toContain('[Tool result get_weather]: {"temp":12}')
  })

  it('tools (functionDeclarations) → préambule de la convention', () => {
    const r = parseGenerateRequest({
      contents: [{ role: 'user', parts: [{ text: 'Météo ?' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Météo', parameters: { type: 'object' } }] }],
    })
    expect(r.prompt).toContain('[Tool calling]')
    expect(r.prompt).toContain('- get_weather: Météo')
    expect(r.prompt).toContain('Never invent tool results')
    expect(r.tools).toEqual([{ name: 'get_weather', description: 'Météo', parameters: { type: 'object' } }])
    expect(r.choice).toEqual({ kind: 'auto' })
  })

  it('toolConfig : NONE coupe, ANY sans liste = required, ANY avec liste = forcé', () => {
    const mk = (toolConfig: unknown): unknown => ({
      contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
      tools: [{ functionDeclarations: [{ name: 'f' }] }],
      toolConfig,
    })
    expect(parseGenerateRequest(mk({ functionCallingConfig: { mode: 'NONE' } })).choice).toEqual({ kind: 'none' })
    expect(parseGenerateRequest(mk({ functionCallingConfig: { mode: 'ANY' } })).choice).toEqual({ kind: 'required' })
    expect(parseGenerateRequest(mk({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } })).choice).toEqual({ kind: 'forced', name: 'f' })
    // forcé vers un outil NON déclaré → required (jamais d'appel fantôme)
    expect(parseGenerateRequest(mk({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['ghost'] } })).choice).toEqual({ kind: 'required' })
  })

  it('mode NONE : pas de préambule même avec des tools', () => {
    const r = parseGenerateRequest({
      contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
      tools: [{ functionDeclarations: [{ name: 'f' }] }],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    })
    expect(r.prompt).toBe('ok')
  })

  it('generationConfig accepté et ignoré (jamais d’erreur)', () => {
    const r = parseGenerateRequest({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 512 } })
    expect(r.prompt).toBe('ok')
  })

  it('rejets clairs : sans contents, tools malformés', () => {
    expect(() => parseGenerateRequest({})).toThrow(/contents/)
    expect(() => parseGenerateRequest({ contents: [] })).toThrow(/contents/)
    expect(() => parseGenerateRequest({ contents: [{ role: 'user', parts: [{ text: 'ok' }] }], tools: [{ functionDeclarations: 'nope' }] })).toThrow(/functionDeclarations/)
    expect(() => parseGenerateRequest({ contents: 'nope' })).toThrow(/contents/)
  })
})

describe('builders de réponse', () => {
  it('buildGenerateResponse : texte seul, appels seuls, mixte', () => {
    const textOnly = buildGenerateResponse('m', 'Bonjour', [], 'prompt') as { candidates: any[]; usageMetadata: any; modelVersion: string }
    expect(textOnly.candidates).toEqual([{ content: { role: 'model', parts: [{ text: 'Bonjour' }] }, finishReason: 'STOP', index: 0 }])
    expect(textOnly.modelVersion).toBe('m')
    expect(textOnly.usageMetadata.totalTokenCount).toBe(textOnly.usageMetadata.promptTokenCount + textOnly.usageMetadata.candidatesTokenCount)

    const callOnly = buildGenerateResponse('m', '', [{ name: 'f', args: { a: 1 } }], 'p') as { candidates: any[] }
    expect(callOnly.candidates[0].content.parts).toEqual([{ functionCall: { name: 'f', args: { a: 1 } } }])

    const both = buildGenerateResponse('m', 'Voici', [{ name: 'f', args: {} }], 'p') as { candidates: any[] }
    expect(both.candidates[0].content.parts).toEqual([{ text: 'Voici' }, { functionCall: { name: 'f', args: {} } }])
  })

  it('chunks de stream : texte, appel, final (finishReason + usage)', () => {
    expect(generateTextChunk('ab')).toEqual({ candidates: [{ content: { role: 'model', parts: [{ text: 'ab' }] }, index: 0 }] })
    expect(generateCallChunk({ name: 'f', args: { x: 1 } })).toEqual({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] }, index: 0 }] })
    const final = generateFinalChunk('m', 'p', 'c') as { candidates: any[]; usageMetadata: any; modelVersion: string }
    expect(final.candidates[0].finishReason).toBe('STOP')
    expect(final.usageMetadata).toEqual(usageMetadata('p', 'c'))
    expect(final.modelVersion).toBe('m')
  })

  it('usageMetadata : estimation cohérente (total = entrée + sortie)', () => {
    const u = usageMetadata('héllo', 'wörld')
    expect(u.totalTokenCount).toBe(u.promptTokenCount + u.candidatesTokenCount)
  })

  it('callToText : la convention exacte du préambule', () => {
    expect(callToText({ name: 'f', args: { a: 1 } })).toBe(`${TOOLS_OPEN} {"name":"f","arguments":{"a":1}} ${TOOLS_CLOSE}`)
  })
})
