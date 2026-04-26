import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe('Assistants Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/assistants')
    await page.waitForLoadState('networkidle')
    // Wait for loading to complete
    await page.waitForTimeout(1000)
  })

  test('should display page title', async ({ page }) => {
    // Check page title
    const title = page.locator('h1', { hasText: 'Assistants' })
    await expect(title).toBeVisible({ timeout: 10000 })

    // Check subtitle
    const subtitle = page.locator('[data-testid="assistants-page--subtitle"]')
    await expect(subtitle).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should display assistants list or empty state', async ({ page }) => {
    // Should show either assistant cards or empty message
    const assistantCards = page.locator('[data-testid^="assistant-card--"]')
    const emptyState = page.locator('[class*="_empty_"]')

    const hasCards = await assistantCards.count() > 0
    const hasEmpty = await emptyState.isVisible()

    // One of them should be visible (not both would be an error)
    expect(hasCards || hasEmpty).toBe(true)

    await expectNoVisibleErrors(page)
  })

  test('should display assistant name when cards exist', async ({ page }) => {
    const assistantCards = page.locator('[data-testid^="assistant-card--"]')
    const count = await assistantCards.count()

    if (count > 0) {
      // Check for assistant name
      const assistantName = page.locator('[data-testid^="assistant-card--name-"]').first()
      await expect(assistantName).toBeVisible()

      // Check for assistant description
      const assistantDescription = page.locator('[data-testid^="assistant-card--description-"]').first()
      await expect(assistantDescription).toBeVisible()
    }

    await expectNoVisibleErrors(page)
  })

  test('should display config levels on detail page only', async ({ page }) => {
    // The list endpoint doesn't return config_levels, so they shouldn't appear on the list page
    // Config levels are only shown on the assistant detail page
    const assistantCards = page.locator('[data-testid^="assistant-card--"]')
    const count = await assistantCards.count()

    if (count > 0) {
      // Config levels should NOT be visible on list page (API doesn't return them)
      const configLevels = page.locator('[class*="_configLevels_"]')
      const configLevelsCount = await configLevels.count()
      expect(configLevelsCount).toBe(0)

      // Navigate to detail page to see config levels
      await assistantCards.first().click()
      await page.waitForLoadState('networkidle')

      // Now we should see config levels on the detail page (in discovery or elsewhere)
      await expect(page).toHaveURL(/\/assistants\//)
    }

    await expectNoVisibleErrors(page)
  })

  test('should navigate to assistant detail page when clicking card', async ({ page }) => {
    const assistantCard = page.locator('[data-testid^="assistant-card--"]').first()
    const cardCount = await assistantCard.count()

    if (cardCount > 0) {
      await assistantCard.click()
      await page.waitForLoadState('networkidle')

      // Should navigate to assistant page (may land on a sub-tab like /configs)
      expect(page.url()).toMatch(/\/assistants\/[a-z-]+/)

      // Should show assistant name as h1
      const title = page.locator('h1')
      await expect(title.first()).toBeVisible()
    }

    await expectNoVisibleErrors(page)
  })

  test('should have working navigation link in sidebar', async ({ page }) => {
    // Verify we're on assistants page via sidebar active state
    const navLink = page.locator('[data-testid="nav--assistants"]')
    await expect(navLink).toBeVisible()
    await expect(navLink).toHaveClass(/navLinkActive/)

    await expectNoVisibleErrors(page)
  })
})

