/**
 * Git operations routes (read-only).
 * Provides commit history and diff generation for projects.
 */
import { FastifyPluginAsync } from 'fastify';
import { query } from '../db/client';
import { resolveProject } from './projects';
import { resolveProjectPath } from '../services/project-path';
import {
  getCommits,
  getCommitDiff,
  getWorkingDiff,
  getBranchDiff,
  getBranches,
  getDefaultBranch,
  getCurrentBranch,
  isGitRepo,
  sanitizeRef,
  checkoutBranch,
  GitCommit,
  DiffResult,
  WorkingDiffResult,
  BranchDiffResult,
} from '../services/git';

interface CommitsQuery {
  branch?: string;
  limit?: string;
  offset?: string;
  path?: string;
}

interface DiffQuery {
  commit_sha?: string;
  base?: string;
  path?: string;
}

const gitRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:projectId/git/commits - Get commit history
  fastify.get<{ Querystring: CommitsQuery }>('/commits', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { branch, limit, offset, path } = request.query;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = await resolveProjectPath(project);
    if (!projectPath) {
      return reply.code(400).send({
        error: 'Project has no path configured',
        message: 'Set the project path via PATCH /api/projects/:id',
      });
    }

    if (!(await isGitRepo(projectPath))) {
      return reply.code(400).send({
        error: 'Not a git repository',
        message: `${projectPath} is not a git repository`,
      });
    }

    try {
      const requestedLimit = limit ? parseInt(limit, 10) : 20;
      const requestedOffset = offset ? parseInt(offset, 10) : 0;
      // Request one extra to determine if there are more
      const commits = await getCommits(projectPath, {
        branch: branch ? sanitizeRef(branch) : undefined,
        limit: requestedLimit + 1,
        offset: requestedOffset,
        path,
      });

      const currentBranch = await getCurrentBranch(projectPath);
      const hasMore = commits.length > requestedLimit;

      return {
        branch: currentBranch,
        commits: hasMore ? commits.slice(0, requestedLimit) : commits,
        pagination: {
          limit: requestedLimit,
          offset: requestedOffset,
          has_more: hasMore,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Git operation failed', message });
    }
  });

  // GET /api/projects/:projectId/git/diff - Get diff for a commit
  fastify.get<{ Querystring: DiffQuery }>('/diff', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { commit_sha, path } = request.query;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = await resolveProjectPath(project);
    if (!projectPath) {
      return reply.code(400).send({
        error: 'Project has no path configured',
        message: 'Set the project path via PATCH /api/projects/:id',
      });
    }

    if (!(await isGitRepo(projectPath))) {
      return reply.code(400).send({
        error: 'Not a git repository',
        message: `${projectPath} is not a git repository`,
      });
    }

    try {
      if (request.query.base) {
        // Branch diff: changes between base branch and HEAD
        return await getBranchDiff(projectPath, sanitizeRef(request.query.base), path);
      } else if (commit_sha) {
        // Diff for specific commit
        return await getCommitDiff(projectPath, sanitizeRef(commit_sha), path);
      } else {
        // Working tree diff - return full structure with staged/unstaged/combined/untracked
        return await getWorkingDiff(projectPath, path);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Git operation failed', message });
    }
  });

  // GET /api/projects/:projectId/git/branches - List local branches
  fastify.get('/branches', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = await resolveProjectPath(project);
    if (!projectPath) {
      return reply.code(400).send({
        error: 'Project has no path configured',
        message: 'Set the project path via PATCH /api/projects/:id',
      });
    }

    if (!(await isGitRepo(projectPath))) {
      return reply.code(400).send({
        error: 'Not a git repository',
        message: `${projectPath} is not a git repository`,
      });
    }

    try {
      const branches = await getBranches(projectPath);
      const current = await getCurrentBranch(projectPath);
      const defaultBranch = await getDefaultBranch(projectPath);

      return { branches, current, default: defaultBranch };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Git operation failed', message });
    }
  });

  // POST /api/projects/:projectId/git/checkout - Switch branch
  fastify.post('/checkout', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { branch } = request.body as { branch?: string };

    if (!branch || typeof branch !== 'string') {
      return reply.code(400).send({ error: 'branch is required' });
    }

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = await resolveProjectPath(project);
    if (!projectPath) {
      return reply.code(400).send({
        error: 'Project has no path configured',
        message: 'Set the project path via PATCH /api/projects/:id',
      });
    }

    if (!(await isGitRepo(projectPath))) {
      return reply.code(400).send({
        error: 'Not a git repository',
        message: `${projectPath} is not a git repository`,
      });
    }

    try {
      const current = await checkoutBranch(projectPath, branch);
      return { current };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(409).send({ error: message });
    }
  });

  // GET /api/projects/:projectId/git/diff/working - Get working tree diff
  fastify.get<{ Querystring: { path?: string } }>('/diff/working', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { path } = request.query;

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const projectPath = await resolveProjectPath(project);
    if (!projectPath) {
      return reply.code(400).send({
        error: 'Project has no path configured',
        message: 'Set the project path via PATCH /api/projects/:id',
      });
    }

    if (!(await isGitRepo(projectPath))) {
      return reply.code(400).send({
        error: 'Not a git repository',
        message: `${projectPath} is not a git repository`,
      });
    }

    try {
      const result = await getWorkingDiff(projectPath, path);

      // If working tree is clean, soft-delete any active uncommitted diff record
      if (result.combined.stats.files === 0) {
        await query(
          `UPDATE diffs
           SET deleted_at = NOW()
           WHERE project_id = $1
             AND commit_sha IS NULL
             AND deleted_at IS NULL`,
          [project.id]
        );
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: 'Git operation failed', message });
    }
  });
};

export default gitRoutes;
