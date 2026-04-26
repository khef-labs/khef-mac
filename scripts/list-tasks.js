#!/usr/bin/env node
/*
 * Lists available project npm scripts grouped by prefix.
 * Usage: node list-tasks.js [target]
 *   (no arg)  — list scripts from the root package.json
 *   :api      — list scripts from apps/api/package.json
 *   :ui       — list scripts from apps/ui/package.json
 */

const fs = require('fs');
const path = require('path');

const TARGETS = {
  ':api': 'apps/api',
  ':ui': 'apps/ui',
};

function main() {
  const arg = process.argv[2];
  let pkgDir = process.cwd();
  let label = 'root';

  if (arg) {
    const rel = TARGETS[arg];
    if (!rel) {
      console.error(`Unknown target: ${arg}`);
      console.error(`Valid targets: ${Object.keys(TARGETS).join(', ')}`);
      process.exit(1);
    }
    // Resolve relative to the repo root (one level up from this script)
    const repoRoot = path.resolve(__dirname, '..');
    pkgDir = path.join(repoRoot, rel);
    label = arg.slice(1);
  }

  const pkgPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`No package.json found at ${pkgPath}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts || {};

  // Group scripts by the segment before the first ':'
  const groups = {};
  for (const [name, cmd] of Object.entries(scripts)) {
    const idx = name.indexOf(':');
    const group = idx === -1 ? 'general' : name.slice(0, idx);
    if (!groups[group]) groups[group] = [];
    groups[group].push({ name, cmd });
  }

  // Stable order for common groups, then alphabetical
  const preferred = ['general', 'db', 'test', 'docs', 'rules', 'mcp'];
  const groupNames = Array.from(new Set([...preferred, ...Object.keys(groups).sort()]));

  console.log(`Available commands (${label}):\n`);
  for (const g of groupNames) {
    if (!groups[g]) continue;
    console.log(`- ${g}`);
    // Sort scripts within group by name
    for (const { name, cmd } of groups[g].sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  • ${name} -> ${cmd}`);
    }
    console.log();
  }
}

main();
