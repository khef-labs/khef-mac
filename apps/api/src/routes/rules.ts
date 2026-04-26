import { FastifyPluginAsync } from 'fastify';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { query, querySingle } from '../db/client';
import {
  syncProjectRules,
  syncUserRules,
  RuleMemory,
  SyncResultItem,
} from '../services/rules-sync';

/**
 * Expand tilde to home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return homedir() + path.slice(1);
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

interface ProjectRow {
  id: string;
  handle: string;
  name: string;
  path: string | null;
}

interface MemoryRow {
  id: string;
  title: string;
  content: string;
}

interface SyncBody {
  location?: string;
}

interface SyncParams {
  projectHandle: string;
}

const rulesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/rules/sync/project/:projectHandle
   * Sync assistant-rule memories to config files
   *
   * For regular projects: requires `location` in request body (target directory)
   * For "user" project: syncs to ~/.claude/ and ~/.codex/
   *
   * Response:
   * {
   *   status: "success",
   *   project: "khef",
   *   results: [
   *     { agent: "claude", target: "/path/to/CLAUDE.local.md", action: "updated" }
   *   ]
   * }
   */
  fastify.post<{ Params: SyncParams; Body: SyncBody }>(
    '/sync/project/:projectHandle',
    async (request, reply) => {
      const { projectHandle } = request.params;
      const { location } = request.body || {};

      // Look up project by handle
      const project = await querySingle<ProjectRow>(
        `SELECT id, handle, name, path FROM projects WHERE handle = $1`,
        [projectHandle]
      );

      if (!project) {
        return reply.status(404).send({
          error: 'Project not found',
          message: `No project with handle "${projectHandle}" exists`,
        });
      }

      // Fetch active assistant-rule memories for the project
      // Only includes rules with status = 'active' (excludes deprecated)
      // Note: array_agg returns {NULL} on LEFT JOIN with no matches, so we use
      // array_remove to strip NULLs before checking length
      const memories = await query<MemoryRow>(
        `SELECT m.id, m.title,
                CASE WHEN array_length(array_remove(array_agg(mc.content ORDER BY mc.chunk_index), NULL), 1) > 0
                     THEN array_to_string(array_agg(mc.content ORDER BY mc.chunk_index), '')
                     ELSE m.content
                END AS content
         FROM memories m
         LEFT JOIN memory_chunks mc ON mc.memory_id = m.id
         JOIN memory_types mt ON mt.id = m.memory_type_id
         JOIN memory_type_statuses mts ON m.status_id = mts.id
         WHERE m.project_id = $1 AND mt.name = 'assistant-rule' AND mts.status_value NOT IN ('deprecated', 'inactive')
         GROUP BY m.id, m.title, m.content`,
        [project.id]
      );

      const rules: RuleMemory[] = memories.map((m) => ({
        title: m.title,
        content: m.content || '',
      }));

      let results: SyncResultItem[];

      if (projectHandle === 'user') {
        // User project: sync to home directories
        results = syncUserRules(rules);
      } else {
        // Regular project: use location from request or project.path
        const targetPath = location || project.path;
        if (!targetPath) {
          return reply.status(400).send({
            error: 'Location required',
            message:
              'No project path configured. Either provide "location" in the request body or set the project path via PATCH /api/projects/:id.',
          });
        }

        // Expand tilde and validate path exists
        const expandedLocation = expandTilde(targetPath);
        if (!existsSync(expandedLocation)) {
          return reply.status(400).send({
            error: 'Invalid location',
            message: `Directory does not exist: ${targetPath}${targetPath !== expandedLocation ? ` (expanded to ${expandedLocation})` : ''}`,
          });
        }

        results = syncProjectRules(rules, expandedLocation, projectHandle);
      }

      return {
        status: 'success',
        project: projectHandle,
        rulesCount: rules.length,
        results,
      };
    }
  );
};

export default rulesRoutes;
