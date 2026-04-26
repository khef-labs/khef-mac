import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, retryOn429 } from './utils/test-helpers'

const apiBase = '/api'

test.describe('Custom Memory Types', () => {
  let testProjectId: string
  let customTypes: string[] = []

  test.beforeAll(async ({ request }) => {
    // Get all memory types and identify custom ones
    const typesRes = await retryOn429(() => request.get(`${apiBase}/memory-types`))
    expect(typesRes.ok()).toBeTruthy()
    const typesData = await typesRes.json()
    // Only top-level custom types appear in the create dropdown
    // Child types (animation, widget, etc.) are selected via a subtype dropdown
    customTypes = typesData.memory_types
      .filter((t: any) => !t.built_in && !t.parent_type)
      .map((t: any) => t.type)
    console.log('Custom types found:', customTypes)

    // Get a project to test with
    const projectsRes = await retryOn429(() => request.get(`${apiBase}/projects`))
    const data = await projectsRes.json()
    const projects = Array.isArray(data) ? data : data.projects
    testProjectId = projects[0]?.id
    expect(testProjectId).toBeTruthy()
  })

  test('custom types should appear in create memory dropdown', async ({ page }) => {
    test.skip(customTypes.length === 0, 'No custom types exist to test')

    // Navigate to project page
    await page.goto(`/projects/${testProjectId}`)
    await page.waitForLoadState('networkidle')

    // Open create memory panel — use the toolbar Create button (not the form submit)
    const typeSelect = page.locator('#create-type')
    if (await typeSelect.count() === 0) {
      const createButton = page.locator('[class*="_createButton_"]', { hasText: 'Create' }).first()
      await expect(createButton).toBeVisible({ timeout: 10000 })
      await createButton.click()
    }

    // Wait for form to appear
    await expect(typeSelect).toBeVisible({ timeout: 5000 })

    // Get all options in the type dropdown
    const options = await typeSelect.locator('option').allTextContents()
    console.log('Type dropdown options:', options)

    // Convert custom type names to expected display format (kebab-to-title)
    for (const customType of customTypes) {
      const expectedLabel = customType
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')

      const found = options.some(opt =>
        opt === expectedLabel ||
        opt.toLowerCase() === customType.toLowerCase()
      )
      expect(found, `Custom type "${customType}" (label: "${expectedLabel}") should be in dropdown. Found: ${options.join(', ')}`).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('API returns custom types in project memory types', async ({ request }) => {
    test.skip(customTypes.length === 0, 'No custom types exist to test')

    const res = await request.get(`${apiBase}/projects/${testProjectId}/memory-types`)
    expect(res.ok()).toBeTruthy()

    const data = await res.json()
    const types = data.memory_types.map((t: any) => t.type)
    console.log('API returned types:', types)

    for (const customType of customTypes) {
      expect(types, `Custom type "${customType}" should be in API response`).toContain(customType)
    }
  })
})
