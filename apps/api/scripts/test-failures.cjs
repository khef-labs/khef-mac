#!/usr/bin/env node

/**
 * Extract Vitest failures into a plain-text file.
 * Usage: node scripts/test-failures.cjs [path/to/results.json]
 * Output: test-results/failures.txt
 */

const fs = require('fs')
const path = require('path')

const jsonPath = process.argv[2] || 'test-results/results.json'
const outputDir = 'test-results'
const outputPath = path.join(outputDir, 'failures.txt')

if (!fs.existsSync(jsonPath)) {
  console.error(`Error: ${jsonPath} not found. Run tests first with 'npm test'.`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

const failures = []

for (const suite of data.testResults || []) {
  const suiteName = suite.name || 'Unknown suite'
  for (const test of suite.assertionResults || []) {
    if (test.status === 'failed') {
      failures.push({
        suite: suiteName,
        title: test.fullName || test.title || 'Unnamed test',
        messages: test.failureMessages || [],
      })
    }
  }
}

const lines = []

if (failures.length === 0) {
  lines.push('OK No failures')
} else {
  for (const failure of failures) {
    lines.push(`FAIL ${failure.title}`)
    lines.push(`  File: ${failure.suite}`)
    for (const message of failure.messages) {
      const clean = String(message).replace(/\x1b\[[0-9;]*m/g, '')
      const msgLines = clean.split('\n').filter(Boolean)
      if (msgLines.length > 0) {
        lines.push(`  Error: ${msgLines[0]}`)
        for (const line of msgLines.slice(1, 4)) {
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
