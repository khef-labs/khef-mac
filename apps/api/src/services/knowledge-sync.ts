import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface KnowledgeMemory {
  id: string;
  handle: string;
  title: string;
  content: string;
  updated_at: string;
}

export interface KnowledgeData {
  project_id: string;
  project_handle: string;
  commands: KnowledgeMemory[];
  context: KnowledgeMemory[];
  patterns: KnowledgeMemory[];
}

export interface KnowledgeSyncResultItem {
  target: string;
  action: 'created' | 'updated' | 'unchanged' | 'removed';
}

// ── Reusable file-splitting primitives ──────────────────────────────

/**
 * An atomic content block that must never be split across files.
 * `section` groups blocks under a ## heading (empty string = no heading).
 */
export interface ContentBlock {
  section: string;
  content: string;
}

/** A single output file produced by the splitter. */
export interface FileChunk {
  filename: string;
  content: string;
}

/**
 * Split threshold in characters. When content exceeds this, start a new file.
 * Set comfortably under Claude Code's ~40k warning threshold.
 */
export const FILE_SPLIT_THRESHOLD = 30000;

/**
 * Split a preamble + list of atomic blocks into one or more chained files.
 *
 * - Blocks are never split mid-block.
 * - Blocks with the same `section` are grouped under a `## Section` heading.
 * - When a section continues into a new file, the heading gets "(continued)".
 * - Each non-final file ends with `@./NEXT-FILE.md`.
 *
 * @param preamble     Content that always starts the first file (header, intro, etc.)
 * @param blocks       Atomic content blocks in order
 * @param baseFilename Stem without extension, e.g. 'KF-PROJECT-KNOWLEDGE'
 * @param continuationHeader  Header for overflow files (e.g. "# Title (continued)\n\n> notice\n")
 * @param threshold    Character limit per file (default: FILE_SPLIT_THRESHOLD)
 * @param linkPrefix   Prefix for @-import chain links between files (default: './')
 */
export function splitContentIntoFiles(
  preamble: string,
  blocks: ContentBlock[],
  baseFilename: string,
  continuationHeader: string,
  threshold: number = FILE_SPLIT_THRESHOLD,
  linkPrefix: string = './',
): FileChunk[] {
  // ── Fast path: check if everything fits in one file ──
  let singleContent = preamble;
  let lastSection = '';
  for (const block of blocks) {
    if (block.section && block.section !== lastSection) {
      singleContent += `\n## ${block.section}\n`;
      lastSection = block.section;
    }
    singleContent += block.content;
  }

  if (singleContent.length <= threshold) {
    return [{ filename: `${baseFilename}.md`, content: singleContent }];
  }

  // ── Splitting path ──
  const files: FileChunk[] = [];
  let currentContent = preamble;
  let fileNum = 1;
  let fileSectionActive = '';                    // last ## emitted in *this* file
  const sectionsInPreviousFiles = new Set<string>(); // for "(continued)" labels
  let fileSections = new Set<string>();           // sections with content in this file

  for (const block of blocks) {
    // Build what we'd append for this block
    let addition = '';
    const needsHeader = !!(block.section && block.section !== fileSectionActive);
    if (needsHeader) {
      const continued = sectionsInPreviousFiles.has(block.section);
      addition += `\n## ${block.section}${continued ? ' (continued)' : ''}\n`;
    }
    addition += block.content;

    // Would adding this exceed the threshold?
    const importReserve = `\n@${linkPrefix}${baseFilename}-99.md\n`.length;
    const baseLen = fileNum === 1 ? preamble.length : continuationHeader.length;
    const wouldExceed = currentContent.length + addition.length + importReserve > threshold;
    // Ensure we always add at least one block per file (prevents infinite loops)
    const hasRealContent = currentContent.length > baseLen + 10;

    if (wouldExceed && hasRealContent) {
      // ── Close current file ──
      for (const s of fileSections) sectionsInPreviousFiles.add(s);

      const nextFileNum = fileNum + 1;
      const nextFilename = `${baseFilename}-${nextFileNum}.md`;
      currentContent += `\n@${linkPrefix}${nextFilename}\n`;
      files.push({
        filename: fileNum === 1 ? `${baseFilename}.md` : `${baseFilename}-${fileNum}.md`,
        content: currentContent,
      });

      // ── Start new file ──
      fileNum = nextFileNum;
      currentContent = continuationHeader;
      fileSectionActive = '';
      fileSections = new Set();

      // Re-compute addition for the new file (section header may be "continued" now)
      addition = '';
      if (block.section) {
        const continued = sectionsInPreviousFiles.has(block.section);
        addition += `\n## ${block.section}${continued ? ' (continued)' : ''}\n`;
        fileSectionActive = block.section;
        fileSections.add(block.section);
        sectionsInPreviousFiles.add(block.section);
      }
      addition += block.content;

      currentContent += addition;
    } else {
      // ── Fits in current file ──
      if (needsHeader && block.section) {
        fileSectionActive = block.section;
      }
      if (block.section) fileSections.add(block.section);
      currentContent += addition;
    }
  }

  // Push final file
  files.push({
    filename: fileNum === 1 ? `${baseFilename}.md` : `${baseFilename}-${fileNum}.md`,
    content: currentContent,
  });

  return files;
}

