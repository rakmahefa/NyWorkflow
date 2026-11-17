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
    const prompt = messagesToPrompt([{ role: 'tool', content: 'résultat' }, null, { role: 'user', content: 'ok' }]) as string
    expect(prompt).toContain('résultat')
    expect(prompt).toContain('ok')
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
