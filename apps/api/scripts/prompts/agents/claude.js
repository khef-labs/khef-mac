const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Sync prompts to Claude Code's commands directory (~/.claude/commands/)
 *
 * Claude commands are markdown files that can be invoked with /command-name.
 * The filename (without .md) becomes the command name.
 */
function applyClaudePrompts(prompts) {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const commandsDir = path.join(claudeDir, 'commands');
  const results = [];

  // No-op if Claude directory doesn't exist
  if (!fs.existsSync(claudeDir)) return results;

  // Create commands directory if it doesn't exist
  if (!fs.existsSync(commandsDir)) {
    fs.mkdirSync(commandsDir, { recursive: true });
  }

  for (const prompt of prompts) {
    const targetPath = path.join(commandsDir, prompt.filename);
    const content = formatForClaude(prompt.content);

    // Check if file needs updating
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
    if (existing !== content) {
      fs.writeFileSync(targetPath, content, 'utf8');
      results.push({ agent: 'claude', target: targetPath, action: existing ? 'updated' : 'created' });
    }
  }

  return results;
}

/**
 * Format prompt content for Claude Code
 * Claude commands use standard markdown.
 */
function formatForClaude(content) {
  // Ensure file ends with newline
  return content.endsWith('\n') ? content : content + '\n';
}

module.exports = { applyClaudePrompts };