/**
 * Remove overflow files (e.g. KF-PROJECT-KNOWLEDGE-3.md) that are no longer needed.
 * Returns full paths of deleted files.
 */
export function cleanupOverflowFiles(
  location: string,
  baseFilename: string,
  currentFilenames: Set<string>,
): string[] {
  const removed: string[] = [];
  const escaped = baseFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-\\d+\\.md$`);

  try {
    for (const entry of readdirSync(location)) {
      if (pattern.test(entry) && !currentFilenames.has(entry)) {
        const fullPath = join(location, entry);
        unlinkSync(fullPath);
        removed.push(fullPath);
      }
    }
  } catch {
    // Directory read errors are non-fatal
  }

  return removed;
}

// ── Knowledge-specific helpers ──────────────────────────────────────

const KNOWLEDGE_FILE = 'KF-PROJECT-KNOWLEDGE.md';
const KNOWLEDGE_BASE = 'KF-PROJECT-KNOWLEDGE';
const IMPORT_LINE = `@./${KNOWLEDGE_FILE}`;

function normalizeContent(s: string): string {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Format knowledge data into one or more markdown files.
 * Splits across numbered files when content exceeds FILE_SPLIT_THRESHOLD.
 */
export function buildKnowledgeFiles(knowledge: KnowledgeData, projectHandle: string): FileChunk[] {
  const preamble =
    `# Project Knowledge: ${projectHandle}\n` +
    '\n' +
    '> Auto-generated from khef memories. Do not edit — changes will be overwritten on next sync.\n' +
    (() => {
      const cmds = knowledge.commands.filter(c => c.content.trim());
      return cmds.length > 0
        ? `\n## Commands\n\n${cmds.map(c => c.content.trim()).join('\n\n')}\n`
        : '';
    })();

  const continuationHeader =
    `# Project Knowledge: ${projectHandle} (continued)\n` +
    '\n' +
    '> Auto-generated from khef memories. Do not edit — changes will be overwritten on next sync.\n';

  // Sort context and pattern entries alphabetically
  const sortedContext = [...knowledge.context]
    .filter((c) => c.content.trim())
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const sortedPatterns = [...knowledge.patterns]
    .filter((p) => p.content.trim())
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const blocks: ContentBlock[] = [
    ...sortedContext.map((c) => ({
      section: 'Context',
      content: `\n### ${c.title}\n\n${c.content.trim()}\n`,
    })),
    ...sortedPatterns.map((p) => ({
      section: 'Patterns',
      content: `\n### ${p.title}\n\n${p.content.trim()}\n`,
    })),
  ];

  return splitContentIntoFiles(preamble, blocks, KNOWLEDGE_BASE, continuationHeader);
}

/**
 * Single-string builder for backward compatibility.
 * Returns only the root file content.
 */
export function buildKnowledgeMarkdown(knowledge: KnowledgeData, projectHandle: string): string {
  return buildKnowledgeFiles(knowledge, projectHandle)[0].content;
}

/**
 * Ensure a markdown file contains the given import line.
 * Returns true if the file was modified.
 */
function ensureImportInFile(filePath: string, importLine: string): boolean {
  let content = '';
  const existed = existsSync(filePath);

  if (existed) {
    content = readFileSync(filePath, 'utf8');
    if (content.includes(importLine)) {
      return false;
    }
  }

  if (content && !content.endsWith('\n')) content += '\n';
  if (content && !/\n\n$/.test(content)) content += '\n';
  content += `${importLine}\n`;

  writeFileSync(filePath, content, 'utf8');
  return true;
}

