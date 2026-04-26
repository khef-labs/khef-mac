import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe.configure({ mode: 'serial' })

async function cleanupAllPending(request: any, apiBase: string) {
  const res = await request.get(`${apiBase}/agent-questions?limit=200`)
  if (!res.ok()) return
  const body = await res.json()
  for (const q of body.questions ?? []) {
    await request.delete(`${apiBase}/agent-questions/${q.id}`).catch(() => {})
  }
}

test.describe('Agent question panel', () => {
  let apiBase = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)
    const health = await request.get(`${apiBase}/agent-questions/health`).catch(() => null)
    if (!health || health.status() !== 200) {
      test.skip(true, 'Redis-backed agent questions API unavailable')
    }
    await cleanupAllPending(request, apiBase)
  })

  test.afterEach(async ({ request }) => {
    await cleanupAllPending(request, apiBase)
  })

  test('shows badge on new question, opens panel on click, submits an answer', async ({
    page,
    request,
  }) => {
    const created = await retryOn429(() =>
      request.post(`${apiBase}/agent-questions`, {
        data: {
          title: 'Pick a static site generator',
          fields: [
            {
              key: 'gen',
              type: 'single-choice',
              label: 'Generator',
              required: true,
              options: [
                { value: 'astro', label: 'Astro' },
                { value: 'hugo', label: 'Hugo' },
              ],
            },
            { key: 'notes', type: 'textarea', label: 'Notes' },
          ],
        },
      }),
    )
    expect(created.status()).toBe(201)
    const { question } = await created.json()

    await page.goto('/projects')
    await page.waitForLoadState('domcontentloaded')

    // The panel should NOT auto-open. The badge should be visible.
    const panel = page.locator('[data-testid="agent-question-panel"]')
    const badge = page.locator('[data-testid="agent-question-host--badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await expect(panel).toBeHidden()
    await expect(badge).toContainText('1')

    // Click the badge to open the panel.
    await badge.click()
    await expect(panel).toBeVisible()
    await expect(panel.locator('h2')).toContainText('Pick a static site generator')

    const submit = panel.locator('[data-testid="agent-question-panel--submit"]')
    await expect(submit).toBeDisabled()

    await panel.locator('[data-testid="agent-question-option--gen--astro"]').click()
    await panel
      .locator('[data-testid="agent-question-field--notes"]')
      .fill('Keep it minimal.')

    await expect(submit).toBeEnabled()
    await submit.click()

    // Panel should close, badge should disappear.
    await expect(panel).toBeHidden({ timeout: 5000 })
    await expect(badge).toBeHidden({ timeout: 5000 })

    const fetched = await request.get(`${apiBase}/agent-questions/${question.id}`)
    expect(fetched.status()).toBe(200)
    const body = await fetched.json()
    expect(body.question.status).toBe('answered')
    expect(body.answer.values.gen).toBe('astro')
    expect(body.answer.values.notes).toBe('Keep it minimal.')

    await expectNoVisibleErrors(page)
  })

  test('close button hides panel without canceling the question', async ({
    page,
    request,
  }) => {
    const created = await retryOn429(() =>
      request.post(`${apiBase}/agent-questions`, {
        data: {
          title: 'Stay pending',
          fields: [{ key: 'x', type: 'text', label: 'X' }],
        },
      }),
    )
    expect(created.status()).toBe(201)
    const { question } = await created.json()

    await page.goto('/projects')
    await page.waitForLoadState('domcontentloaded')

    const badge = page.locator('[data-testid="agent-question-host--badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click()

    const panel = page.locator('[data-testid="agent-question-panel"]')
    await expect(panel).toBeVisible()
    await panel.locator('[data-testid="agent-question-panel--close"]').click()
    await expect(panel).toBeHidden({ timeout: 5000 })

    // Question should still be pending — badge stays visible.
    await expect(badge).toBeVisible()
    const fetched = await request.get(`${apiBase}/agent-questions/${question.id}`)
    const body = await fetched.json()
    expect(body.question.status).toBe('pending')

    await expectNoVisibleErrors(page)
  })

  test('cancel-question button kills the question via the API', async ({
    page,
    request,
  }) => {
    const created = await retryOn429(() =>
      request.post(`${apiBase}/agent-questions`, {
        data: {
          title: 'Cancel me',
          fields: [{ key: 'x', type: 'text', label: 'X' }],
        },
      }),
    )
    expect(created.status()).toBe(201)
    const { question } = await created.json()

    await page.goto('/projects')
    await page.waitForLoadState('domcontentloaded')

    const badge = page.locator('[data-testid="agent-question-host--badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click()

    const panel = page.locator('[data-testid="agent-question-panel"]')
    await expect(panel).toBeVisible()
    await panel.locator('[data-testid="agent-question-panel--cancel-question"]').click()
    await expect(panel).toBeHidden({ timeout: 5000 })
    await expect(badge).toBeHidden({ timeout: 5000 })

    const fetched = await request.get(`${apiBase}/agent-questions/${question.id}`)
    const body = await fetched.json()
    expect(body.question.status).toBe('canceled')

    await expectNoVisibleErrors(page)
  })
})
