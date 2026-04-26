import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { splitContentIntoFiles, cleanupOverflowFiles, FILE_SPLIT_THRESHOLD, ContentBlock, FileChunk } from './knowledge-sync';

const MARKER_START = '<!-- BEGIN KHEF RULES (AUTO-GENERATED) -->';
const MARKER_END = '<!-- END KHEF RULES (AUTO-GENERATED) -->';
const AGENT_BLOCK_RE = /<!--\s*AGENT:\s*([a-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*END\s*AGENT\s*-->/gi;

export interface RuleMemory {
  title: string;
  content: string;
}

export interface SyncResultItem {
  agent: 'claude' | 'codex';
  target: string;
  action: 'updated' | 'created' | 'unchanged' | 'removed';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContent(s: string): string {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function filterRuleContent(content: string, agent: string): string {
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

/**
 * Ensure a config file contains the given import line.
 * Also removes any inline marker blocks left over from the old format.
 * Returns true if the file was modified.
 */
function ensureImportLine(filePath: string, importLine: string): boolean {
  const original = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const blockRe = /<!-- BEGIN [A-Z-]+ RULES \(AUTO-GENERATED\) -->[\s\S]*?<!-- END [A-Z-]+ RULES \(AUTO-GENERATED\) -->/gms;
  let content = original.replace(blockRe, '').replace(/\n{3,}/g, '\n\n');

  if (!content.includes(importLine)) {
    if (!content.endsWith('\n')) content += '\n';
    if (!/\n\n$/.test(content)) content += '\n';
    content += `${importLine}\n`;
  }

  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

/**
 * Remove import line and inline marker blocks from a config file.
 * Returns true if the file was modified.
 */
function removeImportAndMarkers(filePath: string, importLine: string): boolean {
  if (!existsSync(filePath)) return false;
  const original = readFileSync(filePath, 'utf8');
  const blockRe = /<!-- BEGIN [A-Z-]+ RULES \(AUTO-GENERATED\) -->[\s\S]*?<!-- END [A-Z-]+ RULES \(AUTO-GENERATED\) -->/gms;
  let content = original.replace(blockRe, '');
  // Remove the import line (with optional surrounding blank lines)
  content = content.replace(new RegExp(`^[ \\t]*${escapeRegex(importLine)}[ \\t]*\\n?`, 'gm'), '');
  content = content.replace(/\n{3,}/g, '\n\n');
  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function removeGeneratedBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const original = readFileSync(filePath, 'utf8');
  const re = /<!-- BEGIN [A-Z-]+ RULES \(AUTO-GENERATED\) -->[\s\S]*?<!-- END [A-Z-]+ RULES \(AUTO-GENERATED\) -->/gms;
  const stripped = original.replace(re, '').replace(/\n{3,}/g, '\n\n');
  if (stripped !== original) {
    writeFileSync(filePath, stripped, 'utf8');
    return true;
  }
  return false;
}

const RULES_BASE = 'KF-RULES';

/**
 * Build file chunks for project rules using the shared splitter.
 * Rules are flat (no sub-sections), so blocks have empty section.
 */
function buildProjectRulesFiles(rules: RuleMemory[], projectHandle: string): FileChunk[] {
  const preamble =
    `## Khef Agent Rules\n\nThese rules come from the khef "${projectHandle}" project.\n\n`;

  const continuationHeader =
    `## Khef Agent Rules (continued)\n\nThese rules come from the khef "${projectHandle}" project.\n\n`;

  const sorted = [...rules].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  const blocks: ContentBlock[] = sorted.map((r, i) => ({
    section: '',
    content: `### Rule ${i + 1}: ${r.title}\n\n${(r.content || '').trim()}\n\n`,
  }));

  return splitContentIntoFiles(preamble, blocks, RULES_BASE, continuationHeader);
}

/**
 * Build file chunks for user rules (Claude-filtered) using the shared splitter.
 * Chain links use @~/.claude/ prefix since files live in the home directory.
 */
function buildUserClaudeRulesFiles(rules: RuleMemory[]): FileChunk[] {
  const intro =
    'These rules come from the khef "user" project and are tailored for Claude Code (this CLAUDE.md). Follow them when working in Claude, including planning, testing, and commiting.';

  const preamble = `## Khef Agent Rules\n\n${intro}\n\n`;
  const continuationHeader = `## Khef Agent Rules (continued)\n\n${intro}\n\n`;

  const filtered = rules
    .map((r) => ({ ...r, content: filterRuleContent(r.content, 'claude') }))
    .filter((r) => (r.content || '').trim());
  const ordered = filtered.length ? filtered : rules;
  const sorted = [...ordered].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const blocks: ContentBlock[] = sorted.map((r, i) => ({
    section: '',
    content: `### Rule ${i + 1}: ${r.title}\n\n${(r.content || '').trim()}\n\n`,
  }));

  return splitContentIntoFiles(preamble, blocks, RULES_BASE, continuationHeader, undefined, '~/.claude/');
}

/**
 * Apply project rules to KF-RULES.md (with overflow splitting) and ensure CLAUDE.local.md imports it
 */
export function applyProjectClaudeRules(
  rules: RuleMemory[],
  cwd: string,
  projectHandle: string
): SyncResultItem[] {
  const rulesTarget = join(cwd, 'KF-RULES.md');
  const claudeLocal = join(cwd, 'CLAUDE.local.md');
  const results: SyncResultItem[] = [];
  const importLine = '@./KF-RULES.md';

  if (!rules || rules.length === 0) {
    // Remove KF-RULES.md if it exists
    if (existsSync(rulesTarget)) {
      unlinkSync(rulesTarget);
      results.push({ agent: 'claude', target: rulesTarget, action: 'removed' });
    }
    // Remove overflow files
    const removed = cleanupOverflowFiles(cwd, RULES_BASE, new Set());
    for (const p of removed) {
      results.push({ agent: 'claude', target: p, action: 'removed' });
    }
    // Remove import line and any leftover inline markers from CLAUDE.local.md
    if (removeImportAndMarkers(claudeLocal, importLine)) {
      results.push({ agent: 'claude', target: claudeLocal, action: 'updated' });
    }
  } else {
    // 1. Build rules files (may be one or many)
    const files = buildProjectRulesFiles(rules, projectHandle);

    // 2. Write each file
    for (const file of files) {
      const filePath = join(cwd, file.filename);
      const fileExisted = existsSync(filePath);
      if (!fileExisted) {
        writeFileSync(filePath, file.content, 'utf8');
        results.push({ agent: 'claude', target: filePath, action: 'created' });
      } else {
        const current = readFileSync(filePath, 'utf8');
        if (normalizeContent(current) !== normalizeContent(file.content)) {
          writeFileSync(filePath, file.content, 'utf8');
          results.push({ agent: 'claude', target: filePath, action: 'updated' });
        }
      }
    }

    // 3. Clean up stale overflow files
    const currentFilenames = new Set(files.map(f => f.filename));
    const removed = cleanupOverflowFiles(cwd, RULES_BASE, currentFilenames);
    for (const p of removed) {
      results.push({ agent: 'claude', target: p, action: 'removed' });
    }

    // 4. Ensure CLAUDE.local.md imports KF-RULES.md (and remove inline markers)
    if (!existsSync(claudeLocal)) writeFileSync(claudeLocal, '', 'utf8');
    if (ensureImportLine(claudeLocal, importLine)) {
      results.push({ agent: 'claude', target: claudeLocal, action: existsSync(claudeLocal) ? 'updated' : 'created' });
    }
  }
  return results;
}

/**
 * Clean up legacy inline marker blocks from AGENTS.local.md.
 * Codex CLI does not read AGENTS.local.md, so we no longer write to it.
 * Codex now bootstraps rules/knowledge via MCP tools at session start
 * (see ~/.codex/AGENTS.md bootstrap instructions).
 */
export function applyProjectCodexRules(
  _rules: RuleMemory[],
  cwd: string,
  _projectHandle: string
): SyncResultItem[] {
  const target = join(cwd, 'AGENTS.local.md');
  const results: SyncResultItem[] = [];

  // Clean up any leftover marker blocks from previous sync runs
  if (removeGeneratedBlock(target)) {
    results.push({ agent: 'codex', target, action: 'removed' });
  }
  return results;
}

/**
 * Apply user rules to ~/.claude/KF-RULES.md (with overflow splitting) and ensure CLAUDE.md imports it
 */
export function applyUserClaudeRules(rules: RuleMemory[]): SyncResultItem[] {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const claudeMain = join(claudeDir, 'CLAUDE.md');
  const results: SyncResultItem[] = [];
  const importLine = '@~/.claude/KF-RULES.md';

  // Respect existing convention: no-op if the agent directory does not exist
  if (!existsSync(claudeDir)) return results;

  if (!rules || rules.length === 0) {
    // Remove KF-RULES.md if it exists
    const baseTarget = join(claudeDir, 'KF-RULES.md');
    if (existsSync(baseTarget)) {
      unlinkSync(baseTarget);
      results.push({ agent: 'claude', target: baseTarget, action: 'removed' });
    }
    // Remove overflow files
    const removed = cleanupOverflowFiles(claudeDir, RULES_BASE, new Set());
    for (const p of removed) {
      results.push({ agent: 'claude', target: p, action: 'removed' });
    }
    // Remove import line and any leftover inline markers from CLAUDE.md
    if (removeImportAndMarkers(claudeMain, importLine)) {
      results.push({ agent: 'claude', target: claudeMain, action: 'updated' });
    }
  } else {
    // 1. Build rules files (may be one or many)
    const files = buildUserClaudeRulesFiles(rules);

    // 2. Write each file
    for (const file of files) {
      const filePath = join(claudeDir, file.filename);
      const fileExisted = existsSync(filePath);
      if (!fileExisted) {
        writeFileSync(filePath, file.content, 'utf8');
        results.push({ agent: 'claude', target: filePath, action: 'created' });
      } else {
        const current = readFileSync(filePath, 'utf8');
        if (normalizeContent(current) !== normalizeContent(file.content)) {
          writeFileSync(filePath, file.content, 'utf8');
          results.push({ agent: 'claude', target: filePath, action: 'updated' });
        }
      }
    }

    // 3. Clean up stale overflow files
    const currentFilenames = new Set(files.map(f => f.filename));
    const removed = cleanupOverflowFiles(claudeDir, RULES_BASE, currentFilenames);
    for (const p of removed) {
      results.push({ agent: 'claude', target: p, action: 'removed' });
    }

    // 4. Ensure CLAUDE.md imports KF-RULES.md and remove any embedded auto-generated blocks
    const blockRe = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'gms');
    if (existsSync(claudeMain)) {
      const originalMain = readFileSync(claudeMain, 'utf8');
      let newContent = originalMain.replace(blockRe, '');
      if (!newContent.includes(importLine)) {
        if (!newContent.endsWith('\n')) newContent += '\n';
        if (!/\n\n$/.test(newContent)) newContent += '\n';
        newContent += `${importLine}\n`;
      }
      if (newContent !== originalMain) {
        writeFileSync(claudeMain, newContent, 'utf8');
        results.push({ agent: 'claude', target: claudeMain, action: 'updated' });
      }
    } else {
      writeFileSync(claudeMain, `${importLine}\n`, 'utf8');
      results.push({ agent: 'claude', target: claudeMain, action: 'created' });
    }
  }
  return results;
}

/**
 * Clean up legacy inline marker blocks from ~/.codex/AGENTS.md.
 * Codex now bootstraps rules/knowledge via MCP tools at session start
 * (see ~/.codex/AGENTS.md bootstrap instructions). No more inlining.
 */
export function applyUserCodexRules(_rules: RuleMemory[]): SyncResultItem[] {
  const home = homedir();
  const codexDir = join(home, '.codex');
  const target = join(codexDir, 'AGENTS.md');
  const results: SyncResultItem[] = [];

  if (!existsSync(codexDir)) return results;

  // Clean up any leftover marker blocks from previous sync runs
  if (removeGeneratedBlock(target)) {
    results.push({ agent: 'codex', target, action: 'removed' });
  }
  return results;
}

/**
 * Sync all rules for a project to the specified location
 */
export function syncProjectRules(
  rules: RuleMemory[],
  location: string,
  projectHandle: string
): SyncResultItem[] {
  const results: SyncResultItem[] = [];
  results.push(...applyProjectClaudeRules(rules, location, projectHandle));
  results.push(...applyProjectCodexRules(rules, location, projectHandle));
  return results;
}

/**
 * Sync all rules for the "user" project to home directories
 */
export function syncUserRules(rules: RuleMemory[]): SyncResultItem[] {
  const results: SyncResultItem[] = [];
  results.push(...applyUserClaudeRules(rules));
  results.push(...applyUserCodexRules(rules));
  return results;
}
