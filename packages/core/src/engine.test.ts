import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRun, loadStageInputs, runStage, runStateFromEvents } from './engine.ts'
import { parseWorkspace } from './parse.ts'
import { assembleStageMessages } from './prompt.ts'
import type { StageChatMessage, StageLlm } from './prompt.ts'
import type { StageContract, Workspace } from './index'
import type { SessionEvent } from '@nyworkflow/session'

// Le vrai workspace d'exemple, copié dans un bac à sable (l'exécution écrit).
const EXAMPLE = join(import.meta.dirname, '../../../examples/workspaces/exemple-rapport')

const T1 = '2026-11-17T12:00:00.000Z'
const T2 = '2026-11-17T12:01:00.000Z'
const now = (): string => T1

const roots: string[] = []

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Copie l'exemple dans un temp dir et renvoie le workspace parsé. */
async function freshWorkspace(): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), 'nyw-engine-'))
  roots.push(dir)
  const target = join(dir, 'exemple-rapport')
  cpSync(EXAMPLE, target, { recursive: true })
  return parseWorkspace(target)
}

interface LlmCall {
  model: string
  messages: StageChatMessage[]
}

/** Un contrat d'étape par nom — échoue fort s'il est absent. */
function stage(ws: Workspace, name: string): StageContract {
  const contract = ws.stages.find((s) => s.stage === name)
  if (!contract) throw new Error(`étape absente : ${name}`)
  return contract
}

/** Maquette LLM : réponses en file, appels capturés, token par token. */
function fakeLlm(replies: string[], failures = 0): { llm: StageLlm; calls: LlmCall[] } {
  const calls: LlmCall[] = []
  let i = 0
  const llm: StageLlm = {
    async *chatStream(options) {
      calls.push({ model: options.model, messages: options.messages })
      if (calls.length <= failures) throw new Error('panne simulée de la passerelle')
      const text = replies[Math.min(i++, replies.length - 1)] ?? ''
      for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) yield chunk
    },
  }
  return { llm, calls }
}

const SUBJECT = 'Les loutres de Madagascar'

describe('loadStageInputs', () => {
  it('étape 1 : le sujet remplace l’entrée non-fichier, la carte est lue', async () => {
    const ws = await freshWorkspace()
    const recherche = stage(ws, '01-recherche')
    const loaded = await loadStageInputs(ws, recherche, SUBJECT)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.content).toBe(SUBJECT)
    expect(loaded[1]?.ref.source).toBe('CONTEXT.md')
    expect(loaded[1]?.content).toContain('rapport Markdown court')
  })

  it('sujet absent alors que le contrat l’attend : erreur claire', async () => {
    const ws = await freshWorkspace()
    await expect(loadStageInputs(ws, stage(ws, '01-recherche'))).rejects.toThrow(/attend le sujet/)
  })
})

describe('assembleStageMessages — pure', () => {
  it('assemble carte, sujet, entrées, process et sortie attendue', async () => {
    const ws = await freshWorkspace()
    const contract = stage(ws, '01-recherche')
    const loaded = await loadStageInputs(ws, contract, SUBJECT)
    const messages = assembleStageMessages({ workspace: 'exemple-rapport', contract, map: ws.map, loaded })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('exemple-rapport')
    const user = messages[1]?.content ?? ''
    expect(user).toContain('Les loutres de Madagascar')
    expect(user).toContain('## Carte du workspace')
    expect(user).toContain('## Process')
    expect(user).toContain('Décomposer le sujet')
    expect(user).toContain('output/faits.md')
  })
})

