// Capture README : build déjà fait (dist), maquette passerelle sur 9801,
// serveur preview sur 4173, scène jouée dans un vrai Chromium, PNG écrit
// dans docs/assets/screenshot.png.
import { mkdir } from 'node:fs/promises'
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

const mock = await startMockGateway(9801)
const server = await preview({ root: path.resolve(here, '..') })
const browser = await chromium.launch()

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  })
  await page.goto('http://127.0.0.1:4173/')

  // Attendre la passerelle (maquette) puis jouer la scène.
  await page.waitForSelector('[data-test="gateway-status"][data-state="up"]')
  await page.getByRole('button', { name: '+ Nouvelle session' }).click()
  const box = page.getByLabel('Message')
  await box.fill('/new Rapport Q3')
  await box.press('Enter')
  await page.locator('[data-test="session-item"]').first().click()
  await page.locator('[data-test="model-select"]').selectOption('gemini-2.5-pro')

  await box.fill('Présente NyWorkflow en deux phrases.')
  await box.press('Enter')

  // Fin du flux : dernier message assistant complet, sans curseur.
  await page.waitForFunction(() => {
    const msgs = document.querySelectorAll('.msg.assistant')
    const last = msgs[msgs.length - 1]
    return !!last && !last.querySelector('.caret') && (last.textContent ?? '').includes('output/')
  })

  await mkdir(outDir, { recursive: true })
  await page.screenshot({ path: outFile })
  console.log(`Capture écrite : ${outFile}`)
} finally {
  await browser.close()
  await server.close()
  await mock.close()
}
