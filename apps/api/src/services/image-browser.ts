import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sharp from 'sharp';

/**
 * Image-browser service: directory listing, file streaming with on-demand
 * HEIC->JPEG conversion, and metadata for a single image. Path validation
 * mirrors apps/api/src/routes/filesystem.ts (tilde expansion + path.resolve).
 */

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tiff', '.tif', '.svg',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
};

const CONVERT_TO_JPEG = new Set(['.heic', '.heif']);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.DS_Store',
  '.next', '.nuxt', '.cache', '.turbo', '.parcel-cache', 'coverage',
]);

const MAX_RECURSIVE_DEPTH = 8;
const MAX_LIST_ENTRIES = 5000;

export interface ListedImage {
  name: string;
  path: string;
  size: number;
  modified: string;
  ext: string;
  mime: string;
}

export interface ImageMetadata {
  path: string;
  name: string;
  size: number;
  modified: string;
  mime: string;
  width: number | null;
  height: number | null;
  format: string | null;
}

export interface StreamedImage {
  bytes: Buffer;
  mime: string;
  converted: boolean;
}

export class ImageBrowserError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function validatePath(rawPath: string): string {
  if (!rawPath) throw new ImageBrowserError(400, 'path is required');
  const expanded = expandTilde(rawPath);
  if (!path.isAbsolute(expanded)) {
    throw new ImageBrowserError(400, 'Path must be absolute');
  }
  return path.resolve(expanded);
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export async function listImages(rawPath: string, recursive = false): Promise<{ root: string; images: ListedImage[]; truncated: boolean }> {
  const root = validatePath(rawPath);
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new ImageBrowserError(404, 'Directory not found');
  }
  if (!stat.isDirectory()) {
    throw new ImageBrowserError(400, 'Path is not a directory');
  }

  const images: ListedImage[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (images.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (images.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
      if (entry.name === '.DS_Store') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (depth >= MAX_RECURSIVE_DEPTH) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isImageFile(entry.name)) continue;
      try {
        const s = await fs.stat(full);
        const ext = path.extname(entry.name).toLowerCase();
        images.push({
          name: entry.name,
          path: full,
          size: s.size,
          modified: s.mtime.toISOString(),
          ext,
          mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
        });
      } catch {
        // Skip unreadable entries
      }
    }
  }

  await walk(root, 1);

  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

  return { root, images, truncated };
}

export async function streamImage(rawPath: string): Promise<StreamedImage> {
  const full = validatePath(rawPath);
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    throw new ImageBrowserError(404, 'File not found');
  }
  if (!stat.isFile()) throw new ImageBrowserError(400, 'Path is not a file');
  if (!isImageFile(full)) throw new ImageBrowserError(415, 'Not an image file');

  const ext = path.extname(full).toLowerCase();

  if (CONVERT_TO_JPEG.has(ext)) {
    try {
      const bytes = await sharp(full).rotate().jpeg({ quality: 85 }).toBuffer();
      return { bytes, mime: 'image/jpeg', converted: true };
    } catch (err) {
      throw new ImageBrowserError(500, `HEIC conversion failed: ${(err as Error).message}`);
    }
  }

  const bytes = await fs.readFile(full);
  return { bytes, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', converted: false };
}

export async function getImageMetadata(rawPath: string): Promise<ImageMetadata> {
  const full = validatePath(rawPath);
  let stat;
  try {
    stat = await fs.stat(full);
  } catch {
    throw new ImageBrowserError(404, 'File not found');
  }
  if (!stat.isFile()) throw new ImageBrowserError(400, 'Path is not a file');
  if (!isImageFile(full)) throw new ImageBrowserError(415, 'Not an image file');

  const ext = path.extname(full).toLowerCase();
  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  try {
    const meta = await sharp(full).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    format = meta.format ?? null;
  } catch {
    // metadata read failed (e.g., svg or unsupported variant) — leave nulls
  }

  return {
    path: full,
    name: path.basename(full),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
    width,
    height,
    format,
  };
}
