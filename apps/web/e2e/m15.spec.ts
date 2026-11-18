import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

// M15 — le protocole deux temps, de bout en bout dans l'UI réelle contre la
// maquette passerelle (qui parle le protocole : thinking titré DANS le
// contenu, tool_calls avec leur argument `title`) :
//   - le thought process ouvre la réponse, titré et repliable ;
//   - la balise coupée en plein milieu du flux est recousue (jamais visible) ;
//   - les tool_calls d'un même tour sont GROUPÉS en une carte repliable ;
//   - chaque ligne d'appel porte le TITRE que le modèle a rempli ;
//   - le titre des appels survit au rechargement (journal → hydratation).
//
// La maquette émet le protocole sur TOUTES ses réponses hors PENSE (le
// marqueur PENSE reste le modèle « canal natif », testé en M12) : la
// moindre réponse sans outil vérifie donc déjà le deux-temps. Ici on
// pousse jusqu'aux groupes d'actions et à la persistance.

test('deux temps : thinking titré ouvre la réponse, replié puis rouvert', async ({ page }) => {
  await page.goto('/')
  const title = `Deux temps ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('présente-moi le projet')
  await box.press('Enter')

  // Le bloc titré apparaît (l'attribut data-title porte le titre du protocole).
  const thinking = page.locator('[data-test="thinking-block"]')
  await expect(thinking.first()).toBeVisible({ timeout: 10_000 })
  await expect(thinking.first()).toHaveAttribute('data-title', 'Comprendre la demande')

  // La réponse visible suit HORS du thought process — les balises ni le
  // dialogue interne ne fuient dans le texte (la balise fermante arrive
  // coupée en deux morceaux : le splitter la recoud).
  await expect(page.locator('.msg.assistant').last()).toContainText("NyWorkflow charge l'ICM", { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).not.toContainText('<thinking')

  // Replié d'office une fois la réponse partie, rouvert d'un clic.
  await expect(thinking.first().locator('.thinking-body')).toHaveCount(0, { timeout: 5_000 })
  await thinking.first().locator('.thinking-head').click()
  await expect(thinking.first().locator('.thinking-body')).toContainText('ICM')
  await expect(thinking.first().locator('.thinking-head')).toContainText('Comprendre la demande')
})

test('groupe d’actions : tool_calls groupés, titrés, repliables', async ({ page }) => {
  await page.goto('/')
  const title = `Groupe ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPROTOCOL cartographie tout')
  await box.press('Enter')

  // Les DEUX appels du tour atterrissent dans UNE carte de groupe.
  const group = page.locator('[data-test="tool-group"]')
  await expect(group.first()).toBeVisible({ timeout: 10_000 })
  await expect(group).toHaveCount(1)
  await expect(group.first()).toHaveAttribute('data-count', '2')

  // Le thinking titré du tour d'actions est là, lui aussi.
  await expect(page.locator('[data-test="thinking-block"]').first()).toHaveAttribute('data-title', 'Planifier le tour')

  // Exécutés en parallèle (les deux se règlent), la réponse finale conclut.
  // M18 : le groupe réglé se replie DE LUI-MÊME — le titre agrégé dit
  // l'intention (« 1 fichier lu · 1 recherche de fichiers »), le compteur
  // dit le verdict.
  await expect(group.first()).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(group.first().locator('.tool-group-meta')).toContainText('2 ✓')
  await expect(group.first()).toContainText('1 fichier lu')
  await expect(group.first()).toContainText('1 recherche de fichiers')
  await expect(page.locator('.msg.assistant').last()).toContainText('PROTOCOLE CINQ PHASES', { timeout: 10_000 })
  await expect(group.first().locator('[data-test="tool-row"]')).toHaveCount(0) // replié d'office

  // Un clic ouvre l'arbre : chaque ligne porte le titre que le modèle a
  // rempli dans ses arguments.
  await group.first().locator('.tool-group-head').click()
  const read = group.locator('[data-test="tool-row"]', { hasText: 'read' })
  const glob = group.locator('[data-test="tool-row"]', { hasText: 'glob' })
  await expect(read).toHaveAttribute('data-title', 'Relire la charte')
  await expect(glob).toHaveAttribute('data-title', 'Cartographier les notes')
  await expect(read).toContainText('Relire la charte')
  await expect(glob).toContainText('Cartographier les notes')

  // La carte se replie d'un clic — les lignes disparaissent, le titre reste.
  await group.first().locator('.tool-group-head').click()
  await expect(group.first().locator('[data-test="tool-row"]')).toHaveCount(0)
  await expect(group.first()).toContainText('1 fichier lu')
  await group.first().locator('.tool-group-head').click()
  await expect(group.first().locator('[data-test="tool-row"]')).toHaveCount(2)
})

test('persistance : le groupe et les titres survivent au rechargement (journal)', async ({ page }) => {
  await page.goto('/')
  const title = `Persisté ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPROTOCOL cartographie encore')
  await box.press('Enter')
  await expect(page.locator('[data-test="tool-group"]').first()).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('PROTOCOLE CINQ PHASES', { timeout: 10_000 })

  // Rechargement : le journal rejoue les tool.call dans l'ordre — le
  // regroupement par adjacence et les titres (arguments journalisés)
  // reconstruisent la même carte. Les suites parallèles partagent le
  // workspace : on RE-SÉLECTIONNE notre session par son titre (l'app
  // ouvre la plus récente, qui peut être celle d'un autre test).
  await page.reload()
  await page.locator('[data-test="session-item"]').filter({ hasText: title }).click()
  const group = page.locator('[data-test="tool-group"]')
  await expect(group.first()).toBeVisible({ timeout: 10_000 })
  await expect(group).toHaveCount(1)
  await expect(group.first()).toHaveAttribute('data-count', '2')
  // M18 : le groupe rejoué est réglé — replié d'office, le titre agrégé
  // reconstitué depuis le journal. Un clic ouvre l'arbre et ses titres.
  await expect(group.first()).toContainText('1 fichier lu')
  await group.first().locator('.tool-group-head').click()
  await expect(group.first().locator('[data-test="tool-row"]', { hasText: 'read' })).toHaveAttribute('data-title', 'Relire la charte')
  await expect(group.first().locator('[data-test="tool-row"]', { hasText: 'glob' })).toHaveAttribute('data-title', 'Cartographier les notes')
})
