import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, TEST_DATABASE_URL } from '../setup';

// Ensure DB URL is set before importing routes
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import relationRoutes from '../../src/routes/relations';

describe('Graph Health Endpoint', () => {
  let app: FastifyInstance;
  let client: Client;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify();
    app.register(projectRoutes, { prefix: '/api/projects' });
    app.register(projectMemoryRoutes, { prefix: '/api/projects/:projectId/memories' });
    app.register(relationRoutes, { prefix: '/api/relations' });

    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE projects CASCADE');
  });

  it('should report orphan count and disconnected subgraphs', async () => {
    // Create project
    const createProj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Graph Project' },
    });
    expect(createProj.statusCode).toBe(201);
    const projectId = JSON.parse(createProj.payload).project.id as string;

    // Create three memories (A, B connected; C orphan)
    const memA = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'a', title: 'A', content: 'A', type: 'user-note' },
    });
    const aId = JSON.parse(memA.payload).memory.id as string;

    const memB = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'b', title: 'B', content: 'B', type: 'user-note' },
    });
    const bId = JSON.parse(memB.payload).memory.id as string;

    const memC = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'c', title: 'C', content: 'C', type: 'user-note' },
    });
    const cId = JSON.parse(memC.payload).memory.id as string;
    expect(cId).toBeTruthy();

    // Relate A -> B
    const rel = await app.inject({
      method: 'POST',
      url: '/api/relations',
      payload: {
        source_memory_id: aId,
        target_memory_id: bId,
        relation_type: 'relates_to',
      },
    });
    expect(rel.statusCode).toBe(201);

    // Query graph health
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/graph-health`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.project_id).toBe(projectId);
    expect(body.summary.total_memories).toBe(3);
    expect(body.summary.total_relations).toBe(1);
    expect(body.summary.orphan_count).toBe(1);
    expect(body.summary.connected_count).toBe(2);
    // components: { A,B } and { C } = 2 components, 1 isolated
    expect(body.summary.components_count).toBe(2);
    expect(body.summary.isolated_component_count).toBe(1);
    expect(body.summary.largest_component_size).toBe(2);

    // Relation types should include relates_to count 1
    const relates = body.relation_types.find((r: any) => r.type === 'relates_to');
    expect(relates.count).toBe(1);
  });

  it('should return 404 for non-existent project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/non-existent-project/graph-health',
    });
    expect(res.statusCode).toBe(404);
  });

  it('should handle empty project with no memories', async () => {
    // Create project with no memories
    const createProj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Empty Project' },
    });
    expect(createProj.statusCode).toBe(201);
    const projectId = JSON.parse(createProj.payload).project.id as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/graph-health`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.summary.total_memories).toBe(0);
    expect(body.summary.orphan_count).toBe(0);
    expect(body.summary.connected_count).toBe(0);
    expect(body.summary.total_relations).toBe(0);
    expect(body.summary.connection_rate).toBe(0);
    expect(body.summary.components_count).toBe(0);
    expect(body.summary.isolated_component_count).toBe(0);
    expect(body.summary.largest_component_size).toBe(0);
    expect(body.orphan_memories).toEqual([]);
    expect(body.relation_types).toEqual([]);
  });

  it('should handle single orphan memory', async () => {
    const createProj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Single Memory Project' },
    });
    const projectId = JSON.parse(createProj.payload).project.id as string;

    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'lonely', title: 'Lonely', content: 'Just me', type: 'user-note' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/graph-health`,
    });
    const body = JSON.parse(res.payload);

    expect(body.summary.total_memories).toBe(1);
    expect(body.summary.orphan_count).toBe(1);
    expect(body.summary.connected_count).toBe(0);
    expect(body.summary.components_count).toBe(1);
    expect(body.summary.isolated_component_count).toBe(0); // Single component, not "isolated"
    expect(body.summary.largest_component_size).toBe(1);
    expect(body.summary.connection_rate).toBe(0);
  });

  it('should handle fully connected graph', async () => {
    const createProj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Connected Project' },
    });
    const projectId = JSON.parse(createProj.payload).project.id as string;

    // Create 3 memories all connected: A -> B -> C
    const memA = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'a', title: 'A', content: 'A', type: 'decision' },
    });
    const aId = JSON.parse(memA.payload).memory.id as string;

    const memB = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'b', title: 'B', content: 'B', type: 'pattern' },
    });
    const bId = JSON.parse(memB.payload).memory.id as string;

    const memC = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/memories`,
      payload: { handle: 'c', title: 'C', content: 'C', type: 'context' },
    });
    const cId = JSON.parse(memC.payload).memory.id as string;

    // A -> B (supports)
    await app.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { source_memory_id: aId, target_memory_id: bId, relation_type: 'supports' },
    });

    // B -> C (depends_on)
    await app.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { source_memory_id: bId, target_memory_id: cId, relation_type: 'depends_on' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/graph-health`,
    });
    const body = JSON.parse(res.payload);

    expect(body.summary.total_memories).toBe(3);
    expect(body.summary.orphan_count).toBe(0);
    expect(body.summary.connected_count).toBe(3);
    expect(body.summary.total_relations).toBe(2);
    expect(body.summary.connection_rate).toBe(100);
    expect(body.summary.components_count).toBe(1);
    expect(body.summary.isolated_component_count).toBe(0);
    expect(body.summary.largest_component_size).toBe(3);

    // Check relation type distribution
    expect(body.relation_types).toHaveLength(2);
    const supports = body.relation_types.find((r: any) => r.type === 'supports');
    const dependsOn = body.relation_types.find((r: any) => r.type === 'depends_on');
    expect(supports.count).toBe(1);
    expect(dependsOn.count).toBe(1);

    // Check memory type stats
    const decisionStats = body.memory_type_stats.find((s: any) => s.type === 'decision');
    expect(decisionStats.total).toBe(1);
    expect(decisionStats.with_relations).toBe(1);
    expect(decisionStats.orphan_count).toBe(0);
  });

  it('should report cross-project edges', async () => {
    // Project A
    const aProj = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Project A' } });
    const aId = JSON.parse(aProj.payload).project.id as string;
    // Project B
    const bProj = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Project B' } });
    const bId = JSON.parse(bProj.payload).project.id as string;

    // Memory in A
    const aMem = await app.inject({ method: 'POST', url: `/api/projects/${aId}/memories`, payload: { handle: 'a1', title: 'A1', content: 'A1', type: 'user-note' } });
    const aMemId = JSON.parse(aMem.payload).memory.id as string;
    // Memory in B
    const bMem = await app.inject({ method: 'POST', url: `/api/projects/${bId}/memories`, payload: { handle: 'b1', title: 'B1', content: 'B1', type: 'user-note' } });
    const bMemId = JSON.parse(bMem.payload).memory.id as string;

    // Cross-project relation A -> B
    const rel = await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: aMemId, target_memory_id: bMemId, relation_type: 'relates_to' } });
    expect(rel.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: `/api/projects/${aId}/graph-health` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    expect(body.summary.total_relations).toBe(1);
    expect(body.cross_project.edges).toBe(1);
    expect(body.cross_project.internal_edges).toBe(0);
    expect(body.cross_project.ratio).toBe(100);
  });
});
