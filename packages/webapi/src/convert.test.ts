import { describe, expect, it } from 'vitest'
import { contentText, messagesToPrompt, tokenEstimate, usage } from './convert.ts'

describe('messagesToPrompt', () => {
  it('chaque rôle porte son marqueur, joint par ligne vide', () => {
    const prompt = messagesToPrompt([
      { role: 'system', content: 'Tu es utile.' },
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Salut !' },
      { role: 'user', content: 'Va-t’en' },
    ])
    expect(prompt).toBe('[System instruction]: Tu es utile.\n\nBonjour\n\n[Assistant]: Salut !\n\nVa-t’en')
  })

  it('contenu multipart OpenAI aplati en texte', () => {
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'b' }])).toBe('a b')
  })

  it('contenu non texte (null, nombre) → chaîne vide', () => {
    expect(contentText(null)).toBe('')
    expect(contentText(42)).toBe('')
  })

  it('messages non objets et rôles inconnus ne cassent rien (rôle inconnu = texte nu)', () => {
    const prompt = messagesToPrompt([{ role: 'banana', content: 'résultat' }, null, { role: 'user', content: 'ok' }]) as string
    expect(prompt).toContain('résultat')
    expect(prompt).toContain('ok')
  })

  it('M10 — message tool : le résultat porte son marqueur', () => {
    const prompt = messagesToPrompt([{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '{"temp":12}' }]) as string
    expect(prompt).toContain('[Tool result]: {"temp":12}')
  })

  it('M10 — tool_calls assistant rendus dans la convention de blocs (le modèle se reconnaît)', () => {
    const prompt = messagesToPrompt([
      { role: 'user', content: 'Météo ?' },
      { role: 'assistant', content: 'Je regarde.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":12}' },
      { role: 'user', content: 'Merci' },
    ]) as string
    expect(prompt).toContain('[Assistant]: Je regarde.')
    expect(prompt).toContain('{{tool {"name":"get_weather","arguments":{"city":"Paris"}} }}')
    expect(prompt).toContain('[Tool result]: {"temp":12}')
    expect(prompt).toContain('Merci')
  })

  it('M10 — assistant avec tool_calls et contenu null : bloc seul, pas de marqueur vide', () => {
    const prompt = messagesToPrompt([{ role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: {} } }] }]) as string
    expect(prompt).toBe('{{tool {"name":"f","arguments":{}} }}')
    expect(prompt).not.toContain('[Assistant]:')
  })

  it('messages absent ou vide → prompt vide', () => {
    expect(messagesToPrompt(undefined)).toBe('')
    expect(messagesToPrompt([])).toBe('')
  })
})

describe('usage (estimation cohérente en non-ASCII)', () => {
  it('total = prompt + completion, en caractères / 4', () => {
    const u = usage('héllo wörld', 'réponse très élégante')
    expect(u.prompt_tokens).toBe(tokenEstimate('héllo wörld'))
    expect(u.total_tokens).toBe(u.prompt_tokens + u.completion_tokens)
  })
})
