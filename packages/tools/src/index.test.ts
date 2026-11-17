import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveInScope } from './scope.ts'
import { checkToolCall, executeToolCall, refusedByUser } from './tools.ts'
import type { ToolCall } from './tools.ts'

// M5 — la preuve du milestone vit ici : un chemin hors périmètre est refusé
// (code out_of_scope), et le refus porte un résumé français journalisable.

const roots: string[] = []

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Un workspace en bac à sable : carte + une étape avec sortie. */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyw-tools-'))
  roots.push(dir)
  writeFileSync(join(dir, 'CONTEXT.md'), '# Carte\n', 'utf8')
  mkdirSync(join(dir, '01-recherche', 'output'), { recursive: true })
  writeFileSync(join(dir, '01-recherche', 'output', 'faits.md'), 'FICHE\n', 'utf8')
  return dir
}

const read = (path: string): ToolCall => ({ tool: 'read', args: { path } })
const write = (path: string, content: string): ToolCall => ({ tool: 'write', args: { path, content } })

describe('resolveInScope — la garde lexicale', () => {
  it('accepte un chemin relatif dans le workspace et le canonise', async () => {
    const root = sandbox()
    const s = await resolveInScope(root, '01-recherche/output/faits.md')
    expect(s.ok).toBe(true)
    expect(s.rel).toBe('01-recherche/output/faits.md')
  })

  it('accepte "." et les chemins avec segments redondants', async () => {
    const root = sandbox()
    expect((await resolveInScope(root, '.')).ok).toBe(true)
    expect((await resolveInScope(root, './CONTEXT.md')).rel).toBe('CONTEXT.md')
    expect((await resolveInScope(root, '01-recherche/../CONTEXT.md')).rel).toBe('CONTEXT.md')
  })

  it('refuse vide, absolu, antislash et échappement ..', async () => {
    const root = sandbox()
    expect((await resolveInScope(root, '')).code).toBe('empty')
    expect((await resolveInScope(root, '  ')).code).toBe('empty')
    expect((await resolveInScope(root, '/etc/passwd')).code).toBe('absolute')
    expect((await resolveInScope(root, 'C:\\Windows')).code).toBe('backslash')
    expect((await resolveInScope(root, '..')).code).toBe('escape')
    expect((await resolveInScope(root, '../voisin.txt')).code).toBe('escape')
    expect((await resolveInScope(root, '01-recherche/../../fuite')).code).toBe('escape')
  })

  it('refuse un symlink qui pointe hors du workspace (réel ou à créer)', async () => {
    const root = sandbox()
    const outside = mkdtempSync(join(tmpdir(), 'nyw-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'SECRET\n', 'utf8')

    // Dossier lié existant → refus au realpath.
    symlinkSync(outside, join(root, 'lien'))
    const existing = await resolveInScope(root, 'lien/secret.txt')
    expect(existing.ok).toBe(false)
    expect(existing.code).toBe('symlink-escape')

    // Fichier à créer DANS un dossier lié qui s'échappe → refus aussi.
    const intoLink = await resolveInScope(root, 'lien/nouveau.txt')
    expect(intoLink.ok).toBe(false)
    expect(intoLink.code).toBe('symlink-escape')
  })
})

describe('checkToolCall — validation avant exécution', () => {
  it('outil inconnu et arguments malformés : refusés avant tout', async () => {
    const root = sandbox()
    const unknown = await checkToolCall(root, { tool: 'shell' as ToolCall['tool'], args: {} })
    expect(unknown.ok).toBe(false)
    expect(unknown.refusal?.code).toBe('unknown_tool')
    expect(unknown.refusal?.summary).toMatch(/outil inconnu/)

    const noPath = await checkToolCall(root, read(''))
    expect(noPath.ok).toBe(false)
    expect(noPath.refusal?.code).toBe('invalid_args')

    const noContent = await checkToolCall(root, { tool: 'write', args: { path: 'a.md' } })
    expect(noContent.ok).toBe(false)
    expect(noContent.refusal?.code).toBe('invalid_args')
  })

  it('hors périmètre : refusé avec un résumé clair, sans approbation', async () => {
    const root = sandbox()
    const check = await checkToolCall(root, read('../../etc/passwd'))
    expect(check.ok).toBe(false)
    expect(check.approval).toBe(false)
    expect(check.refusal?.code).toBe('out_of_scope')
    expect(check.refusal?.summary).toMatch(/hors périmètre/)
  })

  it('write dans le workspace : valide mais approbation requise', async () => {
    const root = sandbox()
    const check = await checkToolCall(root, write('01-recherche/output/notes.md', 'Des notes'))
    expect(check.ok).toBe(true)
    expect(check.approval).toBe(true)
  })

  it('write hors workspace : refusé immédiatement, pas de pause', async () => {
    const root = sandbox()
    const check = await checkToolCall(root, write('../fuite.md', 'x'))
    expect(check.ok).toBe(false)
    expect(check.approval).toBe(false)
    expect(check.refusal?.code).toBe('out_of_scope')
  })
})

describe('executeToolCall — exécution et refus', () => {
  it('read : contenu renvoyé, résumé journalisable', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, read('CONTEXT.md'), true)
    expect(out).toMatchObject({ ok: true })
    if (out.ok) {
      expect(out.data).toMatchObject({ path: 'CONTEXT.md', content: '# Carte\n' })
      expect(out.summary).toMatch(/read « CONTEXT\.md » — \d+ caractères/)
    }
  })

  it('read un dossier ou un fichier absent : refus io_error', async () => {
    const root = sandbox()
    expect((await executeToolCall(root, read('01-recherche'), true)).ok).toBe(false)
    expect((await executeToolCall(root, read('absent.md'), true)).ok).toBe(false)
  })

  it('LA PREUVE : un read hors périmètre est refusé et descriptible', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, read('/etc/passwd'), true)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.code).toBe('out_of_scope')
      expect(out.summary).toBe('refusé (hors périmètre) : read « /etc/passwd » — chemin absolu interdit')
    }
  })

  it('write sans approbation : refus approval_required, rien n’est écrit', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, write('01-recherche/output/notes.md', 'Des notes'), false)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('approval_required')
  })

  it('write approuvé : écrit (dossiers créés au passage), résumé exact', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, write('01-recherche/output/notes/deep.md', 'Au fond'), true)
    expect(out).toMatchObject({ ok: true })
    expect(readFileSync(join(root, '01-recherche/output/notes/deep.md'), 'utf8')).toBe('Au fond')
  })

  it('ls : entrées triées avec leur nature ; racine par défaut', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, { tool: 'ls', args: {} }, true)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { entries: { name: string; dir: boolean }[] }
      expect(data.entries).toEqual([
        { name: '01-recherche', dir: true },
        { name: 'CONTEXT.md', dir: false },
      ])
    }
    const sub = await executeToolCall(root, { tool: 'ls', args: { path: '01-recherche' } }, true)
    expect(sub.ok).toBe(true)
    if (sub.ok) expect((sub.data as { entries: unknown[] }).entries.length).toBeGreaterThan(0)
  })

  it('glob : *, ** et ? — correspondances relatives à la racine', async () => {
    const root = sandbox()
    const star = await executeToolCall(root, { tool: 'glob', args: { pattern: '01-recherche/output/*.md' } }, true)
    expect(star.ok).toBe(true)
    if (star.ok) expect(star.data).toMatchObject({ matches: ['01-recherche/output/faits.md'] })

    const deep = await executeToolCall(root, { tool: 'glob', args: { pattern: '**/*.md' } }, true)
    expect(deep.ok).toBe(true)
    if (deep.ok) expect((deep.data as { matches: string[] }).matches).toContain('CONTEXT.md')

    const one = await executeToolCall(root, { tool: 'glob', args: { pattern: 'CONTEXT.??' } }, true)
    expect(one.ok).toBe(true)
    if (one.ok) expect((one.data as { matches: string[] }).matches).toEqual(['CONTEXT.md'])
  })

  it('refus par l’utilisateur : résumé dédié', () => {
    const r = refusedByUser(write('a.md', 'x'))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('refused_by_user')
    expect(r.summary).toBe("refusé par l'utilisateur : write « a.md »")
  })
})
