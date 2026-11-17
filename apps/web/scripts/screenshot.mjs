// Capture README : build déjà fait (dist), maquette passerelle sur 9801,
// serveur preview sur 4173, scène jouée dans un vrai Chromium, PNG écrit
// dans docs/assets/screenshot.png.
// Scène M6 : la vue workflow — un run créé depuis l'UI, la première étape
// exécutée (checkpoint), la progression visible et la sortie prévisualisée.
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test' // dépendance déclarée — 'playwright' nu n'est pas installable ici
import { preview } from 'vite'
import { startMockGateway } from '../e2e/mock-gateway.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → web/ → apps/ → racine du repo : docs/assets/screenshot.png
const outDir = path.resolve(here, '../../../docs/assets')
const outFile = path.join(outDir, 'screenshot.png')

process.env.W2A_URL ??= 'http://127.0.0.1:9801'
// Journal vierge pour la scène : les journaux des runs précédents survivent
// sur le disque (leçon M3) — ici, un home jetable garantit une liste de runs
// propre et un sujet lisible dans la capture, sans marqueur technique.
const sceneHome = await mkdtemp(path.join(tmpdir(), 'nyw-capture-'))
process.env.NYW_HOME = sceneHome

const mock = await startMockGateway(9801)
const server = await preview({ root: path.resolve(here, '..') })
const browser = await chromium.launch()

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  })
  await page.goto('http://127.0.0.1:4173/')

  // La passerelle (maquette) doit être détectée — elle pilote l'exécution.
  await page.waitForSelector('[data-test="gateway-status"][data-state="up"]')

  // Onglet Workflows, workspace d'exemple, sujet du run. Home jetable : le
  // run créé est le seul de la liste, sélectionné d'office.
  await page.locator('[data-test="tab-workflows"]').click()
  await page.locator('[data-test="workspace-item"]', { hasText: 'exemple-rapport' }).click()
  await page.locator('[data-test="subject-input"]').fill('Les loutres de Madagascar — rapport court')
  await page.locator('[data-test="create-run-btn"]').click()

  // Le run créé doit être là ET sélectionné avant d'avancer (leçon e2e :
  // créer d'abord, assumer les statuts ensuite).
  await page.locator('[data-test="run-row"]').first().waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const first = document.querySelector('[data-test="stage-card"]')
    return first?.getAttribute('data-status') === 'pending'
  })

  // Étape 1 exécutée : checkpoint, carte Fait, sortie prévisualisée.
  await page.locator('[data-test="advance-btn"]').click()
  await page.waitForFunction(() => {
    const first = document.querySelector('[data-test="stage-card"]')
    return first?.getAttribute('data-status') === 'done'
  })
  const faits = page.locator('[data-test="output-file"]', { hasText: '01-recherche/output/faits.md' })
  await faits.waitFor({ state: 'visible' })
  await faits.locator('[data-test="output-toggle"]').click()
  await page.waitForSelector('[data-test="output-preview"]')

  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: outFile })
  console.log(`Capture écrite : ${outFile}`)
} finally {
  await browser.close()
  await server.close()
  await mock.close()
}
