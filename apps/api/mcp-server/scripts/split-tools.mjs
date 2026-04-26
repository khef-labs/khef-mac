/**
 * Extract tool definitions and case handlers from the monolithic index.ts
 * and generate separate tool module files under src/tools/.
 *
 * Usage: node scripts/split-tools.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");
// Use original index.ts from git (before refactoring)
const INDEX = process.argv[2] || join(SRC, "index.ts");
const TOOLS_DIR = join(SRC, "tools");

// Module groupings: module name → list of tool names
const MODULES = {
  projects: [
    "list_projects", "create_project", "update_project", "get_project",
    "initialize_session",
  ],
  memories: [
    "search_memories", "search_content", "search_tags",
    "create_memory", "update_memory", "append_memory", "delete_memory",
    "get_memory_by_id",
  ],
  relations: [
    "create_relation", "suggest_relations", "get_memory_graph", "get_graph_health",
  ],
  tags: [
    "list_tags", "get_tag_memories", "create_tag", "rename_tag", "delete_tag",
  ],
  status: [
    "get_memory_type_statuses", "get_project_memory_types",
    "get_project_memory_type_statuses", "get_memory_status", "update_memory_status",
  ],
  knowledge: [
    "get_project_knowledge", "set_project_commands", "set_project_context",
    "set_project_pattern", "delete_project_context", "delete_project_pattern",
    "sync_project_knowledge", "get_agent_rules",
  ],
  agents: [
    "get_user_agents", "get_project_agents", "get_user_agent", "get_project_agent",
    "create_user_agent", "create_project_agent", "update_user_agent",
    "update_project_agent", "delete_user_agent", "delete_project_agent",
  ],
  comments: [
    "list_comments", "create_comment", "update_comment", "delete_comment",
    "delete_comments", "get_comment_by_id",
  ],
  sessions: [
    "list_session_projects", "list_sessions", "read_session", "delete_session",
    "bulk_delete_sessions", "sync_session_embeddings", "get_session_embedding_status",
    "search_sessions", "list_synced_sessions", "get_synced_session",
    "trigger_session_sync", "get_session_by_id",
  ],
  plans: ["get_plan_by_id", "get_plan_by_name"],
  sections: ["get_memory_outline", "get_memory_section", "update_memory_section"],
  diffs: [
    "get_commits", "get_diff", "annotate_commit", "get_commit_comments",
    "get_diff_comments",
  ],
  "memory-types": [
    "list_memory_types", "get_memory_type", "create_memory_type",
    "update_memory_type", "delete_memory_type",
  ],
  kdag: [
    "list_job_definitions", "get_job_definition", "create_job_definition",
    "update_job_definition", "delete_job_definition",
    "create_kdag_job", "run_kdag_job", "get_kdag_job", "list_kdag_jobs",
  ],
  prompts: [
    "list_prompts", "get_prompt", "create_prompt", "update_prompt", "delete_prompt",
  ],
  "assistant-chat": [
    "assistant_chat", "list_assistant_chats", "get_assistant_chat",
    "delete_assistant_chat",
  ],
  export: [
    "export_memory", "bulk_export_memories", "sync_builtin_commands", "get_stats",
  ],
  db: [
    "query_khef", "query_kvec", "query_kdag", "list_tables", "describe_table",
  ],
  "active-sessions": ["list_active_sessions", "get_current_session"],
  "source-code": ["search_source_code", "get_session_summary"],
};

const source = readFileSync(INDEX, "utf-8");
const lines = source.split("\n");

// ── Extract tool definitions ───────────────────────────────────────────

function extractToolDefs() {
  const toolDefs = new Map(); // toolName → string (the full tool definition object)

  // Find the start of `const tools: Tool[] = [`
  let startIdx = lines.findIndex((l) =>
    /^const tools:\s*Tool\[\]\s*=\s*\[/.test(l.trimStart())
  );
  if (startIdx === -1) throw new Error("Could not find tools array");
  startIdx++;

  let i = startIdx;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    // End of tools array
    if (trimmed === "];") break;

    // Start of a tool object: `{`
    if (trimmed === "{") {
      const objStart = i;
      let depth = 0;
      // Find the matching closing brace
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
        }
        if (depth === 0) {
          // Extract the tool name
          const block = lines.slice(objStart, j + 1).join("\n");
          const nameMatch = block.match(/name:\s*"([^"]+)"/);
          if (nameMatch) {
            // Normalize indentation: remove leading 2 spaces from each line
            const normalized = lines
              .slice(objStart, j + 1)
              .map((l) => l.startsWith("  ") ? l.slice(2) : l)
              .join("\n");
            toolDefs.set(nameMatch[1], normalized);
          }
          i = j + 1;
          break;
        }
      }
    } else {
      i++;
    }
  }

  return toolDefs;
}

// ── Extract case handlers ──────────────────────────────────────────────

function extractCaseHandlers() {
  const handlers = new Map(); // toolName → string (the case block body)

  // Find `switch (name) {`
  const switchIdx = lines.findIndex((l) => /switch\s*\(name\)\s*\{/.test(l));
  if (switchIdx === -1) throw new Error("Could not find switch statement");

  let i = switchIdx + 1;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();

    // Match `case "tool_name": {`
    const caseMatch = trimmed.match(/^case\s+"([^"]+)":\s*\{/);
    if (caseMatch) {
      const toolName = caseMatch[1];
      const caseStart = i;
      // Find the matching closing brace for this case block
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
        }
        if (depth === 0) {
          // Extract case body (between the opening { and closing })
          // We want the inner content, excluding the case line and closing brace
          const innerLines = lines.slice(caseStart + 1, j);
          const body = innerLines
            .map((l) => {
              // Remove 8 spaces of indentation (typical switch > case > body)
              if (l.startsWith("        ")) return l.slice(8);
              if (l.startsWith("      ")) return l.slice(6);
              return l;
            })
            .join("\n")
            .trim();
          handlers.set(toolName, body);
          i = j + 1;
          break;
        }
      }
    } else if (trimmed === "default:") {
      break;
    } else {
      i++;
    }
  }

  return handlers;
}

// ── Generate module files ──────────────────────────────────────────────

function usesDbClient(toolNames) {
  return toolNames.some((n) =>
    ["query_khef", "query_kvec", "query_kdag", "list_tables", "describe_table"].includes(n)
  );
}

function generateModule(moduleName, toolNames, toolDefs, handlers) {
  const usesDb = usesDbClient(toolNames);

  const imports = [
    `import { Tool } from "@modelcontextprotocol/sdk/types.js";`,
    `import type { KhefClient } from "../clients/khef-client.js";`,
    `import type { DbClient } from "../clients/db-client.js";`,
    `import type { ToolResult } from "../types.js";`,
  ];

  // Collect tool definitions
  const defs = toolNames
    .filter((n) => toolDefs.has(n))
    .map((n) => toolDefs.get(n));

  // All handlers have a uniform 4-parameter signature
  // Modules that use dbClient get it without underscore prefix
  const dbParamName = usesDb ? "dbClient" : "_dbClient";
  const handlerParams = `name: string, args: Record<string, unknown>, client: KhefClient, ${dbParamName}: DbClient`;

  const cases = toolNames
    .filter((n) => handlers.has(n))
    .map((n) => {
      const body = handlers.get(n);
      // Re-indent the body for inside the case
      const indented = body
        .split("\n")
        .map((l) => (l ? `      ${l}` : l))
        .join("\n");
      return `    case "${n}": {\n${indented}\n    }`;
    });

  const content = `${imports.join("\n")}

export const tools: Tool[] = [
${defs.map((d) => `  ${d}`).join("\n\n")}
];

export async function handleTool(
  ${handlerParams}
): Promise<ToolResult | null> {
  switch (name) {
${cases.join("\n\n")}

    default:
      return null;
  }
}
`;

  return content;
}

// ── Main ───────────────────────────────────────────────────────────────

const toolDefs = extractToolDefs();
const handlers = extractCaseHandlers();

console.log(`Extracted ${toolDefs.size} tool definitions`);
console.log(`Extracted ${handlers.size} case handlers`);

// Verify all tools are accounted for
const allMapped = new Set(Object.values(MODULES).flat());
const unmapped = [...toolDefs.keys()].filter((n) => !allMapped.has(n));
if (unmapped.length > 0) {
  console.warn(`\nWARNING: ${unmapped.length} unmapped tool(s):`);
  unmapped.forEach((n) => console.warn(`  - ${n}`));
}

const missingDefs = [...allMapped].filter((n) => !toolDefs.has(n));
if (missingDefs.length > 0) {
  console.warn(`\nWARNING: ${missingDefs.length} tool(s) in mapping but not found in definitions:`);
  missingDefs.forEach((n) => console.warn(`  - ${n}`));
}

const missingHandlers = [...allMapped].filter((n) => !handlers.has(n));
if (missingHandlers.length > 0) {
  console.warn(`\nWARNING: ${missingHandlers.length} tool(s) in mapping but not found in handlers:`);
  missingHandlers.forEach((n) => console.warn(`  - ${n}`));
}

mkdirSync(TOOLS_DIR, { recursive: true });

for (const [moduleName, toolNames] of Object.entries(MODULES)) {
  const content = generateModule(moduleName, toolNames, toolDefs, handlers);
  const outPath = join(TOOLS_DIR, `${moduleName}.ts`);
  writeFileSync(outPath, content);
  console.log(`  wrote ${moduleName}.ts (${toolNames.length} tools)`);
}

console.log(`\nDone! Generated ${Object.keys(MODULES).length} tool modules in src/tools/`);
