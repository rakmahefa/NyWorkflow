import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// M5 — la boucle d'approbation, de bout en bout dans l'UI réelle : un run
// est créé et avancé (tools) via l'API same-origin, la maquette passerelle
// demande un write, l'étape se met en pause, et l'humain décide DANS l'UI —
// carte d'approbation, activité d'outils journalisée, écriture sur disque.

const WS = 'exemple-rapport'
const OUTPUT_DIR = join(import.meta.dirname, '../../../examples/workspaces/exemple-rapport/01-recherche/output')

test('un write en attente est approuvé depuis l’UI, l’étape reprend', async ({ page, request }) => {
  const marker = `E2E outils APPROVE2E ${Date.now()}`
  const subject = `${marker} — les loutres`

  // Le run naît côté serveur (comme en M4 — la vue workflow arrive en M6).
  const created = await request.post(`/workspaces/${WS}/runs`, {
    data: { subject },
  })
  expect(created.ok()).toBe(true)
  const run = await created.json()

  const advanced = await request.post(`/workspaces/${WS}/runs/${run.id}/advance`, {
    data: { model: 'gemini-2.5-flash', tools: true },
  })
  expect(advanced.ok()).toBe(true)
  const state = await advanced.json()
  expect(state.state).toEqual({
    status: 'approval',
    stage: '01-recherche',
    tool: 'write',
    args: { path: '01-recherche/output/notes-e2e.md', content: 'DES NOTES E2E OUTILS' },
  })

  // L'UI ouvre la session du run : la carte d'approbation est là.
  await page.goto('/')
  const item = page.locator('[data-test="session-item"]').filter({ hasText: marker })
  await expect(item).toBeVisible()
  await item.click()

  const card = page.locator('[data-test="approval-card"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('write')
  await expect(card).toContainText('01-recherche/output/notes-e2e.md')

  // L'appel en attente figure aussi dans l'activité d'outils.
  const pendingRow = page.locator('[data-test="tool-row"][data-ok="pending"]')
  await expect(pendingRow).toHaveCount(1)

  // Décision humaine : approuver — l'étape reprend jusqu'au checkpoint.
  await page.locator('[data-test="approve-btn"]').click()

  await expect(card).toHaveCount(0)
  const okRows = page.locator('[data-test="tool-row"][data-ok="ok"]')
  await expect(okRows.filter({ hasText: 'notes-e2e.md' })).toHaveCount(1)
  await expect(page.locator('.msg.system').last()).toContainText('approuvée')

  // Les deux écritures sont bien sur disque, dans le workspace d'exemple.
  expect(readFileSync(join(OUTPUT_DIR, 'notes-e2e.md'), 'utf8')).toBe('DES NOTES E2E OUTILS')
  expect(readFileSync(join(OUTPUT_DIR, 'faits.md'), 'utf8')).toBe('FICHE FINALE E2E')

  // L'état dérivé du journal : checkpoint après l'étape 1.
  const after = await request.get(`/workspaces/${WS}/runs/${run.id}`)
  expect((await after.json()).state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
})

test('refus depuis l’UI : rien n’est écrit, le modèle continue', async ({ page, request }) => {
  const marker = `E2E refus APPROVE2E ${Date.now()}`
  const subject = `${marker} — variante refusée`

  const created = await request.post(`/workspaces/${WS}/runs`, {
    data: { subject },
  })
  const run = await created.json()
  const advanced = await request.post(`/workspaces/${WS}/runs/${run.id}/advance`, {
    data: { model: 'gemini-2.5-flash', tools: true },
  })
  expect((await advanced.json()).state.status).toBe('approval')

  await page.goto('/')
  const item = page.locator('[data-test="session-item"]').filter({ hasText: marker })
  await expect(item).toBeVisible()
  await item.click()

  await expect(page.locator('[data-test="approval-card"]')).toBeVisible()
  await page.locator('[data-test="refuse-btn"]').click()

  await expect(page.locator('[data-test="approval-card"]')).toHaveCount(0)
  const refusedRows = page.locator('[data-test="tool-row"][data-ok="refused"]')
  await expect(refusedRows.filter({ hasText: "refusé par l'utilisateur" })).toHaveCount(1)
  await expect(page.locator('.msg.system').last()).toContainText('refusé')

  // La note refusée n'existe pas ; l'artefact final, oui.
  expect(readFileSync(join(OUTPUT_DIR, 'faits.md'), 'utf8')).toBe('FICHE FINALE E2E')
  const after = await request.get(`/workspaces/${WS}/runs/${run.id}`)
  expect((await after.json()).state).toEqual({ status: 'checkpoint', stage: '01-recherche' })
})
