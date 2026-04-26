import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Memory Comments', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_PROJECT_HANDLE = 'ui-test-comments'
  const TEST_PROJECT_NAME = 'UI Test Comments'
  const TEST_MEMORY_HANDLE = 'ui-test-comment-memory'
  const TEST_MEMORY_TITLE = 'UI Test Comment Memory'
  const TEST_MEMORY_CONTENT =
    'This is the content for testing comments.\n\nIt has multiple paragraphs so we can test anchored comments on specific text selections.'

  let apiBase = ''

  let testProjectId = ''
  let testMemoryId = ''

  async function deleteProject(
    request: any,
    projectId: string | null,
    allowNotFound = false
  ) {
    if (!projectId) return
    const res = await request.delete(`${apiBase}/projects/${projectId}`)
    if (res.ok()) return
    if (allowNotFound && res.status() === 404) return
    throw new Error(`Failed to delete test project: ${res.status()}`)
  }

  async function listProjects(request: any) {
    const res = await request.get(`${apiBase}/projects`)
    const data = await res.json().catch(() => null)
    if (Array.isArray(data)) return data
    if (data && Array.isArray(data.projects)) return data.projects
    if (data && Array.isArray(data.items)) return data.items
    if (data?.data && Array.isArray(data.data.projects)) return data.data.projects
    return []
  }

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Clean up existing test project if present
    const projects = await listProjects(request)
    const existing = projects.find((p: any) => p.handle === TEST_PROJECT_HANDLE)
    if (existing?.id) {
      await deleteProject(request, existing.id, true)
    }

    // Create test project
    const projRes = await request.post(`${apiBase}/projects`, {
      data: { handle: TEST_PROJECT_HANDLE, name: TEST_PROJECT_NAME },
    })
    const projData = await projRes.json().catch(() => null)
    const project = projData?.project || projData
    if (!projRes.ok() || !project?.id) {
      throw new Error(`Failed to create test project: ${projRes.status()}`)
    }
    testProjectId = project.id

    // Create test memory
    const memRes = await request.post(
      `${apiBase}/projects/${testProjectId}/memories`,
      {
        data: {
          handle: TEST_MEMORY_HANDLE,
          title: TEST_MEMORY_TITLE,
          content: TEST_MEMORY_CONTENT,
          type: 'user-note',
        },
      }
    )
    const memData = await memRes.json().catch(() => null)
    const memory = memData?.memory || memData
    if (!memRes.ok() || !memory?.id) {
      throw new Error(`Failed to create test memory: ${memRes.status()}`)
    }
    testMemoryId = memory.id
  })

  test.afterAll(async ({ request }) => {
    if (testProjectId) {
      await deleteProject(request, testProjectId, true)
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.goto(`/memories/${testMemoryId}`)
    await page.waitForLoadState('networkidle')
  })

  test('should display comments section with empty state', async ({ page }) => {
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    const emptyMessage = page.locator('[class*="_emptyComments_"]')
    await expect(emptyMessage).toBeVisible()
    await expect(emptyMessage).toHaveText('No comments yet')

    await expectNoVisibleErrors(page)
  })

  test('should display comment input area', async ({ page }) => {
    const textarea = page.locator('[data-comment-input]')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    const submitButton = page.locator('[class*="_submitCommentButton_"]')
    await expect(submitButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should add a general comment', async ({ page }) => {
    const textarea = page.locator('[data-comment-input]')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    await textarea.fill('This is a test comment')

    // Submit
    const submitButton = page.locator('[class*="_submitCommentButton_"]')
    await submitButton.click()

    // Wait for comment to appear
    const commentItem = page.locator('[class*="_commentItem_"]').filter({
      hasText: 'This is a test comment',
    })
    await expect(commentItem).toBeVisible({ timeout: 5000 })

    // Textarea should be cleared
    await expect(textarea).toHaveValue('')

    // Empty state should be gone
    const emptyMessage = page.locator('[class*="_emptyComments_"]')
    await expect(emptyMessage).toBeHidden()

    // Count badge should appear
    const countBadge = page.locator('[class*="_commentCount_"]')
    await expect(countBadge).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should edit an existing comment', async ({ page }) => {
    // Find the comment we just created
    const commentItem = page.locator('[class*="_commentItem_"]').first()
    await expect(commentItem).toBeVisible({ timeout: 10000 })

    // Hover to reveal actions
    await commentItem.hover()

    // Click edit button (pencil icon)
    const editButton = commentItem.locator('button[title="Edit comment"]')
    await editButton.click()

    // Editing textarea should appear inside the comment item
    const editTextarea = commentItem.locator('textarea')
    await expect(editTextarea).toBeVisible()

    // Change the content
    await editTextarea.fill('Updated test comment')

    // Save
    const saveButton = commentItem.locator('button', { hasText: 'Save' })
    await saveButton.click()

    // Updated content should be visible
    await expect(
      commentItem.locator('[class*="_commentContent_"]')
    ).toHaveText('Updated test comment')

    await expectNoVisibleErrors(page)
  })

  test('should delete a comment', async ({ page }) => {
    // First add a comment to delete
    const textarea = page.locator('[data-comment-input]')
    await expect(textarea).toBeVisible({ timeout: 10000 })
    await textarea.fill('Comment to delete')
    const submitButton = page.locator('[class*="_submitCommentButton_"]')
    await submitButton.click()

    // Wait for it to appear
    const commentToDelete = page.locator('[class*="_commentItem_"]').filter({
      hasText: 'Comment to delete',
    })
    await expect(commentToDelete).toBeVisible({ timeout: 5000 })

    const countBefore = await page.locator('[class*="_commentItem_"]').count()

    // Hover and click delete
    await commentToDelete.hover()
    const deleteButton = commentToDelete.locator('button[title="Delete comment"]')
    await deleteButton.click()

    // Wait for the comment to disappear
    await expect(commentToDelete).toBeHidden({ timeout: 5000 })

    const countAfter = await page.locator('[class*="_commentItem_"]').count()
    expect(countAfter).toBeLessThan(countBefore)

    await expectNoVisibleErrors(page)
  })

  test('should show floating comment button on text selection', async ({ page }) => {
    // Wait for content to render
    const contentMarkdown = page.locator('[class*="_contentMarkdown_"]').first()
    await expect(contentMarkdown).toBeVisible({ timeout: 10000 })

    // Select some text in the content
    await contentMarkdown.evaluate((el) => {
      const range = document.createRange()
      // Walk to the first actual text node (firstChild may be a <p> element)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const textNode = walker.nextNode()
      if (textNode && textNode.textContent) {
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(20, textNode.textContent.length))
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    })

    // Trigger mouseup to show the floating button
    await contentMarkdown.dispatchEvent('mouseup')

    // Floating button should appear
    const floatingButton = page.locator('[class*="_floatingCommentButton_"]')
    await expect(floatingButton).toBeVisible({ timeout: 3000 })

    await expectNoVisibleErrors(page)
  })

  test('should capture anchor when clicking floating button', async ({ page }) => {
    // Wait for content to render
    const contentMarkdown = page.locator('[class*="_contentMarkdown_"]').first()
    await expect(contentMarkdown).toBeVisible({ timeout: 10000 })

    // Select text
    await contentMarkdown.evaluate((el) => {
      const range = document.createRange()
      // Walk to the first actual text node (firstChild may be a <p> element)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const textNode = walker.nextNode()
      if (textNode && textNode.textContent) {
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(20, textNode.textContent.length))
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    })

    await contentMarkdown.dispatchEvent('mouseup')

    // Click floating button
    const floatingButton = page.locator('[class*="_floatingCommentButton_"]')
    await expect(floatingButton).toBeVisible({ timeout: 3000 })
    await floatingButton.click()

    // Inline comment box should appear with anchor preview
    const inlineBox = page.locator('[class*="_inlineCommentBox_"]')
    await expect(inlineBox).toBeVisible({ timeout: 3000 })

    const anchorPreview = inlineBox.locator('[class*="_inlineAnchorPreview_"]')
    await expect(anchorPreview).toBeVisible()

    // Type and submit the anchored comment
    const inlineTextarea = page.locator('[data-inline-comment-input]')
    await inlineTextarea.fill('Anchored comment')
    const sendButton = inlineBox.locator('button[type="submit"], [class*="_submitCommentButton_"]')
    await sendButton.click()

    // Comment should appear in the list with anchor badge
    const commentWithAnchor = page.locator('[class*="_commentItem_"]').filter({
      hasText: 'Anchored comment',
    })
    await expect(commentWithAnchor).toBeVisible({ timeout: 5000 })

    const anchorBadge = commentWithAnchor.locator('[class*="_commentAnchorBadge_"]')
    await expect(anchorBadge).toBeVisible()

    // Inline box should be dismissed
    await expect(inlineBox).toBeHidden()

    await expectNoVisibleErrors(page)
  })

  test('should submit comment with Cmd+Enter', async ({ page }) => {
    const textarea = page.locator('[data-comment-input]')
    await expect(textarea).toBeVisible({ timeout: 10000 })

    await textarea.fill('Keyboard shortcut comment')

    // Press Cmd+Enter (Meta+Enter)
    await textarea.press('Meta+Enter')

    // Comment should appear
    const comment = page.locator('[class*="_commentItem_"]').filter({
      hasText: 'Keyboard shortcut comment',
    })
    await expect(comment).toBeVisible({ timeout: 5000 })

    await expectNoVisibleErrors(page)
  })
})
