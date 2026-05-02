import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe.configure({ mode: 'serial' })

test.describe('Editor scratch files', () => {
  let apiBase = ''
  let originalDrawerEnabled = ''
  let originalScratchHome = ''
  let testScratchHome = ''

  async function clearScratchDir(request: any) {
    if (!testScratchHome) return
    try {
      const res = await request.get(
        `${apiBase}/fs/tree?path=${encodeURIComponent(testScratchHome)}&depth=1`
      )
      if (!res.ok()) return
      const body = await res.json()
      for (const entry of body.entries ?? []) {
        await request.delete(`${apiBase}/fs/delete`, { data: { path: entry.path } })
      }
    } catch {
      // Dir doesn't exist yet — fine.
    }
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    const settingsRes = await request.get(`${apiBase}/settings`)
    const settings = await settingsRes.json()
    originalDrawerEnabled = settings.settings['editor.scratchDrawer.enabled'] ?? 'false'
    originalScratchHome = settings.settings['editor.scratchHome'] ?? ''

    testScratchHome = `/tmp/khef-scratch-e2e-${Date.now()}`

    await request.patch(`${apiBase}/settings`, {
      data: {
        'editor.scratchDrawer.enabled': 'true',
        'editor.scratchHome': testScratchHome,
      },
    })
  })

  test.afterAll(async ({ request }) => {
    await request.patch(`${apiBase}/settings`, {
      data: {
        'editor.scratchDrawer.enabled': originalDrawerEnabled,
        'editor.scratchHome': originalScratchHome,
      },
    })

    if (testScratchHome) {
      await request
        .delete(`${apiBase}/fs/delete`, { data: { path: testScratchHome } })
        .catch(() => {})
    }
  })

  test.beforeEach(async ({ request }) => {
    await clearScratchDir(request)
  })

  test('new scratch appears in the scratches sidebar without a page refresh', async ({ page }) => {
    await page.goto('/editor')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTitle('Scratches')).toBeVisible()

    await page.getByTitle('Scratches').click()

    // Sidebar starts empty.
    await expect(
      page.locator(`div[title^="${testScratchHome}/"]`)
    ).toHaveCount(0)

    await page.getByTitle('New Scratch File').click()

    // Tab and sidebar entry both pick up the new file with no page reload.
    await expect(page.locator(`button[title$="/scratch-1.md"]`)).toBeVisible()
    await expect(page.locator(`div[title$="/scratch-1.md"]`)).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('opening a new scratch after refresh does not clobber existing files', async ({ page, request }) => {
    await page.goto('/editor')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTitle('Scratches')).toBeVisible()
    await page.getByTitle('Scratches').click()

    // Create the first scratch via the UI, then write content via the API
    // (simulates a saved scratch without driving CodeMirror keystrokes).
    await page.getByTitle('New Scratch File').click()
    const path1 = `${testScratchHome}/scratch-1.md`
    await expect(page.locator(`button[title$="/scratch-1.md"]`)).toBeVisible()

    const writeRes = await request.put(`${apiBase}/fs/write`, {
      data: { path: path1, content: 'CONTENT-FROM-FIRST-SCRATCH' },
    })
    expect(writeRes.ok()).toBeTruthy()

    // Full page reload — module-level state resets.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTitle('Scratches')).toBeVisible()
    await page.getByTitle('Scratches').click()

    // Open another scratch — must seed the next number from disk, not start over at 1.
    await page.getByTitle('New Scratch File').click()
    await expect(page.locator(`button[title$="/scratch-2.md"]`)).toBeVisible()

    // The first scratch's saved content must not have been overwritten.
    const readRes = await request.get(
      `${apiBase}/fs/read?path=${encodeURIComponent(path1)}`
    )
    expect(readRes.ok()).toBeTruthy()
    const readBody = await readRes.json()
    expect(readBody.content).toBe('CONTENT-FROM-FIRST-SCRATCH')

    // Tab bar must not contain duplicates of the same scratch path.
    const tabTitles = await page.locator(`button[title^="${testScratchHome}/"]`).evaluateAll(
      (els) => els.map((el) => (el as HTMLElement).getAttribute('title')).filter(Boolean) as string[]
    )
    expect(tabTitles.length).toBe(new Set(tabTitles).size)

    await expectNoVisibleErrors(page)
  })
})
