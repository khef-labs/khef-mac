#!/usr/bin/env node

/**
 * Parse Playwright JSON results and produce a readable text report.
 * Usage: node scripts/test-report.cjs [path/to/results.json]
 * Output: playwright-report/report.txt
 */

const fs = require('fs')
const path = require('path')

const jsonPath = process.argv[2] || 'playwright-report/results.json'
const outputPath = 'playwright-report/report.txt'

if (!fs.existsSync(jsonPath)) {
  console.error(`Error: ${jsonPath} not found. Run tests first with 'npm test'.`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

// Collect stats
let passed = 0
let failed = 0
let skipped = 0
const failures = []
const suites = new Map()

function processSpec(spec, suiteName) {
  const title = spec.title

  for (const test of spec.tests || []) {
    const result = test.results?.[0] || {}
    const status = result.status || 'unknown'
    const duration = result.duration || 0

    if (!suites.has(suiteName)) {
      suites.set(suiteName, [])
    }

    const icon = status === 'passed' ? '✓'
      : status === 'failed' ? '✗'
      : status === 'skipped' ? '○'
      : status === 'timedOut' ? '⏱'
      : '?'

    suites.get(suiteName).push({ icon, title, status, duration })

    if (status === 'passed') passed++
    else if (status === 'failed' || status === 'timedOut') {
      failed++
      failures.push({
        suite: suiteName,
        test: title,
        errors: result.errors || [],
      })
    }
    else if (status === 'skipped') skipped++
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

// Process all suites
for (const suite of data.suites || []) {
  processSuite(suite)
}

// Format duration
function formatDuration(ms) {
  if (!ms || isNaN(ms)) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Build report
const lines = []

lines.push('═'.repeat(70))
lines.push(' PLAYWRIGHT TEST REPORT')
lines.push(' ' + new Date().toLocaleString())
lines.push('═'.repeat(70))
lines.push('')

const total = passed + failed + skipped
const totalDuration = formatDuration(data.stats?.duration)

lines.push(`Total: ${total} tests | ✓ ${passed} passed | ✗ ${failed} failed | ○ ${skipped} skipped`)
lines.push(`Duration: ${totalDuration}`)
lines.push('')

// Print by suite
for (const [suiteName, tests] of suites) {
  lines.push('─'.repeat(70))
  lines.push(suiteName)
  lines.push('─'.repeat(70))

  for (const test of tests) {
    const dur = formatDuration(test.duration)
    lines.push(`  ${test.icon} ${test.title} (${dur})`)
  }
  lines.push('')
}

// Print failures
if (failures.length > 0) {
  lines.push('═'.repeat(70))
  lines.push(' FAILURES')
  lines.push('═'.repeat(70))
  lines.push('')

  for (const failure of failures) {
    lines.push(`✗ ${failure.suite} › ${failure.test}`)
    for (const error of failure.errors) {
      if (error.message) {
        // Clean ANSI codes from error message
        const cleanMsg = error.message.replace(/\x1b\[[0-9;]*m/g, '')
        lines.push(`  Error: ${cleanMsg.split('\n')[0]}`)
      }
      if (error.stack) {
        const cleanStack = error.stack.replace(/\x1b\[[0-9;]*m/g, '')
        const stackLines = cleanStack.split('\n').slice(0, 5)
        for (const line of stackLines) {
          lines.push(`    ${line}`)
        }
      }
    }
    lines.push('')
  }
}

// Summary
lines.push('═'.repeat(70))
if (failed === 0) {
  lines.push(' ✓ ALL TESTS PASSED')
} else {
  lines.push(` ✗ ${failed} TEST${failed > 1 ? 'S' : ''} FAILED`)
}
lines.push('═'.repeat(70))

// Write to file
const report = lines.join('\n')
fs.writeFileSync(outputPath, report)

// Also print to console
console.log(report)
console.log('')
console.log(`Report saved to: ${outputPath}`)

process.exit(failed > 0 ? 1 : 0)
