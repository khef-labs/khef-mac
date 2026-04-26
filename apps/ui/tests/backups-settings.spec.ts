import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors } from './utils/test-helpers'

test.describe('Backups settings pages', () => {
  test('sidebar Backups group lists Database and Session Files', async ({ page }) => {
    await page.goto('/settings/database-backups')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="section-nav--database-backups"]')).toBeVisible()
    await expect(page.locator('[data-testid="section-nav--session-files"]')).toBeVisible()

    // Old section keys should no longer exist
    await expect(page.locator('[data-testid="section-nav--backups"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="section-nav--sessions"]')).toHaveCount(0)

    await expectNoVisibleErrors(page)
  })

  test('Database Backups page renders title, stats strip, and pristine action bar', async ({ page }) => {
    await page.goto('/settings/database-backups')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="database-backups--title"]')).toHaveText('Database Backups')
    await expect(page.locator('[data-testid="database-backups--stats"]')).toBeVisible()
    await expect(page.locator('[data-testid="database-backups--pristine-indicator"]')).toBeVisible()
    await expect(page.locator('[data-testid="database-backups--save-button"]')).toBeDisabled()

    await expectNoVisibleErrors(page)
  })

  test('Session Files page renders title, interval select, and stats strip', async ({ page }) => {
    await page.goto('/settings/session-files')
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="session-files--title"]')).toHaveText('Session Files')
    await expect(page.locator('[data-testid="session-files--interval-select"]')).toBeVisible()
    await expect(page.locator('[data-testid="session-files--stats"]')).toBeVisible()
    await expect(page.locator('[data-testid="session-files--pristine-indicator"]')).toBeVisible()
    await expect(page.locator('[data-testid="session-files--save-button"]')).toBeDisabled()

    await expectNoVisibleErrors(page)
  })

  test('editing backup directory flips pristine → modified and Esc reverts', async ({ page }) => {
    await page.goto('/settings/database-backups')
    await page.waitForLoadState('networkidle')

    const input = page.locator('[data-testid="database-backups--location-input"]')
    const originalValue = await input.inputValue()

    await input.fill(`${originalValue}-tmp-edit`)

    await expect(page.locator('[data-testid="database-backups--modified-indicator"]')).toBeVisible()
    await expect(page.locator('[data-testid="database-backups--save-button"]')).toBeEnabled()

    // Sidebar dot should appear for the dirty section
    await expect(
      page.locator('[data-testid="section-nav--database-backups"] [class*="_navLinkDirty_"]')
    ).toBeVisible()

    // Escape reverts back to saved value
    await page.keyboard.press('Escape')
    await expect(input).toHaveValue(originalValue)
    await expect(page.locator('[data-testid="database-backups--pristine-indicator"]')).toBeVisible()
    await expect(page.locator('[data-testid="database-backups--save-button"]')).toBeDisabled()

    await expectNoVisibleErrors(page)
  })

  test('legacy /settings/backups redirects to /settings/database-backups', async ({ page }) => {
    await page.goto('/settings/backups')
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/settings\/database-backups$/)
    await expect(page.locator('[data-testid="database-backups--title"]')).toBeVisible()
  })

  test('legacy /settings/sessions redirects to /settings/session-files', async ({ page }) => {
    await page.goto('/settings/sessions')
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/settings\/session-files$/)
    await expect(page.locator('[data-testid="session-files--title"]')).toBeVisible()
  })
})
