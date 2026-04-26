import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import assistantRoutes from '../../src/routes/assistants';
import configRoutes from '../../src/routes/assistant-configs';

describe('Config Import Discovery', () => {
  let app: FastifyInstance;
  let client: Client;
  let tempDir: string;
  let claudeMdPath: string;
  let importedFilePath: string;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(assistantRoutes, { prefix: '/api/assistants' });
    app.register(configRoutes, { prefix: '/api/configs' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    // Clean up temp dir if it exists
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Clean up previous temp dir before creating a new one
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Clean configs and related tables
    await client.query('DELETE FROM assistant_configs');
    await client.query('DELETE FROM project_assistant_configs');
    await client.query('DELETE FROM configs');
    await client.query('DELETE FROM assistant_config_paths');

    // Create temp directory under $HOME so ~/... references resolve correctly
    // parseImportReferences only matches @~/... or @./... patterns
    const homeDir = os.homedir();
    const dirName = `.khef-test-imports-${Date.now()}`;
    tempDir = path.join(homeDir, dirName);
    fs.mkdirSync(tempDir, { recursive: true });

    // Create a markdown file that references another file via @~/...
    importedFilePath = path.join(tempDir, 'RULES.md');
    fs.writeFileSync(importedFilePath, '# Rules\n\n- Rule 1: Do the thing\n- Rule 2: Do the other thing');

    // Reference uses ~/ prefix so parseImportReferences can match it
    const importRef = `~/${dirName}/RULES.md`;

    claudeMdPath = path.join(tempDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, `# Main Config\n\nSome instructions.\n\n@${importRef}`);

    // Register the temp path as a config path for claude-code
    await client.query(
      `INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description, readonly)
       SELECT a.id, 'global', 'instructions', $1, 'markdown', 'Test config', false
       FROM assistants a WHERE a.handle = 'claude-code'`,
      [claudeMdPath]
    );
  });

  it('should discover and import @ references when discovering configs', async () => {
    // Trigger discovery
    const discoverRes = await app.inject({
      method: 'POST',
      url: '/api/assistants/claude-code/discover',
    });
    expect(discoverRes.statusCode).toBe(200);

    // List configs — should include both the parent and the imported child
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/assistants/claude-code/configs',
    });
    expect(listRes.statusCode).toBe(200);

    const { configs } = listRes.json();
    const parentConfig = configs.find((c: any) => c.path === claudeMdPath);
    const importConfig = configs.find((c: any) => c.path === importedFilePath);

    expect(parentConfig).toBeDefined();
    expect(parentConfig.is_import).toBe(false);
    expect(parentConfig.parent_config_id).toBeUndefined();

    expect(importConfig).toBeDefined();
    expect(importConfig.is_import).toBe(true);
    expect(importConfig.parent_config_id).toBe(parentConfig.id);
    expect(importConfig.content).toContain('Rule 1');
  });

  it('should return imports on single config GET', async () => {
    // Trigger discovery
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    // Get parent config
    const listRes = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const { configs } = listRes.json();
    const parentConfig = configs.find((c: any) => c.path === claudeMdPath);

    // GET single config should include imports array
    const singleRes = await app.inject({
      method: 'GET',
      url: `/api/configs/${parentConfig.id}`,
    });
    expect(singleRes.statusCode).toBe(200);

    const { config } = singleRes.json();
    expect(config.imports).toBeDefined();
    expect(config.imports).toHaveLength(1);
    expect(config.imports[0].path).toBe(importedFilePath);
    expect(config.imports[0].is_import).toBe(true);
  });

  it('should update import content when re-discovered after file changes', async () => {
    // Initial discovery
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    // Verify initial content
    const listRes1 = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const importConfig1 = listRes1.json().configs.find((c: any) => c.path === importedFilePath);
    expect(importConfig1.content).toContain('Rule 1');

    // Modify the imported file on disk
    fs.writeFileSync(importedFilePath, '# Updated Rules\n\n- Rule A: New rule');

    // Re-discover
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    // Check updated content
    const listRes2 = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const importConfig2 = listRes2.json().configs.find((c: any) => c.path === importedFilePath);
    expect(importConfig2.content).toContain('Rule A');
    expect(importConfig2.content).not.toContain('Rule 1');
  });

  it('should handle unchanged parent but changed import file', async () => {
    // Initial discovery
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    // Modify only the imported file (parent stays the same)
    fs.writeFileSync(importedFilePath, '# Changed Rules\n\n- Rule X: Changed');

    // Re-discover — parent is unchanged, but import file changed
    const discoverRes = await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });
    expect(discoverRes.statusCode).toBe(200);

    // Verify import content was updated
    const listRes = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const importConfig = listRes.json().configs.find((c: any) => c.path === importedFilePath);
    expect(importConfig.content).toContain('Rule X');
  });

  it('should not create imports for non-markdown configs', async () => {
    // Create a JSON config path that contains an @ reference (shouldn't be parsed)
    const jsonPath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ key: '@' + importedFilePath }));

    await client.query(
      `INSERT INTO assistant_config_paths (assistant_id, scope, type, path_template, format, description, readonly)
       SELECT a.id, 'global', 'settings', $1, 'json', 'Test JSON config', true
       FROM assistants a WHERE a.handle = 'claude-code'`,
      [jsonPath]
    );

    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    const listRes = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const { configs } = listRes.json();

    // Should have: parent md, import md, json config — the JSON should NOT spawn imports
    const importConfigs = configs.filter((c: any) => c.is_import);
    expect(importConfigs).toHaveLength(1); // Only the one from CLAUDE.md
    expect(importConfigs[0].parent_config_id).toBeDefined();
  });

  it('should idempotently handle repeated discoveries', async () => {
    // Discover twice
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });
    await app.inject({ method: 'POST', url: '/api/assistants/claude-code/discover' });

    // Should still have exactly one import
    const listRes = await app.inject({ method: 'GET', url: '/api/assistants/claude-code/configs' });
    const { configs } = listRes.json();
    const importConfigs = configs.filter((c: any) => c.is_import);
    expect(importConfigs).toHaveLength(1);
  });
});
