import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Seeded memory: Seed badge on MemoryCard', () => {
  let apiBase = ''
  let userProjectId = ''
  let seededMemoryId = ''
  let nonSeededMemoryId = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Find the user project
    const projectsRes = await request.get(`${apiBase}/projects`)
    const projectsData = await projectsRes.json()
    const userProject = (projectsData.projects || []).find((p: any) => p.handle === 'user')
    if (!userProject) throw new Error('user project not found')
    userProjectId = userProject.id

    // Find one seeded and one non-seeded assistant-rule in the user project
    const memRes = await request.get(
      `${apiBase}/memories?project_id=${userProjectId}&type=assistant-rule&compact=true&limit=50`,
    )
    const memData = await memRes.json()
    const memories: any[] = memData.memories || []

    const seeded = memories.find((m) => m.is_seeded === true)
    const nonSeeded = memories.find((m) => m.is_seeded === false)
    if (!seeded) throw new Error('no seeded assistant-rule found in user project')
    if (!nonSeeded) throw new Error('no non-seeded assistant-rule found in user project')
    seededMemoryId = seeded.id
    nonSeededMemoryId = nonSeeded.id
  })

  test('API returns is_seeded flag on compact list responses', async ({ request }) => {
    const res = await request.get(
      `${apiBase}/memories?project_id=${userProjectId}&type=assistant-rule&compact=true&limit=50`,
    )
    const data = await res.json()
    const seeded = (data.memories || []).find((m: any) => m.id === seededMemoryId)
    const nonSeeded = (data.memories || []).find((m: any) => m.id === nonSeededMemoryId)
    expect(seeded?.is_seeded).toBe(true)
    expect(nonSeeded?.is_seeded).toBe(false)
  })

  test('Seed badge renders on MemoryCards for seeded memories', async ({ page }) => {
    await page.goto(`/projects/${userProjectId}`)
    await page.waitForLoadState('networkidle')

    // Wait for memory cards to render at all
    const anyCard = page.locator('[data-testid^="memory-card--"]').first()
    await expect(anyCard).toBeVisible({ timeout: 10000 })

    // At least one Seed badge should be on the page (user project has seeded rules)
    const seedBadges = page.locator('[data-testid^="memory-card--seed-badge--"]')
    await expect(seedBadges.first()).toBeVisible({ timeout: 5000 })
    await expect(seedBadges.first()).toHaveText('Seed')

    // Count seed badges > 0
    const count = await seedBadges.count()
    expect(count).toBeGreaterThan(0)

    await expectNoVisibleErrors(page)
  })
})
