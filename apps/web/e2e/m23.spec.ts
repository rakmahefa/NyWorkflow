// M23 — LE MODEL CONTROL, de bout en bout sur l'app réelle :
//   1. LE RENONCEMENT : la prose qui déclare « je ne suis pas programmé pour
//      ce type de chose » n'est pas une réponse — le harness la détecte,
//      refuse la fin de tour, renvoie la note d'identité au round suivant ;
//      la maquette se reprend (variante fixed) et livre le travail ;
//   2. LE BRIEFING : le thinking du PREMIER round d'un tour s'ouvre par la
//      ligne EXIGENCE — absente, le feedback la réclame avec le gabarit
//      exact ; la maquette conforme par défaut ne la déclenche jamais.
import { expect, test } from '@playwright/test'
import { newSessionViaDialog } from './helpers.mjs'

const MOCK = 'http://127.0.0.1:9801'

test('renoncement : « je ne suis pas programmé pour ça » n’est pas une réponse — le model control la refuse', async ({ page }) => {
  await page.goto('/')
  const title = `M23 renoncement ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTRENONCE refuse la tâche demandée')
  await box.press('Enter')

  // Le tour ne se termine PAS sur le renoncement : la note de model control
  // part au round suivant, la maquette REPREND le travail — la réponse
  // finale arrive, signée, sans capitulation.
  await expect(page.locator('[data-test="round-message"]').last()).toContainText('RENONCE CORRIGÉ', { timeout: 10_000 })
  const finalRound = page.locator('[data-test="agent-round"]').last()
  await expect(finalRound.locator('[data-test="round-listing"]')).toHaveAttribute('data-kind', 'no_tool')
  await expect(finalRound.locator('[data-test="tool-row"]', { hasText: 'no_tool' })).toHaveAttribute('data-state', 'ok')

  // Le pilote voit que le harness a parlé — une fois, pas plus.
  await expect(page.locator('.msg.system').filter({ hasText: 'Renoncement détecté' })).toHaveCount(1)

  // La prose capitulante du round 1 n'est JAMAIS affichée nue (elle n'était
  // pas signée : le refus du model control précède la demande de signature).
  await expect(page.locator('.chat')).not.toContainText('pas programmé pour faire ce type de chose')

  // Le fil porte la note de model control : l'identité (programmé pour
  // EXACTEMENT ce travail), les trois mouvements (chercher, construire,
  // fabriquer) et la reprise exigée. Le chercheur exige le préfixe
  // [HARNESS — feedback] : le prompt système enseigne désormais les mêmes
  // formules — seule la note du harness les DIT au modèle.
  const res = await page.request.get(`${MOCK}/__requests`)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTRENONCE')),
  )
  expect(turn.length).toBeGreaterThanOrEqual(2)
  const isFeedback = (m: { role: string; content?: unknown }): m is { role: string; content: string } =>
    typeof m.content === 'string' && m.content.startsWith('[HARNESS — feedback')
  const noted = turn.find((r) => (r.messages ?? []).some((m) => isFeedback(m) && m.content.includes('Ta réponse déclare ne pas être programmée')))
  expect(noted).toBeDefined()
  const note = noted!.messages.find((m) => isFeedback(m) && m.content.includes('Ta réponse déclare ne pas être programmée'))!.content
  expect(note).toContain('programmé pour EXACTEMENT ce travail')
  expect(note).toContain('EXIGENCE:')
  expect(note).toContain('navigue ton ICM')
})

test('briefing : la ligne EXIGENCE manque au premier round — le feedback la réclame avec le gabarit', async ({ page }) => {
  await page.goto('/')
  const title = `M23 briefing ${Date.now()}`
  await newSessionViaDialog(page, title)

  const box = page.getByLabel('Message')
  await box.fill('AGENTBRIEFING agit sans estimer l’exigence')
  await box.press('Enter')

  // Le tour se déroule normalement (l'appel s'exécute, la réponse finale
  // arrive signée) — l'écart est une question de FORME, pas de contrat.
  const row = page.locator('[data-test="tool-row"]', { hasText: 'ls' }).first()
  await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 10_000 })
  await expect(page.locator('[data-test="round-message"]').last()).toContainText('BRIEFING NOTÉ', { timeout: 10_000 })

  // Mais le feedback engine a réclamé la ligne de briefing au round suivant
  // (le préfixe [HARNESS — distingue la note du prompt système, qui
  // enseigne lui aussi la ligne EXIGENCE).
  const res = await page.request.get(`${MOCK}/__requests`)
  const { requests } = (await res.json()) as { requests: { messages: { role: string; content?: unknown }[] }[] }
  const turn = requests.filter((r) =>
    (r.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('AGENTBRIEFING')),
  )
  const isFeedback = (m: { role: string; content?: unknown }): m is { role: string; content: string } =>
    typeof m.content === 'string' && m.content.startsWith('[HARNESS — feedback')
  const noted = turn.find((r) => (r.messages ?? []).some((m) => isFeedback(m) && m.content.includes('ligne de BRIEFING')))
  expect(noted).toBeDefined()
  const note = noted!.messages.find((m) => isFeedback(m) && m.content.includes('ligne de BRIEFING'))!.content
  expect(note).toContain('EXIGENCE:')
  expect(note).toContain('estime AVANT d’agir')

  // Le round fautif porte sa carte de feedback (phase 5) dans l'UI.
  const feedbackCard = page.locator('[data-test="round-feedback"]').first()
  await expect(feedbackCard).toBeVisible()
  await feedbackCard.locator('.round-feedback-head').click()
  await expect(feedbackCard.locator('.round-feedback-body')).toContainText('ligne de BRIEFING')
})
