import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M17 — le profilage devient OBSERVABLE dans l'UI, et le dossier de session
// se choisit avec la boîte de navigation NATIVE du navigateur :
//   - l'onglet Activité montre la RÉPONSE du modèle (protocole, titres du
//     thinking, extrait, tool calls) — plus seulement « une requête a eu
//     lieu » ;
//   - le quatuor DE LA SESSION (.logs/<id>/ dans son dossier) se lit dans
//     l'onglet Activité : model.jsonl — les réponses du modèle de CETTE
//     session — n'était lisible que sur disque jusqu'ici ;
//   - le bouton « Explorer… » du sélecteur de dossier ouvre la boîte de
//     navigation du navigateur (File System Access API) ; le nom choisi
//     est résolu en chemin serveur par /workspaces/locate (l'API web cache
//     le chemin — le nom est tout ce qu'elle donne) ;
//   - /workspaces/locate répond honnêtement : trouvé par nom, zéro sinon,
//     400 sur les entrées invalides.

test('activité : la RÉPONSE du modèle et le quatuor de la session, dans l’onglet', async ({ page }) => {
  await page.goto('/')
  const title = `M17 profilage ${Date.now()}`
  await newSessionViaDialog(page, title)

  // Un tour simple — la maquette répond sans outil : thinking titré + texte.
  const box = page.getByLabel('Message')
  await box.fill('présente-moi le projet')
  await box.press('Enter')
  await expect(page.locator('.msg.assistant').last()).toContainText("NyWorkflow charge l'ICM", { timeout: 10_000 })

  // L'onglet Activité porte la réponse, pas seulement la requête.
  await page.locator('[data-test="tab-activity"]').click()
  // M18 : le tour est replié d'office — on le déplie pour lire la requête.
  const turn = page.locator('[data-test="act-turn"]').first()
  await expect(turn).toBeVisible()
  await turn.locator('.turn-head').click()
  const req = page.locator('[data-test="act-request"]').first()
  await expect(req).toBeVisible()
  await req.locator('.act-head').click()
  await expect(req.locator('.act-body')).toContainText('Protocole')
  await expect(req.locator('.act-body')).toContainText('thinking d’abord')
  // M22 — les cinq phases dans la carte : listing no_tool, message en-têté.
  await expect(req.locator('.act-body')).toContainText('Phase 2 — Listing annoncé')
  await expect(req.locator('.act-body')).toContainText('Phase 3 — Message')

  // Le quatuor DE LA SESSION — model.jsonl inclus, lisible sur place.
  await expect(page.locator('[data-test="session-logs"]')).toBeVisible()
  await expect(page.locator('[data-test="session-logs-row"]')).toHaveCount(4)
  await page.waitForTimeout(400) // le journal s'écrit en fire-and-forget
  await page.locator('[data-test="session-logs-row"]').filter({ hasText: 'model.jsonl' }).getByRole('button', { name: 'Voir' }).click()
  const tail = page.locator('[data-test="session-log-tail"]')
  await expect(tail).toBeVisible()
  await expect(tail).toContainText('model.response')
})

test('Explorer : la boîte de navigation native, résolue en chemin serveur', async ({ page }) => {
  // La maquette du sélecteur natif : l'API existe (le bouton apparaît) et
  // « l'utilisateur » choisit le dossier exemple-agentique. La vraie boîte
  // de dialogue ne peut pas être pilotée par Playwright — le pont, lui,
  // (locate → résolution → remplissage) est testé de bout en bout.
  await page.addInitScript(() => {
    window.showDirectoryPicker = () => Promise.resolve({ name: 'exemple-agentique' })
  })
  await page.goto('/')
  const title = `M17 explorer ${Date.now()}`
  await page.getByLabel('Message').fill(`/new ${title}`)
  await page.getByLabel('Message').press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await expect(dialog).toBeVisible()

  // L'onglet « Dossier du disque » porte le bouton Explorer (API détectée).
  await page.locator('[data-test="ws-mode-folder"]').click()
  const explorer = page.locator('[data-test="folder-explorer"]')
  await expect(explorer).toBeVisible()
  await expect(page.locator('[data-test="folder-explorer-unsupported"]')).toHaveCount(0)

  // Un clic : la boîte (maquettée) rend le nom, locate le résout — un seul
  // candidat, le chemin se remplit tout seul, la confirmation le dit.
  await explorer.click()
  await expect(page.locator('[data-test="folder-picked"]')).toBeVisible({ timeout: 10_000 })
  const pathValue = await page.locator('[data-test="folder-path-input"]').inputValue()
  expect(pathValue).toContain('exemple-agentique')
})

test('locate : un dossier trouvé par son nom, zéro candidat sinon, 400 sur l’ invalide', async ({ request }) => {
  const found = await request.get('/workspaces/locate?name=exemple-agentique')
  expect(found.ok()).toBeTruthy()
  const body = await found.json()
  expect(body.candidates.length).toBeGreaterThanOrEqual(1)
  expect(body.candidates[0]).toContain('exemple-agentique')

  const none = await request.get('/workspaces/locate?name=ce-dossier-nexiste-pas-m17')
  expect(none.ok()).toBeTruthy()
  expect((await none.json()).candidates).toEqual([])

  const invalid = await request.get('/workspaces/locate?name=a%2Fb')
  expect(invalid.status()).toBe(400)
})
