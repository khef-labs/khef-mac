#!/usr/bin/env node

/**
 * Extract Playwright failures into a plain-text file.
 * Usage: node scripts/test-failures.cjs [path/to/results.json]
 * Output: test-results/failures.txt
 */

const fs = require('fs')
const path = require('path')

const jsonPath = process.argv[2] || 'playwright-report/results.json'
const outputDir = 'test-results'
const outputPath = path.join(outputDir, 'failures.txt')

if (!fs.existsSync(jsonPath)) {
  console.error(`Error: ${jsonPath} not found. Run tests first with 'npm test'.`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

const failures = []

function processSpec(spec, suiteName) {
  const title = spec.title

  for (const test of spec.tests || []) {
    const result = test.results?.[0] || {}
    const status = result.status || 'unknown'

    if (status === 'failed' || status === 'timedOut') {
      failures.push({
        suite: suiteName,
        test: title,
        errors: result.errors || [],
        status,
      })
    }
  }
}

function processSuite(suite, parentName = '') {
  const suiteName = parentName ? `${parentName} › ${suite.title}` : suite.title

  for (const spec of suite.specs || []) {
    processSpec(spec, suiteName)
  }

  for (const child of suite.suites || []) {
    processSuite(child, suiteName)
  }
}

for (const suite of data.suites || []) {
  processSuite(suite)
}

const lines = []

if (failures.length === 0) {
  lines.push('✓ No failures')
} else {
  for (const failure of failures) {
    lines.push(`✗ ${failure.suite} › ${failure.test}`)
    if (failure.status && failure.status !== 'failed') {
      lines.push(`  Status: ${failure.status}`)
    }
    for (const error of failure.errors) {
      if (error.message) {
        const cleanMsg = error.message.replace(/\x1b\[[0-9;]*m/g, '')
        lines.push(`  Error: ${cleanMsg.split('\n')[0]}`)
      }
      if (error.stack) {
        const cleanStack = error.stack.replace(/\x1b\[[0-9;]*m/g, '')
        const stackLines = cleanStack.split('\n').slice(0, 3)
        for (const line of stackLines) {
          lines.push(`    ${line}`)
        }
      }
    }
    lines.push('')
  }
}

fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(outputPath, lines.join('\n'))

console.log(`Failure report saved to: ${outputPath}`)

process.exit(failures.length > 0 ? 1 : 0)
