import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KhefClient } from "../clients/khef-client.js";
import type { DbClient } from "../clients/db-client.js";
import type { ToolResult } from "../types.js";
import { formatPlan, formatPlanSearchResults, formatPlanContentSearch, type PlanContentMatch } from "../formatters/plans.js";

export const tools: Tool[] = [
  {
  name: "get_plan_by_id",
  description:
    "Get a plan by its UUID with all its comments. Use this to fetch a plan directly by ID rather than through the assistant/filename path.",
  inputSchema: {
    type: "object",
    properties: {
      plan_id: {
        type: "string",
        description: "Plan UUID",
      },
    },
    required: ["plan_id"],
  },
},

  {
  name: "get_plan_by_name",
  description:
    "Get a plan by its filename. Returns the most recent snapshot (current version) with title, content, version info, and status.",
  inputSchema: {
    type: "object",
    properties: {
      assistant_handle: {
        type: "string",
        description: "Assistant handle (e.g., 'claude-code')",
      },
      filename: {
        type: "string",
        description:
          "Plan filename (e.g., 'elegant-snacking-snowflake.md')",
      },
    },
    required: ["assistant_handle", "filename"],
  },
},

  {
  name: "search_plans",
  description:
    "Search across all plans by title or content. Returns matching plans with metadata (no full content). Use get_plan_by_id to fetch full content of a result.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Search query (matches against title and content)",
      },
      project_id: {
        type: "string",
        description: "Filter to a specific project (handle, name, or UUID)",
      },
      status: {
        type: "string",
        description: "Filter by plan status (active, archived, completed, abandoned)",
      },
      limit: {
        type: "number",
        description: "Max results (default: 10)",
      },
    },
    required: ["q"],
  },
},

  {
  name: "search_plan",
  description:
    "Search within a specific plan's content. Returns matching excerpts grouped by section with surrounding context.",
  inputSchema: {
    type: "object",
    properties: {
      plan_id: {
        type: "string",
        description: "Plan UUID",
      },
      q: {
        type: "string",
        description: "Search query to find within the plan",
      },
    },
    required: ["plan_id", "q"],
  },
},
];

export async function handleTool(
  name: string, args: Record<string, unknown>, client: KhefClient, dbClient: DbClient
): Promise<ToolResult | null> {
  switch (name) {
    case "get_plan_by_id": {
      const fmt = (args.format as string) || "text";
      const result = await client.getPlanById(args.plan_id as string);
      return {
        content: [{ type: "text", text: fmt === "text" ? formatPlan(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "get_plan_by_name": {
      const fmt = (args.format as string) || "text";
      const assistantHandle =
        (args.assistant_handle as string) || "claude-code";
      const result = await client.getPlanByName(
        assistantHandle,
        args.filename as string
      );
      return {
        content: [{ type: "text", text: fmt === "text" ? formatPlan(result) : JSON.stringify(result, null, 2) }],
      };
    }

    case "search_plans": {
      const q = args.q as string;
      const limit = Math.min((args.limit as number) || 10, 50);
      const pattern = `%${q}%`;

      const conditions = ["(pv.title ILIKE $1 OR pv.content ILIKE $1)"];
      const params: unknown[] = [pattern];
      let idx = 2;

      if (args.project_id) {
        conditions.push(`(proj.handle = $${idx} OR proj.name ILIKE $${idx} OR p.project_id::text = $${idx})`);
        params.push(args.project_id as string);
        idx++;
      }
      if (args.status) {
        conditions.push(`p.status = $${idx}`);
        params.push(args.status as string);
        idx++;
      }

      params.push(limit);

      const sql = `SELECT p.id, p.filename, pv.title, p.status, p.project_id,
                          proj.name as project_name, p.current_version, pv.size, p.updated_at
                   FROM plans p
                   JOIN plan_versions pv ON pv.plan_id = p.id AND pv.version = p.current_version
                   LEFT JOIN projects proj ON proj.id = p.project_id
                   WHERE ${conditions.join(" AND ")}
                   ORDER BY p.updated_at DESC
                   LIMIT $${idx}`;

      const result = await dbClient.queryKhef(sql, params, limit) as { rows: any[] };
      return {
        content: [{ type: "text", text: formatPlanSearchResults(result.rows) }],
      };
    }

    case "search_plan": {
      const planId = args.plan_id as string;
      const q = args.q as string;
      const data = await client.getPlanById(planId);
      const plan = data.plan || data;

      if (!plan || !plan.content) {
        return {
          content: [{ type: "text", text: `Plan ${planId} not found or has no content.` }],
        };
      }

      const matches = searchPlanContent(plan.content, q);
      return {
        content: [{
          type: "text",
          text: formatPlanContentSearch(
            { id: plan.id, title: plan.title, filename: plan.filename },
            q,
            matches
          ),
        }],
      };
    }

    default:
      return null;
  }
}

// ── In-memory plan content search ────────────────────────────────────

interface SectionRange {
  heading: string;
  level: number;
  start: number;
  end: number;
}

function parseSections(content: string): SectionRange[] {
  const sections: SectionRange[] = [];
  const lines = content.split('\n');
  let offset = 0;

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      if (sections.length > 0) {
        sections[sections.length - 1].end = offset;
      }
      sections.push({
        heading: match[2].trim(),
        level: match[1].length,
        start: offset,
        end: content.length,
      });
    }
    offset += line.length + 1;
  }

  if (sections.length === 0) {
    sections.push({ heading: 'Document', level: 1, start: 0, end: content.length });
  }

  return sections;
}

function searchPlanContent(content: string, query: string): PlanContentMatch[] {
  const lower = content.toLowerCase();
  const lowerQ = query.toLowerCase();
  const sections = parseSections(content);
  const CONTEXT = 100;

  const sectionMap = new Map<string, string[]>();

  let pos = 0;
  while (true) {
    const idx = lower.indexOf(lowerQ, pos);
    if (idx === -1) break;

    const excerptStart = Math.max(0, idx - CONTEXT);
    const excerptEnd = Math.min(content.length, idx + lowerQ.length + CONTEXT);
    const excerpt = content.substring(excerptStart, excerptEnd).replace(/\n/g, ' ');

    // Find which section this match belongs to
    let section = sections[0];
    for (const s of sections) {
      if (s.start <= idx) section = s;
      else break;
    }

    const key = section.heading;
    const existing = sectionMap.get(key) ?? [];
    existing.push(excerpt);
    sectionMap.set(key, existing);

    pos = idx + lowerQ.length;
  }

  const results: PlanContentMatch[] = [];
  for (const [heading, excerpts] of sectionMap) {
    results.push({ section: heading, excerpts });
  }
  return results;
}
