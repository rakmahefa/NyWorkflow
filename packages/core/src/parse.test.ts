import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseStageContract, parseWorkspace } from './parse.ts'
import type { ParsedTableRow } from './parse.ts'

// Le vrai workspace d'exemple, tel que livré dans le repo.
const EXAMPLE = join(import.meta.dirname, '../../../examples/workspaces/exemple-rapport')

const roots: string[] = []

function tmpWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nyw-parse-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Un contrat d'étape minimal et valide, à modifier par variante. */
const CONTRACT = (body: string): string => `# Étape 01 — Test

## Entrées

| Source | Emplacement | Portion | Pourquoi |
|---|---|---|---|
${body}

## Process

1. Faire quelque chose.

## Sorties

| Artefact | Emplacement | Format |
|---|---|---|
| Fiche | \`output/faits.md\` | Markdown |
`

describe('parseWorkspace — exemple réel du repo', () => {
  it('deux étapes dans l’ordre, contrats complets, carte brute conservée', async () => {
    const ws = await parseWorkspace(EXAMPLE)
    expect(ws.stages.map((s) => s.stage)).toEqual(['01-recherche', '02-redaction'])
    expect(ws.map).toContain('rapport Markdown court')

    const recherche = ws.stages[0]
    expect(recherche?.title).toBe('Étape 01 — Recherche')
    expect(recherche?.process).toHaveLength(3)
    expect(recherche?.outputs).toEqual(['output/faits.md'])
    // Entrée non-fichier = le sujet ; entrée fichier = chemin relatif à la racine.
    expect(recherche?.inputs[0]).toMatchObject({ source: '', origin: 'Utilisateur', why: 'le sujet à traiter' })
    expect(recherche?.inputs[1]).toMatchObject({ source: 'CONTEXT.md', origin: 'Carte', scope: 'tableau des étapes' })

    const redaction = ws.stages[1]
    expect(redaction?.inputs[0]).toMatchObject({
      source: '01-recherche/output/faits.md',
      scope: 'full', // « fichier complet »
      origin: 'Étape précédente',
      why: 'matière du rapport',
    })
  })
})

describe('parseWorkspace — workspaces cassés, erreurs claires', () => {
  it('sans CONTEXT.md racine', async () => {
    const root = tmpWorkspace({ '01-a/CONTEXT.md': CONTRACT('| Sujet | question | — | parce que |') })
    await expect(parseWorkspace(root)).rejects.toThrow(/sans CONTEXT\.md racine/)
  })

  it('aucune étape numérotée', async () => {
    const root = tmpWorkspace({ 'CONTEXT.md': '# Carte\n', assets: '' } as Record<string, string>)
    // un dossier non numéroté n'est pas une étape — le readdir tolère un fichier absent
    await expect(parseWorkspace(root)).rejects.toThrow(/aucune étape numérotée/)
  })

  it('numéros en double', async () => {
    const root = tmpWorkspace({
      'CONTEXT.md': '# Carte\n',
      '01-a/CONTEXT.md': CONTRACT('| Sujet | question | — | x |'),
      '01-b/CONTEXT.md': CONTRACT('| Sujet | question | — | x |'),
    })
    await expect(parseWorkspace(root)).rejects.toThrow(/numéro d'étape en double/)
  })

  it('étape sans CONTEXT.md', async () => {
    const root = tmpWorkspace({ 'CONTEXT.md': '# Carte\n', '01-a/vide.md': 'rien' })
    await expect(parseWorkspace(root)).rejects.toThrow(/n'a pas de CONTEXT\.md/)
  })

  it('tri numérique : 2-… devant 10-…', async () => {
    const root = tmpWorkspace({
      'CONTEXT.md': '# Carte\n',
      '10-dix/CONTEXT.md': CONTRACT('| Sujet | question | — | x |'),
      '02-deux/CONTEXT.md': CONTRACT('| Sujet | question | — | x |'),
    })
    const ws = await parseWorkspace(root)
    expect(ws.stages.map((s) => s.stage)).toEqual(['02-deux', '10-dix'])
  })
})

describe('parseStageContract — garde-fous du format v1', () => {
  it('entrée hors workspace refusée', () => {
    expect(() => parseStageContract('01-a', CONTRACT('| Fuites | `../../etc/passwd` | full | non |'))).toThrow(
      /hors workspace/,
    )
  })

  it('sortie hors du dossier de l’étape refusée', () => {
    const raw = CONTRACT('| Sujet | question | — | x |').replace('`output/faits.md`', '`../ailleurs.md`')
    expect(() => parseStageContract('01-a', raw)).toThrow(/sortie hors du dossier/)
  })

  it('emplacement de sortie non backtické refusé', () => {
    const raw = CONTRACT('| Sujet | question | — | x |').replace('`output/faits.md`', 'output/faits.md')
    expect(() => parseStageContract('01-a', raw)).toThrow(/backticks attendu/)
  })

  it('deux entrées sans fichier (sujet) refusées', () => {
    const two = CONTRACT('| Sujet | question | — | x |\n| Autre | autre question | — | y |')
    expect(() => parseStageContract('01-a', two)).toThrow(/une seule entrée sans fichier/)
  })

  it('sans section Process : refus', () => {
    const raw = '# Étape\n\n## Sorties\n\n| Artefact | Emplacement | Format |\n|---|---|---|\n| F | `output/a.md` | MD |\n'
    expect(() => parseStageContract('01-a', raw)).toThrow(/Process/)
  })

  it('titre absent : repli sur le nom du dossier, portions spéciales → full', () => {
    const raw = CONTRACT('| Carte | `../CONTEXT.md` | fichier complet | x |').replace('# Étape 01 — Test\n', '')
    const c = parseStageContract('01-a', raw)
    expect(c.title).toBe('01-a')
    expect(c.inputs[0]?.scope).toBe('full')
    expect(c.inputs[0]?.source).toBe('CONTEXT.md')
  })
})

describe('parseStageContract — tolérances du format', () => {
  it('lignes hors table et séparateurs ignorés, cellules manquantes tolérées', () => {
    const raw = `# Étape 01

## Entrées

Une phrase d'introduction qui n'est pas une ligne de table.

| Source | Emplacement | Portion | Pourquoi |
|---|---|---|---|
| Carte | \`../CONTEXT.md\` | règles |

Texte libre après la table.

## Process

1. Étape une.
2. Étape deux.

## Sorties

| Artefact | Emplacement | Format |
|---|---|---|
| Fiche | \`output/faits.md\` | Markdown |
`
    const c = parseStageContract('01-a', raw)
    expect(c.inputs).toEqual([{ source: 'CONTEXT.md', scope: 'règles', origin: 'Carte', why: '' }])
    expect(c.process).toEqual(['1. Étape une.', '2. Étape deux.'])
  })
})

describe('ParsedTableRow — exported for reuse', () => {
  it('le type est utilisable depuis l’extérieur', () => {
    const row: ParsedTableRow = { cells: ['a', 'b'] }
    expect(row.cells).toHaveLength(2)
  })
})
