const fs = require('fs');
const path = require('path');

const MARKER_START = '<!-- BEGIN KHEF RULES (AUTO-GENERATED) -->';
const MARKER_END = '<!-- END KHEF RULES (AUTO-GENERATED) -->';
const LEGACY_MARKER_START = '<!-- BEGIN MEM-ZEN RULES (AUTO-GENERATED) -->';
const LEGACY_MARKER_END = '<!-- END MEM-ZEN RULES (AUTO-GENERATED) -->';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContent(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Strip agent-specific sections that don't match the target agent.
 * Keeps <!-- AGENT: codex --> sections, removes <!-- AGENT: claude --> sections.
 */
function stripNonCodexSections(content) {
  // Remove <!-- AGENT: claude -->...<!-- END AGENT --> sections
  return (content || '')
    .replace(/<!--\s*AGENT:\s*claude\s*-->[\s\S]*?<!--\s*END AGENT\s*-->/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildProjectCodexBlock(rules, projectHandle) {
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
      // Strip non-codex agent sections from rule content
      const content = stripNonCodexSections(r.content || '');
      return `### Rule ${i + 1}: ${r.title}\n\n${content}\n`;
    })
    .join('\n');
  return `${MARKER_START}\n${header}\n\n${intro}\n\n${body}\n${MARKER_END}`;
}

function upsertGeneratedBlock(filePath, generatedBlock) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let content = original.endsWith('\n') ? original : original + '\n';

  const markerPairs = [
    [MARKER_START, MARKER_END],
    [LEGACY_MARKER_START, LEGACY_MARKER_END],
  ];
  let startIdx = -1;
  let endIdx = -1;
  let foundStart = MARKER_START;
  let foundEnd = MARKER_END;
  for (const [start, end] of markerPairs) {
    const s = content.indexOf(start);
    const e = content.indexOf(end);
    if (s !== -1 && e !== -1 && e > s) {
      startIdx = s;
      endIdx = e;
      foundStart = start;
      foundEnd = end;
      break;
    }
  }
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const existing = content.slice(startIdx, endIdx + foundEnd.length);
    if (normalizeContent(existing) === normalizeContent(generatedBlock)) {
      return false; // no change
    }
    content = content.slice(0, startIdx) + generatedBlock + content.slice(endIdx + foundEnd.length);
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

function applyProjectCodexRules(rules, cwd, projectHandleOverride) {
  const target = path.join(cwd, 'AGENTS.local.md');
  const results = [];
  const projectHandle = projectHandleOverride || path.basename(cwd);

  if (!fs.existsSync(target)) fs.writeFileSync(target, '', 'utf8');

  if (!rules || rules.length === 0) {
    // Remove any generated blocks and normalize spacing
    const original = fs.readFileSync(target, 'utf8');
    const reKhef = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'gms');
    const reLegacy = new RegExp(`${escapeRegex(LEGACY_MARKER_START)}[\\s\\S]*?${escapeRegex(LEGACY_MARKER_END)}`, 'gms');
    const stripped = original.replace(reKhef, '').replace(reLegacy, '').replace(/\n{3,}/g, '\n\n');
    if (stripped !== original) {
      fs.writeFileSync(target, stripped, 'utf8');
      results.push({ agent: 'codex', target });
    }
  } else {
    const block = buildProjectCodexBlock(rules, projectHandle);
    const changed = upsertGeneratedBlock(target, block);
    if (changed) {
      results.push({ agent: 'codex', target });
    }
  }
  return results;
}

module.exports = { applyProjectCodexRules };
