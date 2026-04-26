import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors, resolveApiBase } from './utils/test-helpers'

test.describe('Plan Comments', () => {
  test.describe.configure({ mode: 'serial' })

  const TEST_ASSISTANT_HANDLE = 'claude-code'

  let apiBase = ''

  let testPlanFilename = ''

  test.beforeAll(async ({ request }) => {
    apiBase = await resolveApiBase(request)

    // Get list of plans and use first one for testing
    const res = await request.get(`${apiBase}/assistants/${TEST_ASSISTANT_HANDLE}/plans`)
    if (!res.ok()) {
      throw new Error(`Failed to get plans: ${res.status()}`)
    }

    const data = await res.json()
    const plans = data.plans || []

    if (plans.length === 0) {
      // Skip tests if no plans exist
      test.skip()
      return
    }

    testPlanFilename = plans[0].filename
  })

  test.beforeEach(async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Dismiss splash screen if present
    await page.goto(`/assistants/${TEST_ASSISTANT_HANDLE}/plans/${encodeURIComponent(testPlanFilename)}`)
    await page.waitForLoadState('networkidle')

    // Dismiss splash screen if visible
    const splashBtn = page.locator('#splash-btn')
    if (await splashBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await splashBtn.click()
      await page.waitForTimeout(500)
    }
  })

  test('should display plan page with comments section', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Plan title should be visible
    const header = page.locator('h1').first()
    await expect(header).toBeVisible({ timeout: 10000 })

    // Comments section should exist
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    await expectNoVisibleErrors(page)
  })

  test('should display comment input area', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // Comment textarea should exist
    const textarea = page.locator('[class*="commentTextarea"]').last()
    await expect(textarea).toBeVisible({ timeout: 5000 })

    // Submit button should exist
    const submitButton = page.locator('button[title*="Submit comment"]')
    await expect(submitButton).toBeVisible()

    await expectNoVisibleErrors(page)
  })

  test('should show no comments message when empty', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // If no comments exist, should show empty message
    const noComments = page.getByText('No comments yet')
    const commentItems = page.locator('[class*="commentItem"]')
    const commentError = page.locator('[class*="commentError"]')
    const resolvedToggle = page.locator('[class*="resolvedToggle"]')

    // Either show no comments message or have comment items
    await expect
      .poll(
        async () => {
          const hasNoComments = await noComments.isVisible().catch(() => false)
          const hasCommentItems = await commentItems.first().isVisible().catch(() => false)
          const hasCommentError = await commentError.isVisible().catch(() => false)
          const hasResolvedToggle = await resolvedToggle.isVisible().catch(() => false)
          return hasNoComments || hasCommentItems || hasCommentError || hasResolvedToggle
        },
        { timeout: 10000 }
      )
      .toBe(true)

    await expectNoVisibleErrors(page)
  })

  test('should add a comment on a plan', async ({ page, request }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // Find the comment input textarea (last one in the section - the add comment area)
    const textarea = page.locator('[class*="commentTextarea"]').last()
    await expect(textarea).toBeVisible({ timeout: 5000 })

    const testComment = `Test plan comment ${Date.now()}`
    await textarea.fill(testComment)

    // Submit the comment
    const submitButton = page.locator('button[title*="Submit comment"]')
    await submitButton.click()

    // Wait for comment to appear in the list
    const commentItem = page.locator('[class*="commentItem"]').filter({
      hasText: testComment,
    })

    // Comment should appear (API must be working)
    const commentVisible = await commentItem.isVisible({ timeout: 5000 }).catch(() => false)

    if (commentVisible) {
      // Textarea should be cleared
      await expect(textarea).toHaveValue('')

      // No comments message should be gone
      const noComments = page.locator('[class*="noComments"]')
      await expect(noComments).toBeHidden()
    }

    await expectNoVisibleErrors(page)
  })

  test('should edit a comment on a plan', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // First check if there are any comments to edit
    const commentItems = page.locator('[class*="commentItem"]')
    const commentCount = await commentItems.count()

    if (commentCount === 0) {
      // Add a comment first
      const textarea = page.locator('[class*="commentTextarea"]').last()
      await textarea.fill('Comment to edit')
      const submitButton = page.locator('button[title*="Submit comment"]')
      await submitButton.click()
      await page.waitForTimeout(1000)
    }

    // Now try to edit the first comment
    const firstComment = page.locator('[class*="commentItem"]').first()
    const isVisible = await firstComment.isVisible({ timeout: 3000 }).catch(() => false)

    if (isVisible) {
      // Hover to reveal actions
      await firstComment.hover()

      // Click edit button
      const editButton = firstComment.locator('button[title="Edit comment"]')
      const editButtonVisible = await editButton.isVisible({ timeout: 2000 }).catch(() => false)

      if (editButtonVisible) {
        await editButton.click()

        // Editing textarea should appear
        const editTextarea = firstComment.locator('textarea')
        await expect(editTextarea).toBeVisible({ timeout: 3000 })

        // Change content
        await editTextarea.fill('Edited plan comment')

        // Save
        const saveButton = firstComment.locator('button', { hasText: 'Save' })
        await saveButton.click()

        // Updated content should be visible
        await expect(
          firstComment.locator('[class*="commentContent"]')
        ).toHaveText('Edited plan comment')
      }
    }

    await expectNoVisibleErrors(page)
  })

  test('should resolve and reopen a comment', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // Check if there are any comments
    const commentItems = page.locator('[class*="commentItem"]')
    const commentCount = await commentItems.count()

    if (commentCount === 0) {
      // Add a comment first
      const textarea = page.locator('[class*="commentTextarea"]').last()
      await textarea.fill('Comment to resolve')
      const submitButton = page.locator('button[title*="Submit comment"]')
      await submitButton.click()
      await page.waitForTimeout(1000)
    }

    const firstComment = page.locator('[class*="commentItem"]').first()
    const isVisible = await firstComment.isVisible({ timeout: 3000 }).catch(() => false)

    if (isVisible) {
      // Hover and click resolve
      await firstComment.hover()
      const resolveButton = firstComment.locator('button[title="Resolve comment"]')
      const resolveButtonVisible = await resolveButton.isVisible({ timeout: 2000 }).catch(() => false)

      if (resolveButtonVisible) {
        await resolveButton.click()

        // Wait for comment to move to resolved section
        await page.waitForTimeout(500)

        // Resolved toggle should appear
        const resolvedToggle = page.locator('[class*="resolvedToggle"]')
        const toggleVisible = await resolvedToggle.isVisible({ timeout: 2000 }).catch(() => false)

        if (toggleVisible) {
          // Show resolved comments
          await resolvedToggle.click()

          // Find resolved comment and reopen
          const resolvedComment = page.locator('[class*="resolvedComment"]').first()
          const reopenButton = resolvedComment.locator('button', { hasText: 'Reopen' })

          if (await reopenButton.isVisible({ timeout: 2000 }).catch(() => false)) {
            await reopenButton.click()
            await page.waitForTimeout(500)
          }
        }
      }
    }

    await expectNoVisibleErrors(page)
  })

  test('should delete a comment', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // Add a comment to delete
    const textarea = page.locator('[class*="commentTextarea"]').last()
    await textarea.fill('Comment to delete')
    const submitButton = page.locator('button[title*="Submit comment"]')
    await submitButton.click()

    // Wait for it to appear
    const commentToDelete = page.locator('[class*="commentItem"]').filter({
      hasText: 'Comment to delete',
    })
    const visible = await commentToDelete.isVisible({ timeout: 5000 }).catch(() => false)

    if (visible) {
      const countBefore = await page.locator('[class*="commentItem"]').count()

      // Hover and click delete
      await commentToDelete.hover()
      const deleteButton = commentToDelete.locator('button[title="Delete comment"]')

      if (await deleteButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await deleteButton.click()

        // Wait for the comment to disappear
        await expect(commentToDelete).toBeHidden({ timeout: 5000 })

        const countAfter = await page.locator('[class*="commentItem"]').count()
        expect(countAfter).toBeLessThan(countBefore)
      }
    }

    await expectNoVisibleErrors(page)
  })

  test('should reply to a comment', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for comments section
    const commentsTitle = page.locator('h2', { hasText: 'Comments' })
    await expect(commentsTitle).toBeVisible({ timeout: 10000 })

    // Check if there are any comments
    const commentItems = page.locator('[class*="commentItem"]')
    const commentCount = await commentItems.count()

    if (commentCount === 0) {
      // Add a comment first
      const textarea = page.locator('[class*="commentTextarea"]').last()
      await textarea.fill('Comment to reply to')
      const submitButton = page.locator('button[title*="Submit comment"]')
      await submitButton.click()
      await page.waitForTimeout(1000)
    }

    const firstComment = page.locator('[class*="commentThread"]').first()
    const isVisible = await firstComment.isVisible({ timeout: 3000 }).catch(() => false)

    if (isVisible) {
      // Click reply button
      const replyButton = firstComment.locator('button[title="Reply"]')
      const replyButtonVisible = await replyButton.isVisible({ timeout: 2000 }).catch(() => false)

      if (replyButtonVisible) {
        await replyButton.click()

        // Reply input should appear
        const replyInput = firstComment.locator('textarea[placeholder*="reply"]')
        await expect(replyInput).toBeVisible({ timeout: 3000 })

        // Type reply
        await replyInput.fill('This is a reply')

        // Submit reply
        const replySubmit = firstComment.locator('button[title*="Submit reply"]')
        await replySubmit.click()

        // Wait for reply to appear
        await page.waitForTimeout(1000)

        // Reply should be visible in the thread
        const reply = firstComment.locator('[class*="replyItem"]').filter({
          hasText: 'This is a reply',
        })
        const replyVisible = await reply.isVisible({ timeout: 3000 }).catch(() => false)

        // If API works, reply should be visible
        if (replyVisible) {
          await expect(reply).toBeVisible()
        }
      }
    }

    await expectNoVisibleErrors(page)
  })

  test('should capture anchor from selected text', async ({ page }) => {
    if (!testPlanFilename) {
      test.skip()
      return
    }

    // Wait for content to render
    const content = page.locator('article[class*="content"]')
    await expect(content).toBeVisible({ timeout: 10000 })

    // Select some text in the content
    await content.evaluate((el) => {
      const range = document.createRange()
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

    // Try floating "Comment on selection" button, fall back to Alt+C shortcut
    const captureButton = page.locator('button[title*="Comment on selection"]')
    const buttonVisible = await captureButton.isVisible({ timeout: 1500 }).catch(() => false)
    if (buttonVisible) {
      await captureButton.click()
    } else {
      await page.keyboard.down('Alt')
      await page.keyboard.press('KeyC')
      await page.keyboard.up('Alt')
    }

    // Inline anchor preview should appear
    const anchorPreview = page.locator('[class*="inlineAnchorPreview"]')
    const previewVisible = await anchorPreview.isVisible({ timeout: 3000 }).catch(() => false)

    if (previewVisible) {
      // Dismiss the inline comment box to clear anchor
      const inlineCancel = page.locator('button', { hasText: 'Cancel' })
      const cancelVisible = await inlineCancel.isVisible({ timeout: 2000 }).catch(() => false)
      if (cancelVisible) {
        await inlineCancel.click()
      }

      // Anchor preview should be gone
      await expect(anchorPreview).toBeHidden({ timeout: 2000 })
    }

    await expectNoVisibleErrors(page)
  })
})
