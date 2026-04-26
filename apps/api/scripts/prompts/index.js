#!/usr/bin/env node
/*
  sync:dvm-commands-to-disk
  - Read command files from lib/prompts/
  - Sync dvm-* prefixed commands to agent directories:
    - Claude: ~/.claude/commands/
    - Codex: ~/.codex/prompts/
  - Idempotent: only writes if content has changed
*/

const fs = require('fs');
const path = require('path');

const { applyClaudePrompts } = require('./agents/claude');
const { applyCodexPrompts } = require('./agents/codex');

const COMMANDS_DIR = path.join(__dirname, '../../lib/prompts');

function loadCommands() {
  const commands = [];

  if (!fs.existsSync(COMMANDS_DIR)) {
    console.error(`Commands directory not found: ${COMMANDS_DIR}`);
    return commands;
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));

  for (const filename of files) {
    const filePath = path.join(COMMANDS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    commands.push({
      filename,
      name: filename.replace(/\.md$/, ''),
      content,
    });
  }

  return commands;
}

async function main() {
  try {
    const commands = loadCommands();

    if (commands.length === 0) {
      console.log('No commands found in lib/prompts/');
      return;
    }

    console.log(`Found ${commands.length} commands: ${commands.map(c => c.name).join(', ')}`);

    const results = [];

    // Sync to each agent (using existing functions that expect prompts format)
    results.push(...applyClaudePrompts(commands));
    results.push(...applyCodexPrompts(commands));

    if (results.length === 0) {
      console.log('No changes. Commands are already up to date.');
    } else {
      for (const r of results) {
        console.log(`${r.action === 'created' ? 'Created' : 'Updated'} ${r.target}`);
      }
    }
  } catch (err) {
    console.error('Failed to sync commands:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, loadCommands };
