// Vérification M17 — démarre la maquette passerelle, ouvre l'app réelle,
// joue le scénario AGENTPROTOCOL et vérifie la chaîne de PROFILAGE
// complète, dans les DEUX sens du fil :
//   - model.response porte rawArgs + argsOk (le mauvais format serait visible),
//   - model.observation capte les résultats du groupe qui CIRCULENT vers le
//     modèle (le temps 3 du protocole), global ET par session,
//   - GET /sessions/:id/logs (+ /logs/model.jsonl) sert le quatuor DE LA
//     SESSION à l'UI — les réponses du modèle de CETTE session, lisibles,
//   - l'onglet Activité montre la réponse dans la carte requête,
//   - /workspaces/locate résout un nom de dossier en chemin serveur (le
//     pont du bouton Explorer).
import { startMockGateway } from '../e2e/mock-gateway.mjs'
import { chromium } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'nyw-m17-home-'))
const spaces = mkdtempSync(join(tmpdir(), 'nyw-m17-spaces-'))
process.env.NYW_HOME = home
process.env.NYW_WORKSPACES = spaces

const mock = await startMockGateway(9803)
process.env.W2A_URL = 'http://127.0.0.1:9803'

const { createServer: createViteServer } = await import('vite')
const server = await createViteServer({
  configFile: join(import.meta.dirname, '../vite.config.ts'),
  server: { port: 3185, strictPort: true },
})
await server.listen()
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(base)

// 1. Session sur un scaffold frais (le dialogue réel).
await page.getByLabel('Message').fill('/new Démo M17')
await page.keyboard.press('Enter')
const dialog = page.locator('[data-test="new-session-dialog"]')
await dialog.waitFor({ state: 'visible' })
await page.locator('[data-test="session-title-input"]').fill('Démo M17')
await page.locator('[data-test="create-session-btn"]').click()
await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)

const sessions = await (await fetch(`${base}/sessions`)).json()
const mine = sessions.sessions.at(-1)
const wsRoot = join(spaces, mine.workspace)
console.log(`session: ${mine.id} — workspace: ${mine.workspace}`)

// 2. Le tour protocole — deux appels parallèles, puis la réponse finale.
console.log('\n===== TOUR AGENTPROTOCOL =====')
const box = page.getByLabel('Message')
await box.fill('AGENTPROTOCOL cartographie tout')
await box.press('Enter')
await page.locator('[data-test="tool-row"][data-state="ok"]').first().waitFor({ state: 'visible', timeout: 15_000 })
await page.locator('.msg.assistant').filter({ hasText: 'PROTOCOLE TROIS TEMPS' }).first().waitFor({ timeout: 15_000 })
console.log('tour terminé : groupe réglé + réponse finale rendue')

// 3. L'onglet Activité montre la RÉPONSE (protocole, extrait) + le quatuor.
//    NB : les libellés .act-sub sont rendus en MAJUSCULES (CSS) — la carte
//    vérifiée est la DERNIÈRE (le round final porte le texte de la réponse).
console.log('\n===== ONGLET ACTIVITÉ (UI) =====')
await page.locator('[data-test="tab-activity"]').click()
const req = page.locator('[data-test="act-request"]').last()
await req.locator('.act-head').click()
const cardText = (await req.locator('.act-body').innerText()).toUpperCase()
console.log(`carte requête porte « Protocole » : ${cardText.includes('PROTOCOLE') ? 'OUI' : 'NON (ÉCHEC)'}`)
console.log(`carte requête porte « thinking d’abord » : ${cardText.includes('THINKING D’ABORD') ? 'OUI' : 'NON (ÉCHEC)'}`)
console.log(`carte requête porte « Réponse du modèle (extrait) » : ${cardText.includes('RÉPONSE DU MODÈLE') ? 'OUI' : 'NON (ÉCHEC)'}`)
const logsTable = page.locator('[data-test="session-logs-table"]')
await logsTable.waitFor({ state: 'visible', timeout: 5_000 })
console.log(`section « Journaux de la session » : ${logsTable.isVisible() ? 'OUI' : 'NON (ÉCHEC)'}`)

// 4. model.jsonl — les DEUX sens du fil, global et par session.
const readAll = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"model.response"') || l.includes('"model.observation"'))
    .map((l) => JSON.parse(l))

