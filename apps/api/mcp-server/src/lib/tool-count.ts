/**
 * Count MCP tool definitions across tool module files.
 *
 * Scans src/tools/*.ts for tool name entries inside exported `tools: Tool[]`
 * arrays. Run directly with: npx tsx mcp-server/src/lib/tool-count.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "..", "tools");

function countToolsInFile(filePath: string): string[] {
  const source = readFileSync(filePath, "utf-8");
  const lines = source.split("\n");
  const names: string[] = [];

  let inToolsArray = false;
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Detect start of tools array
    if (!inToolsArray && /^export\s+const\s+tools:\s*Tool\[\]\s*=\s*\[/.test(trimmed)) {
      inToolsArray = true;
      braceDepth = 0;
      continue;
    }

    if (!inToolsArray) continue;

    // Track brace depth to know when we're at the top-level tool object
    for (const ch of line) {
      if (ch === "[" || ch === "{") braceDepth++;
      if (ch === "]" || ch === "}") braceDepth--;
    }

    // Tool name entries
    const nameMatch = trimmed.match(/^name:\s*"([^"]+)"/);
    if (nameMatch) {
      names.push(nameMatch[1]);
    }

    // End of tools array
    if (braceDepth <= 0 && trimmed === "];") break;
  }

  return names;
}

export function countTools(toolsDir: string = TOOLS_DIR): {
  count: number;
  names: string[];
  byModule: Record<string, string[]>;
} {
  const files = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  const byModule: Record<string, string[]> = {};
  const allNames: string[] = [];

  for (const file of files) {
    const names = countToolsInFile(join(toolsDir, file));
    const moduleName = file.replace(".ts", "");
    byModule[moduleName] = names;
    allNames.push(...names);
  }

  return { count: allNames.length, names: allNames, byModule };
}

// Run directly
if (process.argv[1] && process.argv[1].includes("tool-count")) {
  const { count, names, byModule } = countTools();
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  if (verbose) {
    for (const [mod, modNames] of Object.entries(byModule)) {
      console.log(`\n  ${mod} (${modNames.length}):`);
      for (const name of modNames) {
        console.log(`    ${name}`);
      }
    }
    console.log();
  }

  console.log(`Total MCP tools: ${count}`);
}
