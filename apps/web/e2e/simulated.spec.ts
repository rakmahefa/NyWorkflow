import { expect, test } from '@playwright/test'

// Passerelle « absente » : chaque appel /api est coupé au niveau de la page.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort())
})

test('passerelle absente : message clair + repli simulé', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('[data-test="gateway-status"]')).toHaveAttribute('data-state', 'down')
  await expect(page.locator('[data-test="model-select"]')).toBeDisabled()
  await expect(page.locator('.msg.system').last()).toContainText('Passerelle webapi absente')

  // Session dédiée (marqueur) : specs parallèles sur CI, journaux partagés —
  // le message ne doit jamais atterrir dans la session d'un autre test.
  const marker = `Simulé ${Date.now()}`
  const box = page.getByLabel('Message')
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()

  await box.fill('Bonjour M2')
  await box.press('Enter')

  await expect(page.locator('.msg.assistant').last()).toContainText('Réponse simulée', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('Bonjour M2')
})
