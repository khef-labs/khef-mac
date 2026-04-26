const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Sync prompts to Codex CLI's prompts directory (~/.codex/prompts/)
 *
 * Codex prompts are markdown files that can be used as reusable instructions.
 * The filename (without .md) becomes the prompt name.
 */
function applyCodexPrompts(prompts) {
  const home = os.homedir();
  const codexDir = path.join(home, '.codex');
  const promptsDir = path.join(codexDir, 'prompts');
  const results = [];

  // No-op if Codex directory doesn't exist
  if (!fs.existsSync(codexDir)) return results;

  // Create prompts directory if it doesn't exist
  if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
  }

  for (const prompt of prompts) {
    const targetPath = path.join(promptsDir, prompt.filename);
    const content = formatForCodex(prompt.content);

    // Check if file needs updating
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
    if (existing !== content) {
      fs.writeFileSync(targetPath, content, 'utf8');
      results.push({ agent: 'codex', target: targetPath, action: existing ? 'updated' : 'created' });
    }
  }

  return results;
}

/**
 * Format prompt content for Codex CLI
 * Codex prompts use standard markdown.
 */
function formatForCodex(content) {
  // Ensure file ends with newline
  return content.endsWith('\n') ? content : content + '\n';
}

module.exports = { applyCodexPrompts };
