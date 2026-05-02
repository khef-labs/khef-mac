import { test, expect } from '@playwright/test'
import { expectNoVisibleErrors } from './utils/test-helpers'

// Fake chat ID — never actually persisted. The API call is intercepted by
// page.route below and resolved with a hand-rolled response so we don't need
// to seed real DB rows or invoke an LLM during the test.
const FAKE_CODEX_CHAT_ID = '019cb8c5-7bfb-7ce2-ab38-757def704436'

test.describe('ChatPage backend pill switching', () => {
  test.beforeEach(async ({ page }) => {
    // Resolve the saved chat as a Codex chat so the URL points at codex-cli
    // even though the user is about to click the Claude pill.
    await page.route(`**/api/chats/${FAKE_CODEX_CHAT_ID}**`, async route => {
      const url = route.request().url()
      if (url.includes('/messages')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ messages: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat: {
            id: FAKE_CODEX_CHAT_ID,
            assistant_handle: 'codex-cli',
            title: 'fake codex chat',
            project_id: null,
            session_id: null,
            source: 'ui',
            caller_handle: null,
            message_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            messages: [],
            delegations: {},
          },
        }),
      })
    })

    // Avoid noise from live data — return empty active sessions and chat list.
    await page.route('**/api/active-sessions**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [], count: 0 }),
      })
    )
    await page.route('**/api/chats?**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: [], pagination: { total_count: 0, limit: 50, offset: 0, has_more: false } }),
      })
    )
  })

  test('clicking the Claude pill on a saved Codex chat switches the surface to Claude', async ({ page }) => {
    await page.goto(`/chat/${FAKE_CODEX_CHAT_ID}`)

    const headerLabel = page.locator('[class*="_chatHeaderLabel_"]')
    await expect(headerLabel).toHaveText('Codex')

    await page.locator('[class*="_filterPill_"]', { hasText: 'Claude' }).click()

    // After the fix, the URL drops the chat-id and the surface re-anchors
    // to a fresh claude PTY. The header label (codex) goes away because
    // there's no active chat or new-chat indicator at `/chat`.
    await expect(page).toHaveURL(/\/chat$/)
    await expect(page.getByText('Click Connect to spawn a live claude PTY.')).toBeVisible()
    await expect(headerLabel).toHaveCount(0)
    await expectNoVisibleErrors(page)
  })
})