describe('runStage — une étape', () => {
  it('écrit la sortie, streame les tokens, émet les événements dans l’ordre', async () => {
    const ws = await freshWorkspace()
    const REPLY = '# Fiche de faits\n\n- Les loutres existent.'
    const { llm, calls } = fakeLlm([REPLY])
    const tokens: string[] = []
    const result = await runStage({
      workspace: ws,
      stage: '01-recherche',
      subject: SUBJECT,
      llm,
      model: 'gemini-test',
      onToken: (t) => tokens.push(t),
      now,
    })

    expect(result.outputs).toEqual(['01-recherche/output/faits.md'])
    expect(result.reply).toBe(REPLY)
    expect(tokens.join('')).toBe(REPLY)
    expect(existsSync(join(ws.root, '01-recherche/output/faits.md'))).toBe(true)

    expect(result.events).toEqual([
      { type: 'stage.started', at: T1, stage: '01-recherche' },
      { type: 'stage.output', at: T1, stage: '01-recherche', files: ['01-recherche/output/faits.md'] },
    ])

    // Le modèle reçoit le bon identifiant et le contexte assemblé.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('gemini-test')
    expect(calls[0]?.messages[1]?.content).toContain(SUBJECT)
    expect(calls[0]?.messages[1]?.content).toContain('output/faits.md')
  })

  it('chaînage : l’étape 2 lit la fiche — et sa version éditée par un humain', async () => {
    const ws = await freshWorkspace()
    const { llm, calls } = fakeLlm(['FICHE V1', 'RAPPORT FINAL'])
    await runStage({ workspace: ws, stage: '01-recherche', subject: SUBJECT, llm, model: 'm', now })

    // Un humain édite la fiche entre deux étapes (checkpoint).
    writeFileSync(join(ws.root, '01-recherche/output/faits.md'), 'FICHE ÉDITÉE PAR UN HUMAIN\n')

    await runStage({ workspace: ws, stage: '02-redaction', subject: SUBJECT, llm, model: 'm', now })
    const prompt2 = calls[1]?.messages[1]?.content ?? ''
    expect(prompt2).toContain('FICHE ÉDITÉE PAR UN HUMAIN')
    expect(prompt2).not.toContain('FICHE V1')
    expect(read(ws, '02-redaction/output/rapport.md')).toBe('RAPPORT FINAL')
  })

  it('entrée manquante : l’étape 2 sans étape 1 échoue avec un message clair', async () => {
    const ws = await freshWorkspace()
    const { llm } = fakeLlm(['peu importe'])
    await expect(
      runStage({ workspace: ws, stage: '02-redaction', llm, model: 'm', now }),
    ).rejects.toThrow(/entrée manquante : 01-recherche\/output\/faits\.md/)
  })

  it('réponse vide : rien n’est écrit', async () => {
    const ws = await freshWorkspace()
    const { llm } = fakeLlm([''])
    await expect(runStage({ workspace: ws, stage: '01-recherche', subject: SUBJECT, llm, model: 'm', now })).rejects.toThrow(
      /réponse vide/,
    )
    expect(existsSync(join(ws.root, '01-recherche/output/faits.md'))).toBe(false)
  })

  it('étape inconnue : refusée explicitement', async () => {
    const ws = await freshWorkspace()
    const { llm } = fakeLlm(['x'])
    await expect(runStage({ workspace: ws, stage: '99-inexistante', llm, model: 'm', now })).rejects.toThrow(
      /étape inconnue/,
    )
  })

  it('une seule sortie par étape en v1 : contrat multi-sorties refusé', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nyw-engine-'))
    roots.push(root)
    mkdirSync(join(root, '01-a'), { recursive: true })
    writeFileSync(
      join(root, '01-a/CONTEXT.md'),
      `# Étape\n\n## Process\n\n1. Faire.\n\n## Sorties\n\n| Artefact | Emplacement | Format |\n|---|---|---|\n| A | \`output/a.md\` | MD |\n| B | \`output/b.md\` | MD |\n`,
    )
    writeFileSync(join(root, 'CONTEXT.md'), '# Carte\n')
    const ws = await parseWorkspace(root)
    const { llm } = fakeLlm(['x'])
    await expect(runStage({ workspace: ws, stage: '01-a', llm, model: 'm', now })).rejects.toThrow(
      /une seule sortie par étape/,
    )
  })
})

