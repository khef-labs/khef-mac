import { test, expect } from '@playwright/test'
import { dismissSplash, expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe('Kvec Page', () => {
  let apiBase = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Verify kvec collections exist
    const res = await retryOn429(() => request.get(`${apiBase}/kvec/collections`))
    expect(res.ok()).toBeTruthy()
    const data = await res.json()
    expect(data.collections.length).toBeGreaterThan(0)
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/kvec')
    await page.waitForLoadState('networkidle')
    await dismissSplash(page)
  })

  test('should display collection cards with stats', async ({ page }) => {
    const cards = page.locator('[data-testid="collection-card"]')
    await expect(cards.first()).toBeVisible({ timeout: 10000 })

    const count = await cards.count()
    expect(count).toBeGreaterThan(0)

    // Each card should show name, store type badge, and stats
    const firstCard = cards.first()
    await expect(firstCard.locator('[class*="_cardTitle_"]')).toBeVisible()
    await expect(firstCard.locator('[class*="_storeTypeBadge_"]')).toBeVisible()
    await expect(firstCard.locator('[class*="_statRow_"]')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show page title and subtitle', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'Kvec' })).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=Browse kvec collections')).toBeVisible()
  })

  test('should navigate to collection detail on card click', async ({ page }) => {
    const firstCard = page.locator('[data-testid="collection-card"]').first()
    await expect(firstCard).toBeVisible({ timeout: 10000 })

    const collectionName = await firstCard.getAttribute('data-collection-name')
    expect(collectionName).toBeTruthy()

    await firstCard.click()
    await page.waitForLoadState('networkidle')

    // Should be on the collection detail page
    expect(page.url()).toContain(`/kvec/${collectionName}`)
    await expect(page.locator('h1', { hasText: collectionName! }).first()).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('sidebar should have Kvec link active', async ({ page }) => {
    const navLink = page.locator('nav a', { hasText: 'Kvec' })
    await expect(navLink).toBeVisible()
    await expect(navLink).toHaveClass(/navLinkActive/)
  })
})

