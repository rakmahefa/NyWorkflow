import { expect, test } from '@playwright/test'
import { startMockGateway } from './mock-gateway.mjs'

// Ces tests supposent la maquette SSE (mock-gateway.mjs) sur 9801 ;
// playwright.config.ts oriente le serveur web vers elle via W2A_URL.
let mock = null

test.beforeAll(async () => {
  mock = await startMockGateway(9801)
})

test.afterAll(async () => {
  await mock?.close()
})

test('affiche l’app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'NyWorkflow' })).toBeVisible()
  await expect(page.getByPlaceholder(/Écrivez un message/)).toBeVisible()
})

test('sessions : bouton, /new, /help, /clear', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('[data-test="session-item"]')
  await expect(items).toHaveCount(1)

  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  await expect(items).toHaveCount(2)

  const box = page.getByLabel('Message')
  await box.fill('/new Démo ICM')
  await box.press('Enter')
  await expect(items).toHaveCount(3)
  await expect(items.filter({ hasText: 'Démo ICM' })).toBeVisible()
  await expect(page.locator('.msg.system').last()).toContainText('Session « Démo ICM » créée')

  await box.fill('/help')
  await box.press('Enter')
  await expect(page.locator('.msg.system').last()).toContainText('/new')

  await box.fill('/clear')
  await box.press('Enter')
  await expect(page.locator('.msg')).toHaveCount(1)
  await expect(page.locator('.msg.system').last()).toContainText('effacé')
})

test('passerelle présente : modèles chargés + streaming réel', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('[data-test="gateway-status"]')).toHaveAttribute('data-state', 'up')
  const select = page.locator('[data-test="model-select"]')
  await expect(select).not.toBeDisabled()
  await expect(select).toHaveValue('gemini-2.5-flash')

  // Change de modèle puis envoie : la maquette doit recevoir le bon id.
  await select.selectOption('gemini-2.5-pro')
  const box = page.getByLabel('Message')
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
  // La maquette répond 500 sur ce seul endpoint ; le listing reste normal.
  await page.route('**/api/v1/chat/completions', (route) =>
    route.fulfill({ status: 500, body: 'boom' }),
  )
  await page.goto('/')

  await expect(page.locator('[data-test="gateway-status"]')).toHaveAttribute('data-state', 'up')
  const box = page.getByLabel('Message')
  await box.fill('hello')
  await box.press('Enter')

  await expect(page.locator('.msg.system').last()).toContainText('Erreur passerelle', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant')).toHaveCount(0)
})
