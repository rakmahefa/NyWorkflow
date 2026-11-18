// M22 — LES CINQ PHASES DU TOUR, de bout en bout sur l'app réelle :
//   1. la conversation montre les phases dans le round : thinking, listing
//      (« Plan : 2 appels — … »), message [MESSAGE], arbre des appels ;
//   2. le miss ne s'affiche JAMAIS : la prose sans en-tête est droppée, le
//      bloc d'appel mal formé n'est ni décodé ni exécuté — mais le feedback
//      engine dit TOUT au modèle (drops, format exact, incohérences) ;
//   3. la SIGNATURE : une prose sans no_tool ne termine pas le tour — le
//      feedback la réclame, le modèle signe, le tour finit proprement ;
//   4. « Utiliser ce dossier » : la sélection explicite dans le dialogue
//      nouvelle session — naviguer ne suffit plus, utiliser applique.
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

const MOCK = 'http://127.0.0.1:9801'

test('cinq phases : le round affiche thinking, listing, message et son arbre d’appels', async ({ page }) => {
  await page.goto('/')
  const title = `M22 phases ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPROTOCOL joue les cinq phases')
  await box.press('Enter')

  // Phase 1 — le thinking titré ouvre le round.
  const round = page.locator('[data-test="agent-round"]').first()
  await expect(round).toBeVisible({ timeout: 10_000 })
  await expect(round.locator('[data-test="thinking-block"]')).toHaveCount(1)

  // Phase 2 — la ligne de listing : le contrat annoncé avec ses titres.
  const listing = round.locator('[data-test="round-listing"]')
  await expect(listing).toBeVisible()
  await expect(listing).toHaveAttribute('data-kind', 'calls')
  await expect(listing).toContainText('Plan : 2 appels')
  await expect(listing).toContainText('Relire la charte')

  // Phase 3 — le message en-têté : la prose du pilote, sans les en-têtes.
  const message = round.locator('[data-test="round-message"]')
  await expect(message).toBeVisible()
  await expect(message).toContainText('Je relis la charte et cartographie les notes.')
  await expect(message).not.toContainText('[MESSAGE]')

  // Phase 4 — l'arbre des appels, groupé, avec statuts.
  const tree = round.locator('[data-test="round-tree"]')
  await expect(tree).toBeVisible()
  await expect(tree.locator('[data-test="tool-group"]')).toHaveCount(1)

  // La réponse finale arrive SIGNÉE : son round porte le listing no_tool,
  // sa prose dans [MESSAGE] et la ligne no_tool exécutée.
  const finalRound = page.locator('[data-test="agent-round"]').last()
  await expect(finalRound.locator('[data-test="round-listing"]')).toHaveAttribute('data-kind', 'no_tool', { timeout: 10_000 })
  await expect(finalRound.locator('[data-test="round-message"]')).toContainText('PROTOCOLE CINQ PHASES')
  const noToolRow = finalRound.locator('[data-test="tool-row"]', { hasText: 'no_tool' })
  await expect(noToolRow).toHaveAttribute('data-state', 'ok')
})

test('drops : la prose sans en-tête ne s’affiche pas, le feedback la signale au modèle', async ({ page }) => {
  await page.goto('/')
  const title = `M22 prose ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPROSEPERDUE parle à côté des sections')
  await box.press('Enter')

  // L'appel valide s'exécute et la réponse finale arrive.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('[data-test="round-message"]').last()).toContainText('PROSE REPLACÉE', { timeout: 10_000 })

  // Le miss ne s'affiche NULLE PART dans la conversation.
  await expect(page.locator('.chat')).not.toContainText('Une prose perdue hors section')

  // Mais le feedback engine l'a dit au modèle, SUR LE FIL.
  const res = await page.request.get(`${MOCK}/__requests`)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTPROSEPERDUE')),
  )
  const noted = turn.find((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('DROPPÉS (jamais affichés au pilote)')),
  )
  expect(noted).toBeDefined()

  // Et dans le journal : les drops du round (model.jsonl, phases.droppedChars).
  const listed = await (await page.request.get('/sessions')).json() as { sessions: { id: string; title: string }[] }
  const mine = listed.sessions.find((s) => s.title === title)
  expect(mine).toBeDefined()
  const tailRes = await page.request.get(`/sessions/${mine!.id}/logs/model.jsonl?tail=20`)
  const tail = (await tailRes.json()) as { tail: string }
  expect(tail.tail).toContain('"droppedChars"')
})

