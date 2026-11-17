import { expect, test } from '@playwright/test'

test('affiche l’app', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'NyWorkflow' })).toBeVisible()
  await expect(page.getByPlaceholder(/Écrivez un message/)).toBeVisible()
})

test('envoie un message et reçoit la réponse simulée (streaming)', async ({ page }) => {
  await page.goto('/')
  const box = page.getByLabel('Message')
  await box.fill('Bonjour M1')
  await box.press('Enter')

  await expect(page.locator('.msg.user')).toContainText('Bonjour M1')
  const reply = page.locator('.msg.assistant').last()
  await expect(reply).toContainText('Réponse simulée', { timeout: 10_000 })
  // The stream ends only when the last sentence is visible.
  await expect(reply).toContainText('gemini-web2api', { timeout: 10_000 })
})

test('sessions : bouton, /new, /help, /clear', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('[data-test="session-item"]')
  await expect(items).toHaveCount(1)

  // Button creates and switches to a new session.
  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  await expect(items).toHaveCount(2)

  // /new with a title.
  const box = page.getByLabel('Message')
  await box.fill('/new Démo ICM')
  await box.press('Enter')
  await expect(items).toHaveCount(3)
  await expect(items.filter({ hasText: 'Démo ICM' })).toBeVisible()
  await expect(page.locator('.msg.system').last()).toContainText('Session « Démo ICM » créée')

  // /help lists the commands.
  await box.fill('/help')
  await box.press('Enter')
  await expect(page.locator('.msg.system').last()).toContainText('/new')

  // /clear wipes the active session, leaving only the confirmation.
  await box.fill('/clear')
  await box.press('Enter')
  await expect(page.locator('.msg')).toHaveCount(1)
  await expect(page.locator('.msg.system').last()).toContainText('effacé')
})