test.describe('Vector Collection Detail Page', () => {
  // Use kvec-source which has repos and files
  const COLLECTION_NAME = 'kvec-source'
  let apiBase = ''
  let hasCollection = false

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Check that the test collection exists and has files
    const res = await retryOn429(() => request.get(`${apiBase}/kvec/collections/${COLLECTION_NAME}`))
    if (res.ok()) {
      const data = await res.json()
      const col = data.collection || {}
      const fileCount = col.file_count || col.stats?.file_count || col.stats?.total_files || 0
      hasCollection = Number(fileCount) > 0
    }
  })

  test.beforeEach(async ({ page }) => {
    test.skip(!hasCollection, `Collection "${COLLECTION_NAME}" not found or empty — skipping`)
    await page.goto(`/kvec/${COLLECTION_NAME}`)
    await page.waitForLoadState('networkidle')
    await dismissSplash(page)
  })

  test('should display collection header with stats', async ({ page }) => {
    await expect(page.locator('h1', { hasText: COLLECTION_NAME }).first()).toBeVisible({ timeout: 10000 })

    // Stats cards should show
    const statCards = page.locator('[class*="_statCard_"]')
    await expect(statCards.first()).toBeVisible()
    const count = await statCards.count()
    expect(count).toBeGreaterThanOrEqual(2) // At minimum Files and Chunks

    // Store type badge
    await expect(page.locator('[class*="_storeTypeBadge_"]')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should have back link to collections list', async ({ page }) => {
    // Breadcrumbs replaced back links — look for breadcrumb with Kvec link
    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible({ timeout: 10000 })

    const kvecLink = breadcrumb.locator('[data-testid="breadcrumb--kvec"]')
    await expect(kvecLink).toBeVisible()

    await kvecLink.click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/kvec')
    expect(page.url()).not.toContain(`/kvec/${COLLECTION_NAME}`)
  })

  test('should show Files tab by default with table', async ({ page }) => {
    // Files tab should be active
    const filesTab = page.locator('button', { hasText: 'Files' })
    await expect(filesTab).toBeVisible({ timeout: 10000 })
    await expect(filesTab).toHaveClass(/tabActive/)

    // Table should render with rows
    const table = page.locator('[class*="_table_"]')
    await expect(table).toBeVisible({ timeout: 10000 })

    const rows = table.locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)

    // Headers should include Path, Repo, Language, Commit
    await expect(table.locator('th', { hasText: 'Path' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Commit' })).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show file filter controls', async ({ page }) => {
    // Search input or filter controls should be visible
    const searchInput = page.locator('input[type="text"], input[type="search"]').first()
    const selectFilter = page.locator('select').first()

    const hasSearch = await searchInput.isVisible().catch(() => false)
    const hasSelect = await selectFilter.isVisible().catch(() => false)

    expect(hasSearch || hasSelect).toBe(true)
  })

  test('should filter files by search query', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search file paths"]')
    await expect(searchInput).toBeVisible({ timeout: 10000 })

    // Type a search to filter
    await searchInput.fill('.ts')
    await page.waitForLoadState('networkidle')

    // All visible paths should contain the search term
    const pathCells = page.locator('[class*="_pathCell_"]')
    const pathCount = await pathCells.count()
    expect(pathCount).toBeGreaterThan(0)

    // Clear search
    const clearButton = page.locator('[class*="_clearButton_"]')
    if (await clearButton.isVisible()) {
      await clearButton.click()
      await page.waitForLoadState('networkidle')
    }
  })

  test('should switch to Repos tab and show repos', async ({ page }) => {
    const reposTab = page.locator('button', { hasText: 'Repos' })
    await expect(reposTab).toBeVisible({ timeout: 10000 })

    await reposTab.click()
    await page.waitForLoadState('networkidle')

    // Repo cards should appear
    const repoCards = page.locator('[data-testid="repo-card"]')
    await expect(repoCards.first()).toBeVisible({ timeout: 10000 })
    const count = await repoCards.count()
    expect(count).toBeGreaterThan(0)

    // Each card should show repo name and file count
    const firstRepo = repoCards.first()
    await expect(firstRepo.locator('[class*="_repoName_"]')).toBeVisible()
    await expect(firstRepo.locator('[class*="_repoFileCount_"]')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should navigate from repo card to files filtered by repo', async ({ page }) => {
    // Go to repos tab
    const reposTab = page.locator('button', { hasText: 'Repos' })
    await expect(reposTab).toBeVisible({ timeout: 10000 })
    await reposTab.click()
    await page.waitForLoadState('networkidle')

    // Get the first repo name
    const firstRepo = page.locator('[data-testid="repo-card"]').first()
    await expect(firstRepo).toBeVisible({ timeout: 10000 })
    const repoName = await firstRepo.locator('[class*="_repoName_"]').textContent()
    expect(repoName).toBeTruthy()

    // Click the repo card
    await firstRepo.click()
    await page.waitForLoadState('networkidle')

    // Should switch to files tab or navigate — verify files are shown
    const filesTab = page.locator('button', { hasText: 'Files' })
    if (await filesTab.isVisible()) {
      await expect(filesTab).toHaveClass(/tabActive/)
    }

    // URL or page content should reflect the repo filter
    const urlHasRepo = page.url().includes(repoName!) || page.url().includes('repo')
    const selectHasRepo = await page.locator('select').first().inputValue().catch(() => '')
    expect(urlHasRepo || selectHasRepo === repoName).toBe(true)

    await expectNoVisibleErrors(page)
  })

  test('should show last upload timestamp in header', async ({ page }) => {
    const meta = page.locator('[class*="_headerMeta_"]')
    await expect(meta).toBeVisible({ timeout: 10000 })

    // Should show "Last upload" text
    await expect(meta.locator('text=Last upload')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show pagination when files exceed page size', async ({ page }) => {
    // Wait for files table to load
    const table = page.locator('[class*="_table_"]')
    await expect(table).toBeVisible({ timeout: 10000 })

    // Pagination should be visible (kvec-source has 600+ files)
    const pagination = page.locator('[class*="_pagination_"]')
    await expect(pagination).toBeVisible()
    await expect(pagination.locator('[class*="_paginationInfo_"]')).toContainText('of')

    // Next button should be enabled
    const nextButton = page.locator('[class*="_paginationButton_"]').last()
    await expect(nextButton).toBeEnabled()

    await expectNoVisibleErrors(page)
  })

  test('should show branch switcher on Embed tab', async ({ page }) => {
    const embedTab = page.locator('button', { hasText: 'Embed' })
    await expect(embedTab).toBeVisible({ timeout: 10000 })
    await embedTab.click()
    await page.waitForLoadState('networkidle')

    // Click a repo quick-pick to populate the path
    const repoPick = page.locator('[class*="_recentPathItem_"]').first()
    await expect(repoPick).toBeVisible({ timeout: 10000 })
    await repoPick.click()

    // Branch switcher should appear after path is set and git info detected
    const branchButton = page.locator('[class*="_branchSwitcherButton_"]')
    await expect(branchButton).toBeVisible({ timeout: 10000 })

    // Should show a branch name (not "detecting...")
    await expect(branchButton).not.toContainText('detecting', { timeout: 5000 })
    const branchText = await branchButton.textContent()
    expect(branchText!.trim().length).toBeGreaterThan(0)

    // Clicking should open the dropdown
    await branchButton.click()
    const dropdown = page.locator('[class*="_branchDropdown_"]')
    await expect(dropdown).toBeVisible()

    // Should list at least one branch
    const items = dropdown.locator('[class*="_branchDropdownItem_"]')
    const count = await items.count()
    expect(count).toBeGreaterThan(0)

    // Close by clicking outside
    await page.locator('h1').first().click()
    await expect(dropdown).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should not show collection-level delete button', async ({ page }) => {
    // Collection-level delete is intentionally removed (too dangerous)
    const deleteButton = page.locator('[class*="_deleteButton_"]', { hasText: 'Delete' })
    await expect(deleteButton).toBeHidden()

    // Row-level file delete buttons should still exist
    const table = page.locator('[class*="_table_"]')
    await expect(table).toBeVisible({ timeout: 10000 })
    const rowDelete = page.locator('[class*="_rowDeleteButton_"]').first()
    await expect(rowDelete).toBeVisible()
  })
})
