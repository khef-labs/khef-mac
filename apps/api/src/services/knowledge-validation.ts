import { query } from '../db/client';
import { FILE_SPLIT_THRESHOLD } from './knowledge-sync';

/**
 * Estimated markdown overhead per entry in the output files.
 * These account for headers, blank lines, and structural formatting.
 */
const KNOWLEDGE_HEADER_OVERHEAD = 120; // "# Project Knowledge: ...\n\n> Auto-generated...\n"
const COMMANDS_SECTION_OVERHEAD = 15;  // "## Commands\n\n"
const CONTEXT_ENTRY_OVERHEAD = 10;     // "### {title}\n\n" (title length varies)
const PATTERN_ENTRY_OVERHEAD = 10;     // "### {title}\n\n" (title length varies)
const CONTEXT_SECTION_OVERHEAD = 15;   // "## Context\n"
const PATTERN_SECTION_OVERHEAD = 15;   // "## Patterns\n"

const RULES_HEADER_OVERHEAD = 150;     // "## Developer Memory...\n\nThese rules come from...\n\n"
const RULE_ENTRY_OVERHEAD = 20;        // "### Rule N: {title}\n\n" (title length varies)

export interface SizeInfo {
  content_size: number;
  estimated_output_size: number;
  /** Per-file split threshold (content may span multiple files beyond this) */
  split_threshold: number;
  /** Number of files the output would span */
  estimated_file_count: number;
}

interface KnowledgeMemoryRow {
  id: string;
  handle: string;
  title: string;
  content: string;
  type_name: string;
}

interface RuleMemoryRow {
  id: string;
  title: string;
  content: string;
}

/**
 * Calculate the current aggregate size of knowledge memories for a project.
 * Returns the estimated total size and how many files it would span.
 * Only counts non-deprecated memories (deprecated ones are excluded from sync).
 */
export async function getKnowledgeAggregateSize(projectId: string): Promise<SizeInfo> {
  const rows = await query<KnowledgeMemoryRow>(
    `SELECT m.id, m.handle, m.title, m.content, mt.name as type_name
     FROM memories m
     JOIN memory_types mt ON m.memory_type_id = mt.id
     JOIN memory_type_statuses mts ON m.status_id = mts.id
     WHERE m.project_id = $1
       AND (mt.name IN ('commands', 'context', 'pattern')
            OR mt.parent_id = (SELECT id FROM memory_types WHERE name = 'knowledge'))
       AND mts.status_value NOT IN ('deprecated', 'inactive')`,
    [projectId]
  );

  let contentSize = 0;
  let outputSize = KNOWLEDGE_HEADER_OVERHEAD;

  let hasCommands = false;
  let hasContext = false;
  let hasPatterns = false;

  for (const row of rows) {
    const trimmedContent = (row.content || '').trim();
    contentSize += trimmedContent.length;

    if (row.type_name === 'commands' || row.handle === 'project-commands') {
      if (trimmedContent) {
        hasCommands = true;
        outputSize += COMMANDS_SECTION_OVERHEAD + trimmedContent.length;
      }
    } else if (row.type_name === 'context' || row.handle.startsWith('ctx-')) {
      if (trimmedContent) {
        hasContext = true;
        outputSize += CONTEXT_ENTRY_OVERHEAD + row.title.length + trimmedContent.length;
      }
    } else if (row.type_name === 'pattern' || row.handle.startsWith('pattern-')) {
      if (trimmedContent) {
        hasPatterns = true;
        outputSize += PATTERN_ENTRY_OVERHEAD + row.title.length + trimmedContent.length;
      }
    }
  }

  if (hasContext) outputSize += CONTEXT_SECTION_OVERHEAD;
  if (hasPatterns) outputSize += PATTERN_SECTION_OVERHEAD;

  return {
    content_size: contentSize,
    estimated_output_size: outputSize,
    split_threshold: FILE_SPLIT_THRESHOLD,
    estimated_file_count: Math.max(1, Math.ceil(outputSize / FILE_SPLIT_THRESHOLD)),
  };
}

/**
 * Calculate the current aggregate size of assistant-rule memories for a project.
 * Returns the estimated total size and how many files it would span.
 * Only counts active rules (deprecated ones are excluded from sync).
 */
export async function getRulesAggregateSize(projectId: string): Promise<SizeInfo> {
  const rows = await query<RuleMemoryRow>(
    `SELECT m.id, m.title, m.content
     FROM memories m
     JOIN memory_types mt ON m.memory_type_id = mt.id
     JOIN memory_type_statuses mts ON m.status_id = mts.id
     WHERE m.project_id = $1 AND mt.name = 'assistant-rule' AND mts.status_value NOT IN ('deprecated', 'inactive')`,
    [projectId]
  );

  let contentSize = 0;
  let outputSize = rows.length > 0 ? RULES_HEADER_OVERHEAD : 0;

  for (const row of rows) {
    const trimmedContent = (row.content || '').trim();
    contentSize += trimmedContent.length;
    outputSize += RULE_ENTRY_OVERHEAD + row.title.length + trimmedContent.length;
  }

  return {
    content_size: contentSize,
    estimated_output_size: outputSize,
    split_threshold: FILE_SPLIT_THRESHOLD,
    estimated_file_count: Math.max(1, Math.ceil(outputSize / FILE_SPLIT_THRESHOLD)),
  };
}
