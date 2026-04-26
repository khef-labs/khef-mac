const fs = require('fs');
const path = require('path');

const MARKER_START = '<!-- BEGIN KHEF RULES (AUTO-GENERATED) -->';
const MARKER_END = '<!-- END KHEF RULES (AUTO-GENERATED) -->';
const LEGACY_MARKER_START = '<!-- BEGIN MEM-ZEN RULES (AUTO-GENERATED) -->';
const LEGACY_MARKER_END = '<!-- END MEM-ZEN RULES (AUTO-GENERATED) -->';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip agent-specific sections that don't match the target agent.
 * Keeps <!-- AGENT: claude --> sections, removes <!-- AGENT: codex --> sections.
 */
function stripNonClaudeSections(content) {
  // Remove <!-- AGENT: codex -->...<!-- END AGENT --> sections
  return (content || '')
    .replace(/<!--\s*AGENT:\s*codex\s*-->[\s\S]*?<!--\s*END AGENT\s*-->/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildProjectRulesFileContent(rules, projectHandle) {
  const header = '## Khef Agent Rules';
  const intro = `These rules come from the khef "${projectHandle}" project.`;
  const list = Array.isArray(rules) ? [...rules] : [];
  list.sort((a, b) => {
    const ta = (a.title || '').toLowerCase();
    const tb = (b.title || '').toLowerCase();
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  const body = list
    .map((r, i) => {
      // Strip non-claude agent sections from rule content
      const content = stripNonClaudeSections(r.content || '');
      return `### Rule ${i + 1}: ${r.title}\n\n${content}\n`;
    })
    .join('\n');
  return `${header}\n\n${intro}\n\n${body}\n`;
}

function ensureImportLine(filePath, importLine) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const khefBlockRe = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'gms');
  const legacyBlockRe = new RegExp(
    `${escapeRegex(LEGACY_MARKER_START)}[\\s\\S]*?${escapeRegex(LEGACY_MARKER_END)}`,
    'gms'
  );
  let content = original.replace(khefBlockRe, '').replace(legacyBlockRe, '').replace(/\n{3,}/g, '\n\n');

  if (!content.includes(importLine)) {
    if (!content.endsWith('\n')) content += '\n';
    if (!/\n\n$/.test(content)) content += '\n';
    content += `${importLine}\n`;
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function removeImportAndMarkers(filePath, importLine) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  const khefBlockRe = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'gms');
  const legacyBlockRe = new RegExp(
    `${escapeRegex(LEGACY_MARKER_START)}[\\s\\S]*?${escapeRegex(LEGACY_MARKER_END)}`,
    'gms'
  );
  let content = original.replace(khefBlockRe, '').replace(legacyBlockRe, '');
  content = content.replace(new RegExp(`^[ \\t]*${escapeRegex(importLine)}[ \\t]*\\n?`, 'gm'), '');
  content = content.replace(/\n{3,}/g, '\n\n');
  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function applyProjectClaudeRules(rules, cwd, projectHandleOverride) {
  const projectHandle = projectHandleOverride || path.basename(cwd);
  const rulesTarget = path.join(cwd, 'KF-RULES.md');
  const claudeLocal = path.join(cwd, 'CLAUDE.local.md');
  const results = [];
  const importLine = '@./KF-RULES.md';

  if (!rules || rules.length === 0) {
    // Remove KF-RULES.md if it exists
    if (fs.existsSync(rulesTarget)) {
      fs.unlinkSync(rulesTarget);
      results.push({ agent: 'claude', target: rulesTarget });
    }
    // Remove import line and any leftover inline markers from CLAUDE.local.md
    if (removeImportAndMarkers(claudeLocal, importLine)) {
      results.push({ agent: 'claude', target: claudeLocal });
    }
  } else {
    // 1. Write rules to KF-RULES.md
    const desired = buildProjectRulesFileContent(rules, projectHandle);
    if (!fs.existsSync(rulesTarget)) {
      fs.writeFileSync(rulesTarget, desired, 'utf8');
      results.push({ agent: 'claude', target: rulesTarget });
    } else {
      const current = fs.readFileSync(rulesTarget, 'utf8');
      if (current !== desired) {
        fs.writeFileSync(rulesTarget, desired, 'utf8');
        results.push({ agent: 'claude', target: rulesTarget });
      }
    }

    // 2. Ensure CLAUDE.local.md imports KF-RULES.md (and remove inline markers)
    if (!fs.existsSync(claudeLocal)) fs.writeFileSync(claudeLocal, '', 'utf8');
    if (ensureImportLine(claudeLocal, importLine)) {
      results.push({ agent: 'claude', target: claudeLocal });
    }
  }
  return results;
}

module.exports = { applyProjectClaudeRules };
