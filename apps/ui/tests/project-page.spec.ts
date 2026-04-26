import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, waitForLoadingComplete, resolveApiBase } from './utils/test-helpers'

test.describe('Project Details Page', () => {
  let projectUrl = ''

  test.beforeAll(async ({ request }) => {
    // Find a seeded project with memories (avoid transient test projects)
    const apiBase = await resolveApiBase(request)
    const res = await request.get(`${apiBase}/projects`)
    const data = await res.json()
    const projects = data.projects || []
    // Prefer 'samples' since it always has seeded memories
    const target = projects.find((p: any) => p.handle === 'samples') || projects.find((p: any) => p.handle === 'khef') || projects[0]
    projectUrl = target ? `/projects/${target.id}` : ''
  })

  test.beforeEach(async ({ page }) => {
    // Navigate to projects list first to get a valid project handle
    await page.goto('/projects')
    await page.waitForLoadState('networkidle')
  })

  test('should display project header with name', async ({ page }) => {
    // Navigate to a known project with memories
    if (projectUrl) {
      await page.goto(projectUrl)
    } else {
      const projectCard = page.locator('[data-testid="project-card"]').first()
      await expect(projectCard).toBeVisible({ timeout: 10000 })
      await projectCard.click()
    }
    await page.waitForLoadState('networkidle')

    // Verify we're on the project page
    expect(page.url()).toContain('/projects/')

    // Check that the page title (h1) is visible
    const title = page.locator('h1').first()
    await expect(title).toBeVisible({ timeout: 10000 })

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should open and close create memory panel', async ({ page }) => {
    // Navigate to first project
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    const createButton = page.getByRole('button', { name: 'Create', exact: true })
    await expect(createButton).toBeVisible()
    await createButton.click()

    const titleInput = page.locator('#create-title')
    const contentTextarea = page.locator('#create-content')
    await expect(titleInput).toBeVisible()
    await expect(contentTextarea).toBeVisible()

    const cancelButton = page.locator('button', { hasText: 'Cancel' })
    await cancelButton.click()
    await expect(contentTextarea).toBeHidden()
  })

  test('should display project summary section', async ({ page }) => {
    // Navigate to first project
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    // Check for summary panel with nav row and filter chips
    const navRow = page.locator('[class*="_navRow_"]')
    await expect(navRow).toBeVisible({ timeout: 10000 })

    // Check that quick filter chips are visible
    await expect(page.getByTestId('project-page--summary-todos-in-progress')).toBeVisible()
    await expect(page.getByTestId('project-page--summary-recent-decisions')).toBeVisible()
    await expect(page.getByTestId('project-page--summary-recent-patterns')).toBeVisible()
    await expect(page.getByTestId('project-page--summary-recent-context')).toBeVisible()

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should open and close edit project panel', async ({ page }) => {
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    const editButton = page.locator('button[title="Edit project"]')
    await expect(editButton).toBeVisible()
    await editButton.click()

    await expect(page.locator('#edit-project-name')).toBeVisible({ timeout: 10000 })
    const nameInput = page.locator('#edit-project-name')
    const descriptionInput = page.locator('#edit-project-description')
    await expect(nameInput).toBeVisible({ timeout: 10000 })
    await expect(descriptionInput).toBeVisible({ timeout: 10000 })

    const cancelButton = page.locator('button', { hasText: 'Cancel' })
    await cancelButton.click()
    await expect(descriptionInput).toBeHidden()
  })

  test('should display search bar and filters', async ({ page }) => {
    // Navigate to a project with memories
    if (projectUrl) {
      await page.goto(projectUrl)
    } else {
      const projectCard = page.locator('[data-testid="project-card"]').first()
      await expect(projectCard).toBeVisible({ timeout: 10000 })
      await projectCard.click()
    }
    await page.waitForLoadState('networkidle')

    // Check for search bar
    const searchInput = page.locator('input[placeholder*="Search"]')
    await expect(searchInput).toBeVisible({ timeout: 10000 })

    // Check for compact inline filters
    const filtersBar = page.locator('[class*="_filtersBar_"]')
    await expect(filtersBar).toBeVisible()

    // Check for type select, tag input, and date pill
    const typeSelect = filtersBar.locator('select').first()
    await expect(typeSelect).toBeVisible()

    const tagInput = filtersBar.locator('input[placeholder="Tag..."]')
    await expect(tagInput).toBeVisible()

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should display memory list or empty state', async ({ page }) => {
    // Navigate to a project with memories
    if (projectUrl) {
      await page.goto(projectUrl)
    } else {
      const projectCard = page.locator('[data-testid="project-card"]').first()
      await expect(projectCard).toBeVisible({ timeout: 10000 })
      await projectCard.click()
    }
    await page.waitForLoadState('networkidle')

    // Wait for loading to complete
    await page.waitForTimeout(2000) // Give time for API response

    // Either memory cards or empty state should be visible
    const memoryCards = page.locator('button[class*="_card_"]')
    const emptyState = page.locator('text=No memories found')

    const hasMemories = await memoryCards.count() > 0
    const hasEmptyState = await emptyState.isVisible()

    expect(hasMemories || hasEmptyState).toBe(true)

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should show pagination when there are many memories', async ({ page }) => {
    // Navigate to a project with memories
    if (projectUrl) {
      await page.goto(projectUrl)
    } else {
      const projectCard = page.locator('[data-testid="project-card"]').first()
      await expect(projectCard).toBeVisible({ timeout: 10000 })
      await projectCard.click()
    }
    await page.waitForLoadState('networkidle')

    // Wait for content to load
    await page.waitForTimeout(2000)

    // Check if pagination controls exist (they only show when total > 20)
    const pagination = page.locator('[class*="_pagination_"]')
    const memoryCards = page.locator('button[class*="_card_"]')

    const memoryCount = await memoryCards.count()

    // If there are memories, pagination meta should be visible
    if (memoryCount > 0) {
      const meta = page.locator('text=/Showing \\d+ of \\d+/')
      await expect(meta).toBeVisible()
    }

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should filter memories by type', async ({ page }) => {
    // Navigate to first project
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    // Wait for initial load
    await page.waitForTimeout(2000)

    // Find and interact with type filter
    const typeSelect = page.locator('select').first()
    await expect(typeSelect).toBeVisible()

    // Get available options
    const options = await typeSelect.locator('option').allTextContents()

    // If there are type options besides "All types", select one
    if (options.length > 1 && !options[1].includes('No types')) {
      await typeSelect.selectOption({ index: 1 })
      await page.waitForTimeout(1000) // Wait for filter to apply

      // Verify the filter chip appears
      const filterChip = page.locator('[class*="_filterChip_"]')
      await expect(filterChip.first()).toBeVisible()
    }

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should navigate to memory detail when clicking a memory card', async ({ page }) => {
    // Navigate to first project
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    // Wait for content to load
    await page.waitForTimeout(2000)

    // Check if there are memory cards
    const memoryCards = page.locator('button[class*="_card_"]')
    const memoryCount = await memoryCards.count()

    if (memoryCount > 0) {
      // Click the first memory card (async handler fetches IDs then navigates)
      await memoryCards.first().click()

      // Wait for navigation to memory detail page
      await page.waitForURL(/\/memories\/[a-f0-9-]+/, { timeout: 10000 })

      // Verify we navigated to memory detail page
      expect(page.url()).toMatch(/\/memories\/[a-f0-9-]+/)

      // Verify no error elements are visible on the memory page
      await expectNoVisibleErrors(page)
    }
  })

  test('should change page size', async ({ page }) => {
    // Navigate to first project
    const projectCard = page.locator('[data-testid="project-card"]').first()
    await expect(projectCard).toBeVisible({ timeout: 10000 })
    await projectCard.click()
    await page.waitForLoadState('networkidle')

    // Wait for content to load
    await page.waitForTimeout(2000)

    // Look for page size dropdown
    const pageSizeDropdown = page.locator('select[class*="_pageSizeDropdown_"]')

    if (await pageSizeDropdown.isVisible()) {
      // Get current value
      const currentValue = await pageSizeDropdown.inputValue()

      // Change to a different value
      await pageSizeDropdown.selectOption('50')
      await page.waitForTimeout(1000)

      // Verify selection changed
      const newValue = await pageSizeDropdown.inputValue()
      expect(newValue).toBe('50')
    }

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })
})

