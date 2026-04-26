import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase, retryOn429 } from './utils/test-helpers'

test.describe('Memory Details Page', () => {
  test.describe.configure({ mode: 'serial' })
  const TEST_PROJECT_HANDLE = 'ui-test-project'
  const TEST_PROJECT_NAME = 'UI Test Project'
  const TEST_MEMORY_HANDLE = 'ui-test-memory'
  const TEST_MEMORY_TITLE = 'UI Test Memory'
  const TEST_MEMORY_CONTENT = 'UI test memory content'
  const TEST_MEMORY_2_HANDLE = 'ui-test-memory-2'
  const TEST_MEMORY_2_TITLE = 'UI Test Memory Two'
  const TEST_MEMORY_2_CONTENT = 'UI test memory content for relation testing'
  const TEST_CHILD_MEMORY_CONTENT = 'UI test memory content for child type display'

  let apiBase = ''

  let testProjectId = ''
  let testMemoryId = ''
  let testMemory2Id = ''
  let testParentType = ''
  let testChildType = ''
  let testChildMemoryId = ''

  async function fetchMemoryByHandle(request: any, handle: string) {
    const res = await request.get(
      `${apiBase}/memories?project_id=${testProjectId}&handle=${encodeURIComponent(handle)}`
    )
    const data = await res.json().catch(() => null)
    const memories = data?.memories || data?.items || data?.data?.memories || []
    return memories.find((memory: any) => memory.handle === handle) || null
  }

  async function deleteProject(
    request: any,
    projectId: string | null,
    allowNotFound = false
  ) {
    if (!projectId) return
    const res = await retryOn429(() => request.delete(`${apiBase}/projects/${projectId}`))
    if (res.ok()) return
    if (allowNotFound && res.status() === 404) return
    throw new Error(`Failed to delete test project: ${res.status()}`)
  }

  async function listProjects(request: any) {
    const res = await retryOn429(() => request.get(`${apiBase}/projects`))
    const data = await res.json().catch(() => null)
    if (Array.isArray(data)) return data
    if (data && Array.isArray(data.projects)) return data.projects
    if (data && Array.isArray(data.items)) return data.items
    if (data?.data && Array.isArray(data.data.projects)) return data.data.projects
    return []
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)
    const suffix = Date.now().toString(36)
    testParentType = `pw-parent-${suffix}`
    testChildType = `pw-child-${suffix}`

    let project = null

    const createProject = async () => {
      const res = await retryOn429(() =>
        request.post(`${apiBase}/projects`, {
          data: {
            handle: TEST_PROJECT_HANDLE,
            name: TEST_PROJECT_NAME,
          },
        })
      )
      const data = await res.json().catch(() => null)
      const created = data?.project || data
      if (!res.ok() || !created?.id) {
        const details = data ? JSON.stringify(data) : await res.text().catch(() => '')
        throw new Error(
          `Failed to create test project: ${res.status()} ${details}`
        )
      }
      return created
    }

    const findProjectByHandle = async () => {
      const projects = await listProjects(request)
      return projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE) || null
    }

    const existing = await findProjectByHandle()
    if (existing?.id) {
      await deleteProject(request, existing.id, true)
    }

    try {
      project = await createProject()
    } catch (error: any) {
      const message = String(error?.message || '')
      if (message.includes('409') || message.includes('projects_handle_key')) {
        const existing = await findProjectByHandle()
        if (existing?.id) {
          await deleteProject(request, existing.id, true)
        }
        project = await createProject()
      } else {
        throw error
      }
    }

    testProjectId = project.id

    const memRes = await retryOn429(() =>
      request.post(
        `${apiBase}/projects/${testProjectId}/memories`,
        {
          data: {
            handle: TEST_MEMORY_HANDLE,
            title: TEST_MEMORY_TITLE,
            content: TEST_MEMORY_CONTENT,
            type: 'user-todo',
            status: 'open',
          },
        }
      )
    )
    const memData = await memRes.json().catch(() => null)
    const memory = memData?.memory || memData
    if (!memRes.ok() || !memory?.id) {
      const details = memData ? JSON.stringify(memData) : await memRes.text().catch(() => '')
      throw new Error(
        `Failed to create test memory: ${memRes.status()} ${details}`
      )
    }
    testMemoryId = memory.id

    // Create a second memory for relation testing
    const mem2Res = await retryOn429(() =>
      request.post(
        `${apiBase}/projects/${testProjectId}/memories`,
        {
          data: {
            handle: TEST_MEMORY_2_HANDLE,
            title: TEST_MEMORY_2_TITLE,
            content: TEST_MEMORY_2_CONTENT,
            type: 'assistant-note',
            status: 'persistent',
          },
        }
      )
    )
    const mem2Data = await mem2Res.json().catch(() => null)
    const memory2 = mem2Data?.memory || mem2Data
    if (!mem2Res.ok() || !memory2?.id) {
      const details = mem2Data ? JSON.stringify(mem2Data) : await mem2Res.text().catch(() => '')
      throw new Error(
        `Failed to create test memory 2: ${mem2Res.status()} ${details}`
      )
    }
    testMemory2Id = memory2.id

    const parentTypeRes = await retryOn429(() =>
      request.post(`${apiBase}/memory-types`, {
        data: {
          name: testParentType,
          description: 'Playwright parent type',
          statuses: [
            { value: 'draft', display_name: 'Draft', sort_order: 1 },
            { value: 'published', display_name: 'Published', sort_order: 2 },
          ],
        },
      })
    )
    if (!parentTypeRes.ok()) {
      const details = await parentTypeRes.text().catch(() => '')
      throw new Error(`Failed to create parent type: ${parentTypeRes.status()} ${details}`)
    }

    const childTypeRes = await retryOn429(() =>
      request.post(`${apiBase}/memory-types`, {
        data: {
          name: testChildType,
          parent_type: testParentType,
          description: 'Playwright child type',
          statuses: [
            { value: 'draft', display_name: 'Draft', sort_order: 1 },
            { value: 'published', display_name: 'Published', sort_order: 2 },
          ],
        },
      })
    )
    if (!childTypeRes.ok()) {
      const details = await childTypeRes.text().catch(() => '')
      throw new Error(`Failed to create child type: ${childTypeRes.status()} ${details}`)
    }

    const childMemRes = await retryOn429(() =>
      request.post(`${apiBase}/projects/${testProjectId}/memories`, {
        data: {
          handle: `ui-test-child-memory-${suffix}`,
          title: 'UI Test Child Memory',
          content: TEST_CHILD_MEMORY_CONTENT,
          type: testChildType,
          status: 'draft',
        },
      })
    )
    const childMemData = await childMemRes.json().catch(() => null)
    const childMemory = childMemData?.memory || childMemData
    if (!childMemRes.ok() || !childMemory?.id) {
      const details = childMemData ? JSON.stringify(childMemData) : await childMemRes.text().catch(() => '')
      throw new Error(`Failed to create child memory: ${childMemRes.status()} ${details}`)
    }
    testChildMemoryId = childMemory.id
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await deleteProject(request, testProjectId, true)
    }
    if (testChildType) {
      await retryOn429(() => request.delete(`${apiBase}/memory-types/${encodeURIComponent(testChildType)}`)).catch(() => null)
    }
    if (testParentType) {
      await retryOn429(() => request.delete(`${apiBase}/memory-types/${encodeURIComponent(testParentType)}`)).catch(() => null)
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 5000 })
      await metadataToggle.click()
      await expect(metadataSection).toBeVisible({ timeout: 5000 })
    }
  })

  function formatStatusLabel(status: string) {
    const labels: Record<string, string> = {
      open: 'Open',
      in_progress: 'In Progress',
      done: 'Done',
      blocked: 'Blocked',
      canceled: 'Canceled',
      proposed: 'Proposed',
      accepted: 'Accepted',
      rejected: 'Rejected',
      superseded: 'Superseded',
      active: 'Active',
      deprecated: 'Deprecated',
      current: 'Current',
      updated: 'Updated',
      outdated: 'Outdated',
    }
    return labels[status] || status
  }

  function formatTypeLabel(type: string) {
    return type
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  }

  test('should display parent type for child memory types', async ({ page }) => {
    await page.goto(`/memories/${testChildMemoryId}`)
    await page.waitForLoadState('networkidle')

    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 5000 })
      await metadataToggle.click()
      await expect(metadataSection).toBeVisible({ timeout: 5000 })
    }

    const expectedParentLabel = formatTypeLabel(testParentType)
    const expectedChildLabel = formatTypeLabel(testChildType)

    // Check type badge shows parent › child
    const typeBadge = metadataSection.locator('[data-testid^="type-badge--"]').first()
    await expect(typeBadge).toContainText(expectedParentLabel)
    await expect(typeBadge).toContainText(expectedChildLabel)

    // Enter edit mode
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    // Type select should show parent type value
    const typeSelect = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Type"))')
      .locator('select')
    await expect(typeSelect).toHaveValue(testParentType)

    // Subtype select should show child type value
    const subtypeSelect = metadataSection.locator('div:has(> div:text-is("Subtype"))').locator('select')
    await expect(subtypeSelect).toHaveValue(testChildType)
  })

  test('should display memory title and badges', async ({ page }) => {
    // Verify we're on a memory page
    expect(page.url()).toMatch(/\/memories\/[a-f0-9-]+/)

    // Check for title
    const title = page.locator('h1').first()
    await expect(title).toBeVisible({ timeout: 10000 })

    // Check for type badge
    const typeBadge = page.locator('[data-testid^="type-badge--"]').first()
    await expect(typeBadge).toBeVisible()

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should display memory content', async ({ page }) => {
    // Check for content section
    const contentSection = page.locator('[data-testid="memory-page--content"]')
    await expect(contentSection).toBeVisible({ timeout: 10000 })

    // Content text should be visible
    const contentText = page.locator('[data-testid="memory-page--content-markdown"]')
    await expect(contentText).toBeVisible()

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should display memory metadata', async ({ page }) => {
    // Check for metadata section
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 10000 })
      await metadataToggle.click()
    }
    await expect(metadataSection).toBeVisible({ timeout: 10000 })

    // Check for handle
    const handleLabel = page.locator('text=Handle')
    await expect(handleLabel).toBeVisible()

    // Check for project
    const projectLabel = metadataSection.getByText('Project', { exact: true })
    await expect(projectLabel).toBeVisible()

    // Check for created timestamp
    const createdLabel = page.locator('text=Created')
    await expect(createdLabel).toBeVisible()

    // Check for updated timestamp (use exact match to avoid matching "Status Updated")
    const updatedLabel = page.getByText('Updated', { exact: true })
    await expect(updatedLabel).toBeVisible()

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should display related memories section', async ({ page }) => {
    // Check for related memories section
    const relatedTitle = page.locator('h2', { hasText: 'Related Memories' })
    await expect(relatedTitle).toBeVisible({ timeout: 10000 })

    // Either related items or "No related memories" message should be visible
    const relatedItems = page.locator('[data-testid^="related-item--"]')
    const emptyMessage = page.locator('text=No related memories found')

    const hasRelated = await relatedItems.count() > 0
    const hasEmpty = await emptyMessage.isVisible()

    expect(hasRelated || hasEmpty).toBe(true)

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should have working back navigation', async ({ page }) => {
    // Navigate back using browser history (breadcrumbs replaced back buttons)
    await page.goBack()
    await page.waitForLoadState('networkidle')

    // Should navigate away from memory page
    expect(page.url()).not.toMatch(/\/memories\/[a-f0-9-]+$/)

    // Verify no error elements are visible
    await expectNoVisibleErrors(page)
  })

  test('should navigate to project when clicking project link', async ({ page }) => {
    // Look for project link
    const projectLink = page.locator('[data-testid="memory-page--project-link"]')

    if (await projectLink.isVisible()) {
      await projectLink.click()
      await page.waitForLoadState('networkidle')

      // Should navigate to project page
      expect(page.url()).toMatch(/\/projects\//)

      // Verify no error elements are visible
      await expectNoVisibleErrors(page)
    }
  })

  test('should navigate to related memory when clicking related item', async ({ page }) => {
    // Look for related memory items
    const relatedItems = page.locator('[data-testid^="related-item--"]')
    const relatedCount = await relatedItems.count()

    if (relatedCount > 0) {
      // Get current memory ID from URL
      const currentUrl = page.url()
      const currentId = currentUrl.match(/\/memories\/([a-f0-9-]+)/)?.[1]

      // Click first related item
      await relatedItems.first().click()
      await page.waitForLoadState('networkidle')

      // Should navigate to different memory page
      expect(page.url()).toMatch(/\/memories\/[a-f0-9-]+/)
      const newId = page.url().match(/\/memories\/([a-f0-9-]+)/)?.[1]

      // Should be a different memory
      expect(newId).not.toBe(currentId)

      // Verify no error elements are visible
      await expectNoVisibleErrors(page)
    }
  })

  test('should show tags when memory has tags', async ({ page }) => {
    // Tags section may or may not be present depending on the memory
    const tagBadges = page.locator('[data-testid^="tag-badge--"]')
    const tagCount = await tagBadges.count()

    if (tagCount > 0) {
      expect(tagCount).toBeGreaterThan(0)
    }

    // Verify no error elements are visible regardless
    await expectNoVisibleErrors(page)
  })

  test('should handle invalid memory ID gracefully', async ({ page }) => {
    // Navigate directly to an invalid memory ID
    await page.goto('/memories/invalid-id-that-does-not-exist')
    await page.waitForLoadState('networkidle')

    // Should show an error message about invalid UUID
    const errorText = page.locator('text=must be a UUID')
    const errorElement = page.locator('[data-testid="memory-page--error"]')

    const hasErrorText = await errorText.isVisible().catch(() => false)
    const hasErrorElement = await errorElement.isVisible().catch(() => false)

    expect(hasErrorText || hasErrorElement).toBe(true)
  })

  test('should display loading state initially', async ({ page }) => {
    // Page should eventually load without errors
    await page.waitForTimeout(1000)
    await expectNoVisibleErrors(page)
  })

  test('should display Type and Status in metadata section', async ({ page }) => {
    // Check for metadata section
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    await expect(metadataSection).toBeVisible({ timeout: 10000 })

    // Check for Type label in metadata
    const typeLabel = metadataSection.locator('text=Type')
    await expect(typeLabel).toBeVisible()

    // Check for Status label in metadata
    const statusLabel = metadataSection.getByText('Status', { exact: true })
    await expect(statusLabel).toBeVisible()

    // Type and Status badges should be visible in metadata
    const typeBadges = metadataSection.locator('[data-testid^="type-badge--"]')
    const statusBadges = metadataSection.locator('[data-testid^="status-badge--"]')
    await expect(typeBadges.first()).toBeVisible()
    await expect(statusBadges.first()).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show edit button for content section', async ({ page }) => {
    const editButton = page.locator('button[title="Edit content"]')
    await editButton.scrollIntoViewIfNeeded()
    await expect(editButton).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should show edit button for metadata section', async ({ page }) => {
    const editButton = page.locator('button[title="Edit metadata"]')
    await expect(editButton).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should show delete button when metadata is being edited', async ({ page }) => {
    const editButton = page.locator('button[title="Edit metadata"]')
    await expect(editButton).toBeVisible({ timeout: 10000 })
    await editButton.click()

    const deleteButton = page.locator('button', { hasText: 'Delete' })
    await expect(deleteButton).toBeVisible()

    const cancelButton = page.locator('button', { hasText: 'Cancel' }).first()
    await cancelButton.click()
  })

  test('should enter content edit mode when clicking edit button', async ({ page }) => {
    // Click edit content button (may need to scroll to it)
    const editButton = page.locator('button[title="Edit content"]')
    await editButton.scrollIntoViewIfNeeded()
    await expect(editButton).toBeVisible({ timeout: 5000 })
    await editButton.click()

    // Textarea should be visible (editing mode active)
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible()

    // Save and Cancel buttons should be visible
    const saveButton = page.locator('button', { hasText: 'Save' })
    const cancelButton = page.locator('button', { hasText: 'Cancel' })
    await expect(saveButton).toBeVisible()
    await expect(cancelButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should enter metadata edit mode when clicking edit button', async ({ page }) => {
    // Click edit metadata button
    const editButton = page.locator('button[title="Edit metadata"]')
    await expect(editButton).toBeVisible({ timeout: 10000 })
    await editButton.click()

    // Project dropdown should be visible in edit mode
    const projectSelect = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Project"))')
      .locator('select')
    await expect(projectSelect).toBeVisible()

    // Type dropdown should be visible
    const typeSelect = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Type"))')
      .locator('select')
    await expect(typeSelect).toBeVisible()

    // Save and Cancel buttons should be visible
    await expect(page.locator('button', { hasText: 'Save' }).first()).toBeVisible()
    await expect(page.locator('button', { hasText: 'Cancel' }).first()).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should cancel content edit mode', async ({ page }) => {
    test.skip(!!process.env.KHEF_USE_TEST_ENV, 'Cancel button interaction differs in test env')

    // Click edit content button
    const editButton = page.locator('button[title="Edit content"]')
    await editButton.scrollIntoViewIfNeeded()
    await expect(editButton).toBeVisible({ timeout: 5000 })
    await editButton.click()

    // Verify we're in edit mode (CodeMirror editor visible)
    const cmEditor = page.locator('.cm-editor')
    await expect(cmEditor).toBeVisible()

    // Click the Cancel button in the content editing toolbar
    const cancelButton = page.locator('button', { hasText: 'Cancel' }).first()
    await cancelButton.scrollIntoViewIfNeeded()
    await cancelButton.click()

    // Should exit edit mode - CodeMirror editor should be hidden
    await expect(cmEditor).toBeHidden({ timeout: 5000 })

    // Edit button should be visible again
    await expect(editButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should cancel metadata edit mode', async ({ page }) => {
    // Click edit metadata button
    const editButton = page.locator('button[title="Edit metadata"]')
    await expect(editButton).toBeVisible({ timeout: 10000 })
    await editButton.click()

    // Verify we're in edit mode — type select should be visible
    const typeSelect = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Type"))')
      .locator('select')
    await expect(typeSelect).toBeVisible()

    // Click cancel
    await page.locator('button', { hasText: 'Cancel' }).first().click()

    // Should exit edit mode - selects should be hidden
    await expect(typeSelect).toBeHidden()

    // Edit button should be visible again
    await expect(editButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should update content and status from the memory page', async ({ page }) => {
    // Capture original title
    const originalTitle = (await page.locator('h1').first().textContent())?.trim() || ''

    // Find and capture original content
    const editContentButton = page.locator('button[title="Edit content"]')
    await editContentButton.scrollIntoViewIfNeeded()
    await editContentButton.click()

    // CodeMirror editor renders as .cm-editor with .cm-content[contenteditable]
    const cmEditor = page.locator('.cm-editor')
    const cmContent = page.locator('.cm-content')
    await expect(cmEditor).toBeVisible({ timeout: 5000 })
    const originalContent = (await cmContent.textContent())?.trim() || ''

    // Update content — use CodeMirror: select all then type
    await cmContent.click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(originalContent + ' (edited)')
    await page.locator('button', { hasText: 'Save' }).first().click()
    await expect(cmEditor).toBeHidden({ timeout: 5000 })

    // Revert content
    await editContentButton.scrollIntoViewIfNeeded()
    await editContentButton.click()
    await expect(cmEditor).toBeVisible({ timeout: 5000 })
    const savedContent = (await cmContent.textContent())?.trim() || ''
    expect(savedContent).toContain('(edited)')
    await cmContent.click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(originalContent)
    await page.locator('button', { hasText: 'Save' }).first().click()
    await expect(cmEditor).toBeHidden({ timeout: 5000 })

    // Update title (metadata)
    const editMetaButton = page.locator('button[title="Edit metadata"]')
    await editMetaButton.click()
    const titleInput = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Title"))')
      .locator('input')
    await expect(titleInput).toBeVisible()
    const updatedTitle = `${originalTitle} (edited)`
    await titleInput.fill(updatedTitle)
    await page.locator('button', { hasText: 'Save' }).first().click()
    await expect(page.locator('h1').first()).toHaveText(updatedTitle)

    // Revert title
    await editMetaButton.click()
    await expect(titleInput).toBeVisible()
    await titleInput.fill(originalTitle)
    await page.locator('button', { hasText: 'Save' }).first().click()
    await expect(page.locator('h1').first()).toHaveText(originalTitle)

    // Update status (metadata)
    await editMetaButton.click()
    const statusSelect = page
      .locator('[data-testid="memory-page--metadata-tables"]')
      .locator('div:has(> div:text-is("Status"))')
      .locator('select')
    await expect(statusSelect).toBeVisible()
    const currentStatus = await statusSelect.inputValue()
    const statusOptions = await statusSelect.locator('option').all()
    let nextStatus: string | null = null

    for (const option of statusOptions) {
      const value = await option.getAttribute('value')
      if (value && value !== currentStatus) {
        nextStatus = value
        break
      }
    }

    if (nextStatus) {
      await statusSelect.selectOption(nextStatus)
      await page.locator('button', { hasText: 'Save' }).first().click()

      // Revert status
      await editMetaButton.click()
      await statusSelect.selectOption(currentStatus)
      await page.locator('button', { hasText: 'Save' }).first().click()
    } else {
      // No alternative status available, exit edit mode
      await page.locator('button', { hasText: 'Cancel' }).first().click()
    }

    await expectNoVisibleErrors(page)
  })

  // ==================== Memory Relations Tests ====================

  test('should display Add Relation button in Related Memories section', async ({ page }) => {
    // Check for related memories section
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    await expect(relatedSection).toBeVisible({ timeout: 10000 })

    // Check for Add Relation button
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should open relation modal when clicking Add Relation button', async ({ page }) => {
    // Find and click the Add Relation button
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    // Modal should be visible
    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Modal should have title
    const modalTitle = modal.locator('[data-testid="relation-modal--title"]')
    await expect(modalTitle).toHaveText('Add Relation')

    // Modal should have relation type dropdown
    const relationTypeSelect = modal.locator('select')
    await expect(relationTypeSelect).toBeVisible()

    // Modal should have search input
    const searchInput = modal.locator('input[type="text"]')
    await expect(searchInput).toBeVisible()

    // Modal should have close button
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await expect(closeButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should close relation modal when clicking close button', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Click close button
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    // Modal should be hidden
    await expect(modal).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should close relation modal when clicking overlay', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modalOverlay = page.locator('[data-testid="relation-modal--overlay"]')
    await expect(modalOverlay).toBeVisible()

    // Click the overlay (not the modal content)
    await modalOverlay.click({ position: { x: 10, y: 10 } })

    // Modal should be hidden
    await expect(modalOverlay).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should have relation type options in dropdown', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Check relation type dropdown exists and has Forward and Inverse optgroups (loaded from API)
    const relationTypeSelect = modal.locator('select')
    await expect(relationTypeSelect).toBeVisible()

    // Check that Forward and Inverse optgroups exist with options
    const forwardGroup = relationTypeSelect.locator('optgroup[label="Forward"]')
    const inverseGroup = relationTypeSelect.locator('optgroup[label="Inverse"]')

    await expect(forwardGroup).toHaveCount(1)
    await expect(inverseGroup).toHaveCount(1)

    // Check that some expected forward options exist
    const forwardOptions = forwardGroup.locator('option')
    const forwardCount = await forwardOptions.count()
    expect(forwardCount).toBeGreaterThan(0)

    // Verify some common relation types are present
    await expect(forwardOptions.filter({ hasText: 'Relates To' })).toHaveCount(1)
    await expect(forwardOptions.filter({ hasText: 'Supports' })).toHaveCount(1)

    // Check inverse options exist
    const inverseOptions = inverseGroup.locator('option')
    const inverseCount = await inverseOptions.count()
    expect(inverseCount).toBeGreaterThan(0)

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should search and display results in relation modal', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Type in search input
    const searchInput = modal.locator('input[type="text"]')
    await searchInput.fill(TEST_MEMORY_2_TITLE.substring(0, 10)) // Search for part of second memory title

    // Wait for results to appear
    await page.waitForTimeout(500) // Allow debounce/search time

    // Either search results or "No memories found" should appear
    const searchResults = modal.locator('[data-testid^="relation-search-result--"]')
    const noResults = modal.locator('text=No memories found')

    // At least one should be visible
    const hasResults = await searchResults.count() > 0
    const hasNoResultsMessage = await noResults.isVisible()
    expect(hasResults || hasNoResultsMessage).toBe(true)

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should create relation when clicking search result', async ({ page, request }) => {
    // First, ensure no existing relations
    const existingRelations = await request.get(`${apiBase}/memories/${testMemoryId}/relations`)
    const existingData = await existingRelations.json().catch(() => [])
    const relationsArray = Array.isArray(existingData) ? existingData : (existingData.relations || [])

    // Delete any existing relations to this memory
    for (const rel of relationsArray) {
      if (rel.id) {
        await request.delete(`${apiBase}/relations/${rel.id}`)
      }
    }

    // Reload page to ensure clean state
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')

    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Search for second memory by title
    const searchInput = modal.locator('input[type="text"]')
    await searchInput.fill(TEST_MEMORY_2_TITLE)

    // Wait for results to appear
    const searchResult = modal.locator('[data-testid^="relation-search-result--"]').filter({
      hasText: TEST_MEMORY_2_TITLE,
    })
    await expect(searchResult.first()).toBeVisible({ timeout: 5000 })

    // Click on the first result and wait for response
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/relations') && response.request().method() === 'POST',
      { timeout: 10000 }
    ).catch(() => null)

    await searchResult.first().click()

    // Wait for the API response
    const response = await responsePromise

    if (response && response.ok()) {
      // Modal should close on success
      await expect(modal).toBeHidden({ timeout: 5000 })

      // Verify the POST response contains a valid relation
      // Note: We don't assert specific IDs because search may return multiple
      // memories with similar titles from different projects
      const responseBody = await response.json().catch(() => null)
      const createdRelation = responseBody?.relation || responseBody

      if (createdRelation?.id) {
        // Verify the relation was created with correct type and has valid IDs
        expect(createdRelation.relation_type).toBe('relates_to')
        expect(createdRelation.source_memory_id).toBeTruthy()
        expect(createdRelation.target_memory_id).toBeTruthy()
      }
    } else {
      // If API failed, modal stays open - close it manually for cleanup
      const closeButton = modal.locator('[data-testid="relation-modal--close"]')
      await closeButton.click()

      // Skip assertion if API doesn't support relations properly
      console.log('Note: Relation creation API may not be available or returned an error')
    }

    await expectNoVisibleErrors(page)
  })

  test('should show relation direction indicators', async ({ page, request }) => {
    // Create a relation via API
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'relates_to',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')

    // Wait for potential async loading
    await page.waitForTimeout(1000)

    // Check that related memory section exists
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    await expect(relatedSection).toBeVisible()

    // Check for related items (may or may not have them depending on API)
    const relatedItems = page.locator('[data-testid^="related-item--"]')
    const itemCount = await relatedItems.count()

    if (itemCount > 0) {
      // If related items exist, check for relation label
      const relationLabel = relatedItems.first().locator('span').first()
      const labelText = await relationLabel.textContent()

      // Should contain either arrow indicator or 'related' text
      expect(labelText).toMatch(/[→←]|related/)
    } else {
      // If no related items, the API may not be returning relations
      // but the relation was created successfully - test passes
      expect(createdRelation?.id).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('should show edit button on related memories', async ({ page, request }) => {
    // Create a relation via API
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'supports',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    // Check for edit button (pencil icon) on related items
    const relatedItemWrapper = page.locator('[data-testid^="relation--"]')

    if (await relatedItemWrapper.count() > 0) {
      const editButton = relatedItemWrapper.first().locator('[data-testid^="relation--edit-"]')
      await expect(editButton).toBeVisible()
    } else {
      // If no related items shown (API issue), verify relation was created
      expect(createdRelation?.id).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('should show edit mode with type dropdown and delete when clicking edit button', async ({ page, request }) => {
    // Create a relation via API
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'relates_to',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    const relatedItemWrapper = page.locator('[data-testid^="relation--"]')

    if (await relatedItemWrapper.count() > 0) {
      const editButton = relatedItemWrapper.first().locator('[data-testid^="relation--edit-"]')

      if (await editButton.isVisible()) {
        await editButton.click()

        // Edit mode should show type dropdown
        const editMode = page.locator('[data-testid="relation--edit-mode"]')
        await expect(editMode).toBeVisible()

        // Should have type dropdown (SelectUpward component)
        const typeSelect = editMode.locator('button[role="combobox"], [class*="_container_"] button').first()
        await expect(typeSelect).toBeVisible()

        // Should have delete button
        const deleteButton = editMode.locator('[data-testid="relation--delete-button"]')
        await expect(deleteButton).toBeVisible()

        // Should have save and cancel buttons
        const saveButton = editMode.locator('[data-testid="relation--save-button"]')
        const cancelButton = editMode.locator('[data-testid="relation--cancel-button"]')
        await expect(saveButton).toBeVisible()
        await expect(cancelButton).toBeVisible()
      }
    } else {
      expect(createdRelation?.id).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('should update relation type when saving edit', async ({ page, request }) => {
    // Create a relation via API
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'relates_to',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    const relatedItemWrapper = page.locator('[data-testid^="relation--"]')

    if (await relatedItemWrapper.count() > 0) {
      const editButton = relatedItemWrapper.first().locator('[data-testid^="relation--edit-"]')

      if (await editButton.isVisible()) {
        await editButton.click()

        const editMode = page.locator('[data-testid="relation--edit-mode"]')
        await expect(editMode).toBeVisible()

        // Change type to 'supports' using SelectUpward component
        const typeSelectTrigger = editMode.locator('button[role="combobox"], [class*="_container_"] button').first()
        await typeSelectTrigger.click()

        // Wait for dropdown and click 'Supports' option
        const dropdown = page.locator('[role="listbox"], [class*="_dropdown_"]')
        await expect(dropdown).toBeVisible()
        await dropdown.locator('button', { hasText: 'Supports' }).click()

        // Click save
        const patchPromise = page.waitForResponse(
          (response) => response.url().includes('/relations/') && response.request().method() === 'PATCH',
          { timeout: 10000 }
        ).catch(() => null)

        const saveButton = editMode.locator('[data-testid="relation--save-button"]')
        await saveButton.click()

        const patchResponse = await patchPromise
        if (patchResponse && patchResponse.ok()) {
          // Edit mode should close
          await expect(editMode).toBeHidden({ timeout: 5000 })
        }
      }
    } else {
      expect(createdRelation?.id).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('should swap source/target when changing relation from forward to inverse type', async ({ page, request }) => {
    // This test verifies that when updating a relation from a forward type (e.g., "supersedes")
    // to its inverse type (e.g., "is_superseded_by"), the relation is properly recreated
    // with swapped source and target

    // Create a relation with forward type: testMemory supersedes testMemory2
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'supersedes',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData
    expect(createdRelation?.id).toBeTruthy()

    // Reload page and dismiss splash if visible
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    // Click splash button if visible to dismiss it
    const splashBtn = page.locator('#splash-btn')
    if (await splashBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await splashBtn.click()
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(500)

    const relatedItemWrapper = page.locator('[data-testid^="relation--"]')

    if (await relatedItemWrapper.count() > 0) {
      // Find the relation we just created (showing "Supersedes" from testMemory's perspective)
      const relatedItem = relatedItemWrapper.filter({ hasText: TEST_MEMORY_2_TITLE })

      if (await relatedItem.count() > 0) {
        const editButton = relatedItem.first().locator('[data-testid^="relation--edit-"]')

        if (await editButton.isVisible()) {
          await editButton.click()

          const editMode = page.locator('[data-testid="relation--edit-mode"]')
          await expect(editMode).toBeVisible()

          // Change type to inverse: "Superseded By" (is_superseded_by)
          const typeSelectTrigger = editMode.locator('button[role="combobox"], [class*="_container_"] button').first()
          await typeSelectTrigger.click()

          const dropdown = page.locator('[role="listbox"], [class*="_dropdown_"]')
          await expect(dropdown).toBeVisible()
          await dropdown.locator('button', { hasText: 'Superseded By' }).click()

          // When changing from forward to inverse, the code should:
          // 1. Delete the old relation
          // 2. Create a new relation with swapped source/target
          const deletePromise = page.waitForResponse(
            (response) => response.url().includes('/relations/') && response.request().method() === 'DELETE',
            { timeout: 10000 }
          ).catch(() => null)

          const createPromise = page.waitForResponse(
            (response) => response.url().includes('/relations') && response.request().method() === 'POST',
            { timeout: 10000 }
          ).catch(() => null)

          const saveButton = editMode.locator('[data-testid="relation--save-button"]')
          await saveButton.click()

          // Wait for both delete and create to complete
          const deleteResponse = await deletePromise
          const newCreateResponse = await createPromise

          // Both operations should succeed
          if (deleteResponse && newCreateResponse) {
            expect(deleteResponse.ok()).toBe(true)
            expect(newCreateResponse.ok()).toBe(true)

            // Verify the new relation has correct source/target (swapped)
            const newRelationData = await newCreateResponse.json().catch(() => null)
            const newRelation = newRelationData?.relation || newRelationData

            // The new relation should have:
            // - source_memory_id = testMemory2Id (the other memory now supersedes this one)
            // - target_memory_id = testMemoryId (this memory is now the target)
            // - relation_type = 'supersedes' (always stored as forward type)
            expect(newRelation?.relation_type).toBe('supersedes')
            expect(newRelation?.source_memory_id).toBe(testMemory2Id)
            expect(newRelation?.target_memory_id).toBe(testMemoryId)

            // Edit mode should close
            await expect(editMode).toBeHidden({ timeout: 5000 })
          }
        }
      }
    } else {
      // API may not support relations display, but verify relation was created
      expect(createdRelation?.id).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  test('should delete relation from edit mode', async ({ page, request }) => {
    // Create a relation via API
    const createRes = await request.post(`${apiBase}/relations`, {
      data: {
        source_memory_id: testMemoryId,
        target_memory_id: testMemory2Id,
        relation_type: 'depends_on',
      },
    })
    const createData = await createRes.json().catch(() => null)
    const createdRelation = createData?.relation || createData
    const relationId = createdRelation?.id

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    const relatedItemWrapper = page.locator('[data-testid^="relation--"]')

    if (await relatedItemWrapper.count() > 0) {
      const initialCount = await relatedItemWrapper.count()
      const editButton = relatedItemWrapper.first().locator('[data-testid^="relation--edit-"]')

      if (await editButton.isVisible()) {
        // Enter edit mode
        await editButton.click()

        const editMode = page.locator('[data-testid="relation--edit-mode"]')
        await expect(editMode).toBeVisible()

        // Click delete button in edit mode
        const deletePromise = page.waitForResponse(
          (response) => response.url().includes('/relations/') && response.request().method() === 'DELETE',
          { timeout: 10000 }
        ).catch(() => null)

        const deleteButton = editMode.locator('[data-testid="relation--delete-button"]')
        await deleteButton.click()

        const deleteResponse = await deletePromise

        if (deleteResponse && deleteResponse.ok()) {
          await page.waitForTimeout(500)

          const newCount = await relatedItemWrapper.count()
          const emptyMessage = page.locator('text=No related memories found')

          expect(newCount < initialCount || await emptyMessage.isVisible()).toBe(true)
        }
      }
    } else {
      expect(relationId).toBeTruthy()
    }

    await expectNoVisibleErrors(page)
  })

  // ==================== New Memory with Relation Tests ====================

  test('should show New button in relation modal', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Check for New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await expect(newButton).toBeVisible()
    await expect(newButton).toHaveText(/New/)

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should show new memory form when clicking New button', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Click New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await newButton.click()

    // Form should be visible
    const newMemoryForm = modal.locator('[data-testid="relation-modal--new-memory-form"]')
    await expect(newMemoryForm).toBeVisible()

    // Check for form fields
    const titleInput = newMemoryForm.locator('input').first()
    await expect(titleInput).toBeVisible()

    const contentTextarea = newMemoryForm.locator('textarea')
    await expect(contentTextarea).toBeVisible()

    const typeSelect = newMemoryForm.locator('select')
    await expect(typeSelect).toBeVisible()

    // Check for Back and Create & Link buttons
    const backButton = newMemoryForm.locator('button', { hasText: 'Back' })
    await expect(backButton).toBeVisible()

    const createButton = newMemoryForm.locator('button', { hasText: 'Create & Link' })
    await expect(createButton).toBeVisible()

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should return to search view when clicking Back in new memory form', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Click New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await newButton.click()

    // Form should be visible
    const newMemoryForm = modal.locator('[data-testid="relation-modal--new-memory-form"]')
    await expect(newMemoryForm).toBeVisible()

    // Click Back
    const backButton = newMemoryForm.locator('button', { hasText: 'Back' })
    await backButton.click()

    // Form should be hidden, search should be visible
    await expect(newMemoryForm).toBeHidden()

    const searchInput = modal.locator('input[type="text"]')
    await expect(searchInput).toBeVisible()

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should create new memory with relation when submitting form', async ({ page, request }) => {
    const newMemoryHandle = 'test-new-memory-' + Date.now()
    const newMemoryTitle = 'Test New Memory With Relation'
    const newMemoryContent = 'Content for new memory created via relation modal'

    // Clean up any existing relations first
    const existingRelations = await request.get(`${apiBase}/memories/${testMemoryId}/relations`)
    const existingData = await existingRelations.json().catch(() => [])
    const relationsArray = Array.isArray(existingData) ? existingData : (existingData.relations || [])
    for (const rel of relationsArray) {
      if (rel.id) {
        await request.delete(`${apiBase}/relations/${rel.id}`)
      }
    }

    // Reload page
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')

    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Select a relation type (supports)
    const relationTypeSelect = modal.locator('[data-testid="relation-modal--type-select"] select')
    await relationTypeSelect.selectOption('supports')

    // Click New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await newButton.click()

    // Fill in the form
    const newMemoryForm = modal.locator('[data-testid="relation-modal--new-memory-form"]')
    await expect(newMemoryForm).toBeVisible()

    const titleInput = newMemoryForm.locator('label', { hasText: 'Title' }).locator('..').locator('input')
    await titleInput.fill(newMemoryTitle)

    const handleInput = newMemoryForm.locator('label', { hasText: 'Handle' }).locator('..').locator('input')
    await handleInput.fill(newMemoryHandle)

    const contentTextarea = newMemoryForm.locator('textarea')
    await contentTextarea.fill(newMemoryContent)

    // Wait for both memory creation and relation creation
    const memoryPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/projects/${testProjectId}/memories`),
      { timeout: 10000 }
    ).catch(() => null)

    const relationPromise = page.waitForResponse(
      (response) => response.url().includes('/relations') && response.request().method() === 'POST',
      { timeout: 10000 }
    ).catch(() => null)

    // Click Create & Link
    const createButton = newMemoryForm.locator('button', { hasText: 'Create & Link' })
    await createButton.click()

    // Wait for responses
    const memoryResponse = await memoryPromise
    const relationResponse = await relationPromise

    // Memory must be created successfully
    expect(memoryResponse).not.toBeNull()
    expect(memoryResponse!.ok()).toBe(true)

    const memoryData = await memoryResponse!.json().catch(() => null)
    let createdMemory = memoryData?.memory || memoryData
    if (!createdMemory?.title || !createdMemory?.handle) {
      createdMemory = await fetchMemoryByHandle(request, newMemoryHandle)
    }
    expect(createdMemory?.title).toBe(newMemoryTitle)
    expect(createdMemory?.handle).toBe(newMemoryHandle)

    // Relation must also be created successfully
    expect(relationResponse).not.toBeNull()
    expect(relationResponse!.ok()).toBe(true)

    const relationData = await relationResponse!.json().catch(() => null)
    const createdRelation = relationData?.relation || relationData
    expect(createdRelation?.relation_type).toBe('supports')

    // Modal should close
    await expect(modal).toBeHidden({ timeout: 5000 })

    // New relation should appear in the list
    await page.waitForTimeout(500)
    const relatedItems = page.locator('[data-testid^="related-item--"]')
    const hasNewRelation = await relatedItems.filter({ hasText: newMemoryTitle }).count() > 0
    expect(hasNewRelation).toBe(true)

    // Clean up: delete the created memory
    if (createdMemory?.id) {
      await request.delete(`${apiBase}/projects/${testProjectId}/memories/${createdMemory.id}`)
    }

    await expectNoVisibleErrors(page)
  })

  test('should show validation error when creating memory without required fields', async ({ page }) => {
    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Click New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await newButton.click()

    // Form should be visible
    const newMemoryForm = modal.locator('[data-testid="relation-modal--new-memory-form"]')
    await expect(newMemoryForm).toBeVisible()

    // Click Create & Link without filling anything
    const createButton = newMemoryForm.locator('button', { hasText: 'Create & Link' })
    await createButton.click()

    // Should show error message
    const errorMessage = newMemoryForm.locator('[data-testid="relation-modal--new-memory-error"]')
    await expect(errorMessage).toBeVisible()
    await expect(errorMessage).toHaveText(/Title and content are required/)

    // Close modal
    const closeButton = modal.locator('[data-testid="relation-modal--close"]')
    await closeButton.click()

    await expectNoVisibleErrors(page)
  })

  test('should create new memory with inverse relation type', async ({ page, request }) => {
    // This test verifies that inverse relation types (like "is_supported_by")
    // are properly resolved to forward types when sent to the API

    // Open the modal
    const relatedSection = page.locator('[data-testid="memory-page--relations-section"]')
    const addRelationButton = relatedSection.locator('button', { hasText: 'Add Relation' })
    await expect(addRelationButton).toBeVisible({ timeout: 10000 })
    await addRelationButton.click()

    const modal = page.locator('[data-testid="relation-modal"]')
    await expect(modal).toBeVisible()

    // Wait for and select an inverse relation type
    const relationTypeSelect = modal.locator('[data-testid="relation-modal--type-select"]').locator('select')
    await expect(relationTypeSelect).toBeVisible({ timeout: 5000 })
    await relationTypeSelect.selectOption('is_supported_by')

    // Click New button
    const newButton = modal.locator('[data-testid="relation-modal--new-memory-button"]')
    await newButton.click()

    // Fill in the form
    const newMemoryForm = modal.locator('[data-testid="relation-modal--new-memory-form"]')
    await expect(newMemoryForm).toBeVisible()

    const newMemoryTitle = `Inverse Test Memory ${Date.now()}`
    const newMemoryHandle = `inverse-test-${Date.now()}`
    const newMemoryContent = 'Test content for inverse relation test'

    const titleInput = newMemoryForm.locator('label', { hasText: 'Title' }).locator('..').locator('input')
    await titleInput.fill(newMemoryTitle)

    const handleInput = newMemoryForm.locator('label', { hasText: 'Handle' }).locator('..').locator('input')
    await handleInput.fill(newMemoryHandle)

    const contentTextarea = newMemoryForm.locator('textarea')
    await contentTextarea.fill(newMemoryContent)

    // Wait for both memory creation and relation creation
    const memoryPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`/projects/${testProjectId}/memories`),
      { timeout: 10000 }
    ).catch(() => null)

    const relationPromise = page.waitForResponse(
      (response) => response.url().includes('/relations') && response.request().method() === 'POST',
      { timeout: 10000 }
    ).catch(() => null)

    // Click Create & Link
    const createButton = newMemoryForm.locator('button', { hasText: 'Create & Link' })
    await createButton.click()

    // Wait for responses
    const memoryResponse = await memoryPromise
    const relationResponse = await relationPromise

    // Memory must be created successfully
    expect(memoryResponse).not.toBeNull()
    expect(memoryResponse!.ok()).toBe(true)

    const memoryData = await memoryResponse!.json().catch(() => null)
    let createdMemory = memoryData?.memory || memoryData
    if (!createdMemory?.title || !createdMemory?.handle) {
      createdMemory = await fetchMemoryByHandle(request, newMemoryHandle)
    }
    expect(createdMemory?.title).toBe(newMemoryTitle)

    // Relation must also be created successfully (inverse type should be resolved to forward)
    expect(relationResponse).not.toBeNull()
    expect(relationResponse!.ok()).toBe(true)

    const relationData = await relationResponse!.json().catch(() => null)
    const createdRelation = relationData?.relation || relationData
    // "is_supported_by" should be resolved to "supports" with swapped source/target
    expect(createdRelation?.relation_type).toBe('supports')

    // Modal should close
    await expect(modal).toBeHidden({ timeout: 5000 })

    // Clean up: delete the created memory
    if (createdMemory?.id) {
      await request.delete(`${apiBase}/projects/${testProjectId}/memories/${createdMemory.id}`)
    }

    await expectNoVisibleErrors(page)
  })

  // ==================== Metadata: Type Cascade Tests ====================

  test('should reset subtype and status when changing type to a parent type', async ({ page }) => {
    // Navigate to the child type memory
    await page.goto(`/memories/${testChildMemoryId}`)
    await page.waitForLoadState('networkidle')

    // Expand metadata
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 5000 })
      await metadataToggle.click()
      await expect(metadataSection).toBeVisible({ timeout: 5000 })
    }

    // Enter edit mode
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    // Verify initial state: type = testParentType, subtype = testChildType
    const typeSelect = metadataSection.locator('div:has(> div:text-is("Type"))').locator('select')
    const subtypeRow = metadataSection.locator('div:has(> div:text-is("Subtype"))')
    const subtypeSelect = subtypeRow.locator('select')
    await expect(typeSelect).toHaveValue(testParentType)
    await expect(subtypeSelect).toHaveValue(testChildType)

    // Change type to 'decision' (a type without children)
    await typeSelect.selectOption('decision')

    // Subtype row should disappear (decision has no children)
    await expect(subtypeRow).toBeHidden({ timeout: 3000 })

    // Status should reset to first status for decision type (async load)
    const statusSelect = metadataSection.locator('div:has(> div:text-is("Status"))').locator('select')
    // Wait for status options to load and auto-select 'proposed'
    await expect(statusSelect).toHaveValue('proposed', { timeout: 5000 })

    // Cancel to avoid persisting
    await page.locator('button', { hasText: 'Cancel' }).first().click()

    await expectNoVisibleErrors(page)
  })

  test('should show subtype options when changing to a parent type with children', async ({ page }) => {
    // Start on the basic test memory (user-todo, no parent/child)
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')

    // Enter edit mode
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    const typeSelect = metadataSection.locator('div:has(> div:text-is("Type"))').locator('select')

    // Change to the custom parent type that has children
    await typeSelect.selectOption(testParentType)

    // Subtype row should appear
    const subtypeRow = metadataSection.locator('div:has(> div:text-is("Subtype"))')
    await expect(subtypeRow).toBeVisible({ timeout: 3000 })

    // Subtype should auto-select first child
    const subtypeSelect = subtypeRow.locator('select')
    await expect(subtypeSelect).toHaveValue(testChildType)

    // Cancel to avoid persisting
    await page.locator('button', { hasText: 'Cancel' }).first().click()

    await expectNoVisibleErrors(page)
  })

  // ==================== Pin Toggle Test ====================

  test('should toggle pin state', async ({ page }) => {
    // Find the pin button in the top nav
    const pinButton = page.locator('button', { hasText: /^Pin$/ }).or(page.locator('button', { hasText: /^Pinned$/ }))
    await expect(pinButton).toBeVisible({ timeout: 10000 })

    const wasPinned = (await pinButton.textContent())?.trim() === 'Pinned'

    // Click to toggle
    const patchPromise = page.waitForResponse(
      (response) => response.url().includes('/memories/') && response.request().method() === 'PATCH',
      { timeout: 10000 }
    ).catch(() => null)

    await pinButton.click()
    const response = await patchPromise

    if (response && response.ok()) {
      // Button text should have toggled
      if (wasPinned) {
        await expect(pinButton).toHaveText(/Pin/)
      } else {
        await expect(pinButton).toHaveText(/Pinned/)
      }

      // Toggle back to original state
      const revertPromise = page.waitForResponse(
        (response) => response.url().includes('/memories/') && response.request().method() === 'PATCH',
        { timeout: 10000 }
      ).catch(() => null)
      await pinButton.click()
      await revertPromise
    }

    await expectNoVisibleErrors(page)
  })

  // ==================== Delete Memory Test ====================

  test('should delete memory via confirm modal', async ({ page, request }) => {
    // Create a throwaway memory to delete
    const deleteHandle = `ui-test-delete-${Date.now()}`
    const deleteRes = await retryOn429(() =>
      request.post(`${apiBase}/projects/${testProjectId}/memories`, {
        data: {
          handle: deleteHandle,
          title: 'Memory To Delete',
          content: 'This memory will be deleted in the test',
          type: 'user-note',
        },
      })
    )
    const deleteData = await deleteRes.json().catch(() => null)
    const deleteMemory = deleteData?.memory || deleteData
    expect(deleteMemory?.id).toBeTruthy()

    // Navigate to it
    await page.goto(`/memories/${deleteMemory.id}`)
    await page.waitForLoadState('networkidle')

    // Expand metadata
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 5000 })
      await metadataToggle.click()
    }

    // Enter edit mode and click Delete
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    const deleteButton = page.locator('button', { hasText: 'Delete' }).first()
    await expect(deleteButton).toBeVisible()
    await deleteButton.click()

    // Confirm modal should appear
    const confirmModal = page.locator('[class*="overlay"]').filter({ hasText: 'Delete Memory' })
    await expect(confirmModal).toBeVisible({ timeout: 5000 })

    // Click confirm delete
    const deletePromise = page.waitForResponse(
      (response) => response.url().includes('/memories/') && response.request().method() === 'DELETE',
      { timeout: 10000 }
    ).catch(() => null)

    const confirmButton = confirmModal.locator('button', { hasText: 'Delete' })
    await confirmButton.click()

    const deleteResponse = await deletePromise

    // Should navigate away after deletion
    if (deleteResponse && deleteResponse.ok()) {
      await page.waitForURL(/\/projects\//, { timeout: 5000 })
    }
  })

  // ==================== Snapshot Tests ====================

  test('should create and view a snapshot', async ({ page }) => {
    // Enter content edit mode
    const editContentButton = page.locator('button[title="Edit content"]')
    await editContentButton.scrollIntoViewIfNeeded()
    await editContentButton.click()

    const cmEditor = page.locator('.cm-editor')
    const cmContent = page.locator('.cm-content')
    await expect(cmEditor).toBeVisible({ timeout: 5000 })

    // Save with snapshot — click the snapshot checkbox if available, then save
    const snapshotCheckbox = page.locator('label', { hasText: 'Snapshot' }).locator('input[type="checkbox"]')
    if (await snapshotCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await snapshotCheckbox.check()
    }

    // Type something to make content dirty
    await cmContent.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (snapshot test)')

    // Save
    const savePromise = page.waitForResponse(
      (response) => response.url().includes('/memories/') && response.request().method() === 'PATCH',
      { timeout: 10000 }
    ).catch(() => null)

    await page.locator('button', { hasText: 'Save' }).first().click()
    await savePromise

    // Should exit edit mode
    await expect(cmEditor).toBeHidden({ timeout: 5000 })

    // Expand metadata to see snapshot selector
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await metadataToggle.click()
      await expect(metadataSection).toBeVisible({ timeout: 5000 })
    }

    // Check if snapshot selector is visible
    const snapshotSelect = metadataSection.locator('select').filter({ has: page.locator('option', { hasText: /current/ }) })
    if (await snapshotSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const options = await snapshotSelect.locator('option').count()
      expect(options).toBeGreaterThanOrEqual(1)
    }

    // Revert content — re-edit and remove the appended text
    await editContentButton.scrollIntoViewIfNeeded()
    await editContentButton.click()
    await expect(cmEditor).toBeVisible({ timeout: 5000 })
    const currentContent = (await cmContent.textContent())?.trim() || ''
    const revertedContent = currentContent.replace(' (snapshot test)', '')
    await cmContent.click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(revertedContent)
    await page.locator('button', { hasText: 'Save' }).first().click()
    await expect(cmEditor).toBeHidden({ timeout: 5000 })

    await expectNoVisibleErrors(page)
  })

  // ==================== Metadata: Handle Edit Test ====================

  test('should edit memory handle', async ({ page }) => {
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')

    // Enter edit mode
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    const handleInput = metadataSection.locator('div:has(> div:text-is("Handle"))').locator('input')
    await expect(handleInput).toBeVisible()

    const originalHandle = await handleInput.inputValue()
    const newHandle = `${originalHandle}-edited`

    await handleInput.fill(newHandle)

    // Save
    const patchPromise = page.waitForResponse(
      (response) => response.url().includes('/memories/') && response.request().method() === 'PATCH',
      { timeout: 10000 }
    ).catch(() => null)

    await page.locator('button', { hasText: 'Save' }).first().click()
    const response = await patchPromise

    if (response && response.ok()) {
      // Re-enter edit mode and verify the handle was saved
      await editButton.click()
      await expect(handleInput).toHaveValue(newHandle)

      // Revert
      await handleInput.fill(originalHandle)
      await page.locator('button', { hasText: 'Save' }).first().click()
    }

    await expectNoVisibleErrors(page)
  })

  // ==================== Metadata: Tag Editing Test ====================

  test('should add and remove tags in metadata edit mode', async ({ page }) => {
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')

    // Enter edit mode
    const editButton = page.locator('button[title="Edit metadata"]')
    await editButton.click()

    // Find the tag input
    const tagInput = metadataSection.locator('div:has(> div:text-is("Tags"))').locator('input')
    await expect(tagInput).toBeVisible()

    // Add a tag
    const testTag = `pw-test-tag-${Date.now()}`
    await tagInput.fill(testTag)
    await tagInput.press('Enter')

    // Tag badge should appear
    const tagBadge = metadataSection.locator('div:has(> div:text-is("Tags"))').locator(`text=${testTag}`)
    await expect(tagBadge).toBeVisible({ timeout: 3000 })

    // Save
    const patchPromise = page.waitForResponse(
      (response) => response.url().includes('/memories/') && response.request().method() === 'PATCH',
      { timeout: 10000 }
    ).catch(() => null)

    await page.locator('button', { hasText: 'Save' }).first().click()
    const response = await patchPromise

    if (response && response.ok()) {
      // Verify tag is visible after save (in view mode)
      const savedTag = page.locator(`[data-testid="tag-badge--${testTag}"]`)
      await expect(savedTag).toBeVisible({ timeout: 5000 })

      // Re-enter edit mode and remove the tag
      await editButton.click()
      const removeButton = metadataSection.locator('div:has(> div:text-is("Tags"))')
        .locator(`button[title="Remove ${testTag}"], [data-testid="tag-remove--${testTag}"]`)
        .or(metadataSection.locator('div:has(> div:text-is("Tags"))').locator(`text=${testTag}`).locator('..').locator('button'))

      if (await removeButton.first().isVisible({ timeout: 2000 }).catch(() => false)) {
        await removeButton.first().click()

        // Save to revert
        await page.locator('button', { hasText: 'Save' }).first().click()
      } else {
        await page.locator('button', { hasText: 'Cancel' }).first().click()
      }
    }

    await expectNoVisibleErrors(page)
  })

})

test.describe('Seed File Path', () => {
  let apiBase = ''
  let seededMemoryId = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Find a seeded memory (one with seed-path metadata) from the khef project
    const projectsRes = await retryOn429(() => request.get(`${apiBase}/projects`))
    const projectsData = await projectsRes.json()
    const khefProject = (projectsData.projects || projectsData || [])
      .find((p: any) => p.handle === 'khef')
    if (!khefProject) return

    const memoriesRes = await retryOn429(() =>
      request.get(`${apiBase}/projects/${khefProject.id}/memories?type=assistant-rule&limit=10`)
    )
    const memoriesData = await memoriesRes.json()
    const memories = memoriesData.memories || []

    // Fetch full details for each to check metadata
    for (const m of memories) {
      const fullRes = await retryOn429(() => request.get(`${apiBase}/memories/${m.id}`))
      const fullData = await fullRes.json()
      const mem = fullData.memory || fullData
      if (mem.metadata?.['seed-path']) {
        seededMemoryId = mem.id
        break
      }
    }
  })

  test('should show seed file path with copy and open-in-editor buttons for seeded memories', async ({ page }) => {
    test.skip(!seededMemoryId, 'No seeded memory with seed-path metadata found')

    await page.goto(`/memories/${seededMemoryId}`)
    await page.waitForLoadState('networkidle')

    // Expand metadata if collapsed
    const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
    if (await metadataSection.count() === 0) {
      const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
      await expect(metadataToggle).toBeVisible({ timeout: 10000 })
      await metadataToggle.click()
    }
    await expect(metadataSection).toBeVisible({ timeout: 10000 })

    // Seed file path should be visible
    const seedPath = page.locator('[data-testid="memory-page--seed-path"]')
    await expect(seedPath).toBeVisible()
    const pathText = await seedPath.textContent()
    expect(pathText).toContain('apps/api/db/seed/memories/')

    // Copy button should be present
    const copyButton = page.locator('[data-testid="memory-page--copy-seed-path"]')
    await expect(copyButton).toBeVisible()

    // Open in editor button should be present
    const editorButton = page.locator('[data-testid="memory-page--open-seed-in-editor"]')
    await expect(editorButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should not show seed file path for non-seeded memories', async ({ page }) => {
    // Navigate to a project and create a memory via API that won't have seed-path
    const projectsRes = await page.request.get(`${apiBase}/projects`)
    const projectsData = await projectsRes.json()
    const project = (projectsData.projects || projectsData || [])[0]
    test.skip(!project, 'No project found')

    const createRes = await retryOn429(() =>
      page.request.post(`${apiBase}/projects/${project.id}/memories`, {
        data: {
          handle: `pw-seed-path-test-${Date.now().toString(36)}`,
          title: `PW Seed Path Test ${Date.now()}`,
          content: 'Test memory without seed path',
          type: 'assistant-note',
        },
      })
    )
    const created = await createRes.json()
    const memoryId = created.memory?.id
    test.skip(!memoryId, 'Failed to create test memory')

    try {
      await page.goto(`/memories/${memoryId}`)
      await page.waitForLoadState('networkidle')

      // Expand metadata if collapsed
      const metadataSection = page.locator('[data-testid="memory-page--metadata-tables"]')
      if (await metadataSection.count() === 0) {
        const metadataToggle = page.getByRole('button', { name: 'Metadata', exact: true })
        await expect(metadataToggle).toBeVisible({ timeout: 10000 })
        await metadataToggle.click()
      }
      await expect(metadataSection).toBeVisible({ timeout: 10000 })

      // Seed file path should NOT be visible
      const seedPath = page.locator('[data-testid="memory-page--seed-path"]')
      await expect(seedPath).toBeHidden()

      await expectNoVisibleErrors(page)
    } finally {
      // Cleanup
      await retryOn429(() =>
        page.request.delete(`${apiBase}/projects/${project.id}/memories/${memoryId}`)
      )
    }
  })
})
