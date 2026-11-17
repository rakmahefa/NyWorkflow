import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// La maquette SSE (mock-gateway.mjs) est démarrée pour toute la session
// par e2e/global-setup.mjs (port 9801) ; playwright.config.ts oriente le
// serveur web vers elle via W2A_URL. L'app parle à la maquette en v1beta
// (M11) — c'est ce namespace qui est servi et vérifié ici.

test('affiche l’app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'NyWorkflow' })).toBeVisible()
  await expect(page.getByPlaceholder(/Écrivez un message/)).toBeVisible()
})

test('sessions : bouton → dialogue, /new, /help, /clear', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('[data-test="session-item"]')
  await expect(items.first()).toBeVisible()

  // Bouton : la boîte de dialogue s'ouvre (titre + workspace ICM).
  await page.locator('[data-test="new-session-btn"]').click()
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await expect(dialog).toBeVisible()
  await page.locator('[data-test="dialog-cancel-btn"]').click()
  await expect(dialog).toHaveCount(0)

  // /new avec titre unique — les journaux survivent aux runs précédents,
  // aucune assertion absolue de comptage.
  const box = page.getByLabel('Message')
  const titre = `Démo ICM ${Date.now()}`
  await newSessionViaDialog(page, titre)
  await expect(page.locator('.msg.system').last()).toContainText(`Session « ${titre} » créée`)

  await box.fill('/help')
  await box.press('Enter')
  await expect(page.locator('.msg.system').last()).toContainText('/new')
  await expect(page.locator('.msg.system').last()).toContainText('/delete')

  await box.fill('/clear')
  await box.press('Enter')
  await expect(page.locator('.msg')).toHaveCount(1)
  await expect(page.locator('.msg.system').last()).toContainText('effacé')
})

test('passerelle présente : v1beta par défaut, modèles Google parsés, streaming réel', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('[data-test="gateway-status"]')).toHaveAttribute('data-state', 'up')
  const select = page.locator('[data-test="model-select"]')
  await expect(select).not.toBeDisabled()
  await expect(select).toHaveValue('gemini-2.5-flash') // forme Google /v1beta/models décodée

  // Change de modèle puis envoie : la maquette doit recevoir le bon id —
  // sur /v1beta/chat/completions, le namespace par défaut de l'app.
  await select.selectOption('gemini-2.5-pro')
  const box = page.getByLabel('Message')
  const marker = `Ping ${Date.now()}`
  await newSessionViaDialog(page, marker)
  await box.fill('ping')
  await box.press('Enter')

  await expect(page.locator('.msg.user')).toContainText('ping')
  await expect(page.locator('.msg.assistant').last()).toContainText('Réponse (maquette) [gemini-2.5-pro] : ping', {
    timeout: 10_000,
  })
  // Le curseur de streaming disparaît à la fin du flux.
  await expect(page.locator('.caret')).toHaveCount(0)
})

test('erreur passerelle sur envoi : message système clair, pas de message vide', async ({ page }) => {
  // La page coupe ce seul endpoint (le namespace v1beta de l'app) ; le
  // listing reste normal.
  await page.route('**/api/v1beta/chat/completions', (route) =>
    route.fulfill({ status: 500, body: 'boom' }),
  )
  await page.goto('/')

  await expect(page.locator('[data-test="gateway-status"]')).toHaveAttribute('data-state', 'up')

  // Session neuve pour l'occasion : l'état des autres tests ne compte pas.
  const box = page.getByLabel('Message')
  await newSessionViaDialog(page, `Erreur test ${Date.now()}`)

  await box.fill('hello')
  await box.press('Enter')

  await expect(page.locator('.msg.system').last()).toContainText('Erreur passerelle', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant')).toHaveCount(0)
})
