// Capture README : build déjà fait (dist), maquette passerelle sur 9801,
// serveur preview sur 4173, scène jouée dans un vrai Chromium, PNG écrit
// dans docs/assets/screenshot.png.
// Scène M15 : une session ICM agentique — dialogue de création (titre +
// workspace, l'option attendue est attendue AVANT de cliquer), un tour
// réflexion + DEUX lectures parallèles (thinking TITRÉ du protocole trois
// temps, carte « Actions de l'agent » groupée, lignes d'outils titrées),
// puis un write qui met la carte d'approbation en scène : la capture montre
// le cœur du produit — l'ICM vers le modèle, le protocole, les tools
// standards, l'humain aux commandes. En cas d'échec, l'état de la page est
// imprimé (CI comprise).
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

/** En cas d'échec : imprime l'état de la page avant de laisser mourir le processus. */
async function dumpOnFailure(page, step) {
  console.error(`[capture] échec à l'étape : ${step}`)
  try {
    const state = await page.evaluate(() => ({
      gateway: document.querySelector('[data-test="gateway-status"]')?.getAttribute('data-state'),
      banner: document.querySelector('[data-test="ws-banner"]')?.textContent ?? null,
      dialogOpen: document.querySelector('[data-test="new-session-dialog"]') !== null,
      dialogError: document.querySelector('[data-test="dialog-error"]')?.textContent ?? null,
      wsOptions: [...document.querySelectorAll('[data-test="ws-select"] option')].map((o) => o.value),
      head: document.querySelector('.main-head h2')?.textContent ?? null,
      msgs: [...document.querySelectorAll('.msg')].map((m) => m.textContent?.slice(0, 90)),
      toolRows: [...document.querySelectorAll('[data-test="tool-row"]')].map((m) => m.textContent),
      composerDisabled: document.querySelector('.composer textarea')?.disabled ?? null,
    }))
    console.error('[capture] état de la page :', JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[capture] page muette :', err)
  }
}

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  })
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('[console]', m.text().slice(0, 300))
  })
  page.on('requestfailed', (r) => console.error('[reqfail]', r.method(), r.url(), r.failure()?.errorText))
  page.on('response', (r) => {
    if (r.status() >= 400) console.error('[http]', r.status(), r.url())
  })

  await page.goto('http://127.0.0.1:4173/')

  // La passerelle (maquette) doit être détectée — elle pilote l'exécution.
  await page.waitForSelector('[data-test="gateway-status"][data-state="up"]', { timeout: 20_000 })

  // Nouvelle session ICM via le dialogue : le registre des workspaces doit
  // être chargé AVANT de cliquer (l'option est attendue explicitement —
  // jamais de session orpheline par course).
  const box = page.getByLabel('Message')
  await box.fill('/new Les loutres de Madagascar — rapport documenté')
  await page.keyboard.press('Enter')
  await page.locator('[data-test="new-session-dialog"]').waitFor({ state: 'visible' })
  await page.locator('[data-test="session-title-input"]').fill('Les loutres de Madagascar — rapport')
  await page.locator('[data-test="ws-select"] option[value="exemple-agentique"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.locator('[data-test="create-session-btn"]').click()
  // La session de la scène est bien l'active (titre dans l'en-tête).
  await page.locator('.main-head h2').filter({ hasText: 'Les loutres de Madagascar — rapport' }).waitFor({ timeout: 20_000 })
  await page.locator('[data-test="ws-banner"]').waitFor({ state: 'visible' })

  // Premier tour : réflexion + DEUX lectures parallèles (le protocole M16 :
  // thinking titré ouvre la réponse, puis les appels groupés et titrés).
  // PENSE garde le canal natif pour la réponse finale — les deux familles
  // de modèles coexistent, la capture montre le bloc titré du tour d'actions.
  await box.fill('PENSE et AGENTPARALLELE lis tout d’un coup')
  await page.keyboard.press('Enter')
  try {
    await page.locator('[data-test="tool-row"]', { hasText: 'read' }).first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(
      () => [...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent?.includes('PARALLÈLE FAIT')),
      undefined,
      { timeout: 30_000 },
    )
    // Deux messages assistant = deux blocs thinking (le tour d'actions titré,
    // la réponse finale native) — on déplie LE PREMIER : le bloc TITRÉ du
    // protocole (strict mode : .first(), jamais le locator nu).
    const thinking = page.locator('[data-test="thinking-block"]').first()
    await thinking.waitFor({ state: 'visible', timeout: 10_000 })
    // Le flux doit être terminé (caret parti) : le clic ouvre alors un bloc
    // que l'auto-repliement ne refermera pas.
    await page.waitForFunction(() => document.querySelector('.caret') === null, undefined, { timeout: 15_000 })
    await thinking.locator('.thinking-head').click() // déplié pour la capture
    await thinking.locator('.thinking-body').waitFor({ state: 'visible', timeout: 10_000 })
  } catch (err) {
    await dumpOnFailure(page, 'premier tour agentique (PENSE + AGENTPARALLELE)')
    throw err
  }

  // Deuxième tour : un write proposé — la carte d'approbation reste à
  // l'écran, l'humain aux commandes : c'est la capture.
  await box.fill('AGENTECRIT écris maintenant le brouillon du rapport')
  await page.keyboard.press('Enter')
  try {
    await page.locator('[data-test="approval-card"]').waitFor({ state: 'visible', timeout: 30_000 })
  } catch (err) {
    await dumpOnFailure(page, 'write sous approbation (AGENTECRIT)')
    throw err
  }

  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: outFile })
  console.log(`Capture écrite : ${outFile}`)
} finally {
  await browser.close()
  await server.close()
  await mock.close()
  await rm(sceneHome, { recursive: true, force: true })
}