/**
 * Sync project knowledge to disk:
 * 1. Write KF-PROJECT-KNOWLEDGE.md (and overflow files if needed)
 * 2. Clean up stale overflow files
 * 3. Ensure CLAUDE.local.md imports the root file
 */
export function syncProjectKnowledge(
  knowledge: KnowledgeData,
  location: string,
  projectHandle: string
): KnowledgeSyncResultItem[] {
  const results: KnowledgeSyncResultItem[] = [];
  const localMdPath = join(location, 'CLAUDE.local.md');

  const files = buildKnowledgeFiles(knowledge, projectHandle);

  // Write each file
  for (const file of files) {
    const filePath = join(location, file.filename);

    if (existsSync(filePath)) {
      const current = readFileSync(filePath, 'utf8');
      if (normalizeContent(current) === normalizeContent(file.content)) {
        results.push({ target: filePath, action: 'unchanged' });
      } else {
        writeFileSync(filePath, file.content, 'utf8');
        results.push({ target: filePath, action: 'updated' });
      }
    } else {
      writeFileSync(filePath, file.content, 'utf8');
      results.push({ target: filePath, action: 'created' });
    }
  }

  // Clean up stale overflow files
  const currentFilenames = new Set(files.map(f => f.filename));
  const removed = cleanupOverflowFiles(location, KNOWLEDGE_BASE, currentFilenames);
  for (const removedPath of removed) {
    results.push({ target: removedPath, action: 'removed' });
  }

  // Ensure CLAUDE.local.md has import (only root file — chaining handles the rest)
  const localMdExisted = existsSync(localMdPath);
  const importChanged = ensureImportInFile(localMdPath, IMPORT_LINE);
  if (importChanged) {
    results.push({
      target: localMdPath,
      action: localMdExisted ? 'updated' : 'created',
    });
  }

  return results;
}

// ── User-level knowledge sync ────────────────────────────────────────

const USER_KNOWLEDGE_BASE = 'KF-USER-KNOWLEDGE';
const USER_KNOWLEDGE_FILE = `${USER_KNOWLEDGE_BASE}.md`;
const USER_KNOWLEDGE_IMPORT = `@~/.claude/${USER_KNOWLEDGE_FILE}`;

/**
 * Format user knowledge into one or more markdown files.
 * Uses "User Knowledge" header instead of project-specific naming.
 */
export function buildUserKnowledgeFiles(knowledge: KnowledgeData): FileChunk[] {
  const preamble =
    '# User Knowledge\n' +
    '\n' +
    '> Auto-generated from khef user project memories. Do not edit — changes will be overwritten on next sync.\n' +
    (() => {
      const cmds = knowledge.commands.filter(c => c.content.trim());
      return cmds.length > 0
        ? `\n## Commands\n\n${cmds.map(c => c.content.trim()).join('\n\n')}\n`
        : '';
    })();

  const continuationHeader =
    '# User Knowledge (continued)\n' +
    '\n' +
    '> Auto-generated from khef user project memories. Do not edit — changes will be overwritten on next sync.\n';

  const sortedContext = [...knowledge.context]
    .filter((c) => c.content.trim())
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const sortedPatterns = [...knowledge.patterns]
    .filter((p) => p.content.trim())
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const blocks: ContentBlock[] = [
    ...sortedContext.map((c) => ({
      section: 'Context',
      content: `\n### ${c.title}\n\n${c.content.trim()}\n`,
    })),
    ...sortedPatterns.map((p) => ({
      section: 'Patterns',
      content: `\n### ${p.title}\n\n${p.content.trim()}\n`,
    })),
  ];

  return splitContentIntoFiles(preamble, blocks, USER_KNOWLEDGE_BASE, continuationHeader, undefined, '~/.claude/');
}

/**
 * Sync user knowledge to ~/.claude/:
 * 1. Write KF-USER-KNOWLEDGE.md (and overflow files if needed)
 * 2. Clean up stale overflow files
 * 3. Ensure ~/.claude/CLAUDE.md imports the root file
 */
