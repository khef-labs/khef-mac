import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import projectKnowledgeRoutes from '../../src/routes/project-knowledge';
import {
  FILE_SPLIT_THRESHOLD,
  splitContentIntoFiles,
  cleanupOverflowFiles,
  buildKnowledgeFiles,
  ContentBlock,
  KnowledgeData,
} from '../../src/services/knowledge-sync';

describe('Knowledge Multi-File Splitting', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(projectKnowledgeRoutes, { prefix: '/api/projects/:projectId/knowledge' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    const result = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Test Project',
        description: 'A test project'
      }
    });

    if (result.statusCode !== 201) {
      throw new Error(`Failed to create project: ${result.payload}`);
    }

    projectId = JSON.parse(result.payload).project.id;
  });

  describe('splitContentIntoFiles', () => {
    it('should return single file when content fits within threshold', () => {
      const blocks: ContentBlock[] = [
        { section: 'Context', content: '\n### Title\n\nSmall content\n' },
      ];
      const files = splitContentIntoFiles(
        '# Header\n\n',
        blocks,
        'KF-TEST',
        '# Header (continued)\n\n',
        1000,
      );

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('KF-TEST.md');
      expect(files[0].content).toContain('# Header');
      expect(files[0].content).toContain('## Context');
      expect(files[0].content).toContain('Small content');
      // No @-import in single file
      expect(files[0].content).not.toContain('@./');
    });

    it('should split into multiple files when content exceeds threshold', () => {
      const blocks: ContentBlock[] = [];
      for (let i = 0; i < 10; i++) {
        blocks.push({
          section: 'Context',
          content: `\n### Entry ${i}\n\n${'x'.repeat(200)}\n`,
        });
      }

      const files = splitContentIntoFiles(
        '# Header\n\n',
        blocks,
        'KF-TEST',
        '# Header (continued)\n\n',
        500, // very small threshold to force splitting
      );

      expect(files.length).toBeGreaterThan(1);

      // Root file should be named without number suffix
      expect(files[0].filename).toBe('KF-TEST.md');

      // Non-final files should end with @-import to the next file
      for (let i = 0; i < files.length - 1; i++) {
        expect(files[i].content).toContain(`@./${files[i + 1].filename}`);
      }

      // Last file should not have @-import
      expect(files[files.length - 1].content).not.toContain('@./');

      // Overflow files should be numbered
      for (let i = 1; i < files.length; i++) {
        expect(files[i].filename).toMatch(/^KF-TEST-\d+\.md$/);
      }
    });

    it('should add (continued) label when section spans multiple files', () => {
      const blocks: ContentBlock[] = [];
      for (let i = 0; i < 6; i++) {
        blocks.push({
          section: 'Context',
          content: `\n### Entry ${i}\n\n${'x'.repeat(300)}\n`,
        });
      }

      const files = splitContentIntoFiles(
        '# Header\n\n',
        blocks,
        'KF-TEST',
        '# Header (continued)\n\n',
        600,
      );

      expect(files.length).toBeGreaterThan(1);

      // First file should have plain section header
      expect(files[0].content).toContain('## Context\n');
      expect(files[0].content).not.toContain('(continued)');

      // Later files should have "(continued)" if they continue the same section
      const laterFiles = files.slice(1);
      const hasContinued = laterFiles.some(f => f.content.includes('Context (continued)'));
      expect(hasContinued).toBe(true);
    });

    it('should never split a block across files', () => {
      // One very large block that exceeds the threshold alone
      const blocks: ContentBlock[] = [
        { section: 'Context', content: `\n### Big Entry\n\n${'x'.repeat(2000)}\n` },
        { section: 'Context', content: `\n### Small Entry\n\n${'y'.repeat(50)}\n` },
      ];

      const files = splitContentIntoFiles(
        '# Header\n\n',
        blocks,
        'KF-TEST',
        '# Header (continued)\n\n',
        500,
      );

      // The big block should appear entirely in one file
      const bigBlockFile = files.find(f => f.content.includes('Big Entry'));
      expect(bigBlockFile).toBeDefined();
      expect(bigBlockFile!.content).toContain('x'.repeat(2000));
    });

    it('should handle multiple sections correctly', () => {
      const blocks: ContentBlock[] = [
        { section: 'Context', content: '\n### Ctx 1\n\nContext content\n' },
        { section: 'Patterns', content: '\n### Pat 1\n\nPattern content\n' },
      ];

      const files = splitContentIntoFiles(
        '# Header\n\n',
        blocks,
        'KF-TEST',
        '# Header (continued)\n\n',
        5000,
      );

      expect(files).toHaveLength(1);
      expect(files[0].content).toContain('## Context');
      expect(files[0].content).toContain('## Patterns');
    });

    it('should handle empty blocks array', () => {
      const files = splitContentIntoFiles(
        '# Header\n\n',
        [],
        'KF-TEST',
        '# Header (continued)\n\n',
      );

      expect(files).toHaveLength(1);
      expect(files[0].content).toBe('# Header\n\n');
    });
  });

  describe('buildKnowledgeFiles', () => {
    it('should produce single file for small knowledge', () => {
      const knowledge: KnowledgeData = {
        project_id: 'test-id',
        project_handle: 'test-project',
        commands: [{
          id: '1', handle: 'project-commands', title: 'Commands',
          content: '- npm run dev', updated_at: new Date().toISOString(),
        }],
        context: [{
          id: '2', handle: 'ctx-arch', title: 'Architecture',
          content: 'Fastify + PostgreSQL', updated_at: new Date().toISOString(),
        }],
        patterns: [],
      };

      const files = buildKnowledgeFiles(knowledge, 'test-project');
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('KF-PROJECT-KNOWLEDGE.md');
      expect(files[0].content).toContain('# Project Knowledge: test-project');
      expect(files[0].content).toContain('npm run dev');
      expect(files[0].content).toContain('Architecture');
    });

    it('should split large knowledge across multiple files', () => {
      const context = [];
      for (let i = 0; i < 20; i++) {
        context.push({
          id: `ctx-${i}`,
          handle: `ctx-entry-${i}`,
          title: `Context Entry ${i}`,
          content: `${'x'.repeat(3000)}`,
          updated_at: new Date().toISOString(),
        });
      }

      const knowledge: KnowledgeData = {
        project_id: 'test-id',
        project_handle: 'test-project',
        commands: [],
        context,
        patterns: [],
      };

      const files = buildKnowledgeFiles(knowledge, 'test-project');
      expect(files.length).toBeGreaterThan(1);
      expect(files[0].filename).toBe('KF-PROJECT-KNOWLEDGE.md');
      expect(files[1].filename).toBe('KF-PROJECT-KNOWLEDGE-2.md');

      // Verify chaining
      expect(files[0].content).toContain('@./KF-PROJECT-KNOWLEDGE-2.md');

      // Continuation files should have continuation header
      expect(files[1].content).toContain('Project Knowledge: test-project (continued)');
    });

    it('should sort context and patterns alphabetically', () => {
      const knowledge: KnowledgeData = {
        project_id: 'test-id',
        project_handle: 'test-project',
        commands: [],
        context: [
          { id: '1', handle: 'ctx-z', title: 'Zebra', content: 'Z content', updated_at: '' },
          { id: '2', handle: 'ctx-a', title: 'Alpha', content: 'A content', updated_at: '' },
          { id: '3', handle: 'ctx-m', title: 'Middle', content: 'M content', updated_at: '' },
        ],
        patterns: [],
      };

      const files = buildKnowledgeFiles(knowledge, 'test-project');
      const content = files[0].content;
      const alphaPos = content.indexOf('### Alpha');
      const middlePos = content.indexOf('### Middle');
      const zebraPos = content.indexOf('### Zebra');

      expect(alphaPos).toBeLessThan(middlePos);
      expect(middlePos).toBeLessThan(zebraPos);
    });

    it('should skip entries with empty content', () => {
      const knowledge: KnowledgeData = {
        project_id: 'test-id',
        project_handle: 'test-project',
        commands: [{ id: '1', handle: 'project-commands', title: 'Commands', content: '  ', updated_at: '' }],
        context: [
          { id: '2', handle: 'ctx-empty', title: 'Empty', content: '', updated_at: '' },
          { id: '3', handle: 'ctx-real', title: 'Real', content: 'actual content', updated_at: '' },
        ],
        patterns: [],
      };

      const files = buildKnowledgeFiles(knowledge, 'test-project');
      expect(files[0].content).toContain('Real');
      expect(files[0].content).not.toContain('Empty');
      expect(files[0].content).not.toContain('## Commands');
    });
  });

  describe('cleanupOverflowFiles', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('should remove stale overflow files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-test-'));

      // Create some overflow files
      fs.writeFileSync(path.join(tmpDir, 'KF-TEST-2.md'), 'old');
      fs.writeFileSync(path.join(tmpDir, 'KF-TEST-3.md'), 'old');
      fs.writeFileSync(path.join(tmpDir, 'KF-TEST-4.md'), 'old');

      // Only KF-TEST-2.md is current
      const currentFiles = new Set(['KF-TEST.md', 'KF-TEST-2.md']);
      const removed = cleanupOverflowFiles(tmpDir, 'KF-TEST', currentFiles);

      expect(removed).toHaveLength(2);
      expect(removed.map(r => path.basename(r)).sort()).toEqual(['KF-TEST-3.md', 'KF-TEST-4.md']);

      // Verify files are actually deleted
      expect(fs.existsSync(path.join(tmpDir, 'KF-TEST-2.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'KF-TEST-3.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'KF-TEST-4.md'))).toBe(false);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should not remove non-matching files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-test-'));

      fs.writeFileSync(path.join(tmpDir, 'KF-TEST-2.md'), 'keep');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'keep');
      fs.writeFileSync(path.join(tmpDir, 'KF-OTHER-2.md'), 'keep');

      const currentFiles = new Set(['KF-TEST.md']);
      const removed = cleanupOverflowFiles(tmpDir, 'KF-TEST', currentFiles);

      expect(removed).toHaveLength(1);
      expect(path.basename(removed[0])).toBe('KF-TEST-2.md');
      expect(fs.existsSync(path.join(tmpDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'KF-OTHER-2.md'))).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('Knowledge API accepts large content', () => {
    it('should accept large commands content', async () => {
      const largeContent = 'x'.repeat(50000);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/knowledge/commands`,
        payload: { content: largeContent }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory).toBeDefined();
      expect(body.memory.content).toBe(largeContent);
    });

    it('should accept large context content', async () => {
      const largeContent = 'y'.repeat(50000);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/knowledge/context/big-ctx`,
        payload: {
          title: 'Big Context',
          content: largeContent
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory).toBeDefined();
    });

    it('should accept large pattern content', async () => {
      const largeContent = 'z'.repeat(50000);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/knowledge/patterns/big-pattern`,
        payload: {
          title: 'Big Pattern',
          content: largeContent
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory).toBeDefined();
    });

    it('should accept multiple large entries', async () => {
      // Fill up with content that would have exceeded the old limit
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/knowledge/context/ctx-${i}`,
          payload: {
            title: `Context ${i}`,
            content: 'a'.repeat(10000)
          }
        });
        expect(response.statusCode).toBe(200);
      }

      // Verify they all exist
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/knowledge`
      });
      const body = JSON.parse(getRes.payload);
      expect(body.context).toHaveLength(5);
    });
  });

  describe('Assistant rules accept large content', () => {
    it('should accept large assistant-rule', async () => {
      const largeContent = 'x'.repeat(50000);
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'huge-rule',
          title: 'Huge rule',
          content: largeContent,
          type: 'assistant-rule'
        }
      });

      expect(response.statusCode).toBe(201);
    });

    it('should accept multiple large rules', async () => {
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/memories`,
          payload: {
            handle: `rule-${i}`,
            title: `Rule ${i}`,
            content: 'x'.repeat(10000),
            type: 'assistant-rule'
          }
        });
        expect(response.statusCode).toBe(201);
      }
    });

    it('should accept large content on update', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'update-rule',
          title: 'Updateable rule',
          content: 'Initial content',
          type: 'assistant-rule'
        }
      });
      const memoryId = JSON.parse(createRes.payload).memory.id;

      const largeContent = 'y'.repeat(50000);
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${projectId}/memories/${memoryId}`,
        payload: { content: largeContent }
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('FILE_SPLIT_THRESHOLD constant', () => {
    it('should be 30000', () => {
      expect(FILE_SPLIT_THRESHOLD).toBe(30000);
    });
  });
});
