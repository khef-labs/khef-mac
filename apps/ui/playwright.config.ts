import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

// Load .env.test when running in test environment mode
function loadTestEnv(): Record<string, string> {
  if (!process.env.KHEF_USE_TEST_ENV) return {}

  const envPath = resolve(process.cwd(), '.env.test')
  if (!existsSync(envPath)) return {}

  const content = readFileSync(envPath, 'utf-8')
  const env: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [key, ...valueParts] = trimmed.split('=')
    if (key) env[key] = valueParts.join('=')
  }

  return env
}

const testEnv = loadTestEnv()

// Make test env vars available to test process (not just webServer)
if (process.env.KHEF_USE_TEST_ENV) {
  Object.assign(process.env, testEnv)
}

// Use different ports for test environment to allow dev server to run simultaneously
const uiPort = testEnv.KHEF_UI_PORT || '5174'
const baseURL = `http://localhost:${uiPort}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list', { printSteps: true }],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            {
              name: 'khef-state',
              value: JSON.stringify({ splashSeen: true }),
            },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.KHEF_USE_TEST_ENV ? 'npm run dev:test' : 'npm run dev:all',
    url: baseURL,
    // Don't reuse in CI or test mode (test script kills existing servers first)
    // In dev mode (no KHEF_USE_TEST_ENV), allow reuse for faster iteration
    reuseExistingServer: !process.env.CI && !process.env.KHEF_USE_TEST_ENV,
    timeout: 120 * 1000,
    env: {
      ...process.env,
      ...testEnv,
      KHEF_API_URL:
        testEnv.KHEF_API_URL ||
        process.env.KHEF_API_URL ||
        process.env.KHEF_PROXY_TARGET ||
        'http://localhost:3201/api',
      KHEF_PROXY_TARGET:
        testEnv.KHEF_PROXY_TARGET ||
        process.env.KHEF_PROXY_TARGET ||
        'http://localhost:3201/api',
    },
  },
})
