#!/usr/bin/env node

/**
 * Merges hooks from hooks.reference.json into ~/.claude/settings.json.
 * Existing non-hook settings are preserved. Hook entries are replaced wholesale.
 * Validates JSON at each stage — bails without writing if anything is invalid.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REFERENCE_PATH = join(import.meta.dirname, 'hooks.reference.json');
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

function parseJSON(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON in ${label} (${filePath}): ${err.message}`);
    process.exit(1);
  }
}

// Read and validate reference hooks
const reference = parseJSON(REFERENCE_PATH, 'hooks.reference.json');
if (!reference.hooks || typeof reference.hooks !== 'object') {
  console.error('No "hooks" key found in hooks.reference.json');
  process.exit(1);
}

// Read and validate existing settings (or start fresh)
let settings = {};
if (existsSync(SETTINGS_PATH)) {
  settings = parseJSON(SETTINGS_PATH, 'settings.json');
}

// Compare before writing
const before = JSON.stringify(settings.hooks ?? {});
const after = JSON.stringify(reference.hooks);

if (before === after) {
  console.log('Hooks already up to date in ~/.claude/settings.json');
  process.exit(0);
}

// Merge in memory, then validate the result serializes cleanly
settings.hooks = reference.hooks;

let output;
try {
  output = JSON.stringify(settings, null, 2) + '\n';
  JSON.parse(output); // round-trip validation
} catch (err) {
  console.error(`Merged settings produced invalid JSON — aborting: ${err.message}`);
  process.exit(1);
}

writeFileSync(SETTINGS_PATH, output);
console.log('Installed hooks into ~/.claude/settings.json');
