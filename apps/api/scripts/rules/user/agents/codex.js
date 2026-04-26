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

function buildKhefRulesSection(rules) {
  const header = '## Khef Agent Rules';
  const intro =
    'These rules come from the khef "user" project and are tailored for Codex CLI (this AGENTS.md). Follow them when working in this environment, including planning, testing, and committing.';
  const list = Array.isArray(rules) ? [...rules] : [];
  const filtered = list
    .map((r) => ({ ...r, content: filterRuleContent(r.content, 'codex') }))
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

function buildPrecedenceSection() {
  const precedenceHeader = '## Agent File Precedence';
  const precedenceBlock = [
    precedenceHeader,
    '',
    '- Agents must search for and read `AGENTS.local.md` files within the current project tree and treat them as additive/overrides.',
    '- Precedence (most specific wins):',
    '  1. `AGENTS.local.md` in the project (deepest directory first)',
    '  2. Repository `AGENTS.md` files (deepest directory first)',
    '  3. Global rules in `~/.codex/AGENTS.md`',
    '',
  ].join('\n');
  return precedenceBlock;
}

function buildGeneratedBlock(rules) {
  const precedence = buildPrecedenceSection();
  const section = buildKhefRulesSection(rules);
  return `${MARKER_START}\n${precedence}\n\n${section}\n${MARKER_END}`;
}

function normalizeContent(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function stripStandalonePrecedence(content) {
  const re = new RegExp('^##\\s+Agent\\s+File\\s+Precedence[\\s\\S]*?(?=\\n#{1,6}\\s|$)', 'im');
  const start = content.indexOf(MARKER_START);
  const end = content.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = content.slice(0, start).replace(re, '');
    const middle = content.slice(start, end + MARKER_END.length);
    const after = content.slice(end + MARKER_END.length).replace(re, '');
    return before + middle + after;
  }
  return content.replace(re, '');
}

function upsertGeneratedBlock(filePath, generatedBlock) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  let content = original.endsWith('\n') ? original : original + '\n';

  // Remove any standalone precedence section to migrate into the generated block
  content = stripStandalonePrecedence(content);

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

function applyCodexRules(rules) {
  const home = os.homedir();
  const codexDir = path.join(home, '.codex');
  const target = path.join(codexDir, 'AGENTS.md');
  const results = [];

  if (!fs.existsSync(codexDir) || !fs.existsSync(target)) return results;

  const block = buildGeneratedBlock(rules);
  const changedSection = upsertGeneratedBlock(target, block);
  if (changedSection) {
    results.push({ agent: 'codex', target });
  }
  return results;
}

module.exports = { applyCodexRules };
