import { expect, test } from '@playwright/test'

// La maquette SSE (mock-gateway.mjs) est démarrée pour toute la session
// par e2e/global-setup.mjs (port 9801) ; playwright.config.ts oriente le
// serveur web vers elle via W2A_URL.

test('affiche l’app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'NyWorkflow' })).toBeVisible()
  await expect(page.getByPlaceholder(/Écrivez un message/)).toBeVisible()
})

test('sessions : bouton, /new, /help, /clear', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('[data-test="session-item"]')
  await expect(items.first()).toBeVisible()

  // Bouton : session créée et active (vue = nouvelle session).
  // (le « + » est désormais une icône SVG — le nom accessible change)
  await page.getByRole('button', { name: 'Nouvelle session' }).click()
  await expect(page.locator('.msg.system').last()).toContainText('créée')

  // /new avec titre unique — les journaux survivent aux runs précédents,
  // aucune assertion absolue de comptage.
  const box = page.getByLabel('Message')
  const titre = `Démo ICM ${Date.now()}`
  await box.fill(`/new ${titre}`)
  await box.press('Enter')
  await expect(items.filter({ hasText: titre })).toBeVisible()
  await expect(page.locator('.msg.system').last()).toContainText(`Session « ${titre} » créée`)

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
  // Session dédiée (marqueur) : specs parallèles sur CI, journaux partagés —
  // le message ne doit jamais atterrir dans la session d'un autre test.
  await select.selectOption('gemini-2.5-pro')
  const box = page.getByLabel('Message')
  const marker = `Ping ${Date.now()}`
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()
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

  // Session neuve pour l'occasion : l'état des autres tests ne compte pas.
  const box = page.getByLabel('Message')
  await box.fill('/new Erreur test')
  await box.press('Enter')
  await expect(page.locator('.msg.system').last()).toContainText('Erreur test')

  await box.fill('hello')
  await box.press('Enter')

  await expect(page.locator('.msg.system').last()).toContainText('Erreur passerelle', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant')).toHaveCount(0)
})