const waitBoth = async (file) => {
  for (let i = 0; i < 50; i++) {
    try {
      const lines = readAll(file)
      if (lines.filter((l) => l.kind === 'model.observation').length >= 1 && lines.filter((l) => l.kind === 'model.response').length >= 2) return lines
    } catch {
      // pas encore écrit
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return readAll(file)
}

console.log('\n===== model.jsonl GLOBAL — réponse PUIS observation =====')
const globalFile = join(home, '.logs', 'model.jsonl')
const globalLines = await waitBoth(globalFile)
for (const r of globalLines) {
  if (r.kind === 'model.response') {
    console.log(
      `round ${r.round} [${r.outcome}] titres=${JSON.stringify(r.thinkingTitles)} appels=${r.toolCalls.map((c) => `${c.tool}«${c.title}»argsOk=${c.argsOk ?? '—'}`).join(' ')} protocole=${JSON.stringify(r.protocol)}`,
    )
  } else {
    console.log(
      `⤷ observation du round ${r.round} → round ${r.fedToRound} : ${r.calls} résultats, ok=${r.ok} — ${r.results.map((x) => `${x.tool}«${x.title}»${x.ok ? 'ok' : `erreur: ${x.error.slice(0, 40)}`}`).join(' | ')}`,
    )
  }
}

console.log('\n===== model.jsonl PAR SESSION (dossier/.logs/<id>) =====')
const perSessionFile = join(wsRoot, '.logs', mine.id, 'model.jsonl')
console.log(`fichier: ${perSessionFile} — ${existsSync(perSessionFile) ? 'présent' : 'ABSENT (ÉCHEC)'}`)
const perLines = readAll(perSessionFile)
for (const r of perLines) console.log(`${r.kind} round ${r.round} workspace=${r.workspace}`)

// 5. L'API du quatuor de la session — ce que l'UI lit.
console.log('\n===== GET /sessions/:id/logs (API) =====')
const list = await (await fetch(`${base}/sessions/${mine.id}/logs`)).json()
console.log(`dir: ${list.dir}`)
console.log(`quatuor: ${list.files.map((f) => `${f.name}(${f.lines}l)`).join(' ')}`)
const tail = await (await fetch(`${base}/sessions/${mine.id}/logs/model.jsonl?tail=50`)).json()
console.log(`tail model.jsonl contient model.response : ${tail.tail.includes('"model.response"') ? 'OUI' : 'NON (ÉCHEC)'}`)
console.log(`tail model.jsonl contient model.observation : ${tail.tail.includes('"model.observation"') ? 'OUI' : 'NON (ÉCHEC)'}`)

// 6. Le pont du sélecteur natif : locate résout le nom du dossier.
console.log('\n===== GET /workspaces/locate (pont Explorer) =====')
const locate = await (await fetch(`${base}/workspaces/locate?name=${encodeURIComponent(mine.workspace)}`)).json()
console.log(`« ${locate.name} » → ${locate.candidates.length} candidat(s), ${locate.scanned} dossiers parcourus`)
for (const c of locate.candidates) console.log(`  ${c}`)

// Le verdict.
const responses = globalLines.filter((l) => l.kind === 'model.response')
const observations = globalLines.filter((l) => l.kind === 'model.observation')
const ok =
  cardText.includes('PROTOCOLE') &&
  cardText.includes('RÉPONSE DU MODÈLE') &&
  cardText.includes('THINKING D’ABORD') &&
  logsTable.isVisible() &&
  responses.length >= 2 &&
  responses.every((r) => r.protocol.argsOk === true) &&
  responses[0]?.toolCalls.every((c) => c.argsOk === true && typeof c.rawArgs === 'string') &&
  observations.length >= 1 &&
  observations[0]?.calls === 2 &&
  observations[0]?.results.every((x) => x.ok === true && typeof x.result === 'string') &&
  perLines.some((l) => l.kind === 'model.observation') &&
  list.files.length === 4 &&
  tail.tail.includes('"model.response"') &&
  tail.tail.includes('"model.observation"') &&
  locate.candidates[0] === wsRoot

await browser.close()
await server.close()
await mock.close()
rmSync(home, { recursive: true, force: true })
rmSync(spaces, { recursive: true, force: true })
console.log(
  `\n${ok ? 'VÉRIFICATION M17 OK — profilage observable des deux sens, quatuor de session servi à l’UI, pont Explorer vivant' : 'ÉCHEC M17 — voir les NON/ABSENT ci-dessus'}`,
)
process.exit(ok ? 0 : 1)
