// M20/M21 — LE MENTOR + LE CONTRAT D'APPELS, de bout en bout sur l'app
// réelle (maquette amont) : un modèle qui saute le thinking, n'instruit pas
// le title de son appel et n'annonce pas son plan (les écarts EXACTS des
// logs 2026-11-18-ebbe, le contrat M21 en plus) doit voir son groupe
// REFUSÉ — la note [HARNESS — protocole] part au round suivant, vérifiée
// SUR LE FIL (la maquette enregistre les requêtes), dans l'UI (l'onglet
// Activité montre le rappel sur la carte du round), et dans model.jsonl
// (le champ feedback de la model.response fautive). La maquette se
// CORRIGE alors : le groupe conforme s'exécute.
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

const MOCK = 'http://127.0.0.1:9801'

test('mentor : l’écart de protocole est renvoyé au modèle, visible et journalisé', async ({ page }) => {
  await page.goto('/')
  const title = `Mentor ${Date.now()}`
  await newSessionViaDialog(page, title)

  // Le tour non conforme : appel sans thinking ni title ni annonce PLAN.
  // M21 — le groupe est REFUSÉ (contrat non tenu), puis la maquette se
  // corrige : l'appel titré et annoncé s'exécute, la conclusion arrive.
  const box = page.getByLabel('Message')
  await box.fill('AGENTNONCONFORME va contre le protocole')
  await box.press('Enter')
  const row = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('.msg.assistant').last()).toContainText('NONCONFORME FAIT', { timeout: 10_000 })

  // SUR LE FIL : la maquette a enregistré les requêtes de CE tour —
  // round 1 sans rappel (le mentor se tait avant l'écart), round 2 avec
  // la note [HARNESS — protocole] en DERNIER message — le refus du
  // contrat, juste après la réponse fautive qu'il corrige.
  const res = await page.request.get(`${MOCK}/__requests`)
  expect(res.ok()).toBe(true)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTNONCONFORME')),
  )
  expect(turn.length).toBeGreaterThanOrEqual(2)
  const r1 = turn[0]!
  const r2 = turn[1]!
  expect((r1.messages ?? []).some((m) => typeof m.content === 'string' && m.content.startsWith('[HARNESS — '))).toBe(false)
  const last = r2.messages.at(-1)
  expect(last?.role).toBe('user')
  expect(String(last?.content)).toContain('[HARNESS — protocole, round 1]')
  expect(String(last?.content)).toContain('<thinking>')
  expect(String(last?.content)).toContain('`title`')
  // M21 — le refus du contrat : le groupe non conforme n'a PAS été exécuté.
  expect(String(last?.content)).toContain('PAS été exécuté')
  expect(String(last?.content)).toContain('RÉÉMETS le groupe complet')
  // Le round refusé n'a produit AUCUN résultat d'outil (rien n'a tourné).
  expect(r2.messages.map((m) => m.role)).not.toContain('tool')

  // DANS L'UI : l'onglet Activité porte le rappel sur la carte du round.
  await page.locator('[data-test="tab-activity"]').click()
  const turnBlock = page.locator('[data-test="act-turn"]').last()
  await turnBlock.locator('.turn-head').click()
  const roundCard = turnBlock.locator('[data-test="act-request"]').first()
  await roundCard.locator('.act-head').click()
  const mentor = roundCard.locator('[data-test="act-mentor"]')
  await expect(mentor).toBeVisible()
  await expect(mentor).toContainText('[HARNESS — protocole, round 1]')

  // DANS LE JOURNAL : model.jsonl porte le refus AVEC la réponse fautive
  // (champ feedback de la model.response du round 1 — M21).
  const listed = await (await page.request.get('/sessions')).json() as { sessions: { id: string; title: string }[] }
  const mine = listed.sessions.find((s) => s.title === title)
  expect(mine).toBeDefined()
  const tailRes = await page.request.get(`/sessions/${mine!.id}/logs/model.jsonl?tail=20`)
  expect(tailRes.ok()).toBe(true)
  const tail = (await tailRes.json()) as { tail: string }
  const refused = tail.tail
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { kind?: string; feedback?: string })
    .find((r) => r.kind === 'model.response' && r.feedback !== undefined)
  expect(refused).toBeDefined()
  expect(refused!.feedback).toContain('[HARNESS — protocole, round 1]')
  expect(refused!.feedback).toContain('PAS été exécuté')
})
