import { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { query } from '../db/client';
import { logger } from '../lib/logger';

const log = logger.child({ component: 'files' });
import { resolveProject } from './projects';
import { buildStorageDir } from '../services/google';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';

interface FileRecord {
  id: string;
  project_id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  size: number;
  path: string;
  created_at: string;
}

interface Setting {
  key: string;
  value: string;
}

const ALLOWED_MIME_TYPES = [
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Audio
  'audio/mpeg',      // .mp3
  'audio/wav',       // .wav
  'audio/ogg',       // .ogg
  // Videos
  'video/mp4',
  'video/webm',
  'video/quicktime', // .mov
  // Documents
  'application/pdf',
  'text/csv',
  'text/plain',
  // Office
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
];

async function getStoragePath(): Promise<string> {
  const rows = await query<Setting>(
    "SELECT value FROM settings WHERE key = 'files.storagePath'"
  );
  return rows.length > 0 ? rows[0].value : './uploads';
}

async function getMaxFileSizeMb(): Promise<number> {
  const rows = await query<Setting>(
    "SELECT value FROM settings WHERE key = 'files.maxSizeMb'"
  );
  return rows.length > 0 ? parseInt(rows[0].value, 10) : 10;
}

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  return map[mimeType] || 'bin';
}

// Project-scoped file routes
export const projectFileRoutes: FastifyPluginAsync = async (fastify) => {
  // Register multipart support
  await fastify.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500MB hard cap; actual limit enforced by settings check after write
    },
  });

  // POST /api/projects/:projectId/files - Upload a file
  fastify.post('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    // Validate mime type
    if (!ALLOWED_MIME_TYPES.includes(data.mimetype)) {
      return reply.code(400).send({
        error: 'Invalid file type',
        allowed_types: ALLOWED_MIME_TYPES,
      });
    }

    // Get storage settings
    const maxSizeMb = await getMaxFileSizeMb();

    // Create date-organized project directory
    const projectDir = await buildStorageDir(project.handle);

    // Generate unique filename
    const fileId = crypto.randomUUID();
    const extension = getExtension(data.mimetype);
    const filename = `${fileId}.${extension}`;
    const filePath = path.join(projectDir, filename);

    // Stream file to disk
    const writeStream = fs.createWriteStream(filePath);
    await pipeline(data.file, writeStream);

    // Get file size
    const stats = await fs.promises.stat(filePath);
    const fileSizeBytes = stats.size;
    const fileSizeMb = fileSizeBytes / (1024 * 1024);

    // Check file size against limit
    if (fileSizeMb > maxSizeMb) {
      // Clean up oversized file
      await fs.promises.unlink(filePath);
      return reply.code(400).send({
        error: `File too large. Maximum size is ${maxSizeMb}MB`,
      });
    }

    // Insert file record into database
    const rows = await query<FileRecord>(
      `INSERT INTO files (id, project_id, filename, original_filename, mime_type, size, path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [fileId, project.id, filename, data.filename, data.mimetype, fileSizeBytes, filePath]
    );

    const file = rows[0];

    return {
      id: file.id,
      url: `/api/files/${file.id}`,
      filename: file.original_filename,
      mime_type: file.mime_type,
      size: file.size,
      project_id: file.project_id,
      created_at: file.created_at,
    };
  });

  // GET /api/projects/:projectId/files - List files for a project
  fastify.get('/', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const files = await query<FileRecord>(
      `SELECT * FROM files WHERE project_id = $1 ORDER BY created_at DESC`,
      [project.id]
    );

    // Check disk existence in parallel
    const existsChecks = await Promise.all(
      files.map(async (f) => {
        try {
          await fs.promises.access(f.path, fs.constants.R_OK);
          return true;
        } catch {
          return false;
        }
      })
    );

    return {
      files: files.map((f, i) => ({
        id: f.id,
        url: `/api/files/${f.id}`,
        filename: f.original_filename,
        mime_type: f.mime_type,
        size: f.size,
        created_at: f.created_at,
        exists_on_disk: existsChecks[i],
      })),
    };
  });

  // POST /api/projects/:projectId/files/cleanup - Remove records for files missing from disk
  fastify.post('/cleanup', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const files = await query<FileRecord>(
      `SELECT * FROM files WHERE project_id = $1`,
      [project.id]
    );

    const orphanIds: string[] = [];
    for (const f of files) {
      try {
        await fs.promises.access(f.path, fs.constants.R_OK);
      } catch {
        orphanIds.push(f.id);
      }
    }

    if (orphanIds.length === 0) {
      return { removed: 0 };
    }

    await query(
      `DELETE FROM files WHERE id = ANY($1)`,
      [orphanIds]
    );

    log.info({ count: orphanIds.length, projectId: project.id }, 'Cleaned up orphaned file records');

    return { removed: orphanIds.length };
  });

  // DELETE /api/projects/:projectId/files/:fileId - Delete a file
  fastify.delete('/:fileId', async (request, reply) => {
    const { projectId, fileId } = request.params as {
      projectId: string;
      fileId: string;
    };

    // Resolve project
    const project = await resolveProject(projectId);
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Find file
    const files = await query<FileRecord>(
      `SELECT * FROM files WHERE id = $1 AND project_id = $2`,
      [fileId, project.id]
    );

    if (files.length === 0) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const file = files[0];

    // Delete from disk using stored path
    try {
      await fs.promises.unlink(file.path);
    } catch (err) {
      // Log but don't fail if file is already gone
      log.warn({ err, path: file.path }, 'Could not delete file from disk');
    }

    // Delete from database
    await query('DELETE FROM files WHERE id = $1', [fileId]);

    return reply.code(204).send();
  });
};

// Global file routes (no project scope needed for serving)
export const globalFileRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/files/migrate - Move all files to new storage path
  fastify.post('/migrate', async (request, reply) => {
    const { targetPath } = request.body as { targetPath: string };

    if (!targetPath || typeof targetPath !== 'string') {
      return reply.code(400).send({ error: 'targetPath is required' });
    }

    // Get all files with their project handles
    const files = await query<FileRecord & { project_handle: string }>(
      `SELECT f.*, p.handle as project_handle
       FROM files f
       JOIN projects p ON f.project_id = p.id`
    );

    if (files.length === 0) {
      return { moved: 0, skipped: 0, failed: 0, errors: [] };
    }

    const results = {
      moved: 0,
      skipped: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const file of files) {
      const newDir = path.join(targetPath, file.project_handle);
      const newPath = path.join(newDir, file.filename);

      // Resolve both paths to absolute for proper comparison
      const oldPathAbsolute = path.resolve(file.path);
      const newPathAbsolute = path.resolve(newPath);

      // Skip if already at target location (compare absolute paths)
      if (oldPathAbsolute === newPathAbsolute) {
        // Update DB path to use new relative path format if different
        if (file.path !== newPath) {
          await query('UPDATE files SET path = $1 WHERE id = $2', [newPath, file.id]);
        }
        results.skipped++;
        continue;
      }

      // Check if source file exists
      try {
        await fs.promises.access(oldPathAbsolute, fs.constants.R_OK);
      } catch {
        // Source file doesn't exist - check if it's already at the new location
        try {
          await fs.promises.access(newPathAbsolute, fs.constants.R_OK);
          // File is already at new location, just update DB
          await query('UPDATE files SET path = $1 WHERE id = $2', [newPath, file.id]);
          results.skipped++;
          continue;
        } catch {
          // File doesn't exist at either location
          results.failed++;
          results.errors.push(`${file.original_filename}: File not found at old (${oldPathAbsolute}) or new (${newPathAbsolute}) path`);
          continue;
        }
      }

      try {
        // Create target directory
        await fs.promises.mkdir(newDir, { recursive: true });

        // Move file (rename for same filesystem, copy+delete for cross-filesystem)
        try {
          await fs.promises.rename(oldPathAbsolute, newPathAbsolute);
        } catch (renameErr: any) {
          // Cross-filesystem: copy then delete
          if (renameErr.code === 'EXDEV') {
            await fs.promises.copyFile(oldPathAbsolute, newPathAbsolute);
            await fs.promises.unlink(oldPathAbsolute);
          } else {
            throw renameErr;
          }
        }

        // Update database with new path
        await query('UPDATE files SET path = $1 WHERE id = $2', [newPath, file.id]);
        results.moved++;
      } catch (err: any) {
        results.failed++;
        results.errors.push(`${file.original_filename}: ${err.message}`);
      }
    }

    return results;
  });

  // GET /api/files/local - Serve a local file by absolute path (images only)
  fastify.get('/local', async (request, reply) => {
    const { path: filePath } = request.query as { path?: string };

    if (!filePath || typeof filePath !== 'string') {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }

    // Security: require absolute path
    if (!filePath.startsWith('/')) {
      return reply.code(400).send({ error: 'Path must be absolute' });
    }

    // Security: reject path traversal
    if (filePath.includes('..')) {
      return reply.code(400).send({ error: 'Path traversal not allowed' });
    }

    // Only serve image and PDF files
    const allowedExtensions: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.pdf': 'application/pdf',
    };

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = allowedExtensions[ext];
    if (!mimeType) {
      return reply.code(400).send({ error: 'Only image and PDF files are allowed' });
    }

    // Check file exists
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }

    reply.header('Content-Type', mimeType);
    reply.header('Cache-Control', 'public, max-age=3600');

    const stream = fs.createReadStream(filePath);
    return reply.send(stream);
  });

  // GET /api/files/:id - Serve a file (supports Range requests for video/audio)
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Find file
    const files = await query<FileRecord>(
      `SELECT * FROM files WHERE id = $1`,
      [id]
    );

    if (files.length === 0) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const file = files[0];

    // Check if file exists on disk and get size
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file.path);
    } catch {
      return reply.code(404).send({ error: 'File not found on disk' });
    }

    const fileSize = stat.size;
    const rangeHeader = request.headers.range;

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', file.mime_type);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');

    if (rangeHeader) {
      // Parse Range header (e.g., "bytes=0-999")
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        reply.code(416).header('Content-Range', `bytes */${fileSize}`);
        return reply.send();
      }

      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        reply.code(416).header('Content-Range', `bytes */${fileSize}`);
        return reply.send();
      }

      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      reply.header('Content-Length', end - start + 1);

      const stream = fs.createReadStream(file.path, { start, end });
      return reply.send(stream);
    }

    // No Range header — serve entire file
    reply.header('Content-Length', fileSize);
    const stream = fs.createReadStream(file.path);
    return reply.send(stream);
  });
};

export default projectFileRoutes;