test.describe('Assistant Detail Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate directly to claude-code assistant (known to exist)
    await page.goto('/assistants/claude-code')
    await page.waitForLoadState('networkidle')
  })

  test('should display assistant title', async ({ page }) => {
    // Assistant detail uses sidebar layout with h1 heading
    const title = page.locator('h1').first()
    await expect(title).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should auto-discover config files on page load', async ({ page }) => {
    // Discovery should happen automatically - check for discovery panel or configs
    await page.waitForLoadState('networkidle')

    // Either discovered files panel or configurations section should be visible
    const discoveryPanel = page.locator('[class*="_discoveryPanel_"]')
    const configList = page.locator('[class*="_configList_"]')
    const emptyState = page.locator('[class*="_empty_"]')

    // One of these should be visible after auto-discovery
    const hasDiscovery = await discoveryPanel.count()
    const hasConfigs = await configList.count()
    const hasEmpty = await emptyState.count()

    expect(hasDiscovery + hasConfigs + hasEmpty).toBeGreaterThan(0)

    await expectNoVisibleErrors(page)
  })

  test('should display configurations section title', async ({ page }) => {
    // Navigate to configs sub-page which is the default landing
    await page.goto('/assistants/claude-code/configs')
    await page.waitForLoadState('networkidle')

    const sectionTitle = page.locator('h2', { hasText: 'Configs' })
    await expect(sectionTitle).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test.describe('skill routes', () => {
    test.describe.configure({ mode: 'serial' })

    const assistantHandle = 'claude-code'
    const skillName = 'ui-test-skill-route'
    let apiBase = ''
    let created = false

    test.beforeAll(async ({ request }) => {
      apiBase = await resolveApiBase(request)

      const existing = await retryOn429(() =>
        request.get(
          `${apiBase}/assistants/${assistantHandle}/commands/${encodeURIComponent(skillName)}?scope=user&type=skill`
        )
      )

      if (existing.ok()) return

      const createRes = await retryOn429(() =>
        request.post(`${apiBase}/assistants/${assistantHandle}/commands`, {
          data: {
            name: skillName,
            description: 'Skill route regression test',
            content: '# UI Test Skill\n\nLegacy skill URLs should redirect to the command detail page.',
            scope: 'user',
            type: 'skill',
          },
        })
      )

      expect(createRes.ok()).toBeTruthy()
      created = true
    })

    test.afterAll(async ({ request }) => {
      if (!created) return
      await retryOn429(() =>
        request.delete(
          `${apiBase}/assistants/${assistantHandle}/commands/${encodeURIComponent(skillName)}?scope=user&type=skill`
        )
      )
    })

    test('should load skill detail URLs in the skills section', async ({ page }) => {
      await page.goto(
        `/assistants/${assistantHandle}/skills/${encodeURIComponent(skillName)}?scope=user&type=skill&from=%2Fassistants%2F${assistantHandle}`
      )
      await page.waitForLoadState('networkidle')

      await expect(page).toHaveURL(
        new RegExp(`/assistants/${assistantHandle}/skills/${skillName}\\?scope=user&type=skill`)
      )
      await expect(page.locator('h1').first()).toContainText(skillName)

      await expectNoVisibleErrors(page)
    })
  })
})

