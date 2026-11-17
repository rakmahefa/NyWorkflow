import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M13 — le niveau de sécurité règle les outils, bout en bout dans l'UI
// réelle contre la maquette passerelle :
//   - « aucun outil » à la création : aucun tool_call déclaré, la maquette
//     répond en texte, RIEN n'est écrit dans le workspace ;
//   - « accepter » en direct dans le bandeau : un write s'exécute sans
//     carte d'approbation (la porte reste fermée sous « demander ») ;
//   - le défaut des nouvelles sessions se règle dans les Paramètres ;
//   - la carte « Profiling & logs » liste le trio .logs (lecture seule).

const SCAFFOLDED: string[] = []

test.afterAll(() => {
  for (const name of SCAFFOLDED) {
    rmSync(join(import.meta.dirname, '../../../examples/workspaces', name), { recursive: true, force: true })
  }
})

test('« aucun outil » dès la création : conversation ICM pure, aucun tool_call', async ({ page }) => {
  await page.goto('/')
  const title = `Sans outils ${Date.now()}`
  const box = page.getByLabel('Message')
  await box.fill(`/new ${title}`)
  await box.press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await dialog.waitFor({ state: 'visible' })

  // Niveau « aucun outil » choisi À LA CRÉATION.
  await dialog.locator('[data-test="security-level"]').selectOption('no-tools')
  await dialog.locator('[data-test="create-session-btn"]').click()
  await expect(dialog).toHaveCount(0)

  // Le bandeau porte le niveau ; la session vit dans son groupe.
  await expect(page.locator('[data-test="security-select"]')).toHaveValue('no-tools')

  // Un marqueur qui, AVEC des outils, déclencherait un write (AGENTECRIT) :
  // sans déclarations d'outils, la maquette répond en texte — aucune ligne
  // d'outil, aucune carte, aucun fichier écrit.
  await box.fill('AGENTECRIT écris le livrable interdit')
  await box.press('Enter')
  await expect(page.locator('.msg.assistant').last()).toContainText('AGENTECRIT', { timeout: 10_000 })
  await expect(page.locator('[data-test="tool-row"]')).toHaveCount(0)
  await expect(page.locator('[data-test="approval-card"]')).toHaveCount(0)
})

