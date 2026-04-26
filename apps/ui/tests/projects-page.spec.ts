import { test, expect } from '@playwright/test'
import { dismissSplash, expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe('Projects Page', () => {
  test.describe.configure({ mode: 'serial' })

  const FAVORITE_HANDLE = 'favorites-page-test'
  const OTHER_HANDLE = 'favorites-page-test-alt'
  const FAVORITE_NAME = 'Favorites Page Test'
  const OTHER_NAME = 'Favorites Page Test Alt'

  let apiBase = ''
  let favoriteProjectId = ''
  let otherProjectId = ''

  async function listProjects(request: any) {
    const res = await retryOn429(() => request.get(`${apiBase}/projects`))
    const data = await res.json().catch(() => null)
    return Array.isArray(data) ? data : data?.projects || []
  }

  async function deleteProjectByHandle(request: any, handle: string) {
    const projects = await listProjects(request)
    const existing = projects.find((p: any) => p.handle === handle)
    if (existing?.id) {
      await retryOn429(() => request.delete(`${apiBase}/projects/${existing.id}`))
    }
  }

  async function createProject(request: any, handle: string, name: string) {
    const res = await retryOn429(() =>
      request.post(`${apiBase}/projects`, {
        data: { handle, name },
      })
    )
    const data = await res.json().catch(() => null)
    const project = data?.project || data
    if (!res.ok() || !project?.id) {
      throw new Error(`Failed to create project: ${res.status()}`)
    }
    return project.id as string
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    await deleteProjectByHandle(request, FAVORITE_HANDLE)
    await deleteProjectByHandle(request, OTHER_HANDLE)

    favoriteProjectId = await createProject(request, FAVORITE_HANDLE, FAVORITE_NAME)
    otherProjectId = await createProject(request, OTHER_HANDLE, OTHER_NAME)

    const patchRes = await retryOn429(() =>
      request.patch(`${apiBase}/projects/${favoriteProjectId}`, {
        data: { is_favorite: true },
      })
    )
    if (!patchRes.ok()) {
      throw new Error(`Failed to favorite project: ${patchRes.status()}`)
    }
  })

  test.afterAll(async ({ request }) => {
    if (favoriteProjectId) {
      await retryOn429(() => request.delete(`${apiBase}/projects/${favoriteProjectId}`))
    }
    if (otherProjectId) {
      await retryOn429(() => request.delete(`${apiBase}/projects/${otherProjectId}`))
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/projects')
    await page.waitForLoadState('networkidle')
    await dismissSplash(page)
  })

  test('should open and close create project panel', async ({ page }) => {
    const createButton = page.locator('button', { hasText: 'Create Project' })
    await expect(createButton).toBeVisible({ timeout: 10000 })
    await createButton.click()

    const nameInput = page.locator('#project-name')
    const descriptionInput = page.locator('#project-description')
    await expect(nameInput).toBeVisible()
    await expect(descriptionInput).toBeVisible()

    const cancelButton = page.locator('button', { hasText: 'Cancel' })
    await cancelButton.click()
    await expect(descriptionInput).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should filter favorites and toggle star', async ({ page }) => {
    const favoriteCard = page.locator(
      `[data-testid="project-card"][data-project-id="${favoriteProjectId}"]`
    )
    const otherCard = page.locator(
      `[data-testid="project-card"][data-project-id="${otherProjectId}"]`
    )

    await expect(favoriteCard).toBeVisible()
    await expect(otherCard).toBeVisible()

    await expect(favoriteCard.locator('[data-favorite="true"]')).toBeVisible()
    await expect(otherCard.locator('[data-favorite="true"]')).toHaveCount(0)

    const filterButton = page.locator('[data-testid="favorite-filter"]')
    await filterButton.click()
    await page.waitForLoadState('networkidle')

    await expect(favoriteCard).toBeVisible()
    await expect(otherCard).toBeHidden()

    await filterButton.click()
    await page.waitForLoadState('networkidle')

    await otherCard.click({ button: 'right' })
    const addToFavorites = page.locator('[class*="menuItem"]', { hasText: 'Add to favorites' })
    await expect(addToFavorites).toBeVisible()
    await addToFavorites.click()
    await expect(otherCard.locator('[data-favorite="true"]')).toBeVisible()

    await expectNoVisibleErrors(page)
  })
})
