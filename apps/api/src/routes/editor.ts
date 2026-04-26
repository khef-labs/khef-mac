/**
 * Editor-related endpoints (scratch home resolution, etc.).
 * Prefix: /api/editor
 */

import type { FastifyPluginAsync } from 'fastify';
import { promises as fsp } from 'fs';
import { resolve } from 'path';
import { querySingle } from '../db/client';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const DEFAULT_SCRATCH_DIR = resolve(REPO_ROOT, 'khef-scratches');

const editorRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/editor/scratch-home
   * Returns the resolved scratch home directory, creating it if missing.
   * If the `editor.scratchHome` setting is empty, falls back to
   * <repo-root>/khef-scratches (gitignored).
   */
  fastify.get('/scratch-home', async (_request, reply) => {
    const row = await querySingle<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'editor.scratchHome' LIMIT 1`
    );
    const override = row?.value?.trim() ?? '';
    const path = override.length > 0 ? resolve(override) : DEFAULT_SCRATCH_DIR;

    try {
      await fsp.mkdir(path, { recursive: true });
    } catch (err: any) {
      return reply.status(500).send({
        error: `Failed to create scratch home at ${path}: ${err?.message || err}`,
      });
    }

    return {
      path,
      is_default: override.length === 0,
    };
  });
};

export default editorRoutes;