export function syncUserKnowledge(knowledge: KnowledgeData): KnowledgeSyncResultItem[] {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const claudeMain = join(claudeDir, 'CLAUDE.md');
  const results: KnowledgeSyncResultItem[] = [];

  if (!existsSync(claudeDir)) return results;

  const files = buildUserKnowledgeFiles(knowledge);

  // Write each file
  for (const file of files) {
    const filePath = join(claudeDir, file.filename);

    if (existsSync(filePath)) {
      const current = readFileSync(filePath, 'utf8');
      if (normalizeContent(current) === normalizeContent(file.content)) {
        results.push({ target: filePath, action: 'unchanged' });
      } else {
        writeFileSync(filePath, file.content, 'utf8');
        results.push({ target: filePath, action: 'updated' });
      }
    } else {
      writeFileSync(filePath, file.content, 'utf8');
      results.push({ target: filePath, action: 'created' });
    }
  }

  // Clean up stale overflow files
  const currentFilenames = new Set(files.map(f => f.filename));
  const removed = cleanupOverflowFiles(claudeDir, USER_KNOWLEDGE_BASE, currentFilenames);
  for (const removedPath of removed) {
    results.push({ target: removedPath, action: 'removed' });
  }

  // Ensure CLAUDE.md imports KF-USER-KNOWLEDGE.md
  const claudeMainExisted = existsSync(claudeMain);
  const importChanged = ensureImportInFile(claudeMain, USER_KNOWLEDGE_IMPORT);
  if (importChanged) {
    results.push({
      target: claudeMain,
      action: claudeMainExisted ? 'updated' : 'created',
    });
  }

  return results;
}

// ── Glossary sync ─────────────────────────────────────────────────────

const GLOSSARY_FILE = 'KF-GLOSSARY.md';
const GLOSSARY_IMPORT_USER = `@~/.claude/${GLOSSARY_FILE}`;
const GLOSSARY_IMPORT_PROJECT = `@./${GLOSSARY_FILE}`;

const USER_GLOSSARY_TEMPLATE = `# User Glossary

> Terms, abbreviations, and shorthand that Claude should understand across all projects.
> Edit this file directly — it syncs to the khef config database automatically.

## Terms

<!-- Add glossary entries below. Example:
### sss
Search source code — shorthand for \`search_source_code\` MCP tool.
-->
`;

/**
 * Sync user glossary to ~/.claude/:
 * 1. Create KF-GLOSSARY.md with template if it doesn't exist
 * 2. Ensure ~/.claude/CLAUDE.md imports the file
 */
export function syncUserGlossary(): KnowledgeSyncResultItem[] {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const claudeMain = join(claudeDir, 'CLAUDE.md');
  const glossaryPath = join(claudeDir, GLOSSARY_FILE);
  const results: KnowledgeSyncResultItem[] = [];

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Create glossary file with template if it doesn't exist
  if (!existsSync(glossaryPath)) {
    writeFileSync(glossaryPath, USER_GLOSSARY_TEMPLATE, 'utf8');
    results.push({ target: glossaryPath, action: 'created' });
  } else {
    results.push({ target: glossaryPath, action: 'unchanged' });
  }

  // Ensure CLAUDE.md imports KF-GLOSSARY.md
  const claudeMainExisted = existsSync(claudeMain);
  const glossaryImportChanged = ensureImportInFile(claudeMain, GLOSSARY_IMPORT_USER);
  if (glossaryImportChanged) {
    results.push({
      target: claudeMain,
      action: claudeMainExisted ? 'updated' : 'created',
    });
  }

  return results;
}

/**
 * Sync project glossary:
 * If KF-GLOSSARY.md exists in the project dir, ensure CLAUDE.local.md imports it.
 * Project glossaries are opt-in — if the file doesn't exist, skip.
 */
export function syncProjectGlossary(location: string): KnowledgeSyncResultItem[] {
  const glossaryPath = join(location, GLOSSARY_FILE);
  const localMdPath = join(location, 'CLAUDE.local.md');
  const results: KnowledgeSyncResultItem[] = [];

  if (!existsSync(glossaryPath)) {
    return results;
  }

  // Glossary file exists — ensure CLAUDE.local.md imports it
  const localMdExisted = existsSync(localMdPath);
  const glossaryImportChanged = ensureImportInFile(localMdPath, GLOSSARY_IMPORT_PROJECT);
  if (glossaryImportChanged) {
    results.push({
      target: localMdPath,
      action: localMdExisted ? 'updated' : 'created',
    });
  }

  return results;
}
