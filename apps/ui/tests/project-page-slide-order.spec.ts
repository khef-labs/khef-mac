import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

/**
 * Regression guard for: project memories list endpoint must include `metadata`
 * when compact=false, so the slide_order sort comparator on ProjectPage can
 * order memories by metadata['slide-order'] instead of falling back to API
 * insertion order. Without metadata in the response, every value is +Infinity
 * and tiebreaker is created_at — a memory with slide-order=30 ends up wherever
 * its creation time happens to land.
 */
test.describe('Project page — slide_order sort respects slide-order metadata', () => {
  test.describe.configure({ mode: 'serial' })

  let apiBase = ''
  let projectId = ''
  let lastSlideId = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)
    const handle = `slide-order-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

    const proj = await retryOn429(() =>
      request.post(`${apiBase}/projects`, { data: { handle, name: 'Slide Order Test' } }),
    )
    if (!proj.ok()) {
      throw new Error(`POST /projects failed: ${proj.status()} ${await proj.text()}`)
    }
    projectId = (await proj.json()).project.id

    // Five memories with slide-order: 1, 5, 10, 15, 30. Created in that
    // sequence, so created_at ASC also goes 1→5→10→15→30. To prove the sort
    // really is using metadata (not just insertion order), the next test
    // creates an extra memory with slide-order=2 *last* — its created_at
    // is newest but its slide-order should place it second.
    const orders = [1, 5, 10, 15, 30]
    for (const order of orders) {
      const m = await retryOn429(() =>
        request.post(`${apiBase}/projects/${projectId}/memories`, {
          data: { handle: `mem-${order}`, title: `Memory ${order}`, content: '.', type: 'context' },
        }),
      )
      const id = (await m.json()).memory.id
      if (order === 30) lastSlideId = id
      await retryOn429(() =>
        request.put(`${apiBase}/memories/${id}/metadata/slide-order`, {
          data: { value: String(order) },
        }),
      )
    }

    // Out-of-creation-order memory: created last but slide-order=2, so it
    // should sort *second* under slide_order, not last.
    const late = await retryOn429(() =>
      request.post(`${apiBase}/projects/${projectId}/memories`, {
        data: { handle: 'mem-2', title: 'Memory 2', content: '.', type: 'context' },
      }),
    )
    const lateId = (await late.json()).memory.id
    await retryOn429(() =>
      request.put(`${apiBase}/memories/${lateId}/metadata/slide-order`, {
        data: { value: '2' },
      }),
    )
  })

  test.afterAll(async ({ request }) => {
    if (projectId) {
      await retryOn429(() => request.delete(`${apiBase}/projects/${projectId}`))
    }
  })

  test('list endpoint returns metadata with compact=false', async ({ request }) => {
    const res = await retryOn429(() =>
      request.get(`${apiBase}/projects/${projectId}/memories?compact=false&limit=200`),
    )
    expect(res.status()).toBe(200)
    const body = await res.json()

    const slide30 = body.memories.find((m: any) => m.handle === 'mem-30')
    expect(slide30).toBeDefined()
    expect(slide30.metadata).toBeDefined()
    expect(slide30.metadata['slide-order']).toBe('30')
  })

  test('navigating from slide_order sort lands the high-order memory at the last position', async ({ page }) => {
    // Clear any stale navContext from prior session storage so the test runs
    // against a clean state — mirrors what a user gets after a hard refresh.
    await page.goto('/projects')
    await page.evaluate(() => window.sessionStorage.removeItem('khefNavContext'))

    await page.goto(`/projects/${projectId}`)
    await page.waitForLoadState('domcontentloaded')
    // Wait for at least one memory card to render — proves the list fetch finished.
    await expect(page.locator('[data-testid^="memory-card--"]').first()).toBeVisible({ timeout: 15000 })

    // Switch sort to "Slide" (slide_order). The chip is a button with
    // data-testid="sort-bar--slide_order".
    const slideSort = page.getByTestId('sort-bar--slide_order')
    await expect(slideSort).toBeVisible({ timeout: 10000 })
    await slideSort.click()
    // Wait for the active class to confirm the sort actually applied.
    await expect(slideSort).toHaveAttribute('aria-pressed', 'true')

    // Confirm the rendered DOM order is by slide-order. The lastSlideId
    // (slide-order=30) should be the last memory card in the list.
    const cardIdsInDom = await page
      .locator('[data-testid^="memory-card--"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).getAttribute('data-testid')!.replace('memory-card--', '')))
    expect(cardIdsInDom[cardIdsInDom.length - 1]).toBe(lastSlideId)

    // Click the memory that has the highest slide-order. With 6 memories
    // (slide-order 1, 2, 5, 10, 15, 30), it should land at position 6 of 6.
    const card = page.getByTestId(`memory-card--${lastSlideId}`)
    await expect(card).toBeVisible({ timeout: 10000 })
    await card.click()
    await page.waitForURL(/\/memories\//, { timeout: 15000 })

    expect(page.url()).toContain(`/memories/${lastSlideId}`)

    const navPosition = page.getByTestId('nav-position')
    await expect(navPosition).toBeVisible({ timeout: 10000 })
    await expect(navPosition).toHaveText('6 of 6')

    await expectNoVisibleErrors(page)
  })

  test('reloading a memory page clears stale navContext so user-facing recovery is automatic', async ({ page, context }) => {
    // Reproduces the user-facing bug: navContext is sessionStorage-backed,
    // so it survives sort changes and even hard reloads. If a user opened a
    // memory before slide_order sort was applied (or before metadata was
    // available), they get stuck with the old "N of M" position counter
    // and prev/next stops matching the list's actual order. The expected
    // recovery is "reload the page" — without the main.tsx clear-on-reload
    // hook, that does nothing.

    // Seed a fake stale navContext that has the wrong ids + a wrong index.
    // Use real-looking ids from the test project so the validation passes.
    const memList = await context.request.get(`${apiBase}/projects/${projectId}/memories?compact=true&limit=200`)
    const ids = (await memList.json()).memories.map((m: any) => m.id)

    await page.goto('/projects')
    await page.evaluate((staleIds) => {
      // Reverse order to simulate "stale" — the actual current order is
      // unrelated, but it must include the target id. Index 0 means the
      // memory page will show "1 of 6" before the reload clears it.
      window.sessionStorage.setItem(
        'khefNavContext',
        JSON.stringify({ ids: staleIds, currentIndex: 0, source: '/projects/x' }),
      )
    }, ids)

    await page.goto(`/memories/${ids[0]}`)
    const navPosition = page.getByTestId('nav-position')
    await expect(navPosition).toBeVisible({ timeout: 10000 })
    // Confirm the seeded stale context is in effect — counter shows 1 of N.
    await expect(navPosition).toHaveText(`1 of ${ids.length}`)

    // Trigger a reload. The main.tsx clear-on-reload hook should remove
    // navContext on the next page load, so the counter disappears (no
    // stored context to render from).
    await page.reload()
    await expect(page.getByTestId('nav-position')).toHaveCount(0, { timeout: 10000 })

    // Sanity: sessionStorage was actually cleared, not just hidden by CSS.
    const stored = await page.evaluate(() => window.sessionStorage.getItem('khefNavContext'))
    expect(stored).toBeNull()
  })

  test('paginated project (>20 memories) builds slide-order nav from full list, not just page 1', async ({ page, context }) => {
    // ProjectPage's PAGE_SIZE default is 20. When total > pageSize, clicking
    // a memory card refetches the full id list to build navContext. That
    // refetch was using compact=true, which strips metadata — so the
    // client-side slide-order sort silently fell back to API insertion order
    // (created_at). Repro: add enough memories to exceed page size, click
    // mem-30 (slide-order=30, created 5th overall). Under the bug it would
    // land at position 5 (created_at index); sorted correctly it lands at 6.
    for (let i = 100; i < 125; i++) {
      const m = await retryOn429(() =>
        context.request.post(`${apiBase}/projects/${projectId}/memories`, {
          data: { handle: `mem-${i}`, title: `M${i}`, content: '.', type: 'context' },
        }),
      )
      const id = (await m.json()).memory.id
      await retryOn429(() =>
        context.request.put(`${apiBase}/memories/${id}/metadata/slide-order`, {
          data: { value: String(i) },
        }),
      )
    }

    await page.goto('/projects')
    await page.evaluate(() => window.sessionStorage.removeItem('khef-state'))

    await page.goto(`/projects/${projectId}`)
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid^="memory-card--"]').first()).toBeVisible({ timeout: 15000 })

    await page.getByTestId('sort-bar--slide_order').click()

    // mem-30 (slide-order=30) sits on page 1 once the list is sorted by
    // slide-order: 1, 2, 5, 10, 15, 30, 100, 101, ... — index 5, position 6.
    const lastSlide = page.getByTestId(`memory-card--${lastSlideId}`)
    await expect(lastSlide).toBeVisible({ timeout: 10000 })
    await lastSlide.click()
    await page.waitForURL(/\/memories\//, { timeout: 15000 })

    const navPosition = page.getByTestId('nav-position')
    await expect(navPosition).toHaveText('6 of 31')
  })

  test('mid-order memory created last lands at slot 2, proving sort uses metadata not insertion order', async ({ page, request }) => {
    // The "mem-2" memory was created last in beforeAll but has slide-order=2.
    // Under slide_order sort, it should be position 2 of 6 — not 6 of 6.
    const memList = await retryOn429(() =>
      request.get(`${apiBase}/projects/${projectId}/memories?compact=true&limit=200`),
    )
    const list = await memList.json()
    const mem2 = list.memories.find((m: any) => m.handle === 'mem-2')
    expect(mem2).toBeDefined()
    const mem2Id = mem2.id

    await page.goto('/projects')
    await page.evaluate(() => window.sessionStorage.removeItem('khefNavContext'))

    await page.goto(`/projects/${projectId}`)
    await page.waitForLoadState('domcontentloaded')
    // Wait for at least one memory card to render — proves the list fetch finished.
    await expect(page.locator('[data-testid^="memory-card--"]').first()).toBeVisible({ timeout: 15000 })

    await page.getByTestId('sort-bar--slide_order').click()

    const card2 = page.getByTestId(`memory-card--${mem2Id}`)
    await expect(card2).toBeVisible({ timeout: 10000 })
    await card2.click()
    await page.waitForURL(/\/memories\//, { timeout: 15000 })

    // The mid-order memory (slide-order=2) sits at slot 2 regardless of the
    // total count. The previous test in this file may have added paginated
    // fixtures, so we don't pin "2 of 6" — only the rank in the ordering.
    const navPosition = page.getByTestId('nav-position')
    await expect(navPosition).toHaveText(/^2 of \d+$/)

    await expectNoVisibleErrors(page)
  })
})
