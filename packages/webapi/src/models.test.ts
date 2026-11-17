import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_MODEL, DEFAULT_MODEL_TABLE, UnknownModelError, listModelIds, loadModelTable, resolveModel, resolveModelStrict } from './models.ts'

describe('table par défaut', () => {
  it('contient les 8 modèles connus de l’interface Gemini', () => {
    expect(listModelIds(DEFAULT_MODEL_TABLE)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-thinking',
      'gemini-3.1-pro',
      'gemini-3.1-pro-enhanced',
      'gemini-auto',
      'gemini-3.5-flash-thinking-lite',
      'gemini-flash-lite',
    ])
  })

  it('le pro-enhanced porte ses cases extra (31 → 2, 80 → 3)', () => {
    expect(DEFAULT_MODEL_TABLE['gemini-3.1-pro-enhanced']).toEqual({ mode: 3, think: 4, extra: { 31: 2, 80: 3 } })
  })
})

describe('resolveModel (souple — côté client)', () => {
  it('résout le modèle par défaut', () => {
    expect(resolveModel(DEFAULT_MODEL, DEFAULT_MODEL_TABLE, DEFAULT_MODEL)).toMatchObject({ name: 'gemini-3.6-flash', mode: 1, think: 4 })
  })

  it('surcharge le niveau de réflexion via @think=', () => {
    expect(resolveModel('gemini-3.6-flash@think=2', DEFAULT_MODEL_TABLE, DEFAULT_MODEL)).toMatchObject({ name: 'gemini-3.6-flash', think: 2 })
  })

  it('borne @think>4 à 4', () => {
    expect(resolveModel('gemini-3.6-flash@think=9', DEFAULT_MODEL_TABLE, DEFAULT_MODEL).think).toBe(4)
  })

  it('rejette plusieurs suffixes @think=', () => {
    expect(() => resolveModel('a@think=1@think=2', DEFAULT_MODEL_TABLE, DEFAULT_MODEL)).toThrow(UnknownModelError)
  })

  it('modèle inconnu → repli sur le défaut (jamais d’échec silencieux côté client interne)', () => {
    expect(resolveModel('gpt-9', DEFAULT_MODEL_TABLE, DEFAULT_MODEL).name).toBe(DEFAULT_MODEL)
  })

  it('modèle inconnu et défaut inconnu → erreur', () => {
    expect(() => resolveModel('x', { 'gemini-3.6-flash': { mode: 1, think: 4 } }, 'inconnu')).toThrow(UnknownModelError)
  })
})

describe('resolveModelStrict (strict — côté serveur)', () => {
  it('rejette un modèle inconnu (l’API publique ne choisit pas à la place)', () => {
    expect(() => resolveModelStrict('gpt-9', DEFAULT_MODEL_TABLE, DEFAULT_MODEL)).toThrow(/Unknown model/)
  })

  it('accepte un modèle connu avec suffixe @think=', () => {
    expect(resolveModelStrict('gemini-3.1-pro@think=0', DEFAULT_MODEL_TABLE, DEFAULT_MODEL)).toMatchObject({ name: 'gemini-3.1-pro', think: 0 })
  })
})

describe('loadModelTable (data-driven)', () => {
  it('un fichier JSON remplace la table entière — le point anti-casseurs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nyw-models-'))
    try {
      const file = path.join(dir, 'models.json')
      writeFileSync(file, JSON.stringify({ 'gemini-4-flash': { mode: 1, think: 4 } }))
      const table = loadModelTable(file)
      expect(listModelIds(table)).toEqual(['gemini-4-flash'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fichier illisible ou vide → table par défaut, la passerelle démarre toujours', () => {
    expect(loadModelTable('/chemin/inconnu/models.json')).toBe(DEFAULT_MODEL_TABLE)
    const dir = mkdtempSync(path.join(tmpdir(), 'nyw-models-'))
    try {
      const file = path.join(dir, 'models.json')
      writeFileSync(file, '{}')
      expect(loadModelTable(file)).toBe(DEFAULT_MODEL_TABLE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
