import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildIcmSystemPrompt,
  loadIcm,
  renderTree,
  scaffoldAgenticWorkspace,
  scaffoldContext,
  walkTree,
  workspaceName,
  SCAFFOLD_FOLDERS,
  CONTEXT_MAX_CHARS,
} from './index.ts'

// M11 — le pivot ICM : l'arbre libre chargé vers le modèle, les CONTEXT.md
// lus racine d'abord, le prompt système assemblé, et le scaffold agentique.

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nyw-icm-'))
  dirs.push(d)
  return d
}

describe('workspaceName', () => {
  it('le nom du dossier, sans séparateur final', () => {
    expect(workspaceName('/tmp/mon-ws')).toBe('mon-ws')
    expect(workspaceName('mon-ws/')).toBe('mon-ws')
    expect(workspaceName('mon-ws')).toBe('mon-ws')
  })
})

describe('walkTree + renderTree', () => {
  it('dossiers d’abord puis fichiers, chaque groupe alphabétique, connecteurs', async () => {
    const root = tmp()
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, 'inbox'))
    writeFileSync(join(root, 'CONTEXT.md'), '# Carte')
    writeFileSync(join(root, 'a.txt'), 'A')
    writeFileSync(join(root, 'notes', 'plan.md'), 'PLAN')
    writeFileSync(join(root, 'inbox', '.gitkeep'), '')

    const { entries, truncated } = await walkTree(root)
    expect(truncated).toBe(false)
    expect(entries).toEqual([
      { path: 'inbox', dir: true },
      { path: 'inbox/.gitkeep', dir: false },
      { path: 'notes', dir: true },
      { path: 'notes/plan.md', dir: false },
      { path: 'a.txt', dir: false },
      { path: 'CONTEXT.md', dir: false },
    ])

    expect(renderTree(entries)).toBe(
      ['inbox/', '├── .gitkeep', 'notes/', '├── plan.md', 'a.txt', 'CONTEXT.md'].join('\n'),
    )
  })

  it('dossiers cachés et poubelles sautés, .gitkeep et dotfiles gardés', async () => {
    const root = tmp()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'outputs'))
    writeFileSync(join(root, '.git', 'HEAD'), 'x')
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'x')
    writeFileSync(join(root, 'outputs', '.gitkeep'), '')
    writeFileSync(join(root, '.env.local'), 'SECRET=1')

    const { entries } = await walkTree(root)
    expect(entries.map((e) => e.path)).toEqual(['outputs', 'outputs/.gitkeep', '.env.local'])
  })

  it('arbre vide et troncature honnête', () => {
    expect(renderTree([])).toBe('(arbre vide)')
    const many = Array.from({ length: 3 }, (_, i) => ({ path: `d${i}`, dir: true }))
    expect(renderTree(many, true)).toContain('arbre tronqué')
  })
})

describe('loadIcm', () => {
  it('arbre + CONTEXT.md racine d’abord, puis imbriqués en ordre de chemin', async () => {
    const root = tmp()
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, 'research', 'ddg'), { recursive: true })
    writeFileSync(join(root, 'CONTEXT.md'), '# Racine')
    writeFileSync(join(root, 'notes', 'CONTEXT.md'), '# Notes')
    writeFileSync(join(root, 'research', 'CONTEXT.md'), '# Recherche')
    writeFileSync(join(root, 'research', 'ddg', 'CONTEXT.md'), '# DDG')

    const icm = await loadIcm(root)
    expect(icm.name).toBe(root.split('/').pop() as string)
    expect(icm.tree).toContain('CONTEXT.md')
    expect(icm.contexts.map((c) => c.path)).toEqual(['', 'notes/CONTEXT.md', 'research/CONTEXT.md', 'research/ddg/CONTEXT.md'])
    expect(icm.contexts[0]?.content).toBe('# Racine')
  })

  it('workspace sans CONTEXT.md : valide, contexts vides', async () => {
    const root = tmp()
    writeFileSync(join(root, 'fichier.md'), 'contenu')
    const icm = await loadIcm(root)
    expect(icm.contexts).toEqual([])
    expect(icm.tree).toContain('fichier.md')
  })

  it('un CONTEXT.md géant est tronqué au plafond, avec marqueur', async () => {
    const root = tmp()
    writeFileSync(join(root, 'CONTEXT.md'), 'x'.repeat(CONTEXT_MAX_CHARS + 5_000))
    const icm = await loadIcm(root)
    expect(icm.contexts[0]?.content).toContain(`tronqué à ${CONTEXT_MAX_CHARS} caractères`)
    expect((icm.contexts[0]?.content.length ?? 0)).toBeLessThanOrEqual(CONTEXT_MAX_CHARS + 100)
  })
})

describe('buildIcmSystemPrompt', () => {
  it('porte la méthode, l’arbre, les CONTEXT.md et les conventions', async () => {
    const root = tmp()
    mkdirSync(join(root, 'outputs'))
    writeFileSync(join(root, 'CONTEXT.md'), '# Mission loutres')
    writeFileSync(join(root, 'outputs', '.gitkeep'), '')

    const prompt = buildIcmSystemPrompt(await loadIcm(root))
    expect(prompt).toContain('agent ICM')
    expect(prompt).toContain('Interpretable Context Methodology')
    expect(prompt).toContain('## Arborescence actuelle')
    expect(prompt).toContain('outputs/')
    expect(prompt).toContain('## CONTEXT.md racine')
    expect(prompt).toContain('# Mission loutres')
    expect(prompt).toContain('mkdir')
    expect(prompt).toContain('websearch')
  })

  it('workspace vierge : invite à écrire le CONTEXT.md', () => {
    const prompt = buildIcmSystemPrompt({ name: 'vierge', tree: '(arbre vide)', contexts: [] })
    expect(prompt).toContain('aucun — ce workspace est vierge')
    expect(prompt).toContain('CONTEXT.md')
  })
})

describe('scaffoldAgenticWorkspace', () => {
  it('crée la charte + les 4 dossiers + .gitkeep, arbre complet au premier ls', async () => {
    const parent = tmp()
    const root = join(parent, 'mon-agent')
    await scaffoldAgenticWorkspace(root)

    expect(existsSync(join(root, 'CONTEXT.md'))).toBe(true)
    for (const folder of SCAFFOLD_FOLDERS) {
      expect(existsSync(join(root, folder, '.gitkeep'))).toBe(true)
    }
    const charter = readFileSync(join(root, 'CONTEXT.md'), 'utf8')
    expect(charter).toContain('# mon-agent — workspace ICM agentique')
    expect(charter).toContain('## Mission')
    expect(charter).toContain('## Méthode ICM')
    expect(charter).toContain('## Arborescence')
    expect(charter).toContain('## Outils')
    expect(charter).toContain('## Règles')

    // L'ICM charge ce workspace fraîchement scaffoldé sans surprise.
    const icm = await loadIcm(root)
    expect(icm.tree).toContain('inbox/')
    expect(icm.tree).toContain('research/')
    expect(icm.contexts).toHaveLength(1)
    const prompt = buildIcmSystemPrompt(icm)
    expect(prompt).toContain('# mon-agent — workspace ICM agentique')
  })

  it('refuse un workspace existant — jamais d’écrasement', async () => {
    const root = tmp()
    await expect(scaffoldAgenticWorkspace(root)).rejects.toThrow(/existe déjà/)
    expect(existsSync(join(root, 'CONTEXT.md'))).toBe(false)
  })

  it('scaffoldContext : nom du workspace dans le titre', () => {
    expect(scaffoldContext('demo')).toContain('# demo — workspace ICM agentique')
  })
})
