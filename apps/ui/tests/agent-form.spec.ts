import { test, expect } from '@playwright/test'

test.describe('Agent Page Form', () => {
  test('textareas should expand without scrollbar on new agent page', async ({ page }) => {
    // Navigate directly to new agent page
    await page.goto('/assistants/claude-code/agents/new')
    await page.waitForLoadState('networkidle')

    // Should show "New Agent" title
    await expect(page.locator('h1', { hasText: 'New Agent' })).toBeVisible()

    // Screenshot: empty new agent form
    await page.screenshot({ path: 'test-results/agent-page-new-empty.png', fullPage: true })

    // Find the textareas (description and prompt)
    const descriptionTextarea = page.locator('[class*="_formTextarea_"]').first()
    const promptTextarea = page.locator('[class*="_formTextarea_"]').last()

    await expect(descriptionTextarea).toBeVisible()
    await expect(promptTextarea).toBeVisible()

    // Fill description with multi-line content
    const descriptionContent = `This agent helps with code review and analysis.
It can identify potential bugs, suggest improvements,
and ensure code follows best practices.
Multiple lines to test expansion.`

    await descriptionTextarea.fill(descriptionContent)

    // Fill prompt with much longer content to really test expansion
    const promptContent = `# Test Agent Prompt

This is a test prompt with multiple lines to verify that the textarea
expands properly without showing a scrollbar.

## Features
- Feature 1: This is a longer description to test wrapping behavior
- Feature 2: Another feature with some more text
- Feature 3: Yet another feature description here
- Feature 4: Adding more content
- Feature 5: Even more features

## Instructions
1. Do this first - with detailed explanation of what to do
2. Then do this - more details about the second step
3. Finally do this - and the last step explanation
4. Additional step - to make the content longer
5. Another step - continuing to add content

## Additional Notes
This section adds even more content to ensure the textarea properly expands.
We want to make sure there's no scrollbar appearing even with substantial content.

### Subsection
More text here to fill out the textarea and verify expansion works correctly.
The field-sizing: content CSS property should handle this automatically.

### Another Subsection
Final bit of content to round out the test case with plenty of text.
This should be enough to verify the textarea expands without scrollbar.`

    await promptTextarea.fill(promptContent)

    // Screenshot: form with content
    await page.screenshot({ path: 'test-results/agent-page-new-filled.png', fullPage: true })

    // Check description textarea
    const descDimensions = await descriptionTextarea.evaluate((el: HTMLTextAreaElement) => {
      const styles = window.getComputedStyle(el)
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflow: styles.overflow,
        overflowX: styles.overflowX,
        overflowY: styles.overflowY,
        fieldSizing: styles.getPropertyValue('field-sizing'),
        className: el.className,
      }
    })
    console.log('Description textarea:', descDimensions)

    // Check prompt textarea
    const promptDimensions = await promptTextarea.evaluate((el: HTMLTextAreaElement) => {
      const styles = window.getComputedStyle(el)
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflow: styles.overflow,
        overflowX: styles.overflowX,
        overflowY: styles.overflowY,
        fieldSizing: styles.getPropertyValue('field-sizing'),
        className: el.className,
      }
    })
    console.log('Prompt textarea:', promptDimensions)

    // Both should have no scrollbar (scrollHeight ~= clientHeight)
    expect(Math.abs(descDimensions.scrollHeight - descDimensions.clientHeight)).toBeLessThanOrEqual(2)
    expect(Math.abs(promptDimensions.scrollHeight - promptDimensions.clientHeight)).toBeLessThanOrEqual(2)
  })
})
