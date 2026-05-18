import { FastifyPluginAsync } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import { query } from '../db/client';
import { resolveProject } from './projects';
import { buildStorageDir } from '../services/google';
import {
  ImageBrowserError,
  getImageMetadata,
  listImages,
  streamImage,
  validatePath,
  isImageFile,
} from '../services/image-browser';

interface MemoryTypeRow { id: string }
interface StatusRow { id: string }
interface FileRow { id: string; project_id: string; filename: string; original_filename: string; mime_type: string; size: number; path: string; created_at: string }
interface MemoryRow { id: string; created_at: string; updated_at: string }

const SLUG_MAX = 40;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX) || 'image';
}

function sendImageError(reply: any, err: unknown): any {
  if (err instanceof ImageBrowserError) {
    return reply.status(err.status).send({ error: err.message });
  }
  reply.request.log.error({ err }, 'image-browser error');
  return reply.status(500).send({ error: 'Internal error' });
}

const imageBrowserRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /list?path=&recursive=
  fastify.get<{ Querystring: { path: string; recursive?: string } }>('/list', async (request, reply) => {
    try {
      const recursive = request.query.recursive === 'true' || request.query.recursive === '1';
      const result = await listImages(request.query.path, recursive);
      return result;
    } catch (err) {
      return sendImageError(reply, err);
    }
  });

  // GET /metadata?path=
  fastify.get<{ Querystring: { path: string } }>('/metadata', async (request, reply) => {
    try {
      const meta = await getImageMetadata(request.query.path);
      return meta;
    } catch (err) {
      return sendImageError(reply, err);
    }
  });

  // GET /file?path= — binary stream (converts HEIC -> JPEG)
  fastify.get<{ Querystring: { path: string } }>('/file', async (request, reply) => {
    try {
      const result = await streamImage(request.query.path);
      reply.header('Content-Type', result.mime);
      reply.header('Cache-Control', 'private, max-age=300');
      reply.header('Content-Length', String(result.bytes.length));
      if (result.converted) reply.header('X-Image-Converted', '1');
      return reply.send(result.bytes);
    } catch (err) {
      return sendImageError(reply, err);
    }
  });

  // POST /save-as-memory
  // Body: { path: string, project_id: string (handle|uuid), memory_type?: string, title?: string, tags?: string[] }
  fastify.post<{
    Body: { path: string; project_id: string; memory_type?: string; title?: string; tags?: string[] };
  }>('/save-as-memory', async (request, reply) => {
    try {
      const { path: rawPath, project_id, memory_type, title, tags } = request.body || {} as any;
      if (!rawPath) return reply.status(400).send({ error: 'path is required' });
      if (!project_id) return reply.status(400).send({ error: 'project_id is required' });

      const project = await resolveProject(project_id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      // Validate source path + verify it's an image
      const sourcePath = validatePath(rawPath);
      let stat;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        return reply.status(404).send({ error: 'Source image not found' });
      }
      if (!stat.isFile()) return reply.status(400).send({ error: 'Source path is not a file' });
      if (!isImageFile(sourcePath)) return reply.status(415).send({ error: 'Source is not an image file' });

      const sourceName = path.basename(sourcePath);
      const sourceExt = path.extname(sourcePath).toLowerCase();
      const needsConvert = sourceExt === '.heic' || sourceExt === '.heif';

      // Read (and optionally convert) bytes
      let bytes: Buffer;
      let storedMime: string;
      let storedExt: string;
      let storedOriginalName: string;
      if (needsConvert) {
        bytes = await sharp(sourcePath).rotate().jpeg({ quality: 88 }).toBuffer();
        storedMime = 'image/jpeg';
        storedExt = 'jpg';
        storedOriginalName = sourceName.replace(/\.heic$|\.heif$/i, '.jpg');
      } else {
        bytes = await fs.readFile(sourcePath);
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
        };
        storedMime = mimeMap[sourceExt] ?? 'application/octet-stream';
        storedExt = sourceExt.replace(/^\./, '') || 'bin';
        storedOriginalName = sourceName;
      }

      // Write to project storage dir
      const fileId = crypto.randomUUID();
      const filename = `${fileId}.${storedExt}`;
      const storageDir = await buildStorageDir(project.handle);
      const storedPath = path.join(storageDir, filename);
      await fs.writeFile(storedPath, bytes);

      // Insert files row
      const fileRows = await query<FileRow>(
        `INSERT INTO files (id, project_id, filename, original_filename, mime_type, size, path)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [fileId, project.id, filename, storedOriginalName, storedMime, bytes.length, storedPath]
      );
      const fileRow = fileRows[0];

      // Resolve memory type + default status
      const requestedType = (memory_type && typeof memory_type === 'string') ? memory_type : 'reference';
      const typeRows = await query<MemoryTypeRow>(
        'SELECT id FROM memory_types WHERE name = $1',
        [requestedType]
      );
      if (typeRows.length === 0) {
        return reply.status(400).send({ error: `Unknown memory type: ${requestedType}` });
      }
      const memoryTypeId = typeRows[0].id;
      const statusRows = await query<StatusRow>(
        `SELECT id FROM memory_type_statuses WHERE memory_type_id = $1 ORDER BY sort_order ASC LIMIT 1`,
        [memoryTypeId]
      );
      const statusId = statusRows[0]?.id ?? null;

      // Resolve a unique handle for the memory
      const baseSlug = slugify(sourceName);
      let finalHandle = baseSlug;
      for (let i = 2; i < 1000; i++) {
        const collision = await query<{ id: string }>(
          'SELECT id FROM memories WHERE project_id = $1 AND handle = $2',
          [project.id, finalHandle]
        );
        if (collision.length === 0) break;
        finalHandle = `${baseSlug}-${i}`.slice(0, 60);
      }

      const finalTitle = (title && typeof title === 'string' && title.trim()) ? title.trim() : sourceName;
      const content = `![${storedOriginalName}](/api/files/${fileRow.id})\n\nSource: \`${sourcePath}\`\n`;

      const memRows = await query<MemoryRow>(
        `INSERT INTO memories (project_id, handle, title, content, memory_type_id, status_id, status_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, created_at, updated_at`,
        [project.id, finalHandle, finalTitle, content, memoryTypeId, statusId]
      );
      const memory = memRows[0];

      // Tags
      const validTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase()) : [];
      for (const tagName of validTags) {
        let tagRows = await query<{ id: string }>(
          'SELECT id FROM tags WHERE name = $1', [tagName]
        );
        if (tagRows.length === 0) {
          tagRows = await query<{ id: string }>(
            'INSERT INTO tags (name) VALUES ($1) RETURNING id', [tagName]
          );
        }
        await query(
          'INSERT INTO memory_tags (memory_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [memory.id, tagRows[0].id]
        );
      }

      return reply.status(201).send({
        memory: {
          id: memory.id,
          project_id: project.id,
          handle: finalHandle,
          title: finalTitle,
          type: requestedType,
        },
        file: {
          id: fileRow.id,
          url: `/api/files/${fileRow.id}`,
          mime_type: fileRow.mime_type,
          size: fileRow.size,
          converted: needsConvert,
        },
      });
    } catch (err) {
      return sendImageError(reply, err);
    }
  });
};

export default imageBrowserRoutes;
