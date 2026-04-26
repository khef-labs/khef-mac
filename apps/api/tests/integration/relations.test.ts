import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { setupTestDb, cleanupTestDb, TEST_DATABASE_URL } from '../setup';

// Set env before importing routes so db client uses correct URL
process.env.DATABASE_URL = TEST_DATABASE_URL;

import projectRoutes from '../../src/routes/projects';
import projectMemoryRoutes from '../../src/routes/project-memories';
import relationRoutes from '../../src/routes/relations';

describe('Memory Relations Integration Tests', () => {
  let app: FastifyInstance;
  let client: Client;
  let projectId: string;

  beforeAll(async () => {
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

    const result = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'Test Project',
        description: 'A test project'
      }
    });

    if (result.statusCode !== 201) {
      console.error('Failed to create project:', result.statusCode, result.payload);
      throw new Error(`Failed to create project: ${result.payload}`);
    }

    projectId = JSON.parse(result.payload).project.id;
  });

  describe('Relate Memories', () => {
    it('should create a relates_to relation between memories', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'auth-flow',
          title: 'auth-flow',
          content: 'User authentication flow',
          type: 'context'
        }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'session-mgmt',
          title: 'session-mgmt',
          content: 'Session management details',
          type: 'context'
        }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      expect(relationRes.statusCode).toBe(201);
      const body = JSON.parse(relationRes.payload);
      expect(body.relation.source_memory_id).toBe(mem1Id);
      expect(body.relation.target_memory_id).toBe(mem2Id);
      expect(body.relation.relation_type).toBe('relates_to');
    });

    it('should create a contradicts relation', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'mongo-decision',
          title: 'mongo-decision',
          content: 'Use MongoDB for primary database',
          type: 'decision'
        }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'postgres-decision',
          title: 'postgres-decision',
          content: 'PostgreSQL chosen for ACID guarantees',
          type: 'decision'
        }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'contradicts'
        }
      });

      expect(relationRes.statusCode).toBe(201);
      expect(JSON.parse(relationRes.payload).relation.relation_type).toBe('contradicts');
    });

    it('should create depends_on and supports relations', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'api-gateway',
          title: 'api-gateway',
          content: 'API Gateway handles authentication',
          type: 'api'
        }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'microservices-trust',
          title: 'microservices-trust',
          content: 'Microservices trust gateway tokens',
          type: 'api'
        }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const dependsRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem2Id,
          target_memory_id: mem1Id,
          relation_type: 'depends_on'
        }
      });

      expect(dependsRes.statusCode).toBe(201);

      const supportsRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'supports'
        }
      });

      expect(supportsRes.statusCode).toBe(201);
    });

    it('should reject self-referential relations', async () => {
      const memRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: {
          handle: 'some-memory',
          title: 'some-memory',
          content: 'Some memory',
          type: 'user-note'
        }
      });

      const memId = JSON.parse(memRes.payload).memory.id;

      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: memId,
          target_memory_id: memId,
          relation_type: 'relates_to'
        }
      });

      expect(relationRes.statusCode).toBe(400);
    });
  });

  describe('Get Memory Relations', () => {
    it('should get incoming and outgoing relations for a memory', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-1', title: 'Memory 1', content: 'Memory 1', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-2', title: 'Memory 2', content: 'Memory 2', type: 'user-note' }
      });

      const mem3Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-3', title: 'Memory 3', content: 'Memory 3', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;
      const mem3Id = JSON.parse(mem3Res.payload).memory.id;

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem3Id,
          target_memory_id: mem1Id,
          relation_type: 'supports'
        }
      });

      const relationsRes = await app.inject({
        method: 'GET',
        url: `/api/relations/memory/${mem1Id}`
      });

      expect(relationsRes.statusCode).toBe(200);
      const body = JSON.parse(relationsRes.payload);

      // New flat format with contextual relation types
      expect(body.relations.length).toBe(2);

      // Find the outgoing relation (mem1 -> mem2, relates_to)
      const outgoingRelation = body.relations.find((r: any) => r.relation_type === 'relates_to');
      expect(outgoingRelation).toBeDefined();
      expect(outgoingRelation.related_memory.id).toBe(mem2Id);
      expect(outgoingRelation.related_memory).toHaveProperty('project_handle');
      expect(outgoingRelation.related_memory).toHaveProperty('handle');

      // Find the incoming relation (mem3 -> mem1, shows as is_supported_by from mem1's perspective)
      const incomingRelation = body.relations.find((r: any) => r.relation_type === 'is_supported_by');
      expect(incomingRelation).toBeDefined();
      expect(incomingRelation.related_memory.id).toBe(mem3Id);
      expect(incomingRelation.related_memory).toHaveProperty('project_handle');
      expect(incomingRelation.related_memory).toHaveProperty('handle');
    });
  });

  describe('Get Memory Graph', () => {
    it('should traverse memory relations graph', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'root', title: 'Root', content: 'Root', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'child-1', title: 'Child 1', content: 'Child 1', type: 'user-note' }
      });

      const mem3Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'grandchild', title: 'Grandchild', content: 'Grandchild', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;
      const mem3Id = JSON.parse(mem3Res.payload).memory.id;

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem2Id,
          target_memory_id: mem3Id,
          relation_type: 'relates_to'
        }
      });

      const graphRes = await app.inject({
        method: 'GET',
        url: `/api/relations/memory/${mem1Id}/graph?depth=2`
      });

      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);

      expect(body.nodes.length).toBeGreaterThanOrEqual(2);
      expect(body.edges.length).toBeGreaterThanOrEqual(1);

      const nodeIds = body.nodes.map((n: any) => n.id);
      expect(nodeIds).toContain(mem1Id);
      expect(nodeIds).toContain(mem2Id);
    });

    it('should return compact graph by default with excerpts and project info', async () => {
      const pRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Graph Compact' } });
      const pid = JSON.parse(pRes.payload).project.id;

      const aRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'a', title: 'A', content: 'Some long content for A', type: 'user-note' } });
      const bRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'b', title: 'B', content: 'Some long content for B', type: 'user-note' } });
      const aId = JSON.parse(aRes.payload).memory.id;
      const bId = JSON.parse(bRes.payload).memory.id;

      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: aId, target_memory_id: bId, relation_type: 'relates_to' } });

      const graphRes = await app.inject({ method: 'GET', url: `/api/relations/memory/${aId}/graph?depth=1` });
      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);
      const node = body.nodes[0];
      expect(node).toHaveProperty('project_handle');
      expect(node).toHaveProperty('project_name');
      expect(node).toHaveProperty('handle');
      expect(node).toHaveProperty('title');
      expect(node).toHaveProperty('content_excerpt');
      expect(node).not.toHaveProperty('content');
    });

    it('should return full nodes when compact=false', async () => {
      const pRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Graph Full' } });
      const pid = JSON.parse(pRes.payload).project.id;

      const aRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'fa', title: 'FA', content: 'Full content A', type: 'user-note' } });
      const bRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'fb', title: 'FB', content: 'Full content B', type: 'user-note' } });
      const aId = JSON.parse(aRes.payload).memory.id;
      const bId = JSON.parse(bRes.payload).memory.id;

      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: aId, target_memory_id: bId, relation_type: 'relates_to' } });

      const graphRes = await app.inject({ method: 'GET', url: `/api/relations/memory/${aId}/graph?depth=1&compact=false` });
      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);
      const node = body.nodes[0];
      expect(node).toHaveProperty('content');
      expect(node).not.toHaveProperty('content_excerpt');
      expect(node).toHaveProperty('project_handle');
      expect(node).toHaveProperty('project_name');
    });

    it('should traverse graph bidirectionally (include incoming relations)', async () => {
      // Create three memories: A -> B <- C
      // When querying from B, both A and C should be found
      const memARes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'mem-a', title: 'Memory A', content: 'Memory A', type: 'user-note' }
      });

      const memBRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'mem-b', title: 'Memory B', content: 'Memory B', type: 'user-note' }
      });

      const memCRes = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'mem-c', title: 'Memory C', content: 'Memory C', type: 'user-note' }
      });

      const memAId = JSON.parse(memARes.payload).memory.id;
      const memBId = JSON.parse(memBRes.payload).memory.id;
      const memCId = JSON.parse(memCRes.payload).memory.id;

      // A -> B (A is source, B is target)
      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: memAId,
          target_memory_id: memBId,
          relation_type: 'supports'
        }
      });

      // C -> B (C is source, B is target)
      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: memCId,
          target_memory_id: memBId,
          relation_type: 'depends_on'
        }
      });

      // Query graph from B - should find both A and C via incoming relations
      const graphRes = await app.inject({
        method: 'GET',
        url: `/api/relations/memory/${memBId}/graph?depth=1`
      });

      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);

      // Should have 3 nodes: A, B, and C
      expect(body.nodes.length).toBe(3);
      const nodeIds = body.nodes.map((n: any) => n.id);
      expect(nodeIds).toContain(memAId);
      expect(nodeIds).toContain(memBId);
      expect(nodeIds).toContain(memCId);

      // Should have 2 edges
      expect(body.edges.length).toBe(2);
    });

    it('should traverse graph bidirectionally from leaf node', async () => {
      // Create: A -> B -> C
      // When querying from C with depth=2, should find B and A by traversing incoming relations
      const pRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Bidirectional Leaf Test' } });
      const pid = JSON.parse(pRes.payload).project.id;

      const aRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'leaf-start', title: 'Leaf Start', content: 'Start node', type: 'user-note' } });
      const bRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'leaf-middle', title: 'Leaf Middle', content: 'Middle node', type: 'user-note' } });
      const cRes = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: 'leaf-end', title: 'Leaf End', content: 'End node', type: 'user-note' } });

      const aId = JSON.parse(aRes.payload).memory.id;
      const bId = JSON.parse(bRes.payload).memory.id;
      const cId = JSON.parse(cRes.payload).memory.id;

      // A -> B
      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: aId, target_memory_id: bId, relation_type: 'relates_to' } });
      // B -> C
      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: bId, target_memory_id: cId, relation_type: 'relates_to' } });

      // Query from C (the leaf node) - should traverse backwards to find B and A
      const graphRes = await app.inject({ method: 'GET', url: `/api/relations/memory/${cId}/graph?depth=2` });
      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);

      // Must contain all three nodes (may contain more if test data persists across tests)
      const nodeIds = body.nodes.map((n: any) => n.id);
      expect(nodeIds).toContain(aId);
      expect(nodeIds).toContain(bId);
      expect(nodeIds).toContain(cId);

      // Must have at least the 2 edges we created
      expect(body.edges.length).toBeGreaterThanOrEqual(2);
      const edgePairs = body.edges.map((e: any) => `${e.source_memory_id}->${e.target_memory_id}`);
      expect(edgePairs).toContain(`${aId}->${bId}`);
      expect(edgePairs).toContain(`${bId}->${cId}`);
    });

    it('should respect max_nodes and set truncated flag', async () => {
      const pRes = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Graph Limit' } });
      const pid = JSON.parse(pRes.payload).project.id;

      const ids: string[] = [];
      for (const h of ['n1', 'n2', 'n3']) {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${pid}/memories`, payload: { handle: h, title: h.toUpperCase(), content: h, type: 'user-note' } });
        ids.push(JSON.parse(res.payload).memory.id);
      }

      // Chain n1->n2->n3
      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: ids[0], target_memory_id: ids[1], relation_type: 'relates_to' } });
      await app.inject({ method: 'POST', url: '/api/relations', payload: { source_memory_id: ids[1], target_memory_id: ids[2], relation_type: 'relates_to' } });

      const graphRes = await app.inject({ method: 'GET', url: `/api/relations/memory/${ids[0]}/graph?depth=3&max_nodes=2&max_edges=1` });
      expect(graphRes.statusCode).toBe(200);
      const body = JSON.parse(graphRes.payload);
      expect(body.nodes.length).toBeLessThanOrEqual(2);
      expect(body.edges.length).toBeLessThanOrEqual(1);
      expect(body.truncated).toBeDefined();
      expect(body.truncated.nodes).toBe(true);
      expect(body.truncated.edges).toBe(true);
    });
  });

  describe('Update Relation', () => {
    it('should update relation_type', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'update-mem-1', title: 'Update Memory 1', content: 'Memory 1', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'update-mem-2', title: 'Update Memory 2', content: 'Memory 2', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      const relationId = JSON.parse(createRes.payload).relation.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/relations/${relationId}`,
        payload: { relation_type: 'supports' }
      });

      expect(updateRes.statusCode).toBe(200);
      const body = JSON.parse(updateRes.payload);
      expect(body.relation.relation_type).toBe('supports');
      expect(body.relation.id).toBe(relationId);
    });

    it('should reject invalid relation_type', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'invalid-type-mem-1', title: 'Invalid Type Memory 1', content: 'Memory 1', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'invalid-type-mem-2', title: 'Invalid Type Memory 2', content: 'Memory 2', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      const relationId = JSON.parse(createRes.payload).relation.id;

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/relations/${relationId}`,
        payload: { relation_type: 'invalid_type' }
      });

      expect(updateRes.statusCode).toBe(400);
    });

    it('should return 404 for non-existent relation', async () => {
      const updateRes = await app.inject({
        method: 'PATCH',
        url: '/api/relations/00000000-0000-0000-0000-000000000000',
        payload: { relation_type: 'supports' }
      });

      expect(updateRes.statusCode).toBe(404);
    });
  });

  describe('Delete Relation', () => {
    it('should delete a relation', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-1', title: 'Memory 1', content: 'Memory 1', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-2', title: 'Memory 2', content: 'Memory 2', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      const createRelRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      const relationId = JSON.parse(createRelRes.payload).relation.id;

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/relations/${relationId}`
      });

      expect(deleteRes.statusCode).toBe(204);

      const relations = await client.query(
        'SELECT * FROM memory_relations WHERE id = $1',
        [relationId]
      );

      expect(relations.rows.length).toBe(0);
    });

    it('should cascade delete relations when memory is deleted', async () => {
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-1', title: 'Memory 1', content: 'Memory 1', type: 'user-note' }
      });

      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-2', title: 'Memory 2', content: 'Memory 2', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectId}/memories/${mem1Id}`
      });

      const relations = await client.query(
        'SELECT * FROM memory_relations WHERE source_memory_id = $1 OR target_memory_id = $1',
        [mem1Id]
      );

      expect(relations.rows.length).toBe(0);
    });
  });

  describe('Cross-Project Relations', () => {
    it('should allow relations between memories from different projects', async () => {
      // Create second project
      const project2Res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Project 2' }
      });
      const project2Id = JSON.parse(project2Res.payload).project.id;

      // Create memory in first project
      const mem1Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/memories`,
        payload: { handle: 'memory-in-project-1', title: 'Memory in project 1', content: 'Memory in project 1', type: 'user-note' }
      });

      // Create memory in second project
      const mem2Res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project2Id}/memories`,
        payload: { handle: 'memory-in-project-2', title: 'Memory in project 2', content: 'Memory in project 2', type: 'user-note' }
      });

      const mem1Id = JSON.parse(mem1Res.payload).memory.id;
      const mem2Id = JSON.parse(mem2Res.payload).memory.id;

      // Create relation across projects
      const relationRes = await app.inject({
        method: 'POST',
        url: '/api/relations',
        payload: {
          source_memory_id: mem1Id,
          target_memory_id: mem2Id,
          relation_type: 'relates_to'
        }
      });

      expect(relationRes.statusCode).toBe(201);
      const body = JSON.parse(relationRes.payload);
      expect(body.relation.source_memory_id).toBe(mem1Id);
      expect(body.relation.target_memory_id).toBe(mem2Id);
      expect(body.relation.relation_type).toBe('relates_to');
    });
  });
});
