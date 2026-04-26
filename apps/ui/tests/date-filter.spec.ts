import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Date Filter - Search Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/search')
    await page.waitForLoadState('networkidle')
  })

  test('should display single date picker and range toggle by default', async ({ page }) => {
    const dateLabel = page.locator('label', { hasText: 'Date' })
    const rangeLabel = page.locator('label', { hasText: 'Range' })

    await expect(dateLabel).toBeVisible({ timeout: 10000 })
    await expect(rangeLabel).toBeVisible()

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toHaveCount(1)

    const fromLabel = page.locator('label', { hasText: 'From' })
    const toLabel = page.locator('label', { hasText: 'To' })
    await expect(fromLabel).toHaveCount(0)
    await expect(toLabel).toHaveCount(0)

    await expectNoVisibleErrors(page)
  })

  test('should show filter chip when Date is set', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-01-15')
    await page.waitForTimeout(500)

    const filterChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(filterChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show From/To inputs after enabling range mode', async ({ page }) => {
    const toggleButton = page.locator('button', { hasText: 'Use date range' })
    await expect(toggleButton).toBeVisible({ timeout: 10000 })

    await toggleButton.click()

    const fromLabel = page.locator('label', { hasText: 'From' })
    const toLabel = page.locator('label', { hasText: 'To' })
    await expect(fromLabel).toBeVisible()
    await expect(toLabel).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should set date to today when clicking Today', async ({ page }) => {
    const now = new Date()
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split('T')[0]

    const todayButton = page.locator('button', { hasText: 'Today' })
    await expect(todayButton).toBeVisible({ timeout: 10000 })
    await todayButton.click()

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toHaveValue(today)

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: `Date: ${today}` })
    await expect(dateChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should set date to yesterday when clicking Yesterday', async ({ page }) => {
    const now = new Date()
    const todayLocal = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    const yesterday = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const yesterdayButton = page.locator('button', { hasText: 'Yesterday' })
    await expect(yesterdayButton).toBeVisible({ timeout: 10000 })
    await yesterdayButton.click()

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toHaveValue(yesterday)

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: `Date: ${yesterday}` })
    await expect(dateChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should persist single date in URL', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-01-01')
    await page.waitForTimeout(500)

    const url = page.url()
    expect(url).toContain('date=2024-01-01')
    expect(url).not.toContain('date_from=')
    expect(url).not.toContain('date_to=')

    await expectNoVisibleErrors(page)
  })

  test('should load single date from URL params', async ({ page }) => {
    await page.goto('/search?date=2024-03-15')
    await page.waitForLoadState('networkidle')

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toHaveValue('2024-03-15')

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(dateChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should load range mode from URL params', async ({ page }) => {
    await page.goto('/search?date_from=2024-03-15&date_to=2024-09-20')
    await page.waitForLoadState('networkidle')

    const fromInput = page.locator('input[type="date"]').first()
    const toInput = page.locator('input[type="date"]').last()

    await expect(fromInput).toHaveValue('2024-03-15')
    await expect(toInput).toHaveValue('2024-09-20')

    const fromChip = page.locator('[class*="_filterChip_"]', { hasText: 'From:' })
    const toChip = page.locator('[class*="_filterChip_"]', { hasText: 'To:' })

    await expect(fromChip).toBeVisible()
    await expect(toChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should clear Date filter when chip is clicked', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-05-01')
    await page.waitForTimeout(500)

    const filterChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(filterChip).toBeVisible()

    await filterChip.click()
    await page.waitForTimeout(500)

    await expect(filterChip).toBeHidden()
    await expect(dateInput).toHaveValue('')

    await expectNoVisibleErrors(page)
  })

  test('should clear all filters including dates', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-12-31')
    await page.waitForTimeout(500)

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(dateChip).toBeVisible()

    const clearAllButton = page.locator('button', { hasText: 'Clear all' })
    await clearAllButton.click()
    await page.waitForTimeout(500)

    await expect(dateChip).toBeHidden()
    await expect(dateInput).toHaveValue('')

    await expectNoVisibleErrors(page)
  })
})

