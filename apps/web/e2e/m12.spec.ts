import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M12 — les nouvelles surfaces de l'harness, bout en bout dans l'UI réelle
// contre la maquette passerelle :
//   - le dossier du disque enregistré comme workspace (navigateur de dossiers) ;
//   - l'onglet Activité (chaque requête modèle tracée, chaque appel d'outil) ;
//   - la réflexion en bloc repliable (reasoning_content → « > Réflexion ») ;
//   - les appels sûrs parallèles ;
//   - le shell en arrière-plan (approbation → jobId → shell_output).

const DISK = mkdtempSync(join(tmpdir(), 'nyw-e2e-disk-'))
const MANIFEST_PATH = join(import.meta.dirname, '../../../examples/workspaces/workspaces.json')

test.afterAll(() => {
  rmSync(DISK, { recursive: true, force: true })
  // The registered test folder leaves the registry manifest — clean it so
  // the repo stays exactly as committed.
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const kept = (manifest.workspaces ?? []).filter((w: { path?: string }) => !w.path?.includes('nyw-e2e-disk'))
    if (kept.length !== manifest.workspaces.length) {
      if (kept.length === 0) rmSync(MANIFEST_PATH, { force: true })
      else writeFileSync(MANIFEST_PATH, JSON.stringify({ workspaces: kept }, null, 2) + '\n', 'utf8')
    }
  } catch {
    // no manifest — nothing to clean
  }
})

test('workspace folder : dossier du disque enregistré tel quel, session liée, ICM chargée', async ({ page }) => {
  await page.goto('/')
  const myFolder = join(DISK, 'mes-loutres')
  mkdirSync(myFolder, { recursive: true })
  writeFileSync(join(myFolder, 'CONTEXT.md'), '# Dossier loutres du pilote\n', 'utf8')
  mkdirSync(join(myFolder, 'donnees'))
  writeFileSync(join(myFolder, 'donnees', 'comptages.txt'), '12 loutres\n', 'utf8')

  const title = `Dossier pilote ${Date.now()}`
  await page.getByLabel('Message').fill(`/new ${title}`)
  await page.keyboard.press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await dialog.waitFor({ state: 'visible' })
  await dialog.locator('[data-test="ws-mode-folder"]').click()

  // Navigate: type the parent path, open, then choose the folder.
  const pathInput = dialog.locator('[data-test="folder-path-input"]')
  await pathInput.fill(DISK)
  await dialog.locator('[data-test="folder-go"]').click()
  const row = dialog.locator('[data-test="folder-row"]', { hasText: 'mes-loutres' })
  // Generous: the first dialog of a run pays the dev server's cold transform.
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  await row.locator('[data-test="folder-choose"]').click()
  await dialog.locator('[data-test="session-title-input"]').fill(title)
  await dialog.locator('[data-test="create-session-btn"]').click()
  await expect(dialog).toHaveCount(0)

  // La session vit dans son groupe, le bandeau porte le workspace.
  await expect(page.locator('[data-test="ws-banner"]')).toContainText('mes-loutres')
  // L'arbre du pilote est chargé tel quel — rien n'a été créé dedans.
  expect(existsSync(join(myFolder, 'inbox'))).toBe(false)

  // La lecture y fonctionne sur SES fichiers.
  const box = page.getByLabel('Message')
  await box.fill('AGENTLIT montre-moi la carte du workspace')
  await box.press('Enter')
  await expect(page.locator('[data-test="tool-row"]', { hasText: 'read' }).first()).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('LIVRABLE FINAL AGENT', { timeout: 10_000 })

  // Le manifeste du registre porte l'inscription (donnée, pas du code).
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  expect(manifest.workspaces.some((w: { name: string }) => w.name === 'mes-loutres')).toBe(true)
})

test('onglet Activité : chaque requête modèle tracée, chaque outil dépliable', async ({ page }) => {
  await page.goto('/')
  const title = `Activité ${Date.now()}`
  await newSessionViaDialog(page, title)

  await page.locator('[data-test="tab-activity"]').click()
  await expect(page.locator('[data-test="activity-panel"]')).toBeVisible()
  await expect(page.locator('.activity .empty')).toBeVisible() // rien encore

  // Un tour agentique : une requête (tool_calls) + un read + une requête finale.
  await page.locator('[data-test="tab-chat"]').click()
  const box = page.getByLabel('Message')
  await box.fill('AGENTLIT montre-moi la carte')
  await box.press('Enter')
  await expect(page.locator('.msg.assistant').last()).toContainText('LIVRABLE FINAL AGENT', { timeout: 10_000 })

  await page.locator('[data-test="tab-activity"]').click()
  const requests = page.locator('[data-test="act-request"]')
  await expect(requests.first()).toBeVisible()
  expect(await requests.count()).toBeGreaterThanOrEqual(2)
  // Le premier tour a déclenché des appels d'outils, le dernier une réponse.
  await expect(requests.first()).toContainText('appels d’outils')
  await expect(requests.last()).toContainText('réponse')

  // L'appel d'outil est là, dépliable avec ses arguments.
  const tool = page.locator('[data-test="act-tool"]', { hasText: 'read' }).first()
  await expect(tool).toBeVisible()
  await tool.locator('.act-head').click()
  await expect(tool.locator('.act-body')).toBeVisible()
  await expect(tool.locator('pre').first()).toContainText('CONTEXT.md')
})

