import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

function parseRelativeTimeToMinutes(value: string): number | null {
  const trimmed = value.trim().toLowerCase()
  const match = trimmed.match(/^(\d+)\s*([smhdw])\s*ago$/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const unit = match[2]
  switch (unit) {
    case 's':
      return Math.max(1, Math.round(amount / 60))
    case 'm':
      return amount
    case 'h':
      return amount * 60
    case 'd':
      return amount * 60 * 24
    case 'w':
      return amount * 60 * 24 * 7
    default:
      return null
  }
}

test.describe('Session Page', () => {
  test('should sort transcript entries by timestamp', async ({ page, request }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Requires real session files on disk')

    const apiBase = await resolveApiBase(request)
    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json().catch(() => null)
    const projects = projectsData?.projects || []

    const projectWithSessions = projects.find((p: any) => p.session_count > 0 || p.sessionCount > 0) || projects[0]
    if (!projectWithSessions) {
      test.skip(true, 'No session projects found')
    }

    const dirName = projectWithSessions.dir_name || projectWithSessions.dirName
    expect(dirName, 'Session project dir_name missing').toBeTruthy()

    const sessionsRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    )
    const sessionsData = await sessionsRes.json().catch(() => null)
    const sessions = sessionsData?.sessions || []
    if (sessions.length === 0) {
      test.skip(true, 'No sessions found')
    }

    const sessionId = sessions[0]?.id
    expect(sessionId, 'Session id missing').toBeTruthy()

    const transcriptRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}?limit=100&offset=0`
    )
    const transcriptData = await transcriptRes.json().catch(() => null)
    const entries = transcriptData?.session?.entries || []
    if (entries.length === 0) {
      test.skip(true, 'No session entries found')
    }

    const indexed = entries.map((entry: any, index: number) => ({
      entry,
      index,
      timestamp: entry.timestamp ? Date.parse(entry.timestamp) : null,
    }))

    const sortable = indexed.filter((item) => item.timestamp !== null)
    if (sortable.length < 2) {
      test.skip(true, 'Not enough timestamped entries to validate sort')
    }

    indexed.sort((a, b) => {
      const aTs = a.timestamp
      const bTs = b.timestamp
      if (aTs !== null && bTs !== null) {
        if (aTs === bTs) return a.index - b.index
        return aTs - bTs
      }
      return a.index - b.index
    })

    const expectedAsc = indexed.map((item) => item.entry)
    const expectedDesc = [...expectedAsc].reverse()

    const projectId = projectWithSessions.matched_project?.id || projectWithSessions.matchedProject?.id
    const sessionUrl = projectId
      ? `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`

    await page.goto(sessionUrl)
    await page.waitForLoadState('networkidle')

    // Skip if session page didn't load transcript (e.g., test env with no session files)
    // Check for the sort order select which only appears on the session transcript page
    const sortSelect = page.locator('#session-sort-order')
    const hasSortSelect = await sortSelect.isVisible({ timeout: 5000 }).catch(() => false)
    if (!hasSortSelect) {
      test.skip(true, 'Session transcript page not loaded (no sort control)')
    }

    const timestampSpans = page.locator('[class*="_entryRole_"] span')
    const count = await timestampSpans.count()
    if (count < 2) {
      test.skip(true, 'Not enough timestamped entries in UI')
    }

    const firstValue = await timestampSpans.nth(0).textContent()
    const secondValue = await timestampSpans.nth(1).textContent()
    const firstMinutes = firstValue ? parseRelativeTimeToMinutes(firstValue) : null
    const secondMinutes = secondValue ? parseRelativeTimeToMinutes(secondValue) : null
    if (firstMinutes === null || secondMinutes === null) {
      test.skip(true, 'Unable to parse relative timestamps in UI')
    }
    expect(firstMinutes!).toBeLessThanOrEqual(secondMinutes!)

    const nextButton = page.locator('button', { hasText: 'Next' })
    if (await nextButton.isEnabled()) {
      await nextButton.click()
      await page.waitForLoadState('networkidle')
      const page2FirstValue = await timestampSpans.nth(0).textContent()
      const page2FirstMinutes = page2FirstValue ? parseRelativeTimeToMinutes(page2FirstValue) : null
      if (page2FirstMinutes === null) {
        test.skip(true, 'Unable to parse relative timestamps on page 2')
      }
      expect(page2FirstMinutes!).toBeGreaterThanOrEqual(firstMinutes!)
    }

    await page.locator('#session-sort-order').selectOption('asc')

    const firstAscValue = await timestampSpans.nth(0).textContent()
    const secondAscValue = await timestampSpans.nth(1).textContent()
    const firstAscMinutes = firstAscValue ? parseRelativeTimeToMinutes(firstAscValue) : null
    const secondAscMinutes = secondAscValue ? parseRelativeTimeToMinutes(secondAscValue) : null
    if (firstAscMinutes === null || secondAscMinutes === null) {
      test.skip(true, 'Unable to parse relative timestamps in UI (asc)')
    }
    expect(firstAscMinutes!).toBeGreaterThanOrEqual(secondAscMinutes!)

    await expectNoVisibleErrors(page)
  })

  test('ids_only param should return all session IDs in correct sort order', async ({ request }) => {
    const apiBase = await resolveApiBase(request)

    // Get a project with sessions
    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json().catch(() => null)
    const projects = projectsData?.projects || []

    const projectWithSessions = projects.find((p: any) => (p.session_count || p.sessionCount || 0) >= 3) || projects[0]
    if (!projectWithSessions) {
      test.skip(true, 'No session projects found')
    }

    const dirName = projectWithSessions.dir_name || projectWithSessions.dirName
    expect(dirName, 'Session project dir_name missing').toBeTruthy()

    // Fetch sessions with regular pagination (first page)
    const regularRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}?sort=date&order=desc&limit=50`
    )
    const regularData = await regularRes.json()
    expect(regularData.sessions).toBeDefined()
    expect(regularData.pagination).toBeDefined()

    // Fetch with ids_only=true
    const idsOnlyRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}?sort=date&order=desc&ids_only=true`
    )
    const idsOnlyData = await idsOnlyRes.json()

    // Verify ids array is returned
    expect(idsOnlyData.ids).toBeDefined()
    expect(Array.isArray(idsOnlyData.ids)).toBe(true)
    expect(idsOnlyData.ids.length).toBeGreaterThan(0)

    // IDs should be returned without pagination limit
    expect(idsOnlyData.ids.length).toBe(regularData.pagination.total_count)

    // First IDs should match the regular list order
    const regularIds = regularData.sessions.map((s: any) => s.id)
    for (let i = 0; i < regularIds.length; i++) {
      expect(idsOnlyData.ids[i]).toBe(regularIds[i])
    }

    // Test with ascending order
    const idsAscRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}?sort=date&order=asc&ids_only=true`
    )
    const idsAscData = await idsAscRes.json()

    // Ascending should be reverse of descending
    expect(idsAscData.ids.length).toBe(idsOnlyData.ids.length)
    expect(idsAscData.ids[0]).toBe(idsOnlyData.ids[idsOnlyData.ids.length - 1])
    expect(idsAscData.ids[idsAscData.ids.length - 1]).toBe(idsOnlyData.ids[0])
  })

  test('session navigation should use full sorted list', async ({ page, request }) => {
    const apiBase = await resolveApiBase(request)

    // Get a project with multiple sessions
    const projectsRes = await request.get(`${apiBase}/assistants/claude-code/sessions`)
    const projectsData = await projectsRes.json().catch(() => null)
    const projects = projectsData?.projects || []

    const projectWithSessions = projects.find((p: any) => (p.session_count || p.sessionCount || 0) >= 3)
    if (!projectWithSessions) {
      test.skip(true, 'Need at least 3 sessions to test navigation')
    }

    const dirName = projectWithSessions.dir_name || projectWithSessions.dirName
    const projectId = projectWithSessions.matched_project?.id

    // Get all session IDs in sorted order
    const idsRes = await request.get(
      `${apiBase}/assistants/claude-code/sessions/${encodeURIComponent(dirName)}?sort=date&order=desc&ids_only=true`
    )
    const idsData = await idsRes.json()
    const sortedIds = idsData.ids

    if (sortedIds.length < 3) {
      test.skip(true, 'Need at least 3 sessions to test navigation')
    }

    // Navigate to sessions list page
    const sessionsUrl = projectId
      ? `/projects/${projectId}/sessions`
      : `/assistants/claude-code/sessions/${encodeURIComponent(dirName)}`
    await page.goto(sessionsUrl)
    await page.waitForLoadState('networkidle')

    // Click the first session card
    const firstCard = page.locator('[data-testid^="session-card--"]').first()
    await firstCard.click()
    await page.waitForLoadState('networkidle')

    // Should be on session page with nav showing "1 of N"
    const navPosition = page.locator('[class*="_navPosition_"]')
    await expect(navPosition).toContainText('1 of', { timeout: 5000 })

    // Navigate right to session 2
    const rightButton = page.locator('[class*="_navButton_"]').last()
    await rightButton.click()
    await page.waitForLoadState('networkidle')

    // Should now be at session 2
    await expect(navPosition).toContainText('2 of', { timeout: 5000 })

    const secondUrl = page.url()
    expect(secondUrl).not.toBe(sessionsUrl)

    // Navigate right again to session 3
    await rightButton.click()
    await page.waitForLoadState('networkidle')

    await expect(navPosition).toContainText('3 of', { timeout: 5000 })
    const url3 = page.url()
    expect(url3).toContain(sortedIds[2])
  })
})
