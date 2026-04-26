import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

const TEST_NAMES = ['testridge', 'testpeak', 'testember']

test.describe.configure({ mode: 'serial' })

test.describe('Nicknames Section', () => {
  test.skip(!process.env.KHEF_USE_TEST_ENV, 'Mutates settings — requires test env')
  let apiBase: string

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)
    // Start with clean state
    await retryOn429(() =>
      request.patch(`${apiBase}/settings`, {
        data: {
          'nicknames.preferred': '[]',
          'nicknames.staleDays': '7',
        },
      })
    )
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/assistants/claude-code/nicknames')
    await page.waitForLoadState('networkidle')
  })

  test.afterAll(async ({ request }) => {
    // Clean up: restore nicknames to empty list
    await retryOn429(() =>
      request.patch(`${apiBase}/settings`, {
        data: {
          'nicknames.preferred': '[]',
          'nicknames.staleDays': '7',
        },
      })
    )
  })

  test('should display nicknames section', async ({ page }) => {
    const section = page.locator('[data-testid="nicknames-section"]')
    await expect(section).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should display controls', async ({ page }) => {
    const staleDays = page.locator('[data-testid="nicknames-stale-days"]')
    await expect(staleDays).toBeVisible()

    const minLength = page.locator('[data-testid="nicknames-min-length"]')
    await expect(minLength).toBeVisible()

    const maxLength = page.locator('[data-testid="nicknames-max-length"]')
    await expect(maxLength).toBeVisible()

    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    await expect(addInput).toBeVisible()

    const addButton = page.locator('[data-testid="nicknames-add-button"]')
    await expect(addButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show empty state when no names configured', async ({ page }) => {
    const emptyList = page.locator('[data-testid="nicknames-empty-list"]')
    await expect(emptyList).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should add a name', async ({ page }) => {
    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    const addButton = page.locator('[data-testid="nicknames-add-button"]')

    await addInput.fill(TEST_NAMES[0])
    await addButton.click()

    // Name should appear in the list
    const row = page.locator(`[data-testid="nicknames-row--${TEST_NAMES[0]}"]`)
    await expect(row).toBeVisible()

    // Input should be cleared
    await expect(addInput).toHaveValue('')

    await expectNoVisibleErrors(page)
  })

  test('should add multiple names and display in order', async ({ page, request }) => {
    // Reset to clean state
    await retryOn429(() =>
      request.patch(`${apiBase}/settings`, {
        data: { 'nicknames.preferred': '[]' },
      })
    )
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Add all test names
    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    const addButton = page.locator('[data-testid="nicknames-add-button"]')

    for (const name of TEST_NAMES) {
      await addInput.fill(name)
      await addButton.click()
      await page.waitForTimeout(300)
    }

    // All names should be visible
    for (const name of TEST_NAMES) {
      const row = page.locator(`[data-testid="nicknames-row--${name}"]`)
      await expect(row).toBeVisible()
    }

    // Verify the list has the right count
    const list = page.locator('[data-testid="nicknames-list"]')
    await expect(list).toBeVisible()

    const rows = list.locator('[class*="_nameRow_"]')
    const count = await rows.count()
    expect(count).toBe(TEST_NAMES.length)

    await expectNoVisibleErrors(page)
  })

  test('should not add duplicate names', async ({ page }) => {
    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    const addButton = page.locator('[data-testid="nicknames-add-button"]')

    // Add a name
    await addInput.fill(TEST_NAMES[0])
    await addButton.click()
    await page.waitForTimeout(300)

    // Count rows
    const list = page.locator('[data-testid="nicknames-list"]')
    const countBefore = await list.locator('[class*="_nameRow_"]').count()

    // Try to add the same name again
    await addInput.fill(TEST_NAMES[0])
    await addButton.click()
    await page.waitForTimeout(300)

    const countAfter = await list.locator('[class*="_nameRow_"]').count()
    expect(countAfter).toBe(countBefore)

    await expectNoVisibleErrors(page)
  })

  test('should remove a name', async ({ page }) => {
    // Ensure we have a name to remove
    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    const addButton = page.locator('[data-testid="nicknames-add-button"]')
    await addInput.fill(TEST_NAMES[0])
    await addButton.click()
    await page.waitForTimeout(300)

    const row = page.locator(`[data-testid="nicknames-row--${TEST_NAMES[0]}"]`)
    await expect(row).toBeVisible()

    // Hover to reveal remove button, then click
    await row.hover()
    const removeButton = page.locator(`[data-testid="nicknames-row--${TEST_NAMES[0]}--remove"]`)
    await removeButton.click()
    await page.waitForTimeout(300)

    // Row should be gone
    await expect(row).not.toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should persist names after page reload', async ({ page, request }) => {
    // Reset to clean state
    await retryOn429(() =>
      request.patch(`${apiBase}/settings`, {
        data: { 'nicknames.preferred': '[]' },
      })
    )
    await page.reload()
    await page.waitForLoadState('networkidle')

    const addInput = page.locator('[data-testid="nicknames-add-input"]')
    const addButton = page.locator('[data-testid="nicknames-add-button"]')

    const testName = 'testpersist'
    await addInput.fill(testName)
    await addButton.click()
    await page.waitForTimeout(500)

    // Reload the page
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Name should still be there
    const row = page.locator(`[data-testid="nicknames-row--${testName}"]`)
    await expect(row).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should display stale days incrementer with value', async ({ page }) => {
    const incrementer = page.locator('[data-testid="nicknames-stale-days"]')
    await expect(incrementer).toBeVisible()

    // Should show a numeric value
    const value = await incrementer.locator('[class*="_incrementerValue_"]').textContent()
    const numValue = parseInt(value || '', 10)
    expect(numValue).toBeGreaterThanOrEqual(1)
    expect(numValue).toBeLessThanOrEqual(90)

    await expectNoVisibleErrors(page)
  })
})
