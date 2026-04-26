const fs = require('fs');
const path = require('path');

const KNOWLEDGE_FILE = 'KF-PROJECT-KNOWLEDGE.md';
const IMPORT_LINE = `./${KNOWLEDGE_FILE}`;

function normalizeContent(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function buildKnowledgeMarkdown(knowledge, projectHandle) {
  const lines = [];

  lines.push(`# Project Knowledge: ${projectHandle}`);
  lines.push('');
  lines.push('> Auto-generated from khef memories. Do not edit — changes will be overwritten on next sync.');

  // Commands section
  if (knowledge.commands && (knowledge.commands.content || '').trim()) {
    lines.push('');
    lines.push('## Commands');
    lines.push('');
    lines.push(knowledge.commands.content.trim());
  }

  // Context section — sorted alphabetically by title
  const sortedContext = (knowledge.context || [])
    .filter((c) => (c.content || '').trim())
    .sort((a, b) => (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase()));

  if (sortedContext.length > 0) {
    lines.push('');
    lines.push('## Context');
    for (const ctx of sortedContext) {
      lines.push('');
      lines.push(`### ${ctx.title}`);
      lines.push('');
      lines.push(ctx.content.trim());
    }
  }

  // Patterns section — sorted alphabetically by title
  const sortedPatterns = (knowledge.patterns || [])
    .filter((p) => (p.content || '').trim())
    .sort((a, b) => (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase()));

  if (sortedPatterns.length > 0) {
    lines.push('');
    lines.push('## Patterns');
    for (const pat of sortedPatterns) {
      lines.push('');
      lines.push(`### ${pat.title}`);
      lines.push('');
      lines.push(pat.content.trim());
    }
  }

  return lines.join('\n') + '\n';
}

function ensureImportLine(localMdPath) {
  let content = '';
  const existed = fs.existsSync(localMdPath);

  if (existed) {
    content = fs.readFileSync(localMdPath, 'utf8');
    if (content.includes(IMPORT_LINE)) {
      return false;
    }
  }

  if (content && !content.endsWith('\n')) {
    content += '\n';
  }
  if (content && !/\n\n$/.test(content)) {
    content += '\n';
  }
  content += `@${IMPORT_LINE}\n`;

  fs.writeFileSync(localMdPath, content, 'utf8');
  return true;
}

function applyProjectClaudeKnowledge(knowledge, cwd, projectHandle) {
  const results = [];

  const knowledgePath = path.join(cwd, KNOWLEDGE_FILE);
  const localMdPath = path.join(cwd, 'CLAUDE.local.md');

  const desired = buildKnowledgeMarkdown(knowledge, projectHandle);

  // Write knowledge file
  if (fs.existsSync(knowledgePath)) {
    const current = fs.readFileSync(knowledgePath, 'utf8');
    if (normalizeContent(current) === normalizeContent(desired)) {
      results.push({ agent: 'claude', target: knowledgePath, action: 'unchanged' });
    } else {
      fs.writeFileSync(knowledgePath, desired, 'utf8');
      results.push({ agent: 'claude', target: knowledgePath, action: 'updated' });
    }
  } else {
    fs.writeFileSync(knowledgePath, desired, 'utf8');
    results.push({ agent: 'claude', target: knowledgePath, action: 'created' });
  }

  // Ensure CLAUDE.local.md has the import line
  const localMdExisted = fs.existsSync(localMdPath);
  const importChanged = ensureImportLine(localMdPath);
  if (importChanged) {
    results.push({
      agent: 'claude',
      target: localMdPath,
      action: localMdExisted ? 'updated' : 'created',
    });
  }

  return results;
}

module.exports = { applyProjectClaudeKnowledge };
