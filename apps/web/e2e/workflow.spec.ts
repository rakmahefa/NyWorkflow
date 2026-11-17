import { cpSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// M6 — la vue workflow, de bout en bout dans l'UI réelle : un workspace
// dédié (copie de l'exemple, créée puis supprimée par ce fichier — aucun
// risque de course avec les autres specs qui écrivent dans exemple-rapport),
// un run créé depuis l'UI, les étapes qui s'allument au fil des checkpoints,
// la prévisualisation des sorties lue sur disque, et la boucle d'approbation
// d'un write rejouée depuis la vue. Zéro curl : tout se joue au clic.

const SOURCE = join(import.meta.dirname, '../../../examples/workspaces/exemple-rapport')
const WS = 'e2e-vue-workflow'
const WS_DIR = join(import.meta.dirname, '../../../examples/workspaces', WS)

test.beforeAll(() => {
  cpSync(SOURCE, WS_DIR, { recursive: true })
  // Sorties à neuf : la progression se lit sur le run, le disque repart vide.
  for (const stage of ['01-recherche', '02-redaction']) {
    const out = join(WS_DIR, stage, 'output')
    for (const f of readdirSync(out)) {
      if (f !== '.gitkeep') rmSync(join(out, f), { recursive: true, force: true })
    }
  }
})

test.afterAll(() => {
  rmSync(WS_DIR, { recursive: true, force: true })
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // La maquette passerelle (global setup) doit être détectée : le sélecteur
  // de modèles pilote l'exécution des étapes.
  await page.locator('[data-test="gateway-status"][data-state="up"]').waitFor()
  await page.locator('[data-test="tab-workflows"]').click()
  const ws = page.locator('[data-test="workspace-item"]', { hasText: WS })
  await expect(ws).toBeVisible()
  await ws.click()
})

test('un run créé dans l’UI traverse ses étapes, la progression et les sorties se voient', async ({ page }) => {
  const marker = `E2E Vue WF ${Date.now()}`
  const subject = `${marker} — les loutres de Madagascar`

  // Le pipeline du workspace est là, et la carte se déplie.
  const cards = page.locator('[data-test="stage-card"]')
  await expect(cards).toHaveCount(2)
  await expect(page.locator('.wf-map summary')).toContainText('2 étapes')

  // Création du run depuis l'UI — le sujet devient le titre, le run est
  // sélectionné d'office : tout est « à venir » (les journaux des runs
  // précédents ne perturbent rien — assertions scopées au marqueur).
  await page.locator('[data-test="subject-input"]').fill(subject)
  await page.locator('[data-test="create-run-btn"]').click()

  const row = page.locator('[data-test="run-row"]', { hasText: marker })
  await expect(row).toBeVisible()
  await expect(row.locator('.run-badge')).toHaveText('En attente')
  await expect(cards.first()).toHaveAttribute('data-status', 'pending')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'pending')

  // Étape 1 : checkpoint — la carte passe à Fait, la sortie se prévisualise.
  await page.locator('[data-test="advance-btn"]').click()
  await expect(cards.first()).toHaveAttribute('data-status', 'done')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'pending')
  await expect(row.locator('.run-badge')).toHaveText('Checkpoint')

  const faits = page.locator('[data-test="output-file"]', { hasText: '01-recherche/output/faits.md' })
  await expect(faits).toBeVisible()
  await faits.locator('[data-test="output-toggle"]').click()
  await expect(page.locator('[data-test="output-preview"]')).toContainText('Réponse (maquette)')

  // Étape 2 : done — tout est vert, le rapport pointe son nez.
  await page.locator('[data-test="advance-btn"]').click()
  await expect(row.locator('.run-badge')).toHaveText('Terminé')
  await expect(cards.first()).toHaveAttribute('data-status', 'done')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'done')
  await expect(page.locator('[data-test="output-file"]', { hasText: '02-redaction/output/rapport.md' })).toBeVisible()

  // La session du run vit dans l'onglet Sessions — la même, journalisée.
  await page.locator('[data-test="tab-sessions"]').click()
  await expect(page.locator('[data-test="session-item"]', { hasText: marker })).toBeVisible()
})

test('un write demandé par le modèle se pause et s’approuve depuis la vue workflow', async ({ page }) => {
  const marker = `E2E Vue WF APPROVE2E ${Date.now()}`
  const subject = `${marker} — variante outils`

  await page.locator('[data-test="subject-input"]').fill(subject)
  await page.locator('[data-test="create-run-btn"]').click()
  const row = page.locator('[data-test="run-row"]', { hasText: marker })
  await expect(row).toBeVisible()

  // Outils activés : l'étape devient une boucle d'agent — la maquette
  // demande un write, l'étape se met en pause sur la carte d'approbation.
  await page.locator('[data-test="tools-toggle"]').check()
  await page.locator('[data-test="advance-btn"]').click()

  const card = page.locator('[data-test="approval-card"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('write')
  await expect(card).toContainText('01-recherche/output/notes-e2e.md')
  await expect(row.locator('.run-badge')).toHaveText('Approbation requise')

  // Décision humaine depuis la vue : l'étape reprend jusqu'au checkpoint.
  await page.locator('[data-test="approve-btn"]').click()
  await expect(card).toHaveCount(0)
  await expect(page.locator('[data-test="tool-row"][data-ok="ok"]', { hasText: 'notes-e2e.md' })).toBeVisible()
  await expect(row.locator('.run-badge')).toHaveText('Checkpoint')
  await expect(page.locator('[data-test="stage-card"]').first()).toHaveAttribute('data-status', 'done')

  // L'artefact final (après le résultat d'outil) est bien là, prévisualisable.
  const faits = page.locator('[data-test="output-file"]', { hasText: '01-recherche/output/faits.md' })
  await expect(faits).toBeVisible()
  await faits.locator('[data-test="output-toggle"]').click()
  await expect(page.locator('[data-test="output-preview"]')).toContainText('FICHE FINALE E2E')
})
