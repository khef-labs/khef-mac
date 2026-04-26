import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

type PromptSeed = {
  handle: string;
  title: string;
  description: string;
  content: string;
};

function parseFrontMatter(md: string): { meta: Record<string, string>; body: string } {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') {
    throw new Error('Missing front matter delimiter (---) at top of file');
  }
  const meta: Record<string, string> = {};
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

function loadPromptSeeds(): PromptSeed[] {
  const dir = join(__dirname, 'prompts');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const seeds: PromptSeed[] = [];

  for (const file of files) {
    const md = readFileSync(join(dir, file), 'utf-8');
    const { meta, body } = parseFrontMatter(md);

    const missing: string[] = [];
    if (!meta.handle) missing.push('handle');
    if (!meta.title) missing.push('title');
    if (missing.length > 0) {
      throw new Error(`Missing required front matter ${missing.join(', ')} in ${file}`);
    }

    seeds.push({
      handle: meta.handle,
      title: meta.title,
      description: meta.description || '',
      content: body.trim(),
    });
  }

  return seeds;
}

export async function seedPrompts(client: Client): Promise<void> {
  const seeds = loadPromptSeeds();
  if (seeds.length === 0) return;

  console.log(`\nSeeding ${seeds.length} prompts...`);

  for (const s of seeds) {
    await client.query(
      `INSERT INTO prompts (handle, title, description, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (handle) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         content = EXCLUDED.content`,
      [s.handle, s.title, s.description, s.content]
    );
    console.log(`  ✓ ${s.handle}`);
  }
}
