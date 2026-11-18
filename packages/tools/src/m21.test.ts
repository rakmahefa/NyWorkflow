// M21 — no_tool : le garde-fou du contrat d'appels. L'outil signe une
// réponse finale sans action : validé sans approbation, exécuté comme un
// no-op honnête (résumé français journalisable, payload minimal), jamais
// dangereux. Vérifié aussi dans le registre : TOOL_NAMES le porte, la
// boucle du navigateur le déclare (e2e m21).
import { describe, expect, it } from 'vitest'
import { checkToolCall, executeToolCall, isDangerous, TOOL_NAMES } from './tools.ts'
import type { ToolCall } from './tools.ts'

const noTool = (args: Record<string, unknown> = {}): ToolCall => ({ tool: 'no_tool', args })

describe('no_tool — le pivot du contrat (M21)', () => {
  it('est déclaré dans le registre et jamais dangereux', () => {
    expect(TOOL_NAMES).toContain('no_tool')
    expect(isDangerous('no_tool')).toBe(false)
  })

  it('est validé sans approbation, avec ou sans reason', async () => {
    const bare = await checkToolCall('.', noTool())
    expect(bare.ok).toBe(true)
    expect(bare.approval).toBe(false)
    const titled = await checkToolCall('.', noTool({ title: 'Réponse finale', reason: 'ICM déjà chargé' }))
    expect(titled.ok).toBe(true)
    expect(titled.approval).toBe(false)
  })

  it('refuse une reason trop longue (max 200)', async () => {
    const res = await checkToolCall('.', noTool({ reason: 'x'.repeat(201) }))
    expect(res.ok).toBe(false)
    expect(res.refusal?.code).toBe('invalid_args')
    expect(res.refusal?.summary).toContain('no_tool')
  })

  it("s'exécute comme un no-op honnête : ok, résumé français, payload signé", async () => {
    const out = await executeToolCall('.', noTool({ reason: 'La réponse vient de l’ICM' }), true)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.summary).toContain('no_tool')
      expect(out.summary).toContain('La réponse vient de l’ICM')
      expect(out.data).toEqual({ noTool: true, reason: 'La réponse vient de l’ICM' })
    }
  })

  it('garde un résumé parlant sans reason', async () => {
    const out = await executeToolCall('.', noTool(), true)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.summary).toContain('aucun outil ce tour')
  })
})
