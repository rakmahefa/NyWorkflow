// Vérification M16 — démarre la maquette passerelle, ouvre l'app réelle,
// joue le scénario AGENTPROTOCOL et vérifie la CHAÎNE COMPLÈTE du
// protocole trois temps : l'ICM documente le harness (harness/ + tools/
// chargés), le tour se déroule, et le 4e journal model.jsonl capte la
// réponse du modèle à chaque round AVEC la conformité protocole calculée
// serveur — global (.nyworkflow/.logs) ET par session (dossier/.logs/<id>).
import { startMockGateway } from '../e2e/mock-gateway.mjs'
import { chromium } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'nyw-m16-home-'))
const spaces = mkdtempSync(join(tmpdir(), 'nyw-m16-spaces-'))
process.env.NYW_HOME = home
process.env.NYW_WORKSPACES = spaces

const mock = await startMockGateway(9802)
process.env.W2A_URL = 'http://127.0.0.1:9802'

const { createServer: createViteServer } = await import('vite')
const server = await createViteServer({
  configFile: join(import.meta.dirname, '../vite.config.ts'),
  server: { port: 3184, strictPort: true },
})
await server.listen()
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(base)

// 1. L'ICM de base documente le harness — vérifiée AVANT tout tour.
await page.getByLabel('Message').fill('/new Démo M16')
await page.keyboard.press('Enter')
const dialog = page.locator('[data-test="new-session-dialog"]')
await dialog.waitFor({ state: 'visible' })
await page.locator('[data-test="session-title-input"]').fill('Démo M16')
await page.locator('[data-test="create-session-btn"]').click()
await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)

const sessions = await (await fetch(`${base}/sessions`)).json()
const mine = sessions.sessions.at(-1)
console.log(`session: ${mine.id} — workspace: ${mine.workspace}`)

const icm = await (await fetch(`${base}/workspaces/${mine.workspace}/icm`)).json()
console.log(`\n===== ICM CHARGÉE (${icm.contexts.length} CONTEXT.md) =====`)
console.log(`contexts: ${icm.contexts.map((c) => c.path === '' ? '(racine)' : c.path).join(', ')}`)
for (const needle of [
  'Protocole de réponse — trois temps',
  'Le temps de l’observation',
  '{"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}',
  '# harness/ — le harness NyWorkflow',
  '# tools/ — le protocole d’utilisation des outils',
]) {
  console.log(`prompt contient « ${needle.slice(0, 60)}… » : ${icm.system.includes(needle) ? 'OUI' : 'NON (ÉCHEC)'}`)
}

// 2. Le scaffold porte la doc — harness/ + tools/ avec les 9 fiches.
console.log('\n===== SCAFFOLD SUR DISQUE =====')
const wsRoot = join(spaces, mine.workspace)
for (const f of ['harness/CONTEXT.md', 'harness/ENGINE.md', 'tools/CONTEXT.md', 'tools/read.md', 'tools/shell.md', 'tools/websearch.md', 'tools/shell_kill.md']) {
  console.log(`${f} : ${existsSync(join(wsRoot, '.workspace', f)) ? 'présent' : 'ABSENT (ÉCHEC)'}`)
}

// 3. Le tour protocole — la maquette suit les trois temps.
console.log('\n===== TOUR AGENTPROTOCOL =====')
const box = page.getByLabel('Message')
await box.fill('AGENTPROTOCOL cartographie tout')
await box.press('Enter')
await page.locator('[data-test="tool-row"][data-state="ok"]').first().waitFor({ state: 'visible', timeout: 15_000 })
await page.locator('.msg.assistant').filter({ hasText: 'PROTOCOLE TROIS TEMPS' }).first().waitFor({ timeout: 15_000 })
console.log('tour terminé : appels réglés + réponse finale rendue')

// 4. Le journal du modèle — global + par session, conformité comprise.
//    (les appends sont fire-and-forget : on sonde jusqu'à 5 s)
const readLines = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"model.response"'))
    .map((l) => JSON.parse(l))

const waitLines = async (file) => {
  for (let i = 0; i < 50; i++) {
    try {
      const lines = readLines(file)
      if (lines.length >= 2) return lines
    } catch {
      // pas encore écrit
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return readLines(file)
}

console.log('\n===== model.jsonl GLOBAL (.nyworkflow/.logs) =====')
for (const r of await waitLines(join(home, '.logs', 'model.jsonl'))) {
  console.log(
    `round ${r.round} [${r.outcome}] modèle=${r.model} ms=${r.ms} systemChars=${r.systemChars} thinking=${r.thinkingChars}c text=${r.textChars}c titres=${JSON.stringify(r.thinkingTitles)} appels=${r.toolCalls.map((c) => `${c.tool}«${c.title}»`).join(' ')} protocole=${JSON.stringify(r.protocol)}`,
  )
}

console.log('\n===== model.jsonl PAR SESSION (dossier/.logs/<id>) =====')
const perSessionFile = join(wsRoot, '.logs', mine.id, 'model.jsonl')
console.log(`fichier: ${perSessionFile} — ${existsSync(perSessionFile) ? 'présent' : 'ABSENT (ÉCHEC)'}`)
if (existsSync(perSessionFile)) {
  for (const r of readLines(perSessionFile)) {
    console.log(`round ${r.round} [${r.outcome}] workspace=${r.workspace} protocole=${JSON.stringify(r.protocol)}`)
  }
}

const globalLines = readLines(join(home, '.logs', 'model.jsonl'))
const ok =
  icm.contexts.length === 9 &&
  icm.system.includes('Protocole de réponse — trois temps') &&
  existsSync(join(wsRoot, '.workspace', 'harness', 'CONTEXT.md')) &&
  existsSync(join(wsRoot, '.workspace', 'tools', 'read.md')) &&
  globalLines.length >= 2 &&
  globalLines.every((r) => r.protocol.thinkingFirst === true && r.protocol.thinkingTitled === true) &&
  globalLines[0]?.protocol.toolCallsTitled === 2

await browser.close()
await server.close()
await mock.close()
rmSync(home, { recursive: true, force: true })
rmSync(spaces, { recursive: true, force: true })
console.log(`\n${ok ? 'VÉRIFICATION M16 OK — protocole trois temps vivant, ICM documentée, journal du modèle peuplé' : 'ÉCHEC M16 — voir les NON/ABSENT ci-dessus'}`)
process.exit(ok ? 0 : 1)
