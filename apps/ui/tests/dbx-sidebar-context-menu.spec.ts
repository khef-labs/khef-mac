import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe.configure({ mode: 'serial' })

/**
 * Right-click context menu on saved queries and scripts in the DBX sidebar.
 *
 * Covers:
 * - Menu opens with the expected items for each row kind
 * - "Copy ID" writes the row id to the clipboard
 * - Saved-query menu includes "Copy handle"; script menu omits it
 * - When right-clicking near the bottom of the viewport, the menu is shifted
 *   inside the viewport bounds instead of getting cut off (the bug Roger hit
 *   when right-clicking the lowest script row).
 */

test.describe('DBX sidebar right-click context menu', () => {
  let apiBase = ''
  let builtinConnId = ''
  let savedQueryId = ''
  let scriptId = ''
  const queryHandle = `e2e-ctxmenu-${Date.now()}`
  const queryName = `E2E ctxmenu ${Date.now()}`
  const scriptName = `e2e-ctxmenu-script-${Date.now()}`

  test.beforeAll(async ({ request, browser }) => {
    apiBase = await resolveApiBase(request)

    // Find the builtin connection — the test row is bound to it so we can
    // clean it up without disturbing user connections.
    const connsRes = await request.get(`${apiBase}/dbx/connections`)
    expect(connsRes.ok()).toBeTruthy()
    const { connections } = await connsRes.json()
    const builtin = connections.find((c: any) => c.is_builtin)
    expect(builtin, 'expected a builtin dbx connection').toBeTruthy()
    builtinConnId = builtin.id

    // Saved query with deterministic handle + name so the row data-testid is
    // findable and toast text is exact.
    const sqRes = await request.post(`${apiBase}/dbx/saved-queries`, {
      data: {
        name: queryName,
        handle: queryHandle,
        connection_id: builtinConnId,
        sql: 'SELECT 1',
        owner_session_id: 'khef-ui',
        is_shared: true,
      },
    })
    expect(sqRes.ok()).toBeTruthy()
    savedQueryId = (await sqRes.json()).saved_query.id

    // Script (separate kind) — same purpose.
    const scRes = await request.post(`${apiBase}/dbx/scripts`, {
      data: {
        name: scriptName,
        content: 'SELECT 1',
        connection_id: builtinConnId,
      },
    })
    expect(scRes.ok()).toBeTruthy()
    scriptId = (await scRes.json()).script.id

    // Grant clipboard access for the default Chromium context so the menu's
    // Copy actions don't throw NotAllowedError.
    await browser.contexts()[0]?.grantPermissions(['clipboard-read', 'clipboard-write'])
  })

  test.afterAll(async ({ request }) => {
    if (savedQueryId) {
      await request.delete(`${apiBase}/dbx/saved-queries/${savedQueryId}`).catch(() => {})
    }
    if (scriptId) {
      await request.delete(`${apiBase}/dbx/scripts/${scriptId}`).catch(() => {})
    }
  })

  test('right-click on a saved query shows the copy menu and copies ID', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/dbx')
    await page.waitForLoadState('domcontentloaded')

    const row = page.getByTestId(`saved-query-row--${queryHandle}`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })

    const menu = page.getByTestId('dbx-sidebar-context-menu')
    await expect(menu).toBeVisible()

    // Saved-query menu includes all four actions including Copy handle.
    await expect(menu.getByText('Copy name', { exact: true })).toBeVisible()
    await expect(menu.getByText('Copy ID', { exact: true })).toBeVisible()
    await expect(menu.getByText('Copy name + ID', { exact: true })).toBeVisible()
    await expect(menu.getByText('Copy handle', { exact: true })).toBeVisible()

    await menu.getByText('Copy ID', { exact: true }).click()
    await expect(menu).toBeHidden()

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(savedQueryId)

    await expectNoVisibleErrors(page)
  })

  test('right-click on a script shows the copy menu without Copy handle', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/dbx')
    await page.waitForLoadState('domcontentloaded')

    const row = page.getByTestId(`dbx-script-row--${scriptId}`)
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })

    const menu = page.getByTestId('dbx-sidebar-context-menu')
    await expect(menu).toBeVisible()

    await expect(menu.getByText('Copy name', { exact: true })).toBeVisible()
    await expect(menu.getByText('Copy ID', { exact: true })).toBeVisible()
    await expect(menu.getByText('Copy name + ID', { exact: true })).toBeVisible()
    // Scripts don't have a kebab-case handle so the Copy handle row is omitted.
    await expect(menu.getByText('Copy handle', { exact: true })).toHaveCount(0)

    await menu.getByText('Copy name + ID', { exact: true }).click()
    await expect(menu).toBeHidden()

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(`${scriptName} (${scriptId})`)

    await expectNoVisibleErrors(page)
  })

  test('menu stays inside the viewport when right-clicked near the bottom edge', async ({ page }) => {
    // Constrained height so the bottommost sidebar row is close to the
    // viewport bottom — this is the scenario where the menu used to overflow.
    await page.setViewportSize({ width: 1280, height: 480 })
    await page.goto('/dbx')
    await page.waitForLoadState('domcontentloaded')

    const row = page.getByTestId(`dbx-script-row--${scriptId}`)
    await expect(row).toBeVisible()
    await row.scrollIntoViewIfNeeded()
    const rowBox = await row.boundingBox()
    if (!rowBox) throw new Error('script row has no bounding box')

    // Right-click near the bottom of the row so the menu's natural position
    // would overflow the viewport without the clamp.
    await row.click({
      button: 'right',
      position: { x: Math.min(rowBox.width - 4, 20), y: Math.max(1, rowBox.height - 2) },
    })

    const menu = page.getByTestId('dbx-sidebar-context-menu')
    await expect(menu).toBeVisible()
    // useLayoutEffect commits the corrected position synchronously after the
    // first paint; a single frame is enough for the second render to land.
    await page.waitForTimeout(50)

    const menuBox = await menu.boundingBox()
    const viewport = page.viewportSize()
    if (!menuBox || !viewport) throw new Error('menu or viewport missing dimensions')

    expect(menuBox.x, 'menu left edge inside viewport').toBeGreaterThanOrEqual(0)
    expect(menuBox.y, 'menu top edge inside viewport').toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width, 'menu right edge inside viewport').toBeLessThanOrEqual(viewport.width)
    expect(menuBox.y + menuBox.height, 'menu bottom edge inside viewport').toBeLessThanOrEqual(viewport.height)

    await expectNoVisibleErrors(page)
  })
})
