import { Page, expect, APIRequestContext } from '@playwright/test'

/**
 * Get the API base URL for tests.
 * Uses test backend (3201) when KHEF_USE_TEST_ENV is set, otherwise dev (3200).
 */
export function getApiBase(): string {
  const envApi = process.env.KHEF_API_URL
  const envProxyTarget = process.env.KHEF_PROXY_TARGET

  if (process.env.KHEF_USE_TEST_ENV) {
    const testBase = envApi || envProxyTarget || 'http://localhost:5177/api'
    assertNotDevApiBase(testBase)
    return testBase
  }

  if (envApi) return envApi
  return envProxyTarget || 'http://localhost:5175/api'
}

/**
 * Resolve API base by trying available endpoints.
 * Prefers test environment when KHEF_USE_TEST_ENV is set.
 */
export async function resolveApiBase(request: APIRequestContext): Promise<string> {
  const isTestEnv = !!process.env.KHEF_USE_TEST_ENV

  const candidates = isTestEnv
    ? [
        process.env.KHEF_API_URL,
        process.env.KHEF_PROXY_TARGET,
        'http://localhost:5177/api',  // Test proxy
        'http://localhost:3201/api',  // Test backend directly
      ]
    : [
        process.env.KHEF_API_URL,
        process.env.KHEF_PROXY_TARGET,
        'http://localhost:5175/api',  // Dev proxy
        'http://localhost:3201/api',  // Dev backend
      ]

  const filteredCandidates = candidates.filter(Boolean) as string[]

  for (const candidate of filteredCandidates) {
    if (isTestEnv && candidate.includes('localhost:3201')) {
      continue
    }
    const base = candidate.replace(/\/$/, '')
    try {
      const res = await request.get(`${base}/projects`)
      if (res.ok() || res.status() !== 404) return base
    } catch {
      // Try next
    }
  }

  // Return default based on environment
  const fallback = isTestEnv ? 'http://localhost:5177/api' : 'http://localhost:5175/api'
  if (isTestEnv) {
    assertNotDevApiBase(fallback)
  }
  return fallback
}

function assertNotDevApiBase(base: string) {
  if (base.includes('localhost:3201') || base.includes('127.0.0.1:3200')) {
    throw new Error(
      `Test env resolved dev API base (${base}). Check KHEF_API_URL/KHEF_PROXY_TARGET and .env.test.`
    )
  }
}

/**
 * Check that no error elements are visible on the page.
 * Looks for elements with class names containing "_error_" (CSS module pattern)
 * or data-testid containing "error".
 */
export async function expectNoVisibleErrors(page: Page) {
  // Check for CSS module error classes (e.g., _error_abc123)
  const errorElements = page.locator('[class*="_error_"]')
  const errorCount = await errorElements.count()

  for (let i = 0; i < errorCount; i++) {
    const element = errorElements.nth(i)
    const isVisible = await element.isVisible()
    if (isVisible) {
      const text = await element.textContent()
      throw new Error(`Found visible error element with text: "${text}"`)
    }
  }

  // Also check for data-testid error elements
  const testIdErrors = page.locator('[data-testid*="error"]')
  const testIdErrorCount = await testIdErrors.count()

  for (let i = 0; i < testIdErrorCount; i++) {
    const element = testIdErrors.nth(i)
    const isVisible = await element.isVisible()
    if (isVisible) {
      const text = await element.textContent()
      throw new Error(`Found visible error element with text: "${text}"`)
    }
  }
}

/**
 * Wait for loading to complete by checking that skeleton elements are gone.
 */
export async function waitForLoadingComplete(page: Page, timeout = 10000) {
  // Wait for skeleton elements to disappear
  await expect(page.locator('[class*="_skeleton_"]').first()).toBeHidden({ timeout })
}

/**
 * Dismiss the splash screen if present so it doesn't block clicks.
 */
export async function dismissSplash(page: Page, timeout = 10000) {
  const splash = page.locator('#splash')
  if (await splash.count()) {
    if (await splash.isVisible()) {
      await page.click('#splash-btn')
    }
    await expect(splash).toBeHidden({ timeout })
  }
}

/**
 * Retry an API request on 429 (rate limit) responses.
 * Waits for Retry-After header value (default 2s) between attempts.
 */
export async function retryOn429<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await fn()
    const res = result as any
    if (typeof res?.status === 'function' && res.status() === 429) {
      const retryAfter = parseInt(res.headers?.()?.['retry-after'] || '2', 10)
      await new Promise((r) => setTimeout(r, retryAfter * 1000))
      continue
    }
    return result
  }
  return fn()
}

/**
 * Check that page has loaded without console errors.
 */
export async function expectNoConsoleErrors(page: Page, consoleMessages: string[]) {
  const errors = consoleMessages.filter(msg =>
    msg.toLowerCase().includes('error') &&
    !msg.includes('favicon') // Ignore favicon errors
  )

  if (errors.length > 0) {
    throw new Error(`Console errors found:\n${errors.join('\n')}`)
  }
}
