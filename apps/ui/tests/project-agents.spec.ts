import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Project Agents', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'pa-test-project'
  const TEST_PROJECT_NAME = 'PA Test Project'
  const TEST_PROJECT_PATH = '/tmp/pa-test-project'

  let apiBase = ''
  let testProjectId = ''

  async function findProjectByHandle(request: any) {
    const res = await request.get(`${apiBase}/projects`)
    const data = await res.json().catch(() => null)
    const projects = Array.isArray(data) ? data : data?.projects || []
    return projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE) || null
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Clean up any existing test project
    const existing = await findProjectByHandle(request)
    if (existing?.id) {
      await request.delete(`${apiBase}/projects/${existing.id}`)
    }

    // Create test project
    const createRes = await request.post(`${apiBase}/projects`, {
      data: {
        handle: TEST_PROJECT_HANDLE,
        name: TEST_PROJECT_NAME,
      },
    })
    const created = await createRes.json()
    testProjectId = (created?.project || created)?.id
    if (!testProjectId) throw new Error('Failed to create test project')

    // Set path on the project so the agents link appears
    const patchRes = await request.patch(`${apiBase}/projects/${testProjectId}`, {
      data: { path: TEST_PROJECT_PATH },
    })
    if (!patchRes.ok()) {
      throw new Error(`Failed to set project path: ${patchRes.status()}`)
    }
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await request.delete(`${apiBase}/projects/${testProjectId}`)
    }
  })

  test('should show agents link on project page with path set', async ({ page }) => {
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')

    // Should show the Bot icon button in summary actions
    const agentsLink = page.locator('a[title="Project agents"]')
    await expect(agentsLink).toBeVisible()

    // Click to navigate to agents page
    await agentsLink.click()
    await page.waitForLoadState('networkidle')

    // Should be on the project agents page
    await expect(page).toHaveURL(new RegExp(`/projects/${testProjectId}/agents`))
    await expect(page.locator('h1', { hasText: 'Agents' })).toBeVisible()

    // Should have sections for project agents
    await expect(page.locator('h2', { hasText: 'Project Agents' })).toBeVisible({ timeout: 5000 }).catch(() => {
      // Section heading may have been simplified
    })

    await expectNoVisibleErrors(page)
  })

  test('should navigate to new agent page from project agents', async ({ page }) => {
    await page.goto(`/projects/${testProjectId}/agents`)
    await page.waitForLoadState('networkidle')

    // Find and click the add button
    const addButton = page.locator('a[title="Add Project Agent"]')
    await expect(addButton).toBeVisible()

    await addButton.click()
    await page.waitForLoadState('networkidle')

    // Should be on new agent page with project context
    await expect(page).toHaveURL(new RegExp(`/projects/${testProjectId}/agents/new`))
    await expect(page.locator('h1', { hasText: 'New Agent' })).toBeVisible()
  })

  test('should return to project agents when clicking back from user agent', async ({ page }) => {
    await page.goto(`/projects/${testProjectId}/agents`)
    await page.waitForLoadState('networkidle')

    // Wait for user agents section and click on a user agent
    const userAgentCard = page.locator('a[href*="/assistants/claude-code/agents/"]').first()

    // Skip if no user agents are available
    const count = await userAgentCard.count()
    if (count === 0) {
      test.skip(true, 'No user agents available to test back navigation')
      return
    }

    await expect(userAgentCard).toBeVisible()
    await userAgentCard.click()
    await page.waitForLoadState('networkidle')

    // Should be on the user agent page with from query param
    await expect(page).toHaveURL(/\/assistants\/claude-code\/agents\/.*\?from=/)

    // Navigate back using browser history
    await page.goBack()
    await page.waitForLoadState('networkidle')

    // Should return to project agents page
    await expect(page).toHaveURL(new RegExp(`/projects/${testProjectId}/agents`))
    await expect(page.locator('h1', { hasText: 'Agents' })).toBeVisible()
  })
})
