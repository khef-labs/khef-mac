import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Graph Visualization', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'ui-test-graph'
  const TEST_PROJECT_NAME = 'UI Test Graph'

  let apiBase = ''
  let testProjectId = ''
  let memoryAId = ''
  let memoryBId = ''
  let diagramHealthy = true

  async function deleteProject(request: any, projectId: string) {
    const res = await request.delete(`${apiBase}/projects/${projectId}`)
    if (!res.ok() && res.status() !== 404) {
      throw new Error(`Failed to delete test project: ${res.status()}`)
    }
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)
    try {
      const healthRes = await request.get(`${apiBase}/diagram/health`)
      diagramHealthy = healthRes.ok()
    } catch {
      diagramHealthy = false
    }
    if (!diagramHealthy) {
      test.skip()
      return
    }

    // Clean up any existing test project
    const listRes = await request.get(`${apiBase}/projects`)
    const listData = await listRes.json().catch(() => null)
    const projects = Array.isArray(listData) ? listData : listData?.projects || []
    const existing = projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE)
    if (existing?.id) {
      await deleteProject(request, existing.id)
    }

    // Create test project
    const projRes = await request.post(`${apiBase}/projects`, {
      data: { handle: TEST_PROJECT_HANDLE, name: TEST_PROJECT_NAME },
    })
    const projData = await projRes.json()
    const project = projData?.project || projData
    testProjectId = project.id

    // Create memory A (decision)
    const memARes = await request.post(`${apiBase}/projects/${testProjectId}/memories`, {
      data: {
        handle: 'graph-test-decision',
        title: 'Graph Test Decision',
        content: 'A decision for graph testing',
        type: 'decision',
      },
    })
    const memAData = await memARes.json()
    memoryAId = (memAData?.memory || memAData).id

    // Create memory B (pattern)
    const memBRes = await request.post(`${apiBase}/projects/${testProjectId}/memories`, {
      data: {
        handle: 'graph-test-pattern',
        title: 'Graph Test Pattern',
        content: 'A pattern for graph testing',
        type: 'pattern',
      },
    })
    const memBData = await memBRes.json()
    memoryBId = (memBData?.memory || memBData).id

    // Create a relation between them
    await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: memoryBId,
        target_memory_id: memoryAId,
        relation_type: 'implements',
      },
    })
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await deleteProject(request, testProjectId)
    }
  })

  test('memory graph page renders with toolbar and viewport', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Graph toolbar should show memory title
    const memoryTitle = page.locator('text=Graph Test Decision').first()
    await expect(memoryTitle).toBeVisible({ timeout: 15000 })

    // Depth selector should exist
    const depthSelect = page.locator('select')
    await expect(depthSelect).toBeVisible()

    // Direction toggle should exist
    const directionButton = page.locator('button', { hasText: /^(LR|TB)$/ })
    await expect(directionButton).toBeVisible()

    // Wait for graph to render (SVG appears in the viewport)
    const svg = page.locator('svg').first()
    await expect(svg).toBeVisible({ timeout: 20000 })

    // Status bar should show node and edge counts
    await expect(page.getByText(/\d+ node/)).toBeVisible()
    await expect(page.getByText(/\d+ edge/)).toBeVisible()

    // Zoom controls should be visible
    const zoomIn = page.locator('button[title="Zoom in (+)"]')
    await expect(zoomIn).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('memory graph page shows clickable nodes', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for SVG to render
    const svg = page.locator('svg').first()
    await expect(svg).toBeVisible({ timeout: 20000 })

    // SVG should contain anchor elements (clickable nodes)
    const anchors = page.locator('svg a')
    await expect(anchors.first()).toBeVisible({ timeout: 5000 })

    // Should have at least 2 nodes (A and B)
    const anchorCount = await anchors.count()
    expect(anchorCount).toBeGreaterThanOrEqual(2)
  })

  test('clicking a graph node navigates to memory page', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for SVG to render
    const svg = page.locator('svg').first()
    await expect(svg).toBeVisible({ timeout: 20000 })

    // Find the anchor for memory B and click it
    // The node anchors have xlink:href="/memories/<id>"
    const nodeBLink = page.locator(`svg a[*|href="/memories/${memoryBId}"]`)

    if ((await nodeBLink.count()) > 0) {
      await nodeBLink.first().click()
      // Should navigate to the memory page
      await page.waitForURL(`**/memories/${memoryBId}`, { timeout: 5000 })
      expect(page.url()).toContain(`/memories/${memoryBId}`)
    } else {
      // Fallback: try href without xlink namespace
      const fallbackLink = page.locator(`svg a`).first()
      await fallbackLink.click()
      // Should navigate away from graph page
      await expect(page).toHaveURL(/\/memories\//, { timeout: 5000 })
    }
  })

  test('depth selector fetches new graph data', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for initial render
    const svg = page.locator('svg').first()
    await expect(svg).toBeVisible({ timeout: 20000 })

    // Change depth to 1
    const depthSelect = page.locator('select')
    await depthSelect.selectOption('1')

    // Graph should re-render (SVG should still be visible after update)
    await expect(svg).toBeVisible({ timeout: 15000 })

    await expectNoVisibleErrors(page)
  })

  test('direction toggle switches layout', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for initial render
    await page.locator('svg').first().waitFor({ state: 'visible', timeout: 20000 })

    const directionButton = page.locator('button', { hasText: /^(LR|TB)$/ })
    const initialDirection = await directionButton.textContent()

    // Click to toggle
    await directionButton.click()

    // Direction label should change
    const newDirection = await directionButton.textContent()
    expect(newDirection).not.toEqual(initialDirection)

    // Graph should re-render
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 15000 })

    await expectNoVisibleErrors(page)
  })

  test('project graph page renders', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/projects/${testProjectId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for SVG to render
    const svg = page.locator('svg').first()
    await expect(svg).toBeVisible({ timeout: 20000 })

    // Status bar should show nodes
    await expect(page.getByText(/\d+ node/)).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('memory page shows Graph button when relations exist', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}`)
    await page.waitForLoadState('networkidle')

    // Wait for page to load
    const title = page.locator('h1')
    await expect(title).toBeVisible({ timeout: 10000 })

    // Graph button should appear in the top nav
    const graphButton = page.locator('button[title="View graph"]')
    await expect(graphButton).toBeVisible({ timeout: 15000 })

    await expectNoVisibleErrors(page)
  })

  test('clicking Graph button navigates to graph page', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}`)
    await page.waitForLoadState('networkidle')

    // Wait for Graph button to appear
    const graphButton = page.locator('button[title="View graph"]')
    await expect(graphButton).toBeVisible({ timeout: 15000 })

    // Click it
    await graphButton.click()

    // Should navigate to graph page
    await page.waitForURL(`**/memories/${memoryAId}/graph`, { timeout: 5000 })
    expect(page.url()).toContain(`/memories/${memoryAId}/graph`)
  })

  test('project page has graph link', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')

    // Wait for project header to load
    const projectTitle = page.locator('h1')
    await expect(projectTitle).toBeVisible({ timeout: 10000 })

    // Graph link should be visible (Network icon button with title "View graph")
    const graphLink = page.locator('a[title="View graph"]')
    await expect(graphLink).toBeVisible({ timeout: 5000 })

    // Click it
    await graphLink.click()

    // Should navigate to project graph
    await page.waitForURL(`**/projects/${testProjectId}/graph`, { timeout: 5000 })
    expect(page.url()).toContain(`/projects/${testProjectId}/graph`)
  })

  test('SVG export button downloads file', async ({ page }) => {
    if (!diagramHealthy) test.skip()
    await page.goto(`/memories/${memoryAId}/graph`)
    await page.waitForLoadState('networkidle')

    // Wait for graph to render
    await page.locator('svg').first().waitFor({ state: 'visible', timeout: 20000 })

    // Export button should be enabled
    const exportButton = page.locator('button[title="Export SVG"]')
    await expect(exportButton).toBeVisible()
    await expect(exportButton).toBeEnabled()

    // Set up download listener and click export
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      exportButton.click(),
    ])

    // Verify download filename
    expect(download.suggestedFilename()).toContain('graph-')
    expect(download.suggestedFilename()).toContain('.svg')
  })
})
