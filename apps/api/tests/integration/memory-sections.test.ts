import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import memorySectionsRoutes from '../../src/routes/memory-sections';

describe('Memory Sections Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;
  let memoryId: string;

  const testDocument = `# Overview

This is the overview section.

## Technical Design

This section covers the technical design.

### API Changes

Here are the API changes:
- Added new endpoints
- Updated response format

### Database Schema

The database schema includes:
- users table
- orders table

## Testing Plan

The testing plan covers:
1. Unit tests
2. Integration tests
3. E2E tests

## Conclusion

Final thoughts here.`;

  beforeAll(async () => {
    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(memorySectionsRoutes, { prefix: '/api/memories' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');

    // Create a test project
    const projectResult = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Test Project',
        description: 'A test project'
      }
    });

    if (projectResult.statusCode !== 201) {
      throw new Error(`Failed to create project: ${projectResult.payload}`);
    }
    projectId = JSON.parse(projectResult.payload).project.id;

    // Create a test memory with markdown sections
    const memoryResult = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: {
        handle: 'tech-design-doc',
        title: 'Tech Design: Auth System',
        content: testDocument,
        type: 'decision'
      }
    });

    if (memoryResult.statusCode !== 201) {
      throw new Error(`Failed to create memory: ${memoryResult.payload}`);
    }
    memoryId = JSON.parse(memoryResult.payload).memory.id;
  });

  describe('GET /api/memories/:memoryId/outline', () => {
    it('should return the section structure with content by default', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/outline`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.memory_id).toBe(memoryId);
      expect(body.title).toBe('Tech Design: Auth System');
      expect(body.total_length).toBe(testDocument.length);
      expect(body.sections).toHaveLength(6);

      // Check first section
      expect(body.sections[0].heading).toBe('Overview');
      expect(body.sections[0].level).toBe(1);
      expect(body.sections[0].content).toBe('This is the overview section.');

      // Check nested sections
      const technicalDesign = body.sections.find((s: any) => s.heading === 'Technical Design');
      expect(technicalDesign).toBeDefined();
      expect(technicalDesign.level).toBe(2);
      expect(technicalDesign.content).toBe('This section covers the technical design.');

      const apiChanges = body.sections.find((s: any) => s.heading === 'API Changes');
      expect(apiChanges).toBeDefined();
      expect(apiChanges.level).toBe(3);
      expect(apiChanges.content).toContain('Added new endpoints');
    });

    it('should omit content when include_content=false', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/outline?include_content=false`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.sections).toHaveLength(6);
      expect(body.sections[0].heading).toBe('Overview');
      expect(body.sections[0]).not.toHaveProperty('content');
    });

    it('should return 404 for non-existent memory', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${fakeId}/outline`
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/not-a-uuid/outline`
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/memories/:memoryId/sections/:heading', () => {
    it('should return a specific section by heading', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.memory_id).toBe(memoryId);
      expect(body.heading).toBe('Technical Design');
      expect(body.level).toBe(2);
      expect(body.content).toContain('## Technical Design');
      expect(body.content).toContain('### API Changes');
      expect(body.content).toContain('### Database Schema');
    });

    it('should include subsections by default', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.content).toContain('### API Changes');
      expect(body.content).toContain('### Database Schema');
    });

    it('should exclude subsections when include_subsections=false', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design?include_subsections=false`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.content).toContain('## Technical Design');
      expect(body.content).toContain('This section covers the technical design.');
      expect(body.content).not.toContain('### API Changes');
    });

    it('should be case-insensitive when finding sections', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/technical%20design`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.heading).toBe('Technical Design');
    });

    it('should return 404 for non-existent section', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Non%20Existent%20Section`
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('not found');
    });

    it('should return nested subsection content', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/API%20Changes`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.heading).toBe('API Changes');
      expect(body.level).toBe(3);
      expect(body.content).toContain('Added new endpoints');
    });
  });

  describe('GET /api/memories/:memoryId/search', () => {
    it('should return matching sections with contextual excerpts', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/search?q=${encodeURIComponent('endpoints')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.memory_id).toBe(memoryId);
      expect(body.query).toBe('endpoints');
      expect(body.match_count).toBeGreaterThan(0);
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].heading).toBe('API Changes');
      expect(body.sections[0].hits[0].excerpt).toContain('**endpoints**');
      expect(body.markdown).toContain('## API Changes');
    });

    it('should return multiple matching sections when the term appears in more than one section', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/search?q=${encodeURIComponent('tests')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.sections.length).toBeGreaterThanOrEqual(1);
      expect(body.markdown).toContain('Query: `tests`');
    });

    it('should return document body for memories without headings', async () => {
      const noHeadingsResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'search-no-headings-doc',
          title: 'Search No Headings Doc',
          content: 'Plain text only. Search should still find this sentence.',
          type: 'user-note'
        }
      });
      const noHeadingsId = JSON.parse(noHeadingsResult.payload).memory.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${noHeadingsId}/search?q=${encodeURIComponent('sentence')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].heading).toBe('Document body');
      expect(body.sections[0].hits[0].excerpt).toContain('**sentence**');
    });

    it('should return zero matches when the term is not present', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/search?q=${encodeURIComponent('nonexistent-term')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.match_count).toBe(0);
      expect(body.sections).toEqual([]);
      expect(body.markdown).toContain('No matches found.');
    });

    it('should search chunked memories and return the matching section', async () => {
      const largeSection = 'alpha '.repeat(500);
      const chunkedResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'chunked-search-doc',
          title: 'Chunked Search Doc',
          content: `# Intro\n\n${largeSection}\n\n## Deep Section\n\nThis contains the targetterm inside a large memory.`,
          type: 'user-note'
        }
      });
      const chunkedId = JSON.parse(chunkedResult.payload).memory.id;

      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${chunkedId}/search?q=${encodeURIComponent('targetterm')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].heading).toBe('Deep Section');
      expect(body.sections[0].hits[0].excerpt).toContain('**targetterm**');

      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
        [chunkedId]
      );
      expect(chunks.rows.length).toBeGreaterThan(0);
    });

    it('should return 400 when q is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/search`
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.payload).error).toContain('q is required');
    });
  });

  describe('PATCH /api/memories/:memoryId/sections/:heading', () => {
    it('should update a section without affecting other sections', async () => {
      const newContent = 'Updated technical design content.\n\nNew subsection info.';

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`,
        payload: { content: newContent }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.memory).toBeDefined();
      expect(body.memory.id).toBe(memoryId);

      // Verify the update by fetching the section
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`
      });

      const section = JSON.parse(getResponse.payload);
      expect(section.content).toContain('Updated technical design content');

      // Verify other sections are preserved
      const overviewResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Overview`
      });

      const overview = JSON.parse(overviewResponse.payload);
      expect(overview.content).toContain('This is the overview section');

      const testingResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Testing%20Plan`
      });

      const testing = JSON.parse(testingResponse.payload);
      expect(testing.content).toContain('Unit tests');
    });

    it('should preserve the heading and subsections when updating h1 content', async () => {
      const newContent = 'Completely new overview content.';

      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Overview`,
        payload: { content: newContent }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Overview`
      });

      const body = JSON.parse(response.payload);
      expect(body.content).toContain('# Overview');
      expect(body.content).toContain('Completely new overview content');

      // Subsections must survive the h1 update
      expect(body.content).toContain('## Technical Design');
      expect(body.content).toContain('## Testing Plan');
      expect(body.content).toContain('## Conclusion');
    });

    it('should return 404 for non-existent section', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Non%20Existent`,
        payload: { content: 'New content' }
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 when content is missing', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Overview`,
        payload: {}
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle updating the last section', async () => {
      const newContent = 'Updated conclusion with final remarks.';

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Conclusion`,
        payload: { content: newContent }
      });

      expect(response.statusCode).toBe(200);

      // Verify update
      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Conclusion`
      });

      const section = JSON.parse(getResponse.payload);
      expect(section.content).toContain('Updated conclusion');
    });

    it('should preserve h3 subsections when updating an h2 parent', async () => {
      const newContent = 'Rewritten technical design intro.';

      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`,
        payload: { content: newContent }
      });

      // Verify direct content was replaced
      const sectionResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`
      });
      const section = JSON.parse(sectionResponse.payload);
      expect(section.content).toContain('Rewritten technical design intro');

      // Verify h3 children still exist
      expect(section.content).toContain('### API Changes');
      expect(section.content).toContain('### Database Schema');
      expect(section.content).toContain('Added new endpoints');
      expect(section.content).toContain('users table');
    });

    it('should replace entire section including subsections when replace_subsections is true', async () => {
      const newContent = 'This replaces everything under Technical Design.';

      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`,
        payload: { content: newContent, replace_subsections: true }
      });

      const sectionResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`
      });
      const section = JSON.parse(sectionResponse.payload);
      expect(section.content).toContain('This replaces everything under Technical Design');

      // h3 children should be gone
      expect(section.content).not.toContain('### API Changes');
      expect(section.content).not.toContain('### Database Schema');

      // Sibling sections still exist
      const testingResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Testing%20Plan`
      });
      expect(testingResponse.statusCode).toBe(200);
      expect(JSON.parse(testingResponse.payload).content).toContain('Unit tests');
    });

    it('should not change behavior for leaf sections (no children)', async () => {
      const newContent = 'Updated conclusion text.';

      await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Conclusion`,
        payload: { content: newContent }
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Conclusion`
      });

      const body = JSON.parse(response.payload);
      expect(body.content).toContain('Updated conclusion text');
      expect(body.content).toContain('## Conclusion');
    });

    it('should re-chunk content if it grows large', async () => {
      // Create a large update
      const largeContent = 'x'.repeat(3000);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${memoryId}/sections/Technical%20Design`,
        payload: { content: largeContent }
      });

      expect(response.statusCode).toBe(200);

      // Check that chunks were created
      const chunks = await client.query(
        'SELECT * FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
        [memoryId]
      );

      expect(chunks.rows.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle document with only one section', async () => {
      // Create a simple document
      const simpleResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'simple-doc',
          title: 'Simple Doc',
          content: '# Only Section\n\nThis is the only section.',
          type: 'user-note'
        }
      });

      const simpleId = JSON.parse(simpleResult.payload).memory.id;

      const outlineResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${simpleId}/outline`
      });

      const outline = JSON.parse(outlineResponse.payload);
      expect(outline.sections).toHaveLength(1);
      expect(outline.sections[0].heading).toBe('Only Section');
    });

    it('should handle document without any headings', async () => {
      const noHeadingsResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'no-headings-doc',
          title: 'No Headings Doc',
          content: 'This is just plain text.\n\nNo headings here.',
          type: 'user-note'
        }
      });

      const noHeadingsId = JSON.parse(noHeadingsResult.payload).memory.id;

      const outlineResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${noHeadingsId}/outline`
      });

      const outline = JSON.parse(outlineResponse.payload);
      expect(outline.sections).toHaveLength(0);
    });

    it('should handle headings with special characters', async () => {
      const specialResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'special-chars-doc',
          title: 'Special Chars Doc',
          content: '# API: /users/:id\n\nEndpoint docs.\n\n## Response & Errors\n\nError handling.',
          type: 'user-note'
        }
      });

      const specialId = JSON.parse(specialResult.payload).memory.id;

      // URL-encode the heading with special chars
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${specialId}/sections/${encodeURIComponent('API: /users/:id')}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.heading).toBe('API: /users/:id');
    });

    it('should rename heading when new_heading is provided', async () => {
      const renameResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'rename-test-doc',
          title: 'Rename Test Doc',
          content: '# Overview\n\nIntro.\n\n## Old Heading\n\nSome content.\n\n## Conclusion\n\nEnd.',
          type: 'user-note'
        }
      });

      const renameId = JSON.parse(renameResult.payload).memory.id;

      // Update with new_heading
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${renameId}/sections/Old%20Heading`,
        payload: {
          content: 'Updated content here.',
          new_heading: 'New Heading'
        }
      });

      expect(updateResponse.statusCode).toBe(200);

      // Verify old heading no longer exists
      const oldResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${renameId}/sections/Old%20Heading`
      });
      expect(oldResponse.statusCode).toBe(404);

      // Verify new heading exists with content
      const newResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${renameId}/sections/New%20Heading`
      });
      expect(newResponse.statusCode).toBe(200);
      const body = JSON.parse(newResponse.payload);
      expect(body.heading).toBe('New Heading');
      expect(body.content).toContain('Updated content here.');
      expect(body.level).toBe(2); // Should preserve h2 level
    });

    it('should disambiguate duplicate headings with index parameter', async () => {
      const dupResult = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'duplicate-headings-doc',
          title: 'Duplicate Headings Doc',
          content: '# Overview\n\nFirst overview.\n\n## Details\n\nSome details.\n\n# Overview\n\nSecond overview.',
          type: 'user-note'
        }
      });

      const dupId = JSON.parse(dupResult.payload).memory.id;

      // GET first Overview (index 0, default)
      const firstResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${dupId}/sections/Overview`
      });
      expect(firstResponse.statusCode).toBe(200);
      expect(JSON.parse(firstResponse.payload).content).toContain('First overview');

      // GET second Overview (index 1)
      const secondResponse = await app.inject({
        method: 'GET',
        url: `/api/memories/${dupId}/sections/Overview?index=1`
      });
      expect(secondResponse.statusCode).toBe(200);
      expect(JSON.parse(secondResponse.payload).content).toContain('Second overview');

      // PATCH second Overview
      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/api/memories/${dupId}/sections/Overview`,
        payload: {
          content: 'Updated second overview.',
          index: 1
        }
      });
      expect(patchResponse.statusCode).toBe(200);

      // Verify first Overview unchanged
      const verifyFirst = await app.inject({
        method: 'GET',
        url: `/api/memories/${dupId}/sections/Overview`
      });
      expect(JSON.parse(verifyFirst.payload).content).toContain('First overview');

      // Verify second Overview updated
      const verifySecond = await app.inject({
        method: 'GET',
        url: `/api/memories/${dupId}/sections/Overview?index=1`
      });
      expect(JSON.parse(verifySecond.payload).content).toContain('Updated second overview');
    });

    it('should return 404 when index exceeds occurrences', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/memories/${memoryId}/sections/Overview?index=5`
      });
      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.payload).error).toContain('at index 5');
    });
  });
});
