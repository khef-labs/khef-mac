#!/usr/bin/env tsx
/**
 * Kdag code step: Scan a directory of .md files and produce a JSON manifest.
 *
 * Input (stdin): JSON with source_dir, project_handle, memory_type, collection_handle
 * Output (stdout): JSON manifest with file metadata (no content)
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, basename, dirname, extname } from 'path';
import { randomBytes } from 'crypto';

interface InputData {
  source_dir: string;
  project_handle: string;
  memory_type?: string;
  collection_handle?: string;
}

interface FileEntry {
  path: string;
  handle: string;
  title: string;
  category: string;
  category_tag: string;
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      results.push(fullPath);
    }
  }
  return results;
}

function extractTitle(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: derive from filename
  return deriveTitle(basename(filePath, '.md'));
}

function deriveHandle(filename: string): string {
  // Strip .md extension, strip leading number prefixes like "01-", "03-"
  const base = basename(filename, '.md').replace(/^\d+-/, '');
  // Convert to kebab-case
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveTitle(name: string): string {
  // Convert kebab-case or snake_case to Title Case
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function deriveCategoryTag(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const cleaned = input.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const data: InputData = JSON.parse(cleaned);

    if (!data.source_dir) {
      console.error('source_dir is required');
      process.exit(1);
    }
    if (!data.project_handle) {
      console.error('project_handle is required');
      process.exit(1);
    }

    // Verify directory exists
    const stat = statSync(data.source_dir);
    if (!stat.isDirectory()) {
      console.error(`Not a directory: ${data.source_dir}`);
      process.exit(1);
    }

    const mdFiles = findMarkdownFiles(data.source_dir);
    if (mdFiles.length === 0) {
      console.error(`No .md files found in ${data.source_dir}`);
      process.exit(1);
    }

    // Generate import batch tag
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const hex = randomBytes(2).toString('hex').slice(0, 3);
    const importTag = `import-${date}-${hex}`;

    const files: FileEntry[] = mdFiles.map(filePath => {
      const handle = deriveHandle(basename(filePath));
      const title = extractTitle(filePath);
      const parentDir = basename(dirname(filePath));
      // If file is directly in source_dir, use source_dir's basename as category
      const category = parentDir === basename(data.source_dir) ? parentDir : parentDir;
      const categoryTag = deriveCategoryTag(category);

      return { path: filePath, handle, title, category, category_tag: categoryTag };
    });

    const manifest = {
      project_handle: data.project_handle,
      memory_type: data.memory_type || 'user-note',
      collection_handle: data.collection_handle || null,
      import_tag: importTag,
      files,
    };

    process.stdout.write(JSON.stringify(manifest, null, 2));
  } catch (err: any) {
    console.error(`Failed to scan directory: ${err.message}`);
    process.exit(1);
  }
});
