import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Kdag Backends', () => {
  test('GET /api/kdag/backends returns valid backend list', async ({ request }) => {
    const apiBase = await resolveApiBase(request)
    const res = await request.get(`${apiBase}/kdag/backends`)
    expect(res.ok()).toBe(true)

    const data = await res.json()
    expect(data.backends).toBeDefined()
    expect(Array.isArray(data.backends)).toBe(true)
    expect(data.backends.length).toBeGreaterThanOrEqual(1)

    for (const backend of data.backends) {
      expect(backend.key).toBeTruthy()
      expect(backend.name).toBeTruthy()
      expect(typeof backend.available).toBe('boolean')
      expect(Array.isArray(backend.models)).toBe(true)
      expect(backend.models.length).toBeGreaterThan(0)

      if (!backend.available) {
        expect(backend.reason).toBeTruthy()
      }
    }

    // claude-code should always be present
    const claude = data.backends.find((b: any) => b.key === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude.name).toBe('Claude Code')
  })

  test('synced session page shows dynamic assistant selector', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    // Get available backends
    const backendsRes = await request.get(`${apiBase}/kdag/backends`)
    const backendsData = await backendsRes.json()
    const availableBackends = backendsData.backends.filter((b: any) => b.available)

    // Find a synced session to navigate to
    const sessionsRes = await request.get(`${apiBase}/sessions?limit=1`)
    const sessionsData = await sessionsRes.json()
    const sessions = sessionsData?.sessions || []

    if (sessions.length === 0) {
      test.skip(true, 'No synced sessions found')
    }

    const sessionId = sessions[0].id
    await page.goto(`/sessions/${sessionId}`)
    await page.waitForLoadState('networkidle')

    // Find the assistant select (the one for summarization)
    const assistantSelect = page.locator('[class*="_assistantSelect"]').first()

    // Only check if the select is visible (no summary exists yet)
    if (await assistantSelect.isVisible()) {
      const options = assistantSelect.locator('option')
      const optionCount = await options.count()

      // Should have at least 1 option (claude is always available)
      expect(optionCount).toBeGreaterThanOrEqual(1)

      // Verify option values match available backends
      for (let i = 0; i < optionCount; i++) {
        const value = await options.nth(i).getAttribute('value')
        const matchingBackend = availableBackends.find((b: any) => b.key === value)
        expect(matchingBackend, `Option ${value} should match an available backend`).toBeDefined()
      }

      // Verify model combobox is present
      const modelInput = page.locator('input[list]').first()
      await expect(modelInput).toBeVisible()
    }

    await expectNoVisibleErrors(page)
  })

  test('job page shows dynamic assistant selector with model combobox', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    // Get available backends
    const backendsRes = await request.get(`${apiBase}/kdag/backends`)
    const backendsData = await backendsRes.json()
    const availableBackends = backendsData.backends.filter((b: any) => b.available)

    // Find a completed or failed job to view
    const jobsRes = await request.get(`${apiBase}/kdag/jobs?limit=1`)
    const jobsData = await jobsRes.json()
    const jobs = jobsData?.jobs || []

    if (jobs.length === 0) {
      test.skip(true, 'No kdag jobs found')
    }

    const jobId = jobs[0].id
    await page.goto(`/kdag/jobs/${jobId}`)
    await page.waitForLoadState('networkidle')

    // Find the assistant select in the actions area
    const assistantSelect = page.locator('[class*="_assistantSelect"]').first()

    if (await assistantSelect.isVisible()) {
      const options = assistantSelect.locator('option')
      const optionCount = await options.count()

      expect(optionCount).toBeGreaterThanOrEqual(1)

      // Verify options match available backends
      for (let i = 0; i < optionCount; i++) {
        const value = await options.nth(i).getAttribute('value')
        const matchingBackend = availableBackends.find((b: any) => b.key === value)
        expect(matchingBackend, `Option ${value} should match an available backend`).toBeDefined()
      }

      // Verify model combobox is present
      const modelInput = page.locator('input[list]').first()
      await expect(modelInput).toBeVisible()
    }

    await expectNoVisibleErrors(page)
  })
})
