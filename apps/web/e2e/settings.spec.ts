import { expect, test } from '@playwright/test'

// Menu Paramètres (M8) : modale en trois sections — Apparence (thème
// persisté), Passerelle (diagnostic GET /api/), À propos. La maquette
// passerelle (global setup, port 9801) sert le diagnostic.

test('paramètres : ouverture, diagnostic passerelle, fermeture', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Paramètres' }).click()

  const panel = page.locator('[data-test="settings-panel"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Paramètres' })).toBeVisible()

  // Diagnostic : la maquette répond ok, modèle par défaut visible.
  const diag = page.locator('[data-test="gateway-diag"]')
  await expect(diag).toBeVisible()
  await expect(diag).toContainText('ok')
  await expect(diag).toContainText('gemini-2.5-flash')
  await expect(diag).toContainText('(maquette e2e)')

  // (Le journal amont est couvert par le test dédié ci-dessous — la maquette
  // est partagée par toute la session e2e, son état dépend des tests d'avant.)

  // Escape ferme.
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
})

test('paramètres : thème sombre appliqué et persisté au rechargement', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Paramètres' }).click()

  // Sombre explicite : l'attribut data-theme apparaît sur <html>.
  await page.locator('[data-test="theme-dark"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('[data-test="theme-dark"]')).toHaveAttribute('data-active', 'true')

  // Persisté : le rechargement garde le choix (localStorage).
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  // Retour à Auto : l'attribut disparaît (préférence système reprend).
  await page.getByRole('button', { name: 'Paramètres' }).click()
  await page.locator('[data-test="theme-auto"]').click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')

  // Clair explicite : l'attribut light apparaît, même en système sombre.
  await page.locator('[data-test="theme-light"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('paramètres : journal amont peuplé après un tour réel', async ({ page }) => {
  await page.goto('/')

  // Session dédiée (marqueur unique) : les specs tournent en parallèle sur CI
  // et partagent les journaux — jamais de message dans « la session active »
  // qui peut être celle d'un autre test (leçon M3).
  const marker = `Journal ${Date.now()}`
  const box = page.getByLabel('Message')
  await box.fill(`/new ${marker}`)
  await box.press('Enter')
  await expect(page.locator('[data-test="session-item"]').filter({ hasText: marker })).toBeVisible()

  // Un tour réel via la maquette (streaming).
  await box.fill('Présente NyWorkflow')
  await box.press('Enter')
  await expect(page.locator('.msg.assistant').last()).toContainText('NyWorkflow orchestre', { timeout: 10_000 })

  // Le journal affiche le tour réussi (et l'échec ancien typé de la maquette).
  await page.getByRole('button', { name: 'Paramètres' }).click()
  const journal = page.locator('[data-test="gateway-journal"]')
  await expect(journal).toBeVisible()
  await expect(journal.locator('[data-test="journal-row"]')).toHaveCount(2)
  await expect(journal).toContainText('authentication')
  await expect(journal).toContainText('ok')
})

test('paramètres : sessions /u/N par compte, expiration vue d’avance, stats par compte', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Paramètres' }).click()

  // Table Comptes & sessions : /u/N par compte, libellés du manifeste.
  const accounts = page.locator('[data-test="gateway-accounts"]')
  await expect(accounts).toBeVisible()
  await expect(accounts.locator('[data-test="account-row"]')).toHaveCount(2)
  await expect(accounts).toContainText('Perso')
  await expect(accounts).toContainText('Pro')
  await expect(accounts).toContainText('/u/0')
  await expect(accounts).toContainText('/u/1')

  // Expiration : le compte Perso porte une date (warn/ok selon J-12), le compte
  // Pro est expiré depuis 3 j — le pilote le voit AVANT le 401.
  await expect(accounts).toContainText('expiré depuis 3 j')

  // La session effective du compte actif apparaît dans le diagnostic.
  const diag = page.locator('[data-test="gateway-diag"]')
  await expect(diag).toContainText('Session')
  await expect(diag).toContainText('/u/0')

  // Statistiques par compte : tours, réussites, échecs, dernier tour.
  const usage = page.locator('[data-test="gateway-usage"]')
  await expect(usage).toBeVisible()
  await expect(usage.locator('[data-test="usage-row"]')).toHaveCount(1)
  await expect(usage).toContainText('Perso')
  await expect(usage).toContainText('2') // tours
})

test('paramètres : clic sur l\'overlay ferme, pas sur la modale', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Paramètres' }).click()
  const panel = page.locator('[data-test="settings-panel"]')
  await expect(panel).toBeVisible()

  // Un clic dans la modale ne ferme pas.
  await panel.click({ position: { x: 10, y: 10 } })
  await expect(panel).toBeVisible()

  // Un clic sur l'overlay (le bouton fermer) ferme.
  await page.locator('[data-test="settings-close"]').click()
  await expect(panel).not.toBeVisible()
})
