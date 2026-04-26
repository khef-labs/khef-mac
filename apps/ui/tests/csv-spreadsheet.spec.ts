import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

const CSV_CONTENT = `name,department,salary,active
Alice,Engineering,125000,true
Bob,Marketing,95000,true
Carol,Engineering,135000,true
David,Sales,88000,false
Eva,Engineering,142000,true`

test.describe('CSV Spreadsheet Viewer', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'ui-test-csv'
  const TEST_PROJECT_NAME = 'UI Test CSV'

  let apiBase = ''
  let testProjectId = ''
  let memoryId = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Clean up any existing test project
    const listRes = await request.get(`${apiBase}/projects`)
    const listData = await listRes.json().catch(() => null)
    const projects = Array.isArray(listData) ? listData : listData?.projects || []
    const existing = projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE)
    if (existing?.id) {
      await request.delete(`${apiBase}/projects/${existing.id}`)
    }

    // Create test project
    const projRes = await request.post(`${apiBase}/projects`, {
      data: { handle: TEST_PROJECT_HANDLE, name: TEST_PROJECT_NAME },
    })
    const projData = await projRes.json()
    const project = projData?.project || projData
    testProjectId = project.id

    // Create CSV memory
    const memRes = await request.post(`${apiBase}/projects/${testProjectId}/memories`, {
      data: {
        handle: 'csv-test-employees',
        title: 'Test Employee Dataset',
        content: CSV_CONTENT,
        type: 'csv',
      },
    })
    const memData = await memRes.json()
    const memory = memData?.memory || memData
    memoryId = memory.id
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await request.delete(`${apiBase}/projects/${testProjectId}`)
    }
  })

  test('renders spreadsheet table with headers and rows', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Should show Table view by default for CSV
    const table = page.locator('table')
    await expect(table).toBeVisible()

    // Check headers
    const headers = page.locator('[class*="_headerCell_"]')
    await expect(headers).toHaveCount(4)
    await expect(headers.nth(0)).toContainText('name')
    await expect(headers.nth(1)).toContainText('department')
    await expect(headers.nth(2)).toContainText('salary')
    await expect(headers.nth(3)).toContainText('active')

    // Check row count in info bar
    const info = page.locator('[class*="_info_"]')
    await expect(info).toContainText('5 rows')
    await expect(info).toContainText('4 columns')

    await expectNoVisibleErrors(page)
  })

  test('sorts columns on header click', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Click salary header to sort ascending
    const salaryHeader = page.locator('[class*="_headerCell_"]').nth(2)
    await salaryHeader.click()

    // First data row should have lowest salary
    const firstRowSalary = page.locator('tbody tr').first().locator('td').nth(3)
    await expect(firstRowSalary).toContainText('88000')

    // Click again to sort descending
    await salaryHeader.click()
    const firstRowSalaryDesc = page.locator('tbody tr').first().locator('td').nth(3)
    await expect(firstRowSalaryDesc).toContainText('142000')

    await expectNoVisibleErrors(page)
  })

  test('opens filter dropdown and filters by column value', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Click filter button on department column
    const deptHeader = page.locator('[class*="_headerCell_"]').nth(1)
    const filterBtn = deptHeader.locator('[class*="_filterBtn_"]')
    await filterBtn.click()

    // Filter dropdown should appear
    const dropdown = page.locator('[class*="_filterDropdown_"]')
    await expect(dropdown).toBeVisible()

    // Should show unique values
    await expect(dropdown.locator('[class*="_filterCheckLabel_"]')).toHaveCount(4) // select all + 3 departments

    // Uncheck "Select all" to deselect everything
    const selectAll = dropdown.locator('[class*="_filterSelectAll_"] input[type="checkbox"]')
    await selectAll.click()

    // Check only "Engineering"
    const engineeringLabel = dropdown.locator('[class*="_filterList_"] [class*="_filterCheckLabel_"]').filter({ hasText: 'Engineering' })
    await engineeringLabel.locator('input[type="checkbox"]').click()

    // Apply
    await dropdown.locator('[class*="_filterApplyBtn_"]').click()

    // Dropdown should close
    await expect(dropdown).not.toBeVisible()

    // Should show filtered count
    const info = page.locator('[class*="_info_"]')
    await expect(info).toContainText('3 of 5')
    await expect(info).toContainText('filtered')

    // Active filter chip should be visible
    const chip = page.locator('[class*="_filterChip_"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('department')
    await expect(chip).toContainText('1 of 3')

    await expectNoVisibleErrors(page)
  })

  test('clears a filter via chip remove button', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Apply a filter first
    const filterBtn = page.locator('[class*="_headerCell_"]').nth(1).locator('[class*="_filterBtn_"]')
    await filterBtn.click()

    const dropdown = page.locator('[class*="_filterDropdown_"]')
    const selectAll = dropdown.locator('[class*="_filterSelectAll_"] input[type="checkbox"]')
    await selectAll.click()
    const salesLabel = dropdown.locator('[class*="_filterList_"] [class*="_filterCheckLabel_"]').filter({ hasText: 'Sales' })
    await salesLabel.locator('input[type="checkbox"]').click()
    await dropdown.locator('[class*="_filterApplyBtn_"]').click()

    // Verify filter is active
    const chip = page.locator('[class*="_filterChip_"]')
    await expect(chip).toBeVisible()

    // Click remove on the chip
    await chip.locator('[class*="_filterChipRemove_"]').click()

    // Filter should be gone, all rows visible
    await expect(chip).not.toBeVisible()
    const info = page.locator('[class*="_info_"]')
    await expect(info).toContainText('5 rows')

    await expectNoVisibleErrors(page)
  })

  test('filter dropdown search narrows value list', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Open filter on department column
    const filterBtn = page.locator('[class*="_headerCell_"]').nth(1).locator('[class*="_filterBtn_"]')
    await filterBtn.click()

    const dropdown = page.locator('[class*="_filterDropdown_"]')
    const searchInput = dropdown.locator('[class*="_filterSearch_"]')
    await searchInput.fill('eng')

    // Only Engineering should be visible in the list
    const listLabels = dropdown.locator('[class*="_filterList_"] [class*="_filterCheckLabel_"]')
    await expect(listLabels).toHaveCount(1)
    await expect(listLabels.first()).toContainText('Engineering')

    await expectNoVisibleErrors(page)
  })

  test('drag handle is visible on header cells', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Grip handles should exist on all header cells
    const gripHandles = page.locator('[class*="_dragHandle_"]')
    await expect(gripHandles).toHaveCount(4)

    await expectNoVisibleErrors(page)
  })

  test('dragging grip handle reorders columns', async ({ page }) => {
    await page.goto(`/memories/${memoryId}`)
    await page.waitForLoadState('networkidle')

    // Verify initial order
    const headers = page.locator('[class*="_headerCell_"]')
    await expect(headers.nth(0)).toContainText('name')
    await expect(headers.nth(1)).toContainText('department')

    const firstGrip = page.locator('[data-testid="csv-grip--0"]')
    const secondHeader = page.locator('[class*="_headerCell_"]').nth(1)

    await expect(firstGrip).toBeVisible()

    const gripBox = await firstGrip.boundingBox()
    const targetBox = await secondHeader.boundingBox()
    expect(gripBox).toBeTruthy()
    expect(targetBox).toBeTruthy()

    const startX = gripBox!.x + gripBox!.width / 2
    const startY = gripBox!.y + gripBox!.height / 2
    const endX = targetBox!.x + targetBox!.width / 2
    const endY = targetBox!.y + targetBox!.height / 2

    // Fire mousedown directly on the grip span element via page.evaluate
    // This triggers Preact's synthetic event handler reliably
    await page.evaluate((testId) => {
      const el = document.querySelector(`[data-testid="${testId}"]`)
      if (el) {
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
          button: 0,
        }))
      }
    }, 'csv-grip--0')

    // Now use page.mouse.move to fire document-level mousemove events
    // Move in steps to cross the 5px threshold and reach the target header
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        startX + (endX - startX) * (i / steps),
        startY + (endY - startY) * (i / steps),
      )
    }

    // Fire mouseup via page.mouse (document listener will catch it)
    await page.mouse.up()

    await page.waitForTimeout(300)

    // Columns should be reordered: department first, name second
    await expect(headers.nth(0)).toContainText('department')
    await expect(headers.nth(1)).toContainText('name')

    await expectNoVisibleErrors(page)
  })
})
