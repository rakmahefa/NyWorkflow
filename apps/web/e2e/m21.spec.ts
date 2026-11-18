// M21 — LE CONTRAT D'APPELS ET L'ARBRE, de bout en bout sur l'app réelle :
//   1. no_tool : la réponse finale sans outil est SIGNÉE par l'appel unique
//      no_tool (exécuté, journalisé, survivant au rechargement) ;
//   2. le compte annoncé engage : un groupe qui ne tient pas son annonce
//      PLAN: n'est PAS exécuté — le modèle relit et RÉÉMET conforme ;
//   3. l'arbre par round (façon Z.ai) : le thinking titré au-dessus de SON
//      groupe d'appels niché, en live et après rechargement ;
//   4. le repli Firefox : sans l'API native, le bouton Explorer ouvre la
//      sélection de dossier du navigateur — même résolution locate.
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

const MOCK = 'http://127.0.0.1:9801'

test('no_tool : la réponse finale sans outil est signée, exécutée et journalisée', async ({ page }) => {
  await page.goto('/')
  const title = `M21 sans-outil ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTSANSTOOL présente-toi sans aucun outil')
  await box.press('Enter')

  // La ligne no_tool s'exécute (aucune approbation : l'appel ne touche rien)
  // et la prose finale suit dans le même tour — le tour se TERMINE.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'no_tool' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('SANSTOOL RÉPONDU', { timeout: 10_000 })

  // Le journal a gardé l'appel : après rechargement, la ligne no_tool est
  // toujours là (le contrat signé survit au tour).
  await page.reload()
  const replayed = page.locator('[data-test="tool-row"]', { hasText: 'no_tool' }).first()
  await expect(replayed).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })

  // model.jsonl : l'observation du no_tool part au journal (les deux sens du fil).
  const listed = await (await page.request.get('/sessions')).json() as { sessions: { id: string; title: string }[] }
  const mine = listed.sessions.find((s) => s.title === title)
  expect(mine).toBeDefined()
  const tailRes = await page.request.get(`/sessions/${mine!.id}/logs/model.jsonl?tail=20`)
  expect(tailRes.ok()).toBe(true)
  const tail = (await tailRes.json()) as { tail: string }
  expect(tail.tail).toContain('"tool":"no_tool"')
})

test('contrat : le compte annoncé engage — le groupe non conforme est refusé puis réémis', async ({ page }) => {
  await page.goto('/')
  const title = `M21 compte ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTCOMPTEFAUX liste en annonçant deux appels')
  await box.press('Enter')

  // Round 1 : annonce 2, émet 1 → REFUS (aucune ligne d'outil ne naît du
  // groupe fautif) ; round 2 : la maquette se corrige, le groupe annoncé
  // s'exécute. AU BOUT : exactement UNE ligne ls — pas deux.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 15_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('COMPTE CORRIGÉ', { timeout: 15_000 })
  await expect(page.locator('[data-test="tool-row"]', { hasText: 'ls' })).toHaveCount(1)

  // Le pilote voit le refus dans la conversation.
  await expect(page.locator('.msg.system').filter({ hasText: 'Groupe d’appels refusé' })).toHaveCount(1)

  // SUR LE FIL : la note de refus part au round suivant en DERNIER message,
  // avec l'écart exact (annoncé 2, émis 1) et l'ordre de réémettre.
  const res = await page.request.get(`${MOCK}/__requests`)
  expect(res.ok()).toBe(true)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTCOMPTEFAUX')),
  )
  expect(turn.length).toBeGreaterThanOrEqual(2)
  const r2 = turn[1]!
  const last = r2.messages.at(-1)
  expect(last?.role).toBe('user')
  expect(String(last?.content)).toContain('[HARNESS — protocole, round 1]')
  expect(String(last?.content)).toContain('annonçait 2 tool_calls et tu en as émis 1')
  expect(String(last?.content)).toContain('PAS été exécuté')
})

test('arbre : le thinking titré porte son groupe d’appels niché dessous (live et rechargé)', async ({ page }) => {
  await page.goto('/')
  const title = `M21 arbre ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTPARALLELE lis tout d’un coup')
  await box.press('Enter')

  // En live : un bloc round contient le thinking titré ET l'arbre de SES
  // appels (le groupe façon Z.ai niché sous le plan).
  const round = page.locator('[data-test="agent-round"]').first()
  await expect(round).toBeVisible({ timeout: 10_000 })
  await expect(round.locator('[data-test="thinking-block"]')).toHaveCount(1)
  const tree = round.locator('[data-test="round-tree"]')
  await expect(tree).toBeVisible()
  await expect(tree.locator('[data-test="tool-group"]')).toHaveCount(1)
  await expect(page.locator('.msg.assistant').last()).toContainText('PARALLÈLE FAIT', { timeout: 10_000 })

  // Déplier le groupe : ses deux lignes vivent DANS l'arbre du round.
  await tree.locator('.tool-group-head').click()
  await expect(tree.locator('[data-test="tool-row"]')).toHaveCount(2)

  // Après rechargement : le thinking n'est pas journalisé, mais le round
  // et son arbre groupé subsistent (le journal est la vérité).
  await page.reload()
  const replayed = page.locator('[data-test="agent-round"]').first()
  await expect(replayed).toBeVisible({ timeout: 10_000 })
  await expect(replayed.locator('[data-test="round-tree"]')).toBeVisible()
})

test('Explorer sans API native : la sélection de dossier du navigateur (repli Firefox)', async ({ page }) => {
  // Firefox n'a pas window.showDirectoryPicker — on maquette SON absence :
  // le bouton Explorer reste là, et le clic passe par l'entrée de sélection
  // de dossier du navigateur (webkitdirectory). Le « choix » du pilote est
  // simulé : un fichier dont le chemin relatif porte le nom du dossier.
  await page.addInitScript(() => {
    delete window.showDirectoryPicker
  })
  await page.goto('/')
  await page.getByLabel('Message').fill(`/new M21 firefox ${Date.now()}`)
  await page.getByLabel('Message').press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await expect(dialog).toBeVisible()

  await page.locator('[data-test="ws-mode-folder"]').click()
  const explorer = page.locator('[data-test="folder-explorer"]')
  await expect(explorer).toBeVisible()
  // Sans API native, l'entrée de sélection de dossier existe (le repli).
  const input = page.locator('[data-test="folder-input"]')
  await expect(input).toHaveCount(1)

  // Le « choix » : le dossier exemple-agentique, via son chemin relatif.
  await page.evaluate(() => {
    const el = document.querySelector('[data-test="folder-input"]')
    const dt = new DataTransfer()
    const f = new File(['x'], 'a.txt')
    Object.defineProperty(f, 'webkitRelativePath', { value: 'exemple-agentique/sub/a.txt' })
    dt.items.add(f)
    el.files = dt.files
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // Même résolution que le sélecteur natif : locate → un candidat → rempli.
  await expect(page.locator('[data-test="folder-picked"]')).toBeVisible({ timeout: 10_000 })
  const pathValue = await page.locator('[data-test="folder-path-input"]').inputValue()
  expect(pathValue).toContain('exemple-agentique')
})