test('malformé : le bloc cassé n’est jamais exécuté, le feedback rappelle le FORMAT EXACT', async ({ page }) => {
  await page.goto('/')
  const title = `M22 malformé ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTMALFORME casse son bloc d’appel')
  await box.press('Enter')

  // Le VRAI appel s'exécute (le bloc cassé, lui, n'existe nulle part).
  const row = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('[data-test="tool-row"]')).toHaveCount(1)
  await expect(page.locator('[data-test="round-message"]').last()).toContainText('MALFORMÉ CORRIGÉ', { timeout: 10_000 })

  // Le feedback engine a droppé le bloc ET rappelé le format exact.
  const res = await page.request.get(`${MOCK}/__requests`)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTMALFORME')),
  )
  const noted = turn.find((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('bloc d’appel mal formé')),
  )
  expect(noted).toBeDefined()
  const note = (noted!.messages.find((m) => typeof m.content === 'string' && (m.content as string).includes('bloc d’appel mal formé'))?.content ?? '') as string
  expect(note).toContain('{{tool {"name": "ls", "arguments":')

  // Le journal compte le bloc cassé (phases.brokenToolBlocks).
  const listed = await (await page.request.get('/sessions')).json() as { sessions: { id: string; title: string }[] }
  const mine = listed.sessions.find((s) => s.title === title)
  const tailRes = await page.request.get(`/sessions/${mine!.id}/logs/model.jsonl?tail=20`)
  const tail = (await tailRes.json()) as { tail: string }
  expect(tail.tail).toContain('"brokenToolBlocks"')
})

test('signature : une prose sans no_tool ne termine pas le tour — le feedback la réclame', async ({ page }) => {
  await page.goto('/')
  const title = `M22 signature ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTNONSIGNE répond sans signer')
  await box.press('Enter')

  // Le tour ne s'arrête PAS sur la prose nue : le feedback réclame la
  // signature, la maquette signe — la réponse finale arrive, signée.
  await expect(page.locator('[data-test="round-message"]').last()).toContainText('NONSIGNÉ CORRIGÉ', { timeout: 10_000 })
  const finalRound = page.locator('[data-test="agent-round"]').last()
  await expect(finalRound.locator('[data-test="round-listing"]')).toHaveAttribute('data-kind', 'no_tool')
  await expect(finalRound.locator('[data-test="tool-row"]', { hasText: 'no_tool' })).toHaveAttribute('data-state', 'ok')

  // Le pilote voit que le harness a parlé, et le fil porte la réclamation.
  await expect(page.locator('.msg.system').filter({ hasText: 'non signée' })).toHaveCount(1)
  const res = await page.request.get(`${MOCK}/__requests`)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTNONSIGNE')),
  )
  expect(turn.length).toBeGreaterThanOrEqual(2)
  const nudge = turn[1]!.messages.at(-1)
  expect(String(nudge?.content)).toContain('[HARNESS — feedback]')
  expect(String(nudge?.content)).toContain('n’est pas SIGNÉE')

  // La prose nue du round 1 n'est JAMAIS affichée (le miss ne se liste pas).
  await expect(page.locator('.chat')).not.toContainText('Réponse (maquette)')
})

test('« Utiliser ce dossier » : la sélection explicite du dossier du disque', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Message').fill(`/new M22 utiliser ${Date.now()}`)
  await page.getByLabel('Message').press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await expect(dialog).toBeVisible()

  // Mode « Dossier du disque » — la liste charge (navigation possible)…
  await page.locator('[data-test="ws-mode-folder"]').click()
  await expect(page.locator('[data-test="folder-list"]')).toBeVisible({ timeout: 10_000 })

  // …mais naviguer ne sélectionne RIEN : la création refuse, en guidant.
  await page.locator('[data-test="create-session-btn"]').click()
  await expect(page.locator('[data-test="dialog-error"]')).toContainText('Utiliser ce dossier')

  // « Utiliser ce dossier » applique la sélection : chemin retenu, nom
  // rempli, confirmation visible — puis la session vit DANS ce dossier.
  await page.locator('[data-test="folder-use"]').click()
  await expect(page.locator('[data-test="folder-picked"]')).toContainText('il sera utilisé par la session')
  await expect(page.locator('[data-test="folder-ws-name"]').inputValue()).not.toBe('')

  // Une rangée « Utiliser » prend le sous-dossier directement, sans naviguer.
  const rowBtn = page.locator('[data-test="folder-choose"]').first()
  if (await rowBtn.count()) {
    await rowBtn.click()
    await expect(page.locator('[data-test="folder-picked"]')).toContainText('il sera utilisé par la session')
  }
})