test('réflexion : bloc repliable alimenté en direct, puis replié', async ({ page }) => {
  await page.goto('/')
  const title = `Réflexion ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('PENSE puis réponds-moi')
  await box.press('Enter')

  // Le bloc Réflexion apparaît, se replie une fois la réponse partie, se rouvre d'un clic.
  const thinking = page.locator('[data-test="thinking-block"]')
  await expect(thinking).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('Réponse (maquette)', { timeout: 10_000 })
  await expect(thinking.locator('.thinking-body')).toHaveCount(0, { timeout: 5_000 }) // replié d'office
  await thinking.locator('.thinking-head').click()
  await expect(thinking.locator('.thinking-body')).toContainText('la réponse s’impose')
  await thinking.locator('.thinking-head').click()
  await expect(thinking.locator('.thinking-body')).toHaveCount(0)
})

test('parallèle : deux appels sûrs d’un même tour, exécutés ensemble', async ({ page }) => {
  await page.goto('/')
  const title = `Parallèle ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPARALLELE lis tout d’un coup')
  await box.press('Enter')

  // Les deux lignes (read + ls) se règlent, puis la réponse finale.
  const read = page.locator('[data-test="tool-row"]', { hasText: 'read' }).first()
  const ls = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(read).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(ls).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('PARALLÈLE FAIT', { timeout: 10_000 })

  // Chaque appel garde SON résultat (appariement par callId) : read rend le
  // contenu, ls rend les entrées — visibles dans les détails dépliables.
  await read.locator('.tool-head').click()
  await expect(read.locator('[data-test="tool-details"] pre').first()).toContainText('path')
})

test('arrière-plan : approbation → jobId → suivi shell_output → arrêt', async ({ page }) => {
  await page.goto('/')
  const title = `Arrière-plan ${Date.now()}`
  await newSessionViaDialog(page, title)

  // L'agent lance un shell détaché : la carte montre la commande et le badge.
  const box = page.getByLabel('Message')
  await box.fill('AGENTARRIEREPLAN lance la veille en arrière-plan')
  await box.press('Enter')
  const card = page.locator('[data-test="approval-card"]')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('[data-test="approval-preview"]')).toContainText('sleep')
  await expect(card).toContainText('arrière-plan')

  await card.locator('[data-test="approve-btn"]').click()
  await expect(card).toHaveCount(0, { timeout: 10_000 })
  const bgRow = page.locator('[data-test="tool-row"]', { hasText: 'shell' }).first()
  await expect(bgRow).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(bgRow).toContainText('arrière-plan')
  await expect(page.locator('.msg.assistant').last()).toContainText('ARRIERE-PLAN LANCE', { timeout: 10_000 })

  // Le modèle suit son job (SUIVIJOB → shell_output avec le vrai jobId).
  await box.fill('SUIVIJOB où en est-il ?')
  await box.press('Enter')
  const follow = page.locator('[data-test="tool-row"]', { hasText: 'shell_output' }).first()
  await expect(follow).toBeVisible({ timeout: 10_000 })
  await expect(follow).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('SUIVI FAIT', { timeout: 10_000 })
})

test('renommage inline + niveau de réflexion persistés', async ({ page }) => {
  await page.goto('/')
  const title = `Renomme ${Date.now()}`
  const item = await newSessionViaDialog(page, title)

  // Renommage inline depuis la rangée — l'input remplace le titre, on le
  // vise globalement (une seule édition à la fois).
  const row = page.locator('.session-row').filter({ hasText: title })
  await row.locator('[data-test="rename-btn"]').click()
  const input = page.locator('[data-test="session-rename-input"]')
  await input.fill('Nouveau nom de session')
  await input.press('Enter')
  await expect(page.locator('.main-head h2')).toContainText('Nouveau nom de session')

  // Le titre survit au rechargement (session.renamed au journal).
  await page.reload()
  await expect(page.locator('.main-head h2')).toContainText('Nouveau nom de session')

  // Le niveau de réflexion est proposé et persiste.
  const think = page.locator('[data-test="think-select"]')
  await expect(think).toBeEnabled()
  await think.selectOption('2')
  await page.reload()
  await expect(page.locator('[data-test="think-select"]')).toHaveValue('2')
})

test('file d’attente : un message envoyé pendant un tour part à la fin — jamais perdu', async ({ page }) => {
  await page.goto('/')
  const title = `File ${Date.now()}`
  await newSessionViaDialog(page, title)
  const box = page.getByLabel('Message')
  await box.fill('AGENTLIT première lecture')
  await box.press('Enter')
  await page.locator('[data-test="tool-row"]', { hasText: 'read' }).first().waitFor({ state: 'visible', timeout: 10_000 })
  await box.fill('PONG message en file pendant le tour')
  await box.press('Enter')
  await expect(page.locator('.msg.system').last()).toContainText('mis en file', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('PONG', { timeout: 15_000 })
})
