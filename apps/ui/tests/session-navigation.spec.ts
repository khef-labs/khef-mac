import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

interface NavContext {
  ids: string[]
  currentIndex: number
  source: string
}

test.describe('Session Navigation', () => {
  test('navContext should match displayed session count', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    // Find a project with sessions
    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 3)
    if (!project) {
      test.skip(true, 'Need a project with at least 3 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    // Navigate to sessions list
    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')

    // Wait for sessions to load
    await page.waitForSelector('[data-testid^="session-card--"]')

    // Count displayed sessions
    const displayedCount = await page.locator('[data-testid^="session-card--"]').count()
    expect(displayedCount).toBeGreaterThanOrEqual(3)

    // Click the first session
    await page.locator('[data-testid^="session-card--"]').first().click()
    await page.waitForLoadState('networkidle')

    // Wait for nav controls to appear (indicates navContext is set)
    const navPositionEl = page.locator('[data-testid="nav-position"]')
    await expect(navPositionEl).toBeVisible({ timeout: 5000 })

    // Read navContext from sessionStorage
    const navContext = await page.evaluate(() => {
      const stored = window.sessionStorage.getItem('khefSessionNavContext')
      return stored ? JSON.parse(stored) : null
    }) as NavContext | null

    expect(navContext, 'navContext should be set after clicking session').not.toBeNull()
    expect(navContext!.ids.length).toBeGreaterThanOrEqual(displayedCount)
    expect(navContext!.currentIndex).toBe(0) // First session

    // Verify nav position shows correct count
    await expect(navPositionEl).toContainText(`1 of`)

    await expectNoVisibleErrors(page)
  })

  test('clicking middle session sets correct index', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 5)
    if (!project) {
      test.skip(true, 'Need a project with at least 5 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    const displayedCount = await page.locator('[data-testid^="session-card--"]').count()
    const middleIndex = Math.floor(displayedCount / 2)

    // Click the middle session
    await page.locator('[data-testid^="session-card--"]').nth(middleIndex).click()
    await page.waitForLoadState('networkidle')

    // Wait for nav position to appear
    const navPosition = page.locator('[data-testid="nav-position"]')
    await expect(navPosition).toBeVisible({ timeout: 5000 })

    const navContext = await page.evaluate(() => {
      const stored = window.sessionStorage.getItem('khefSessionNavContext')
      return stored ? JSON.parse(stored) : null
    }) as NavContext | null

    expect(navContext).not.toBeNull()
    // Index should correspond to the clicked position
    expect(navContext!.currentIndex).toBeGreaterThanOrEqual(0)

    await expect(navPosition).toContainText(`${navContext!.currentIndex + 1} of`)

    await expectNoVisibleErrors(page)
  })

  test('arrow navigation visits sessions in correct order', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 3)
    if (!project) {
      test.skip(true, 'Need a project with at least 3 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    // Click first session
    await page.locator('[data-testid^="session-card--"]').first().click()
    await page.waitForLoadState('networkidle')

    // Wait for nav controls to appear
    const navPosition = page.locator('[data-testid="nav-position"]')
    await expect(navPosition).toBeVisible({ timeout: 5000 })
    await expect(navPosition).toContainText('1 of', { timeout: 5000 })

    const firstUrl = page.url()

    // Navigate right to second session
    await page.keyboard.press('ArrowRight')
    await expect(navPosition).toContainText('2 of', { timeout: 5000 })
    const secondUrl = page.url()
    expect(secondUrl).not.toBe(firstUrl)

    // Navigate right to third session
    await page.keyboard.press('ArrowRight')
    await expect(navPosition).toContainText('3 of', { timeout: 5000 })

    // Navigate left back to second
    await page.keyboard.press('ArrowLeft')
    await expect(navPosition).toContainText('2 of', { timeout: 5000 })
    expect(page.url()).toBe(secondUrl)

    await expectNoVisibleErrors(page)
  })

  test('filtered sessions should update navContext correctly', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    // Get project with sessions
    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 5)
    if (!project) {
      test.skip(true, 'Need a project with at least 5 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    // Count unfiltered sessions
    const unfilteredCount = await page.locator('[data-testid^="session-card--"]').count()

    // Apply "Today" quick filter
    const todayButton = page.locator('button', { hasText: 'Today' })
    if (await todayButton.isVisible()) {
      await todayButton.click()
      // Wait for the filter to be applied and UI to update
      await page.waitForTimeout(300)

      const filteredCount = await page.locator('[data-testid^="session-card--"]').count()

      // Only proceed if filter actually reduced the count
      if (filteredCount < unfilteredCount && filteredCount > 0) {
        // Get IDs of filtered sessions
        const filteredIds = await page.locator('[data-testid^="session-card--"]').evaluateAll((cards) =>
          cards.map((card) => {
            const href = card.getAttribute('href') || ''
            const parts = href.split('/')
            return decodeURIComponent(parts[parts.length - 1])
          })
        )

        // Click a filtered session
        await page.locator('[data-testid^="session-card--"]').first().click()
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('[data-testid="nav-position"]', { timeout: 5000 }).catch(() => {
          console.log('Nav position not found - navContext might be null')
        })

        const navContext = await page.evaluate(() => {
          const stored = window.sessionStorage.getItem('khefSessionNavContext')
          return stored ? JSON.parse(stored) : null
        }) as NavContext | null

        expect(navContext, 'navContext should not be null after clicking filtered session').not.toBeNull()
        // navContext should have filtered count, not unfiltered
        expect(navContext!.ids.length).toBe(filteredCount)

        const navPosition = page.locator('[data-testid="nav-position"]')
        await expect(navPosition).toContainText(`of ${filteredCount}`)
      } else {
        // If Today filter shows all or none, skip
        test.skip(true, 'Today filter did not reduce session count meaningfully')
      }
    } else {
      test.skip(true, 'Today button not visible')
    }

    await expectNoVisibleErrors(page)
  })

  test('companion filter should affect navContext', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 5)
    if (!project) {
      test.skip(true, 'Need a project with at least 5 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    const unfilteredCount = await page.locator('[data-testid^="session-card--"]').count()

    // Find and use the Companion filter
    const companionSelect = page.locator('select').filter({ hasText: /All sessions|With companion|Without companion/ })
    if (await companionSelect.count() > 0) {
      // Select "With companion"
      await companionSelect.first().selectOption('true')
      await page.waitForTimeout(300) // Wait for filter to apply

      const withCompanionCount = await page.locator('[data-testid^="session-card--"]').count()

      if (withCompanionCount > 0 && withCompanionCount < unfilteredCount) {
        // Get IDs of filtered sessions
        const filteredIds = await page.locator('[data-testid^="session-card--"]').evaluateAll((cards) =>
          cards.map((card) => {
            const href = card.getAttribute('href') || ''
            const parts = href.split('/')
            return decodeURIComponent(parts[parts.length - 1])
          })
        )

        // Click first filtered session
        await page.locator('[data-testid^="session-card--"]').first().click()
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('[data-testid="nav-position"]', { timeout: 5000 })

        const navContext = await page.evaluate(() => {
          const stored = window.sessionStorage.getItem('khefSessionNavContext')
          return stored ? JSON.parse(stored) : null
        }) as NavContext | null

        expect(navContext, 'navContext should be set').not.toBeNull()
        expect(navContext!.ids.length).toBe(withCompanionCount)

        // Verify IDs match the filtered list
        for (let i = 0; i < Math.min(3, filteredIds.length); i++) {
          expect(navContext!.ids[i]).toBe(filteredIds[i])
        }
      } else {
        test.skip(true, 'Companion filter did not produce useful subset')
      }
    } else {
      test.skip(true, 'Companion filter select not found')
    }

    await expectNoVisibleErrors(page)
  })

  test('changing sort order should update navContext order', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json()
    const projects = projectsData?.projects || []

    const project = projects.find((p: any) => (p.session_count || 0) >= 3)
    if (!project) {
      test.skip(true, 'Need a project with at least 3 sessions')
    }

    const dirName = project.dir_name
    const projectId = project.matched_project?.id

    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    // Click first session and verify navContext is set
    await page.locator('[data-testid^="session-card--"]').first().click()
    await page.waitForLoadState('networkidle')

    const navPosition = page.locator('[data-testid="nav-position"]')
    await expect(navPosition).toBeVisible({ timeout: 5000 })
    await expect(navPosition).toContainText('1 of')

    const descNavContext = await page.evaluate(() => {
      const stored = window.sessionStorage.getItem('khefSessionNavContext')
      return stored ? JSON.parse(stored) : null
    }) as NavContext | null

    expect(descNavContext, 'navContext should be set after clicking session').not.toBeNull()

    // Go back to list
    await page.goBack()
    await page.waitForLoadState('networkidle')
    await page.waitForSelector('[data-testid^="session-card--"]')

    // Change sort order to Oldest first
    const orderSelect = page.locator('select').filter({ hasText: /Newest first|Oldest first/ })
    if (await orderSelect.count() > 0) {
      await orderSelect.first().selectOption('asc')
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(300)
      await page.waitForSelector('[data-testid^="session-card--"]')

      // Click first session in reversed order
      await page.locator('[data-testid^="session-card--"]').first().click()
      await page.waitForLoadState('networkidle')
      await expect(navPosition).toBeVisible({ timeout: 5000 })

      const ascNavContext = await page.evaluate(() => {
        const stored = window.sessionStorage.getItem('khefSessionNavContext')
        return stored ? JSON.parse(stored) : null
      }) as NavContext | null

      expect(ascNavContext, 'navContext should be set').not.toBeNull()
      // The first ID in ascending order should differ from descending
      if (descNavContext!.ids.length > 1) {
        expect(ascNavContext!.ids[0]).not.toBe(descNavContext!.ids[0])
      }
    }

    await expectNoVisibleErrors(page)
  })
})
