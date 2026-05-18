import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, retryOn429 } from './utils/test-helpers'

test.describe('Project Sub-pages', () => {
  let projectId: string
  let createdProject = false

  test.beforeAll(async ({ request }) => {
    // Get the first project with a path (needed for some sub-pages)
    const res = await retryOn429(() => request.get('/api/projects'))
    const data = await res.json()
    const projects = Array.isArray(data) ? data : data.projects || []
    let projectWithPath = projects.find((p: any) => p.path)

    if (!projectWithPath) {
      // Create a test project with a path
      const createRes = await retryOn429(() =>
        request.post('/api/projects', {
          data: {
            name: 'subpage-test-project',
            handle: 'subpage-test-project',
            path: '/tmp/test-project'
          }
        })
      )
      if (createRes.ok()) {
        const created = await createRes.json()
        projectWithPath = created.project
        createdProject = true
      } else {
        // Fall back to first project
        projectWithPath = projects[0]
      }
    }

    if (!projectWithPath) {
      throw new Error('No projects found for testing')
    }
    projectId = projectWithPath.id
  })

  test.afterAll(async ({ request }) => {
    if (createdProject && projectId) {
      await retryOn429(() => request.delete(`/api/projects/subpage-test-project`))
    }
  })

  test('configs page should display title', async ({ page }) => {
    await page.goto(`/projects/${projectId}/configs`)
    await page.waitForLoadState('networkidle')

    const title = page.locator('h1', { hasText: 'Configs' })
    await expect(title).toBeVisible({ timeout: 10000 })

    // Breadcrumb should link back to project
    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('agents page should display title', async ({ page }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Requires real project path on disk')

    await page.goto(`/projects/${projectId}/agents`)
    await page.waitForLoadState('networkidle')

    const title = page.locator('h1', { hasText: 'Agents' })
    await expect(title).toBeVisible({ timeout: 10000 })

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('sessions page should display title', async ({ page }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Requires real project path on disk')

    await page.goto(`/projects/${projectId}/sessions`)
    await page.waitForLoadState('networkidle')

    const title = page.locator('h1', { hasText: 'Sessions' })
    await expect(title).toBeVisible({ timeout: 10000 })

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('plans page should display title', async ({ page }) => {
    await page.goto(`/projects/${projectId}/plans`)
    await page.waitForLoadState('networkidle')

    const title = page.locator('h1', { hasText: 'Plans' })
    await expect(title).toBeVisible({ timeout: 10000 })

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('code review page should display title', async ({ page }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Requires real project path on disk')

    await page.goto(`/projects/${projectId}/code-review`)
    await page.waitForLoadState('networkidle')

    const title = page.locator('h1', { hasText: 'Code Review' })
    await expect(title).toBeVisible({ timeout: 10000 })

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('breadcrumb should show project name', async ({ page }) => {
    await page.goto(`/projects/${projectId}/configs`)
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible({ timeout: 10000 })

    // Breadcrumb should contain a link back to the project
    const projectLink = breadcrumb.locator('a[data-testid^="breadcrumb--"]')
    await expect(projectLink.first()).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('plans page should show project in breadcrumb', async ({ page }) => {
    await page.goto(`/projects/${projectId}/plans`)
    await page.waitForLoadState('networkidle')

    const breadcrumb = page.locator('[data-testid="breadcrumb"]')
    await expect(breadcrumb).toBeVisible({ timeout: 10000 })

    const projectLink = breadcrumb.locator('a[data-testid^="breadcrumb--"]')
    await expect(projectLink.first()).toBeVisible()

    await expectNoVisibleErrors(page)
  })
})
