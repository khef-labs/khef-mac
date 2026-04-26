import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe.configure({ mode: 'serial' })
test.describe('Collection Page — Sort Bar', () => {
  let apiBase = ''
  let projectId = ''
  let collectionId = ''
  const memoryIds: string[] = []
  const suffix = Date.now().toString(36)

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Create a test project
    const projRes = await retryOn429(() =>
      request.post(`${apiBase}/projects`, {
        data: { handle: `sort-bar-${suffix}`, name: `Sort Bar Test ${suffix}` },
      })
    )
    const projData = await projRes.json()
    projectId = projData.project?.id
    if (!projectId) throw new Error(`Failed to create project: ${JSON.stringify(projData)}`)

    // Create memories with different titles and types
    const memories = [
      { handle: `alpha-note-${suffix}`, title: 'Alpha note', type: 'user-note' },
      { handle: `beta-decision-${suffix}`, title: 'Beta decision', type: 'decision' },
      { handle: `gamma-todo-${suffix}`, title: 'Gamma todo', type: 'user-todo' },
    ]

    for (const mem of memories) {
      const res = await retryOn429(() =>
        request.post(`${apiBase}/projects/${projectId}/memories`, {
          data: { ...mem, content: `Content for ${mem.title}` },
        })
      )
      const data = await res.json()
      if (!data.memory?.id) throw new Error(`Failed to create memory: ${JSON.stringify(data)}`)
      memoryIds.push(data.memory.id)
    }

    // Create a list-mode collection
    const colRes = await retryOn429(() =>
      request.post(`${apiBase}/projects/${projectId}/collections`, {
        data: { handle: `sort-col-${suffix}`, name: 'Sort Test Collection', view_mode: 'list' },
      })
    )
    const colData = await colRes.json()
    collectionId = colData.collection?.id
    if (!collectionId) throw new Error(`Failed to create collection: ${JSON.stringify(colData)}`)

    // Add memories to collection
    for (const id of memoryIds) {
      await retryOn429(() =>
        request.post(`${apiBase}/projects/${projectId}/collections/${collectionId}/memories`, {
          data: { memory_id: id },
        })
      )
    }
  })

  test.afterAll(async ({ request }) => {
    if (!apiBase || !projectId) return
    if (collectionId) {
      await request.delete(`${apiBase}/projects/${projectId}/collections/${collectionId}`)
    }
    for (const id of memoryIds) {
      await request.delete(`${apiBase}/projects/${projectId}/memories/${id}`)
    }
    await request.delete(`${apiBase}/projects/${projectId}`)
  })

  test('should render sort bar with all fields', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('sort-bar--position')).toBeVisible()
    await expect(page.getByTestId('sort-bar--title')).toBeVisible()
    await expect(page.getByTestId('sort-bar--type')).toBeVisible()
    await expect(page.getByTestId('sort-bar--status')).toBeVisible()
    await expect(page.getByTestId('sort-bar--updated_at')).toBeVisible()
    await expect(page.getByTestId('sort-bar--created_at')).toBeVisible()
    await expect(page.getByTestId('sort-bar--added_at')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should default to Order sort with active styling', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    const orderBtn = page.getByTestId('sort-bar--position')
    await expect(orderBtn).toHaveAttribute('aria-pressed', 'true')

    const titleBtn = page.getByTestId('sort-bar--title')
    await expect(titleBtn).toHaveAttribute('aria-pressed', 'false')

    await expectNoVisibleErrors(page)
  })

  test('should sort by title when clicked', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('sort-bar--title').click()
    await expect(page.getByTestId('sort-bar--title')).toHaveAttribute('aria-pressed', 'true')

    // Items should be in alphabetical order: Alpha, Beta, Gamma
    const titles = page.locator('[class*="_memoryTitle_"]')
    await expect(titles.first()).toBeVisible()
    const texts = await titles.allTextContents()
    expect(texts[0]).toContain('Alpha')
    expect(texts[1]).toContain('Beta')
    expect(texts[2]).toContain('Gamma')

    await expectNoVisibleErrors(page)
  })

  test('should reverse sort direction on second click', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    const titleBtn = page.getByTestId('sort-bar--title')

    // First click: asc (Alpha, Beta, Gamma)
    await titleBtn.click()
    await expect(page.locator('[class*="_memoryTitle_"]').first()).toBeVisible()
    let titles = await page.locator('[class*="_memoryTitle_"]').allTextContents()
    expect(titles[0]).toContain('Alpha')
    expect(titles[2]).toContain('Gamma')

    // Second click: desc (Gamma, Beta, Alpha)
    await titleBtn.click()
    titles = await page.locator('[class*="_memoryTitle_"]').allTextContents()
    expect(titles[0]).toContain('Gamma')
    expect(titles[2]).toContain('Alpha')

    await expectNoVisibleErrors(page)
  })

  test('should hide reorder buttons when not in manual order', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    // In default Order sort, reorder buttons should exist
    const moveBtns = page.locator('button[title="Move up"]')
    await expect(moveBtns.first()).toBeVisible()

    // Switch to Title sort — reorder buttons should disappear
    await page.getByTestId('sort-bar--title').click()
    await expect(moveBtns.first()).toBeHidden()

    // Switch back to Order — reorder buttons return
    await page.getByTestId('sort-bar--position').click()
    await expect(moveBtns.first()).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should sort by type', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    await page.getByTestId('sort-bar--type').click()
    await expect(page.getByTestId('sort-bar--type')).toHaveAttribute('aria-pressed', 'true')

    // Verify types are in sorted order
    const types = page.locator('[class*="_memoryType_"]')
    await expect(types.first()).toBeVisible()
    const typeTexts = await types.allTextContents()
    for (let i = 0; i < typeTexts.length - 1; i++) {
      expect(typeTexts[i].localeCompare(typeTexts[i + 1])).toBeLessThanOrEqual(0)
    }

    await expectNoVisibleErrors(page)
  })

  test('should not show sort bar in board view', async ({ page }) => {
    await page.goto(`/projects/${projectId}/collections/${collectionId}`)
    await page.waitForLoadState('networkidle')

    // Sort bar visible in list view
    await expect(page.getByTestId('sort-bar--position')).toBeVisible()

    // Switch to board view via the view mode toggle
    const boardBtn = page.locator('button[title="Board"]')
    if (await boardBtn.isVisible()) {
      await boardBtn.click()
      await page.waitForLoadState('networkidle')
      // Sort bar should be hidden
      await expect(page.getByTestId('sort-bar--position')).toBeHidden()
    }

    await expectNoVisibleErrors(page)
  })
})
