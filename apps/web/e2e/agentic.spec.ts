import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M11 — la session ICM agentique, de bout en bout dans l'UI réelle contre
// la maquette passerelle (global-setup, port 9801) : la boîte de dialogue
// de création (titre + workspace), le bandeau ICM, la boucle agentique
// avec tool_calls standards (read auto, mkdir auto, write sous
// approbation), l'activité d'outils dans le flux du chat, et la
// suppression de session en deux temps.

const WS_DIR = join(import.meta.dirname, '../../../examples/workspaces/exemple-agentique')
const OUT_FILE = join(WS_DIR, 'outputs/agent-e2e.md')
const DIR = join(WS_DIR, 'research/e2e-dossier')

test.afterAll(() => {
  rmSync(OUT_FILE, { force: true })
  rmSync(DIR, { recursive: true, force: true })
})

test('nouvelle session : dialogue titre + workspace, bandeau ICM, session active', async ({ page }) => {
  await page.goto('/')
  const title = `Agent ICM ${Date.now()}`

  await newSessionViaDialog(page, title)

  // Le bandeau porte le workspace de la session — l'ICM est visible.
  await expect(page.locator('[data-test="ws-banner"]')).toContainText('exemple-agentique')
  // M12 : la sidebar groupe par workspace — la session vit dans son groupe.
  const group = page.locator('[data-test="ws-group"]', { hasText: 'exemple-agentique' })
  await expect(group).toBeVisible()
  await expect(group.locator('[data-test="session-item"]').filter({ hasText: title })).toBeVisible()
  // La confirmation système mentionne le chargement vers le modèle.
  await expect(page.locator('.msg.system').last()).toContainText('workspace « exemple-agentique » chargé vers le modèle')
})

test('boucle agentique : read auto-exécuté, puis réponse finale', async ({ page }) => {
  await page.goto('/')
  const title = `Lecture ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTLIT montre-moi la carte du workspace')
  await box.press('Enter')

  // La ligne d'outil apparaît (read, réglée), puis la réponse finale.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'read' }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toHaveAttribute('data-state', 'ok')
  await expect(page.locator('.msg.assistant').last()).toContainText('LIVRABLE FINAL AGENT', { timeout: 10_000 })
  // Le composer se réactive à la fin du tour.
  await expect(box).not.toBeDisabled()
})

test('boucle agentique : mkdir auto-exécuté — le modèle crée son arbre', async ({ page }) => {
  await page.goto('/')
  const title = `Dossier ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTDOSSIER prépare un dossier de recherche')
  await box.press('Enter')

  await expect(
    page.locator('[data-test="tool-row"]', { hasText: 'mkdir' }).first(),
  ).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('DOSSIER CRÉÉ', { timeout: 10_000 })
  expect(existsSync(DIR)).toBe(true)
})

test('suppression de session : deux temps, journal disparu, bascule propre', async ({ page }) => {
  await page.goto('/')
  const title = `À supprimer ${Date.now()}`
  await newSessionViaDialog(page, title)
  // Les boutons d'action (fork, suppression) vivent dans la rangée, à côté
  // de l'élément de session — pas dedans.
  const row = page.locator('.session-row').filter({ hasText: title })

  // Premier clic : la confirmation s'arme, rien n'est supprimé.
  await row.locator('[data-test="delete-btn"]').click()
  await expect(row.locator('[data-test="confirm-delete-btn"]')).toBeVisible()
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: title })).toHaveCount(1)

  // Annulation : tout reste en place.
  await row.locator('[data-test="cancel-delete-btn"]').click()
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: title })).toHaveCount(1)

  // Confirmation : la session disparaît du panneau ET du serveur.
  await row.locator('[data-test="delete-btn"]').click()
  await row.locator('[data-test="confirm-delete-btn"]').click()
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: title })).toHaveCount(0, {
    timeout: 10_000,
  })
  const gone = await page.request.get('/sessions')
  const sessions = (await gone.json()).sessions
  expect(sessions.filter((s: { title: string }) => s.title === title)).toHaveLength(0)
})
