// Capture README : build déjà fait (dist), maquette passerelle sur 9801,
// serveur preview sur 4173, scène jouée dans un vrai Chromium, PNG écrit
// dans docs/assets/screenshot.png.
// Scène M11 : une session ICM agentique — dialogue de création (titre +
// workspace), un tour avec read auto-exécuté (ligne d'outil dans le flux),
// puis un write qui met la carte d'approbation en scène : la capture
// montre le cœur du produit — l'ICM vers le modèle, les tools standards,
// l'humain aux commandes.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
// Journal vierge pour la scène : un home jetable garantit une session
// unique et lisible dans la capture, sans marqueur technique.
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

  // Nouvelle session ICM via le dialogue : titre + workspace d'exemple.
  const box = page.getByLabel('Message')
  await box.fill('/new Les loutres de Madagascar — rapport documenté')
  await page.keyboard.press('Enter')
  await page.locator('[data-test="new-session-dialog"]').waitFor({ state: 'visible' })
  await page.locator('[data-test="session-title-input"]').fill('Les loutres de Madagascar — rapport')
  await page.locator('[data-test="create-session-btn"]').click()
  await page.locator('[data-test="ws-banner"]').waitFor({ state: 'visible' })

  // Premier tour : la lecture de la carte (read auto-exécuté) + réponse.
  await box.fill('AGENTLIT commence par lire la carte du workspace')
  await page.keyboard.press('Enter')
  await page
    .locator('[data-test="tool-row"]', { hasText: 'read' })
    .first()
    .waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent?.includes('LIVRABLE FINAL')),
  )

  // Deuxième tour : un write proposé — la carte d'approbation reste à
  // l'écran, l'humain aux commandes : c'est la capture.
  await box.fill('AGENTECRIT écris maintenant le brouillon du rapport')
  await page.keyboard.press('Enter')
  await page.locator('[data-test="approval-card"]').waitFor({ state: 'visible' })

  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: outFile })
  console.log(`Capture écrite : ${outFile}`)
} finally {
  await browser.close()
  await server.close()
  await mock.close()
  await rm(sceneHome, { recursive: true, force: true })
}