test('« accepter » en direct : le write s’exécute sans approbation, puis la porte se rouvre', async ({ page }) => {
  await page.goto('/')
  // Workspace à part : AGENTECRIT écrit outputs/agent-e2e.md — le workspace
  // partagé exemple-agentique appartient à tools.spec (assertion avant
  // approbation : le fichier ne doit PAS exister).
  const wsName = `e2e-confiance-${Date.now().toString(36)}`
  const title = `Confiance ${wsName}`
  const box0 = page.getByLabel('Message')
  await box0.fill(`/new ${title}`)
  await box0.press('Enter')
  const dlg = page.locator('[data-test="new-session-dialog"]')
  await dlg.waitFor({ state: 'visible' })
  await dlg.locator('[data-test="ws-mode-new"]').click()
  await dlg.locator('[data-test="new-ws-name"]').fill(wsName)
  await dlg.locator('[data-test="create-session-btn"]').click()
  await expect(dlg).toHaveCount(0)
  SCAFFOLDED.push(wsName)

  // Le bandeau permet de changer le niveau EN DIRECT.
  await page.locator('[data-test="security-select"]').selectOption('accept')
  await expect(page.locator('.msg.system').last()).toContainText('Accepter automatiquement')

  // AGENTECRIT : normalement une carte d'approbation — ici, exécution directe.
  const box = page.getByLabel('Message')
  await box.fill('AGENTECRIT écris le livrable en confiance')
  await box.press('Enter')
  const row = page.locator('[data-test="tool-row"]', { hasText: 'write' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('[data-test="approval-card"]')).toHaveCount(0)
  await expect(page.locator('.msg.assistant').last()).toContainText('ECRITURE FAITE', { timeout: 10_000 })

  // Retour à « demander » : la même écriture se MET EN PAUSE (carte).
  await page.locator('[data-test="security-select"]').selectOption('ask')
  await box.fill('AGENTECRIT une seconde écriture sous garde')
  await box.press('Enter')
  await expect(page.locator('[data-test="approval-card"]')).toBeVisible({ timeout: 10_000 })
  // On refuse proprement — la porte est gardée, le tour se termine.
  await page.locator('[data-test="refuse-btn"]').click()
  await expect(page.locator('[data-test="approval-card"]')).toHaveCount(0)
})

test('Paramètres : défaut de sécurité des nouvelles sessions + carte Profiling & logs', async ({ page }) => {
  await page.goto('/')

  // Ouvrir les Paramètres, régler le défaut sur « accepter ».
  await page.locator('[data-test="settings-btn"]').click()
  const settings = page.locator('[data-test="settings-panel"]')
  await expect(settings).toBeVisible()
  await page.locator('[data-test="default-security-accept"]').click()
  await page.locator('[data-test="settings-close"]').click()

  // Une nouvelle session naît avec ce défaut.
  const title = `Défaut confiance ${Date.now()}`
  const box = page.getByLabel('Message')
  await box.fill(`/new ${title}`)
  await box.press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await dialog.waitFor({ state: 'visible' })
  await expect(dialog.locator('[data-test="security-level"]')).toHaveValue('accept')
  await dialog.locator('[data-test="security-level"]').selectOption('ask') // remis pour la suite
  await dialog.locator('[data-test="create-session-btn"]').click()
  await expect(dialog).toHaveCount(0)

  // La carte Profiling & logs : dossier + le trio de journaux.
  await page.locator('[data-test="settings-btn"]').click()
  await expect(settings).toBeVisible()
  await expect(page.locator('[data-test="logs-table"]')).toBeVisible()
  await expect(page.locator('[data-test="logs-row"]')).toHaveCount(3)
  await expect(page.locator('[data-test="logs-dir"]')).toContainText('.logs')
  // La queue d'un journal s'affiche.
  await page.locator('[data-test="logs-row"]', { hasText: 'session.jsonl' }).locator('button').click()
  await expect(page.locator('[data-test="log-tail"]')).toContainText('session.jsonl', { timeout: 10_000 })

  // Remettre le défaut sur « demander » (les autres specs partent de là).
  await page.locator('[data-test="default-security-ask"]').click()
  await page.locator('[data-test="settings-close"]').click()
})

test('le scaffold complet naît avec le workspace, tout .md prêt', async ({ page }) => {
  await page.goto('/')
  const name = `e2e-scaffold-${Date.now().toString(36)}`
  const title = `Scaffold complet ${name}`
  const box = page.getByLabel('Message')
  await box.fill(`/new ${title}`)
  await box.press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await dialog.waitFor({ state: 'visible' })
  await dialog.locator('[data-test="ws-mode-new"]').click()
  await dialog.locator('[data-test="new-ws-name"]').fill(name)
  await dialog.locator('[data-test="create-session-btn"]').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-test="ws-banner"]')).toContainText(name)
  SCAFFOLDED.push(name)

  // L'arbre complet existe sur le disque : 14 fichiers, chaque template prêt.
  const root = join(import.meta.dirname, '../../../examples/workspaces', name)
  for (const rel of [
    'CONTEXT.md',
    'inbox/CONTEXT.md',
    'notes/CONTEXT.md',
    'notes/plan.md',
    'notes/tasks.md',
    'notes/journal.md',
    'notes/decisions.md',
    'research/CONTEXT.md',
    'research/sources.md',
    'memory/CONTEXT.md',
    'memory/core.md',
    'memory/lessons.md',
    'outputs/CONTEXT.md',
    'archive/CONTEXT.md',
  ]) {
    expect(existsSync(join(root, rel)), rel).toBe(true)
  }
  expect(readFileSync(join(root, 'memory', 'core.md'), 'utf8')).toContain('Mémoire vive')

  // L'ICM charge les 7 CONTEXT.md : le modèle voit toute la carte.
  const icm = await page.request.get(`/workspaces/${name}/icm`)
  expect(icm.ok()).toBe(true)
  const icmBody = await icm.json()
  expect(icmBody.contexts).toHaveLength(7)
  expect(icmBody.system).toContain('notes/plan.md')
})
