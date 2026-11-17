// Aides e2E partagées — la création de session passe par la boîte de
// dialogue M11 (titre + workspace ICM), jamais par un POST direct.
import { expect } from '@playwright/test'

/**
 * Creates a session through the real dialog: /new (or the sidebar button),
 * title, workspace, create. Resolves when the session is visible+active.
 */
export async function newSessionViaDialog(page, title, { workspace = 'exemple-agentique' } = {}) {
  const box = page.getByLabel('Message')
  await box.fill(`/new ${title}`)
  await box.press('Enter')
  const dialog = page.locator('[data-test="new-session-dialog"]')
  await expect(dialog).toBeVisible()
  await page.locator('[data-test="session-title-input"]').fill(title)
  const select = page.locator('[data-test="ws-select"]')
  if ((await select.count()) > 0 && !(await select.isDisabled())) {
    await select.selectOption(workspace)
  }
  await page.locator('[data-test="create-session-btn"]').click()
  await expect(dialog).toHaveCount(0)
  const item = page.locator('[data-test="session-item"]').filter({ hasText: title })
  await expect(item).toBeVisible()
  await expect(page.locator('.main-head h2')).toContainText(title)
  return item
}
