import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M11 — l'approbation d'outil, dans le flux du chat cette fois : l'agent
// demande un write (la maquette l'émet en tool_call standard), la carte
// s'affiche, l'humain décide DANS l'UI — approuvé : le fichier existe sur
// disque et la boucle reprend ; refusé : rien n'est écrit et l'agent
// continue sans l'écriture. Tout est journalisé, visible après rechargement.

const OUT_FILE = join(import.meta.dirname, '../../../examples/workspaces/exemple-agentique/outputs/agent-e2e.md')

test.afterAll(() => {
  rmSync(OUT_FILE, { force: true })
})

test('write approuvé : fichier écrit, boucle reprise, décision journalisée', async ({ page }) => {
  await page.goto('/')
  const title = `Approuve ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTECRIT écris le livrable de test')
  await box.press('Enter')

  // La carte d'approbation apparaît (write en pause), composer verrouillé.
  const card = page.locator('[data-test="approval-card"]')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText('write')
  await expect(card).toContainText('outputs/agent-e2e.md')
  await expect(box).toBeDisabled()

  // Rien n'est écrit avant la décision.
  expect(existsSync(OUT_FILE)).toBe(false)

  // Approbation : exécution, ligne d'outil réglée, réponse finale.
  await card.locator('[data-test="approve-btn"]').click()
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('[data-test="tool-row"]', { hasText: 'write' }).first()).toHaveAttribute('data-state', 'ok', {
    timeout: 10_000,
  })
  expect(readFileSync(OUT_FILE, 'utf8')).toBe('CONTENU AGENT E2E')
  await expect(page.locator('.msg.assistant').last()).toContainText('ECRITURE FAITE', { timeout: 10_000 })
  // Marge pour la journalisation du dernier message (POST /events en vol).
  await page.waitForTimeout(300)

  // Le tout survit à un rechargement (journal = vérité).
  await page.reload()
  await page.locator('[data-test="session-item"]').filter({ hasText: title }).click()
  await expect(page.locator('[data-test="tool-row"]', { hasText: 'write' }).first()).toHaveAttribute('data-state', 'ok')
  await expect(page.locator('.msg.assistant').last()).toContainText('ECRITURE FAITE')
})

test('write refusé : rien sur disque, l’agent continue sans l’écriture', async ({ page }) => {
  await page.goto('/')
  const title = `Refuse ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTECRIT tentative qui sera refusée')
  await box.press('Enter')

  const card = page.locator('[data-test="approval-card"]')
  await expect(card).toBeVisible({ timeout: 10_000 })

  await card.locator('[data-test="refuse-btn"]').click()
  await expect(card).toHaveCount(0, { timeout: 10_000 })

  // Refus journalisé (ligne d'outil en échec), réponse finale quand même.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'write' }).first()
  await expect(row).toHaveAttribute('data-state', 'err', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('ECRITURE FAITE', { timeout: 10_000 })
})