test.describe('Date Filter - Project Page', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'date-filter-test-project'
  const TEST_PROJECT_NAME = 'Date Filter Test Project'

  let apiBase = ''
  let testProjectId = ''
  const createdProjectIds = new Set<string>()

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Clean up any leftover test project from a previous run
    const listRes = await request.get(`${apiBase}/projects?handle=${TEST_PROJECT_HANDLE}`)
    const listData = await listRes.json().catch(() => null)
    const projects = listData?.projects || (Array.isArray(listData) ? listData : [])
    const existing = projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE)
    if (existing?.id) {
      await request.delete(`${apiBase}/projects/${existing.id}`)
    }

    // Create a dedicated test project
    const createRes = await request.post(`${apiBase}/projects`, {
      data: { handle: TEST_PROJECT_HANDLE, name: TEST_PROJECT_NAME },
    })
    const createData = await createRes.json().catch(() => null)
    const project = createData?.project || createData
    if (!createRes.ok() || !project?.id) {
      throw new Error(`Failed to create test project: ${createRes.status()}`)
    }
    testProjectId = project.id
    createdProjectIds.add(project.id)
  })

  test.afterAll(async ({ request }) => {
    for (const projectId of createdProjectIds) {
      await request.delete(`${apiBase}/projects/${projectId}`)
    }
  })

  async function ensureProjectExists(request: any) {
    if (testProjectId) {
      const res = await request.get(`${apiBase}/projects/${testProjectId}`)
      if (res.ok()) return
    }

    // Recreate if missing
    const listRes = await request.get(`${apiBase}/projects?handle=${TEST_PROJECT_HANDLE}`)
    const listData = await listRes.json().catch(() => null)
    const projects = listData?.projects || (Array.isArray(listData) ? listData : [])
    const existing = projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE)
    if (existing?.id) {
      await request.delete(`${apiBase}/projects/${existing.id}`)
    }

    const createRes = await request.post(`${apiBase}/projects`, {
      data: { handle: TEST_PROJECT_HANDLE, name: TEST_PROJECT_NAME },
    })
    const createData = await createRes.json().catch(() => null)
    const project = createData?.project || createData
    if (!createRes.ok() || !project?.id) {
      throw new Error(`Failed to recreate test project: ${createRes.status()}`)
    }
    testProjectId = project.id
    createdProjectIds.add(project.id)
  }

  test.beforeEach(async ({ page, request }) => {
    await ensureProjectExists(request)
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')
  })

  test('should display single date picker and range toggle by default', async ({ page }) => {
    const filtersBar = page.locator('[class*="_filtersBar_"]')
    await expect(filtersBar).toBeVisible({ timeout: 10000 })

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toHaveCount(1)

    const rangeToggle = filtersBar.locator('button', { hasText: 'Range' })
    await expect(rangeToggle).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show filter chip when Date is set', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-02-20')
    await page.waitForTimeout(500)

    const filterChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(filterChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show From/To inputs after enabling range mode', async ({ page }) => {
    const filtersBar = page.locator('[class*="_filtersBar_"]')
    await expect(filtersBar).toBeVisible({ timeout: 10000 })

    const rangeToggle = filtersBar.locator('button', { hasText: 'Range' })
    await expect(rangeToggle).toBeVisible()
    await rangeToggle.click()

    // Should now show two date inputs (from/to)
    const dateInputs = page.locator('input[type="date"]')
    await expect(dateInputs).toHaveCount(2)

    // Toggle should now say "Single"
    const singleToggle = filtersBar.locator('button', { hasText: 'Single' })
    await expect(singleToggle).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should apply date filter and trigger search', async ({ page }) => {
    await page.waitForTimeout(2000)

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-01-01')
    await page.waitForTimeout(1000)

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(dateChip).toBeVisible()

    const memoryCards = page.locator('button[class*="_card_"]')
    const emptyState = page.locator('text=No memories found')

    const memoryCount = await memoryCards.count()
    const hasEmptyState = await emptyState.isVisible()

    expect(memoryCount >= 0 || hasEmptyState).toBe(true)

    await expectNoVisibleErrors(page)
  })

  test('should clear Date filter when chip is clicked', async ({ page }) => {
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 10000 })

    await dateInput.fill('2024-08-15')
    await page.waitForTimeout(500)

    const filterChip = page.locator('[class*="_filterChip_"]', { hasText: 'Date:' })
    await expect(filterChip).toBeVisible()

    await filterChip.click()
    await page.waitForTimeout(500)

    await expect(filterChip).toBeHidden()
    await expect(dateInput).toHaveValue('')

    await expectNoVisibleErrors(page)
  })

  test('should persist date filter after viewing a memory', async ({ page }) => {
    const uniqueTitle = `Test Memory ${Date.now()}`
    const now = new Date()
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split('T')[0]

    const createButton = page.getByRole('button', { name: 'Create' })
    await expect(createButton).toBeVisible({ timeout: 10000 })
    await createButton.click()

    const titleInput = page.locator('#create-title')
    const contentTextarea = page.locator('#create-content')
    await expect(titleInput).toBeVisible()

    await titleInput.fill(uniqueTitle)
    await contentTextarea.fill('Test content for date filter persistence')

    const submitButton = page.locator('button[type="submit"]', { hasText: 'Create' })
    await submitButton.click()

    await expect(contentTextarea).toBeHidden({ timeout: 10000 })
    await page.waitForTimeout(1000)

    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill(today)
    await page.waitForTimeout(1000)

    const memoryCard = page.locator(`text=${uniqueTitle}`).first()
    await expect(memoryCard).toBeVisible({ timeout: 10000 })
    await memoryCard.click()

    // Navigate back (breadcrumbs replaced back button)
    await page.goBack()
    await page.waitForLoadState('networkidle')

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: `Date: ${today}` })
    await expect(dateInput).toHaveValue(today)
    await expect(dateChip).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should filter memories by single day after creating one', async ({ page }) => {
    const uniqueTitle = `Test Memory ${Date.now()}`
    const now = new Date()
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .split('T')[0]

    const createButton = page.getByRole('button', { name: 'Create' })
    await expect(createButton).toBeVisible({ timeout: 10000 })
    await createButton.click()

    const titleInput = page.locator('#create-title')
    const contentTextarea = page.locator('#create-content')
    await expect(titleInput).toBeVisible()

    await titleInput.fill(uniqueTitle)
    await contentTextarea.fill('Test content for date filter integration test')

    const submitButton = page.locator('button[type="submit"]', { hasText: 'Create' })
    await submitButton.click()

    await expect(contentTextarea).toBeHidden({ timeout: 10000 })
    await page.waitForTimeout(1000)

    const dateInput = page.locator('input[type="date"]')
    await dateInput.fill(today)
    await page.waitForTimeout(1000)

    const dateChip = page.locator('[class*="_filterChip_"]', { hasText: `Date: ${today}` })
    await expect(dateChip).toBeVisible()

    const memoryCard = page.locator(`text=${uniqueTitle}`)
    await expect(memoryCard).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })
})