describe('createRun — checkpoints et reprise manuelle', () => {
  it('avance étape par étape : checkpoint après 01, done après 02', async () => {
    const ws = await freshWorkspace()
    const { llm } = fakeLlm(['FICHE', 'RAPPORT'])
    const events: SessionEvent[] = []
    const run = createRun({ workspace: ws, subject: SUBJECT, llm, model: 'm', onEvent: (e) => void events.push(e), now })

    expect(run.state()).toEqual({ status: 'idle' })
    await expect(run.advance()).resolves.toEqual({ status: 'checkpoint', stage: '01-recherche' })
    await expect(run.advance()).resolves.toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })
    expect(run.state()).toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })

    // Terminé : advance est un no-op, aucun nouvel événement.
    await expect(run.advance()).resolves.toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })

    expect(events.map((e) => e.type)).toEqual([
      'stage.started',
      'stage.output',
      'stage.started',
      'stage.output',
      'run.completed',
    ])
    expect(events[4]).toMatchObject({ type: 'run.completed', stages: ['01-recherche', '02-redaction'] })
    expect(existsSync(join(ws.root, '01-recherche/output/faits.md'))).toBe(true)
    expect(existsSync(join(ws.root, '02-redaction/output/rapport.md'))).toBe(true)
  })

  it('échec d’étape : état error puis retry au même endroit', async () => {
    const ws = await freshWorkspace()
    const { llm } = fakeLlm(['FICHE'], 1) // premier appel en échec
    const run = createRun({ workspace: ws, subject: SUBJECT, llm, model: 'm', now })

    await expect(run.advance()).rejects.toThrow(/panne simulée/)
    expect(run.state()).toMatchObject({ status: 'error', stage: '01-recherche' })

    // La reprise manuelle rejoue la même étape — et cette fois ça passe.
    await expect(run.advance()).resolves.toEqual({ status: 'checkpoint', stage: '01-recherche' })
  })

  it('reprise depuis un journal : seule l’étape inachevée s’exécute', async () => {
    const ws = await freshWorkspace()

    // Premier run : étape 1 seule, événements « journalisés ».
    const first = fakeLlm(['FICHE'])
    const journal: SessionEvent[] = []
    const run1 = createRun({
      workspace: ws,
      subject: SUBJECT,
      llm: first.llm,
      model: 'm',
      onEvent: (e) => void journal.push(e),
      now,
    })
    await run1.advance()

    // Redémarrage : nouveau run nourri du journal — seule l'étape 2 tourne.
    const second = fakeLlm(['RAPPORT'])
    const more: SessionEvent[] = []
    const run2 = createRun({
      workspace: ws,
      subject: SUBJECT,
      llm: second.llm,
      model: 'm',
      onEvent: (e) => void more.push(e),
      initialEvents: journal,
      now: () => T2,
    })
    expect(run2.state()).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    await expect(run2.advance()).resolves.toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })

    expect(second.calls).toHaveLength(1)
    expect(second.calls[0]?.messages[1]?.content).toContain('FICHE') // la fiche de l'étape 1
    expect(more.map((e) => e.type)).toEqual(['stage.started', 'stage.output', 'run.completed'])
    expect(read(ws, '02-redaction/output/rapport.md')).toBe('RAPPORT')
  })
})

describe('runStateFromEvents — l’état dérivé du journal', () => {
  it('journal vide → idle ; étape interrompue → idle (elle sera rejouée)', async () => {
    const ws = await freshWorkspace()
    expect(runStateFromEvents([], ws)).toEqual({ status: 'idle' })
    expect(runStateFromEvents([{ type: 'stage.started', at: T1, stage: '01-recherche' }], ws)).toEqual({
      status: 'idle',
    })
  })

  it('étape 1 sortie → checkpoint 01 ; étape 2 démarrée → toujours checkpoint 01', async () => {
    const ws = await freshWorkspace()
    const base: SessionEvent[] = [
      { type: 'stage.started', at: T1, stage: '01-recherche' },
      { type: 'stage.output', at: T1, stage: '01-recherche', files: ['01-recherche/output/faits.md'] },
    ]
    expect(runStateFromEvents(base, ws)).toEqual({ status: 'checkpoint', stage: '01-recherche' })
    expect(runStateFromEvents([...base, { type: 'stage.started', at: T2, stage: '02-redaction' }], ws)).toEqual({
      status: 'checkpoint',
      stage: '01-recherche',
    })
  })

  it('toutes les sorties sans run.completed → checkpoint final (crash avant complétion)', async () => {
    const ws = await freshWorkspace()
    const events: SessionEvent[] = [
      { type: 'stage.output', at: T1, stage: '01-recherche', files: ['x'] },
      { type: 'stage.output', at: T2, stage: '02-redaction', files: ['y'] },
    ]
    expect(runStateFromEvents(events, ws)).toEqual({ status: 'checkpoint', stage: '02-redaction' })
  })

  it('run.completed → done avec ses étapes', async () => {
    const ws = await freshWorkspace()
    const events: SessionEvent[] = [
      { type: 'stage.output', at: T1, stage: '01-recherche', files: ['x'] },
      { type: 'run.completed', at: T2, stages: ['01-recherche', '02-redaction'] },
    ]
    expect(runStateFromEvents(events, ws)).toEqual({ status: 'done', stages: ['01-recherche', '02-redaction'] })
  })

  it('les étapes d’un autre workspace sont ignorées', async () => {
    const ws = await freshWorkspace()
    const events: SessionEvent[] = [{ type: 'stage.output', at: T1, stage: '09-ailleurs', files: ['x'] }]
    expect(runStateFromEvents(events, ws)).toEqual({ status: 'idle' })
  })
})

function read(ws: { root: string }, rel: string): string {
  return readFileSync(join(ws.root, rel), 'utf8')
}
