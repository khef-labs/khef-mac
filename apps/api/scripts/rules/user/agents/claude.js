const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_START = '<!-- BEGIN MEM-ZEN RULES (AUTO-GENERATED) -->';
const MARKER_END = '<!-- END MEM-ZEN RULES (AUTO-GENERATED) -->';
const AGENT_BLOCK_RE = /<!--\s*AGENT:\s*([a-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*END\s*AGENT\s*-->/gi;

function filterRuleContent(content, agent) {
  const source = (content || '').trim();
  if (!source) return '';
  let hasAgentBlocks = false;
  const filtered = source.replace(AGENT_BLOCK_RE, (match, blockAgent, body) => {
    hasAgentBlocks = true;
    if ((blockAgent || '').toLowerCase() === agent) {
      return (body || '').trim();
    }
    return '';
  });
  if (!hasAgentBlocks) return source;
  return filtered.replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildKhefRulesSection(rules) {
  const header = '## Khef Agent Rules';
  const intro =
    'These rules come from the khef "user" project and are tailored for Claude Code (this CLAUDE.md). Follow them when working in Claude, including planning, testing, and commiting.';
  const list = Array.isArray(rules) ? [...rules] : [];
  const filtered = list
    .map((r) => ({ ...r, content: filterRuleContent(r.content, 'claude') }))
    .filter((r) => (r.content || '').trim());
  const ordered = filtered.length ? filtered : list;
  ordered.sort((a, b) => {
    const ta = (a.title || '').toLowerCase();
    const tb = (b.title || '').toLowerCase();
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  const body = ordered
    .map((r, i) => `### Rule ${i + 1}: ${r.title}\n\n${(r.content || '').trim()}\n`)
    .join('\n');
  return `${header}\n\n${intro}\n\n${body}`;
}

function buildGeneratedBlock(rules) {
  // For KF-RULES.md we do NOT include auto-generated markers; write plain content
  return buildKhefRulesSection(rules);
}

function normalizeContent(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function upsertGeneratedBlock(filePath, generatedBlock) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let content = original.endsWith('\n') ? original : original + '\n';

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const existing = content.slice(startIdx, endIdx + MARKER_END.length);
    if (normalizeContent(existing) === normalizeContent(generatedBlock)) {
      return false; // no change
    }
    content = content.slice(0, startIdx) + generatedBlock + content.slice(endIdx + MARKER_END.length);
  } else {
    // Fallback: header-based replacement or append
    const sectionRe = new RegExp(
      '^##\\s+Developer\\s+Memory\\s*\\(\\s*(?:Dev\\s*[-–—]?\\s*Mem|dev\\s*[-–—]?\\s*mem)\\s*\\)\\s+Agent\\s+Rules[\\s\\S]*?(?=\\n#{1,6}\\s|$)',
      'im'
    );
    if (sectionRe.test(content)) {
      content = content.replace(sectionRe, generatedBlock);
    } else {
      content += (content.includes('\n#') ? '\n' : '') + generatedBlock + '\n';
    }
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function applyClaudeRules(rules) {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const target = path.join(claudeDir, 'KF-RULES.md');
  const claudeMain = path.join(claudeDir, 'CLAUDE.md');
  const results = [];

  // Respect existing convention: no-op if the agent directory does not exist
  if (!fs.existsSync(claudeDir)) return results;

  const block = buildGeneratedBlock(rules);

  // Write rules file deterministically (no markers, no duplicates)
  const desired = `${block}\n`;
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, desired, 'utf8');
    results.push({ agent: 'claude', target });
  } else {
    const current = fs.readFileSync(target, 'utf8');
    if (current !== desired) {
      fs.writeFileSync(target, desired, 'utf8');
      results.push({ agent: 'claude', target });
    }
  }

  // Ensure CLAUDE.md imports KF-RULES.md and remove any embedded auto-generated blocks
  const importLine = '@~/.claude/KF-RULES.md';
  const blockRe = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'gms');
  if (fs.existsSync(claudeMain)) {
    const originalMain = fs.readFileSync(claudeMain, 'utf8');
    // Remove any embedded khef rules blocks without touching other formatting
    let newContent = originalMain.replace(blockRe, '');
    // Ensure a single import line is present; if missing, append with a leading blank line if needed
    if (!newContent.includes(importLine)) {
      // Make sure file ends in exactly one newline before adding an extra blank line + import
      if (!newContent.endsWith('\n')) newContent += '\n';
      // Preserve formatting: add a blank line if the last non-empty line isn't already a blank line
      if (!/\n\n$/.test(newContent)) newContent += '\n';
      newContent += `${importLine}\n`;
    }
    if (newContent !== originalMain) {
      fs.writeFileSync(claudeMain, newContent, 'utf8');
      results.push({ agent: 'claude', target: claudeMain });
    }
  } else {
    fs.writeFileSync(claudeMain, `${importLine}\n`, 'utf8');
    results.push({ agent: 'claude', target: claudeMain });
  }
  return results;
}

module.exports = { applyClaudeRules };
