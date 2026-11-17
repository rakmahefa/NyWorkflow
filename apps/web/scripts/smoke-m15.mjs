// Vérification DOM M15 — démarre la maquette passerelle, ouvre l'app réelle,
// joue le scénario AGENTPROTOCOL et imprime la structure RENDUE de la
// session : titres des blocs thinking, état replié/déplié, groupe
// d'actions (compteur), lignes d'appels titrées. Preuve textuelle de
// l'affichage vu par le pilote.
import { startMockGateway } from '../e2e/mock-gateway.mjs'
import { chromium } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'nyw-shot-home-'))
const spaces = mkdtempSync(join(tmpdir(), 'nyw-shot-spaces-'))
process.env.NYW_HOME = home
process.env.NYW_WORKSPACES = spaces

const mock = await startMockGateway(9801)
process.env.W2A_URL = 'http://127.0.0.1:9801'

const { createServer: createViteServer } = await import('vite')
const server = await createViteServer({
  configFile: join(import.meta.dirname, '../vite.config.ts'),
  server: { port: 3183, strictPort: true },
})
await server.listen()
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(base)

await page.getByLabel('Message').fill('/new Démo protocole')
await page.keyboard.press('Enter')
const dialog = page.locator('[data-test="new-session-dialog"]')
await dialog.waitFor({ state: 'visible' })
await page.locator('[data-test="session-title-input"]').fill('Démo protocole')
await page.locator('[data-test="create-session-btn"]').click()
await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)

const box = page.getByLabel('Message')
await box.fill('AGENTPROTOCOL cartographie tout')
await box.press('Enter')
await page.locator('[data-test="tool-row"][data-state="ok"]').first().waitFor({ state: 'visible', timeout: 15_000 })
await page.locator('.msg.assistant').filter({ hasText: 'PROTOCOLE DEUX TEMPS' }).first().waitFor({ timeout: 15_000 })
await page.waitForTimeout(700) // repli automatique des blocs thinking

const dump = async (label) => {
  console.log(`\n===== ${label} =====`)
  const think = page.locator('[data-test="thinking-block"]')
  const n = await think.count()
  console.log(`thinking-block: ${n}`)
  for (let i = 0; i < n; i++) {
    const b = think.nth(i)
    console.log(`  [${i}] titre="${await b.getAttribute('data-title')}" replié=${(await b.locator('.thinking-body').count()) === 0} enTete="${(await b.locator('.thinking-head').textContent())?.trim()}"`)
  }
  const groups = page.locator('[data-test="tool-group"]')
  const g = await groups.count()
  console.log(`tool-group: ${g}`)
  for (let i = 0; i < g; i++) {
    const grp = groups.nth(i)
    console.log(`  [${i}] count=${await grp.getAttribute('data-count')} enTete="${(await grp.locator('.tool-group-head').textContent())?.trim()}"`)
    const rows = grp.locator('[data-test="tool-row"]')
    const rn = await rows.count()
    for (let j = 0; j < rn; j++) {
      const r = rows.nth(j)
      console.log(`    ligne[${j}] outil=${await r.getAttribute('data-tool')} titre="${await r.getAttribute('data-title')}" état=${await r.getAttribute('data-state')} texte="${(await r.locator('.tool-label').textContent())?.trim().slice(0, 90)}"`)
    }
  }
  const assistant = await page.locator('.msg.assistant').allInnerTexts()
  console.log(`messages assistant: ${assistant.length} — dernier: ${JSON.stringify(assistant[assistant.length - 1]?.slice(0, 140))}`)
}

await dump('APRÈS LE TOUR (état stable, thinking replié d’office)')

// Le pilote déplie le thinking et les détails d'un appel.
await page.locator('[data-test="thinking-block"] .thinking-head').first().click()
await page.locator('[data-test="tool-row"] .tool-head').first().click()
await page.waitForTimeout(250)
await dump('OUVERT PAR LE PILOTE (thinking + détails d’un appel)')

// Le groupe se replie : compteur seul.
await page.locator('.tool-group-head').first().click()
await page.waitForTimeout(200)
await dump('GROUPE REPLIÉ (compteur seul)')

await browser.close()
await server.close()
await mock.close()
rmSync(home, { recursive: true, force: true })
rmSync(spaces, { recursive: true, force: true })
console.log('\nvérification DOM OK')