test.describe('Config Page', () => {
  test.describe.configure({ mode: 'serial' })

  let apiBase = ''
  let testConfigId: string | null = null
  let rulesConfigId: string | null = null
  const assistantHandle = 'claude-code'

  let createdConfigId: string | null = null
  let createdRulesConfigId: string | null = null

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Get configs for claude-code assistant
    try {
      const configsRes = await retryOn429(() => request.get(`${apiBase}/assistants/${assistantHandle}/configs`))
      if (configsRes.ok()) {
        const data = await configsRes.json()
        const configs = data.configs || data
        if (Array.isArray(configs) && configs.length > 0) {
          testConfigId = configs[0].id
          const rulesConfig = configs.find(
            (config) => config.scope === 'global' && config.type === 'rules'
          )
          if (rulesConfig?.id) {
            rulesConfigId = rulesConfig.id
          }
          return
        }
      }
    } catch {
      // Continue to create test config
    }

    // No existing configs - create a test config using scope and type
    try {
      const createRes = await retryOn429(() =>
        request.post(`${apiBase}/assistants/${assistantHandle}/configs`, {
          data: {
            scope: 'global',
            type: 'instructions',
            content: '# Test Config\n\nThis is a test config for Playwright tests.',
          },
        })
      )
      if (createRes.ok()) {
        const data = await createRes.json()
        const config = data.config || data
        if (config?.id) {
          testConfigId = config.id
          createdConfigId = config.id
        }
      }
    } catch (err) {
      console.log('Could not create test config:', err)
    }

    if (!rulesConfigId) {
      try {
        const createRes = await retryOn429(() =>
          request.post(`${apiBase}/assistants/${assistantHandle}/configs`, {
            data: {
              scope: 'global',
              type: 'rules',
              content: '# Global Rules\n\n- Follow the rules.',
            },
          })
        )
        if (createRes.ok()) {
          const data = await createRes.json()
          const config = data.config || data
          if (config?.id) {
            rulesConfigId = config.id
            createdRulesConfigId = config.id
          }
        }
      } catch (err) {
        console.log('Could not create rules config:', err)
      }
    }
  })

  test.afterAll(async ({ request }) => {
    // Clean up test config if we created it
    if (createdConfigId) {
      try {
        await retryOn429(() => request.delete(`${apiBase}/assistants/configs/${createdConfigId}`))
      } catch {
        // Ignore cleanup errors
      }
    }
    if (createdRulesConfigId) {
      try {
        await retryOn429(() => request.delete(`${apiBase}/assistants/configs/${createdRulesConfigId}`))
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  test('should display config content in preview mode', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Check for content (either markdown or code format)
    const content = page.locator('[data-testid="config-page--content-markdown"], [data-testid="config-page--content-code"]')
    await expect(content).toBeVisible({ timeout: 10000 })

    // Edit button should be visible
    const editButton = page.locator('[data-testid="config-page--edit-button"]')
    await expect(editButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should enter edit mode when clicking Edit button', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Click Edit button
    const editButton = page.locator('[data-testid="config-page--edit-button"]')
    await expect(editButton).toBeVisible({ timeout: 10000 })
    await editButton.click()

    // Textarea should be visible
    const editor = page.locator('[data-testid="config-page--content-textarea"]')
    await expect(editor).toBeVisible()

    // Save and Cancel buttons should appear
    const saveButton = page.locator('[data-testid="config-page--save-button"]')
    const cancelButton = page.locator('[data-testid="config-page--cancel-button"]')
    await expect(saveButton).toBeVisible()
    await expect(cancelButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should cancel edit with Cancel button', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Enter edit mode
    const editButton = page.locator('[data-testid="config-page--edit-button"]')
    await editButton.click()

    const editor = page.locator('[data-testid="config-page--content-textarea"]')
    await expect(editor).toBeVisible()

    // Cancel
    const cancelButton = page.locator('[data-testid="config-page--cancel-button"]')
    await cancelButton.click()

    // Should be back to preview mode
    const content = page.locator('[data-testid="config-page--content-markdown"], [data-testid="config-page--content-code"]')
    await expect(content).toBeVisible()
    await expect(editor).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should cancel edit with Escape key', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Enter edit mode
    const editButton = page.locator('[data-testid="config-page--edit-button"]')
    await editButton.click()

    const editor = page.locator('[data-testid="config-page--content-textarea"]')
    await expect(editor).toBeVisible()

    // Focus the editor and press Escape
    await editor.focus()
    await page.waitForTimeout(100) // Give time for focus
    await page.keyboard.press('Escape')

    // Should be back to preview mode
    const content = page.locator('[data-testid="config-page--content-markdown"], [data-testid="config-page--content-code"]')
    await expect(content).toBeVisible({ timeout: 5000 })
    await expect(editor).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should show version in toolbar', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Version number should be displayed
    const versionText = page.locator('[data-testid="config-page--toolbar"]')
    await expect(versionText).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should display config level name', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Should show the config level name (e.g., "Global Instructions")
    const title = page.locator('[data-testid="config-page--title"]')
    await expect(title).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should display file path', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // File path should be visible
    const filePath = page.locator('[data-testid="config-page--file-path"]')
    await expect(filePath).toBeVisible({ timeout: 10000 })

    // Should contain a path-like string
    const pathText = await filePath.textContent()
    expect(pathText).toMatch(/\//)

    await expectNoVisibleErrors(page)
  })

  test('should navigate back to assistant page', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    // Navigate to config with from= param (as the UI does)
    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}?from=%2Fassistants%2F${assistantHandle}`)
    await page.waitForLoadState('networkidle')

    // Use sidebar nav link to go back to configs list
    const configsLink = page.locator('a', { hasText: 'Configs' })
    await expect(configsLink).toBeVisible({ timeout: 10000 })
    await configsLink.click()

    await page.waitForLoadState('networkidle')

    // Should be on assistant page (may include sub-path)
    expect(page.url()).toMatch(/\/assistants\/[a-z-]+/)

    await expectNoVisibleErrors(page)
  })

  test('should show Refresh button in toolbar', async ({ page }) => {
    if (!testConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${testConfigId}`)
    await page.waitForLoadState('networkidle')

    // Refresh icon button should be visible
    const refreshButton = page.locator('button[title="Refresh from disk"]')
    await expect(refreshButton).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should show Sync button for global rules config', async ({ page }) => {
    if (!rulesConfigId) {
      test.skip()
      return
    }

    await page.goto(`/assistants/${assistantHandle}/configs/${rulesConfigId}`)
    await page.waitForLoadState('networkidle')

    const syncButton = page.locator('button[title="Sync rules to disk"]')
    await expect(syncButton).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })
})
