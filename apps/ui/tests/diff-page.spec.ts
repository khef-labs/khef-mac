import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors } from './utils/test-helpers'
import * as fs from 'fs'
import * as path from 'path'

// Run tests serially to avoid race conditions with shared project
test.describe.configure({ mode: 'serial' })

test.describe('Diff Page', () => {
  let projectId: string
  const tempFileName = '.diff-test-temp-file.txt'
  const tempFilePath = path.join(process.cwd(), tempFileName)

  test.beforeAll(async ({ request }) => {
    // Clean up any existing test project first
    const res = await request.get('/api/projects')
    const data = await res.json()
    const projects = Array.isArray(data) ? data : data.projects || []
    const existing = projects.find((p: any) => p.handle === 'diff-test-project')
    if (existing) {
      await request.delete(`/api/projects/${existing.id}`)
    }

    // Create a temporary untracked file to ensure uncommitted changes exist
    fs.writeFileSync(tempFilePath, `Test file created at ${new Date().toISOString()}\n`)

    // Create a test project pointing to khef-ui repo for real git data
    const createRes = await request.post('/api/projects', {
      data: {
        name: 'diff-test-project',
        handle: 'diff-test-project',
        display_name: 'Diff Test Project',
        path: process.cwd(), // khef-ui repo
      },
    })

    if (createRes.ok()) {
      const created = await createRes.json()
      // API returns { project: {...} }
      projectId = created.project?.id || created.id
      if (!projectId) {
        throw new Error(`Project created but no ID returned: ${JSON.stringify(created)}`)
      }
    } else {
      const errorText = await createRes.text()
      throw new Error(`Failed to create diff test project: ${createRes.status()} ${errorText}`)
    }
  })

  test.afterAll(async ({ request }) => {
    // Clean up test project
    if (projectId) {
      await request.delete(`/api/projects/${projectId}`)
    }
    // Clean up temp file
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath)
    }
  })

  test('should display mode buttons when viewing uncommitted changes', async ({ page }) => {
    await page.goto(`/projects/${projectId}/diff`)
    await page.waitForLoadState('networkidle')

    // Should show the code review page with mode switch buttons
    const modeSwitch = page.locator('[data-testid="diff-page--mode-switch"]')
    await expect(modeSwitch).toBeVisible({ timeout: 10000 })

    // Commits and Branch buttons should be visible
    await expect(page.locator('[data-testid="diff-page--mode-commits"]')).toBeVisible()
    await expect(page.locator('[data-testid="diff-page--mode-branch"]')).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should have Commits mode active by default', async ({ page }) => {
    await page.goto(`/projects/${projectId}/diff`)
    await page.waitForLoadState('networkidle')

    // Mode switch should be visible with Commits active
    const modeSwitch = page.locator('[data-testid="diff-page--mode-switch"]')
    await expect(modeSwitch).toBeVisible({ timeout: 10000 })

    const commitsButton = page.locator('[data-testid="diff-page--mode-commits"]')
    await expect(commitsButton).toHaveClass(/modeActive/)

    await expectNoVisibleErrors(page)
  })

  test('should switch to Branch mode when clicking Branch button', async ({ page }) => {
    await page.goto(`/projects/${projectId}/diff`)
    await page.waitForLoadState('networkidle')

    const modeSwitch = page.locator('[data-testid="diff-page--mode-switch"]')
    await expect(modeSwitch).toBeVisible({ timeout: 10000 })

    // Click Branch button
    const branchButton = page.locator('[data-testid="diff-page--mode-branch"]')
    await branchButton.click()
    await expect(branchButton).toHaveClass(/modeActive/)

    await expectNoVisibleErrors(page)
  })

  test('should show commit list in sidebar', async ({ page }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Requires real git repo with history')

    await page.goto(`/projects/${projectId}/diff`)
    await page.waitForLoadState('networkidle')

    // Commit list or uncommitted changes should be in the sidebar
    const sidebar = page.locator('[role="complementary"]')
    await expect(sidebar).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })
})
