import { test, expect } from '@playwright/test'
import { execSync, spawn, ChildProcess } from 'child_process'
import { resolve, dirname } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const API_DIR = resolve(__dirname, '../../api')
const DOCS_DIR = resolve(API_DIR, 'docs/api')
const SERVE_PORT = 8099

test.describe('Swagger Docs', () => {
  test.describe.configure({ mode: 'serial' })

  let serveProcess: ChildProcess

  test.beforeAll(async () => {
    // Bundle the split spec into a single file
    execSync('npx redocly bundle docs/api/openapi.yaml -o docs/api/openapi.bundled.yaml', {
      cwd: API_DIR,
      timeout: 30000,
    })

    // Kill anything already on the port
    try { execSync(`lsof -ti :${SERVE_PORT} | xargs kill 2>/dev/null`, { timeout: 3000 }) } catch {}

    // Start a static file server
    serveProcess = spawn('npx', ['serve', '-l', String(SERVE_PORT), '--cors', '--no-clipboard', '.'], {
      cwd: API_DIR,
      stdio: 'pipe',
    })

    // Wait for serve to be ready by polling
    for (let i = 0; i < 20; i++) {
      try {
        execSync(`curl -sf http://localhost:${SERVE_PORT}/ > /dev/null`, { timeout: 2000 })
        return
      } catch {
        await new Promise(r => setTimeout(r, 500))
      }
    }
    throw new Error('serve startup timeout')
  })

  test.afterAll(async () => {
    if (serveProcess) {
      serveProcess.kill()
    }
  })

  test('page title shows khef API, not mem-zen', async ({ page }) => {
    await page.goto(`http://localhost:${SERVE_PORT}/docs/api/swagger.html`)
    await page.waitForLoadState('networkidle')

    // Wait for Swagger UI to render the API title
    const title = page.locator('.info .title')
    await expect(title).toBeVisible({ timeout: 10000 })
    await expect(title).toContainText('khef API')
    await expect(title).not.toContainText('mem-zen')
  })

  test('all resource tag sections are present', async ({ page }) => {
    await page.goto(`http://localhost:${SERVE_PORT}/docs/api/swagger.html`)
    await page.waitForLoadState('networkidle')

    // Wait for Swagger UI to render
    await expect(page.locator('.info .title')).toBeVisible({ timeout: 10000 })

    const expectedTags = [
      'health',
      'projects',
      'memories',
      'memory-types',
      'relations',
      'tags',
      'assistants',
      'configs',
      'knowledge',
      'diagram',
      'settings',
      'sessions',
      'gemini',
      'active-sessions',
      'vector',
    ]

    for (const tag of expectedTags) {
      const section = page.locator(`#operations-tag-${tag}`)
      await expect(section, `expected tag section "${tag}" to exist`).toBeAttached()
    }
  })

  test('vector search endpoints are documented', async ({ page }) => {
    await page.goto(`http://localhost:${SERVE_PORT}/docs/api/swagger.html`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.info .title')).toBeVisible({ timeout: 10000 })

    // Expand the vector section
    const vectorSection = page.locator('#operations-tag-vector')
    await vectorSection.click()

    // Check that vector search endpoints are visible
    const operationSummaries = page.locator('.opblock-summary-description')
    const allText = await operationSummaries.allTextContents()
    const hasVectorSearch = allText.some(t =>
      t.toLowerCase().includes('vector') ||
      t.toLowerCase().includes('semantic') ||
      t.toLowerCase().includes('search')
    )
    expect(hasVectorSearch, 'expected at least one vector/search endpoint').toBeTruthy()
  })

  test('bundled spec matches source title and path count', async () => {
    const bundled = yaml.load(
      readFileSync(resolve(DOCS_DIR, 'openapi.bundled.yaml'), 'utf-8')
    ) as any

    expect(bundled.info.title).toBe('khef API')
    expect(bundled.info.title).not.toContain('mem-zen')

    const pathCount = Object.keys(bundled.paths).length
    expect(pathCount).toBeGreaterThanOrEqual(100)

    // Verify key path groups exist
    const paths = Object.keys(bundled.paths)
    expect(paths.some(p => p.startsWith('/api/vector'))).toBeTruthy()
    expect(paths.some(p => p.startsWith('/api/memories'))).toBeTruthy()
    expect(paths.some(p => p.startsWith('/api/projects'))).toBeTruthy()
    expect(paths.some(p => p.includes('/sessions'))).toBeTruthy()
    expect(paths.some(p => p.startsWith('/api/active-sessions'))).toBeTruthy()
  })
})
