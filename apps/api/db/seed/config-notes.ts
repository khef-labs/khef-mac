import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

type ConfigNoteSeed = {
  config_path: string; // matches configs.path (supports ~ for homedir)
  content: string;
};

function parseFrontMatter(md: string): { meta: any; body: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('Missing front matter delimiter (---) at top of file');
  }
  const meta: any = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') { i++; break; }
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (m) {
      meta[m[1]] = m[2].trim();
    }
  }
  const body = lines.slice(i).join('\n');
  return { meta, body };
}

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return p.replace('~', process.env.HOME || '');
  }
  return p;
}

export async function seedConfigNotes(client: Client): Promise<void> {
  const seedDir = join(__dirname, 'config-notes');
  if (!existsSync(seedDir)) return;

  const files = readdirSync(seedDir).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) return;

  console.log(`\nSeeding ${files.length} config notes...`);

  for (const file of files) {
    const filepath = join(seedDir, file);
    const raw = readFileSync(filepath, 'utf-8');
    const { meta, body } = parseFrontMatter(raw);

    if (!meta.config_path) {
      console.log(`  ⚠ Skipping ${file}: missing config_path in frontmatter`);
      continue;
    }

    const configPath = expandPath(meta.config_path);
    const content = body.trim();

    if (!content) {
      console.log(`  ⚠ Skipping ${file}: empty content`);
      continue;
    }

    const result = await client.query(
      `UPDATE configs SET notes = $1, updated_at = NOW() WHERE path = $2 AND (notes IS DISTINCT FROM $1)`,
      [content, configPath]
    );

    if (result.rowCount && result.rowCount > 0) {
      console.log(`  ✓ ${file} → ${meta.config_path}`);
    } else {
      // Check if config exists at all
      const exists = await client.query('SELECT 1 FROM configs WHERE path = $1', [configPath]);
      if (exists.rowCount === 0) {
        console.log(`  ⚠ ${file}: no config found for path ${meta.config_path}`);
      }
      // Otherwise silently skip (unchanged)
    }
  }
}