test.describe('Project Details Context Menu', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'pp-context-menu-test'
  const TEST_PROJECT_NAME = 'PP Context Menu Test'
  const TEST_MEMORY_HANDLE = 'pp-context-menu-memory'
  const TEST_MEMORY_TITLE = 'Context Menu Memory'
  const TEST_MEMORY_CONTENT = 'Context menu test content.'

  let apiBase = ''
  let testProjectId = ''
  let testMemoryId = ''

  async function listProjects(request: any) {
    const res = await request.get(`${apiBase}/projects`)
    const data = await res.json().catch(() => null)
    if (Array.isArray(data)) return data
    if (data && Array.isArray(data.projects)) return data.projects
    if (data && Array.isArray(data.items)) return data.items
    if (data?.data && Array.isArray(data.data.projects)) return data.data.projects
    return []
  }

  async function deleteProject(request: any, projectId: string, allowNotFound = false) {
    const res = await request.delete(`${apiBase}/projects/${projectId}`)
    if (res.ok()) return
    if (allowNotFound && res.status() === 404) return
    throw new Error(`Failed to delete test project: ${res.status()}`)
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    const findProjectByHandle = async () => {
      const projects = await listProjects(request)
      return projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE) || null
    }

    const existing = await findProjectByHandle()
    if (existing?.id) {
      await deleteProject(request, existing.id, true)
    }

    const createProject = async () => {
      const res = await request.post(`${apiBase}/projects`, {
        data: {
          handle: TEST_PROJECT_HANDLE,
          name: TEST_PROJECT_NAME,
        },
      })
      const data = await res.json().catch(() => null)
      const created = data?.project || data
      if (!res.ok() || !created?.id) {
        const details = data ? JSON.stringify(data) : await res.text().catch(() => '')
        throw new Error(`Failed to create test project: ${res.status()} ${details}`)
      }
      return created
    }

    try {
      const project = await createProject()
      testProjectId = project.id
    } catch (error: any) {
      const message = String(error?.message || '')
      if (message.includes('409') || message.includes('projects_handle_key')) {
        const existing = await findProjectByHandle()
        if (existing?.id) {
          await deleteProject(request, existing.id, true)
        }
        const project = await createProject()
        testProjectId = project.id
      } else {
        throw error
      }
    }

    const memRes = await request.post(`${apiBase}/projects/${testProjectId}/memories`, {
      data: {
        handle: TEST_MEMORY_HANDLE,
        title: TEST_MEMORY_TITLE,
        content: TEST_MEMORY_CONTENT,
        type: 'user-todo',
        status: 'open',
      },
    })
    const memData = await memRes.json().catch(() => null)
    const memory = memData?.memory || memData
    if (!memRes.ok() || !memory?.id) {
      const details = memData ? JSON.stringify(memData) : await memRes.text().catch(() => '')
      throw new Error(`Failed to create test memory: ${memRes.status()} ${details}`)
    }
    testMemoryId = memory.id
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await deleteProject(request, testProjectId, true)
    }
  })

  test('should change status via context menu', async ({ page }) => {
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')

    const card = page.locator('button[class*="_card_"]', { hasText: TEST_MEMORY_TITLE })
    await expect(card).toBeVisible({ timeout: 10000 })

    await card.click({ button: 'right' })

    const menu = page.locator('[class*="_menu_"]')
    await expect(menu).toBeVisible({ timeout: 10000 })

    await menu.locator('button', { hasText: 'Change Status' }).click()
    const option = menu.locator('button', { hasText: 'In Progress' }).first()

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(`/projects/${testProjectId}/memories/${testMemoryId}`) &&
      response.request().method() === 'PATCH'
    )

    await option.click()
    await responsePromise

    await expect(card.locator('[class*="_badge_"]', { hasText: 'In Progress' })).toBeVisible()
    await expectNoVisibleErrors(page)
  })

  test('should change type via context menu', async ({ page }) => {
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')

    const card = page.locator('button[class*="_card_"]', { hasText: TEST_MEMORY_TITLE })
    await expect(card).toBeVisible({ timeout: 10000 })

    await card.click({ button: 'right' })

    const menu = page.locator('[class*="_menu_"]')
    await expect(menu).toBeVisible({ timeout: 10000 })

    await menu.locator('button', { hasText: 'Change Type' }).click()
    const option = menu.locator('button', { hasText: 'Decision' }).first()

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(`/projects/${testProjectId}/memories/${testMemoryId}`) &&
      response.request().method() === 'PATCH'
    )

    await option.click()
    await responsePromise

    await expect(card.locator('[class*="_badge_"]', { hasText: 'Decision' })).toBeVisible()
    await expectNoVisibleErrors(page)
  })
})
