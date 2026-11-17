import { describe, expect, it } from 'vitest'
import { stageStatuses, stateLabel } from './progress'
import type { RunStateDto } from './sessionApi'

const STAGES = [{ stage: '01-recherche' }, { stage: '02-redaction' }, { stage: '03-relecture' }]

describe('stageStatuses', () => {
  it('idle : rien n’est fini', () => {
    expect(stageStatuses(STAGES, { status: 'idle' })).toEqual(['pending', 'pending', 'pending'])
  })

  it('done : toutes les étapes sont faites', () => {
    expect(stageStatuses(STAGES, { status: 'done', stages: ['01-recherche', '02-redaction', '03-relecture'] })).toEqual([
      'done',
      'done',
      'done',
    ])
  })

  it('checkpoint : faites jusqu’à l’étape citée incluse, le reste à venir', () => {
    expect(stageStatuses(STAGES, { status: 'checkpoint', stage: '01-recherche' })).toEqual(['done', 'pending', 'pending'])
    expect(stageStatuses(STAGES, { status: 'checkpoint', stage: '02-redaction' })).toEqual(['done', 'done', 'pending'])
  })

  it('running / approval / error : l’étape citée est en cours, les précédentes faites', () => {
    for (const state of [
      { status: 'running', stage: '02-redaction' },
      { status: 'approval', stage: '02-redaction', tool: 'write', args: {} },
      { status: 'error', stage: '02-redaction', message: 'boom' },
    ] as RunStateDto['state'][]) {
      expect(stageStatuses(STAGES, state)).toEqual(['done', 'current', 'pending'])
    }
  })

  it('première étape en cours : rien avant elle', () => {
    expect(stageStatuses(STAGES, { status: 'running', stage: '01-recherche' })).toEqual(['current', 'pending', 'pending'])
  })

  it('étape inconnue : repli honnête, rien d’affiché comme fait', () => {
    expect(stageStatuses(STAGES, { status: 'checkpoint', stage: '99-absente' })).toEqual(['pending', 'pending', 'pending'])
    expect(stageStatuses(STAGES, { status: 'running', stage: '99-absente' })).toEqual(['pending', 'pending', 'pending'])
  })
})

describe('stateLabel', () => {
  it('couvre les six états', () => {
    expect(stateLabel({ status: 'idle' })).toBe('En attente')
    expect(stateLabel({ status: 'running', stage: '01-recherche' })).toBe('En cours')
    expect(stateLabel({ status: 'checkpoint', stage: '01-recherche' })).toBe('Checkpoint')
    expect(stateLabel({ status: 'done', stages: [] })).toBe('Terminé')
    expect(stateLabel({ status: 'error', stage: '01-recherche', message: 'boom' })).toBe('Erreur')
    expect(stateLabel({ status: 'approval', stage: '01-recherche', tool: 'write', args: {} })).toBe(
      'Approbation requise',
    )
  })
})
