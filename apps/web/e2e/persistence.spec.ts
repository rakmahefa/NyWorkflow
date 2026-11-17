import { expect, test } from '@playwright/test'

// Persistance M3 — assertions scopées par marqueurs uniques : la suite e2e
// partage un serveur web (et donc des journaux) entre fichiers parallèles,
// aucune assertion absolue de comptage.
// Pas de maquette passerelle ici : que le gateway soit up ou down, le chat
// est journalisé de la même façon (réponse réelle ou simulée).

test('rechargement : sessions et messages restaurés', async ({ page }) => {
  const marker = `Persist ${Date.now()}`
  const question = `Question unique ${Date.now()}`

  await page.goto('/')
  const box = page.getByLabel('Message')
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()

  await box.fill(question)
  await box.press('Enter')
  await expect(page.locator('.msg.user').last()).toContainText(question)
  // Fin du flux assistant + marge pour la journalisation (POST /events).
  await expect(page.locator('.caret')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(250)

  await page.reload()
  await page.locator('[data-test="session-item"]').filter({ hasText: marker }).click()
  await expect(page.locator('.msg.user').last()).toContainText(question)
  await expect(page.locator('.msg.assistant').last()).toBeVisible()
})

test('fork : la copie hérite de l’historique et vit sa vie', async ({ page }) => {
  const marker = `Fork ${Date.now()}`
  const q1 = `Première question ${Date.now()}`
  const q2 = `Suite dans le fork ${Date.now()}`

  await page.goto('/')
  const box = page.getByLabel('Message')
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()

  await box.fill(q1)
  await box.press('Enter')
  await expect(page.locator('.caret')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(250)

  // Fork de la session active.
  await page.locator('.session-row[data-active="true"] [data-test="fork-btn"]').click()
  const forkItem = page.locator('[data-test="session-item"]').filter({ hasText: `${marker} (fork)` })
  await expect(forkItem).toBeVisible()
  await expect(page.locator('.main-head h2')).toContainText('(fork)')

  // Le fork a hérité de l'historique (Q1 visible dans la copie).
  await expect(page.locator('.msg.user').last()).toContainText(q1)

  // Le fork vit sa vie : Q2 n'atterrit que chez lui.
  await box.fill(q2)
  await box.press('Enter')
  await expect(page.locator('.caret')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(250)

  await page.reload()
  await forkItem.click()
  await expect(page.locator('.msg.user')).toHaveCount(2)
  await expect(page.locator('.msg.user').last()).toContainText(q2)

  // La source, elle, n'a toujours que Q1 (nom exact : sans le suffixe « (fork) »).
  await page.getByRole('button', { name: marker, exact: true }).click()
  await expect(page.locator('.msg.user')).toHaveCount(1)
})

test('/clear vide l’affichage — le journal, lui, est conservé', async ({ page }) => {
  const marker = `Clear ${Date.now()}`

  await page.goto('/')
  const box = page.getByLabel('Message')
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()

  await box.fill('un message qui va disparaître de l’affichage')
  await box.press('Enter')
  await expect(page.locator('.caret')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(250)

  await box.fill('/clear')
  await box.press('Enter')
  await expect(page.locator('.msg')).toHaveCount(1) // il ne reste que la note système
  await expect(page.locator('.msg.system').last()).toContainText('journal conservé')

  // Rechargement : append-only — l'échange revient.
  await page.reload()
  await page.locator('[data-test="session-item"]').filter({ hasText: marker }).click()
  await expect(page.locator('.msg.user')).toHaveCount(1)
  await expect(page.locator('.msg.assistant')).toHaveCount(1)
})
