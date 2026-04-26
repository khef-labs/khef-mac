#!/usr/bin/env node
/**
 * Split the monolithic openapi.yaml into per-resource files.
 *
 * Usage: node scripts/split-openapi.mjs
 *
 * This script:
 * 1. Parses docs/api/openapi.yaml
 * 2. Extracts components/parameters, components/schemas, and components/responses into separate files
 * 3. Groups paths by resource and writes them to paths/*.yaml files
 * 4. Rewrites $ref paths to point to the new file locations
 * 5. Writes a new root openapi.yaml with $ref pointers
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '..', 'docs', 'api');
const PATHS_DIR = join(API_DIR, 'paths');
const COMPONENTS_DIR = join(API_DIR, 'components');

// Resource grouping: map path prefixes to resource file names
// Order matters — more specific prefixes must come first
const PATH_GROUPS = [
  // Assistant sub-resources (must come before generic /api/assistants)
  { prefix: '/api/assistants/{handle}/agents', file: 'agents' },
  { prefix: '/api/assistants/{handle}/sessions', file: 'sessions' },
  { prefix: '/api/assistants/{handle}/plans', file: 'plans' },
  { prefix: '/api/assistants/{handle}/memories', file: 'assistant-memories' },
  { prefix: '/api/assistants/{handle}/mcp-servers', file: 'mcp-servers' },
  // Assistants base
  { prefix: '/api/assistants', file: 'assistants' },
  // Project sub-resources (must come before generic /api/projects)
  { prefix: '/api/projects/{projectId}/memories', file: 'memories' },
  { prefix: '/api/projects/{projectId}/knowledge', file: 'knowledge' },
  { prefix: '/api/projects/{projectId}/memory-types', file: 'memory-types' },
  { prefix: '/api/projects/{projectId}/tags', file: 'tags' },
  { prefix: '/api/projects/{projectId}/files', file: 'files' },
  { prefix: '/api/projects/{projectId}/git', file: 'diffs' },
  { prefix: '/api/projects/{projectId}/diffs', file: 'diffs' },
  { prefix: '/api/projects/{projectId}/configs', file: 'projects' },
  // Projects base
  { prefix: '/api/projects', file: 'projects' },
  // Global memories
  { prefix: '/api/memories', file: 'memories' },
  // Memory types (global)
  { prefix: '/api/memory-types', file: 'memory-types' },
  // Relations
  { prefix: '/api/relation-types', file: 'relations' },
  { prefix: '/api/relations', file: 'relations' },
  // Tags (global)
  { prefix: '/api/tags', file: 'tags' },
  // Configs
  { prefix: '/api/configs', file: 'configs' },
  // Diagram
  { prefix: '/api/diagram', file: 'diagram' },
  // Settings
  { prefix: '/api/settings', file: 'settings' },
  // Stats
  { prefix: '/api/stats', file: 'health' },
  { prefix: '/api/initialize_session', file: 'health' },
  // Files (global)
  { prefix: '/api/files', file: 'files' },
  // Gemini
  { prefix: '/api/gemini', file: 'gemini' },
  // Active sessions
  { prefix: '/api/active-sessions', file: 'active-sessions' },
  // Vector
  { prefix: '/api/vector', file: 'vector' },
  // Rules
  { prefix: '/api/rules', file: 'rules' },
  // Diffs (global)
  { prefix: '/api/diffs', file: 'diffs' },
  // Plans (global export)
  { prefix: '/api/plans', file: 'plans' },
  // Sessions (synced)
  { prefix: '/api/sessions', file: 'sessions' },
  // MCP servers (global)
  { prefix: '/api/mcp-servers', file: 'mcp-servers' },
  // Health
  { prefix: '/health', file: 'health' },
];

function classifyPath(pathKey) {
  for (const group of PATH_GROUPS) {
    if (pathKey === group.prefix || pathKey.startsWith(group.prefix + '/') || pathKey.startsWith(group.prefix + '{')) {
      return group.file;
    }
  }
  console.warn(`WARNING: Unclassified path: ${pathKey}`);
  return 'uncategorized';
}

/**
 * Convert a path like /api/projects/{projectId} to a PascalCase anchor name.
 * e.g. /api/projects → Projects
 * e.g. /api/projects/{projectId} → ProjectById
 * e.g. /api/projects/{projectId}/memories/{memoryId}/comments → ProjectMemoryComments
 */
function pathToAnchorName(pathKey) {
  // Remove /api/ prefix
  let p = pathKey.replace(/^\/api\//, '').replace(/^\//, '');

  // Replace path params with "ById" or meaningful names
  // Split into segments
  const segments = p.split('/');
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('{') && seg.endsWith('}')) {
      // Path parameter — skip it, the previous segment implies it
      // But mark that we're looking at a "by id" variant
      if (parts.length > 0) {
        parts[parts.length - 1] += 'ById';
      }
    } else {
      // Convert kebab-case to PascalCase
      const pascal = seg
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
      // Singularize common plurals for "ById" readability
      parts.push(pascal);
    }
  }

  return parts.join('') || 'Root';
}

/**
 * Recursively rewrite $ref strings in an object.
 * '#/components/schemas/X' → '../components/schemas.yaml#/X'
 * '#/components/parameters/X' → '../components/parameters.yaml#/X'
 */
function rewriteRefs(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => rewriteRefs(item));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#/components/schemas/')) {
          const schemaName = value.replace('#/components/schemas/', '');
          result[key] = `../components/schemas.yaml#/${schemaName}`;
        } else if (value.startsWith('#/components/parameters/')) {
          const paramName = value.replace('#/components/parameters/', '');
          result[key] = `../components/parameters.yaml#/${paramName}`;
        } else if (value.startsWith('#/components/responses/')) {
          const responseName = value.replace('#/components/responses/', '');
          result[key] = `../components/responses.yaml#/${responseName}`;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = rewriteRefs(value);
      }
    }
    return result;
  }
  return obj;
}

function dumpYaml(obj) {
  return yaml.dump(obj, {
    lineWidth: 120,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
    sortKeys: false,
  });
}

// ---- Main ----

console.log('Reading openapi.yaml...');
const raw = readFileSync(join(API_DIR, 'openapi.yaml'), 'utf-8');
const spec = yaml.load(raw);

// Create directories
mkdirSync(PATHS_DIR, { recursive: true });
mkdirSync(COMPONENTS_DIR, { recursive: true });

// ---- Extract components ----

console.log('Extracting components/parameters.yaml...');
const parameters = spec.components?.parameters || {};
writeFileSync(
  join(COMPONENTS_DIR, 'parameters.yaml'),
  dumpYaml(parameters)
);
console.log(`  ${Object.keys(parameters).length} parameters`);

console.log('Extracting components/schemas.yaml...');
const schemas = spec.components?.schemas || {};
// Rewrite any internal $ref within schemas (schemas referencing other schemas)
const rewrittenSchemas = {};
for (const [name, schema] of Object.entries(schemas)) {
  rewrittenSchemas[name] = rewriteSchemaRefs(schema);
}
writeFileSync(
  join(COMPONENTS_DIR, 'schemas.yaml'),
  dumpYaml(rewrittenSchemas)
);
console.log(`  ${Object.keys(schemas).length} schemas`);

console.log('Extracting components/responses.yaml...');
const responses = spec.components?.responses || {};
// Rewrite $refs within responses (they reference schemas)
const rewrittenResponses = {};
for (const [name, response] of Object.entries(responses)) {
  rewrittenResponses[name] = rewriteResponseRefs(response);
}
writeFileSync(
  join(COMPONENTS_DIR, 'responses.yaml'),
  dumpYaml(rewrittenResponses)
);
console.log(`  ${Object.keys(responses).length} responses`);

/**
 * Rewrite $ref within responses — references to schemas become local to schemas.yaml
 */
function rewriteResponseRefs(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => rewriteResponseRefs(item));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#/components/schemas/')) {
          const schemaName = value.replace('#/components/schemas/', '');
          result[key] = `schemas.yaml#/${schemaName}`;
        } else if (value.startsWith('#/components/responses/')) {
          const responseName = value.replace('#/components/responses/', '');
          result[key] = `#/${responseName}`;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = rewriteResponseRefs(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Rewrite $ref within schemas — schemas reference other schemas in the same file,
 * so '#/components/schemas/X' → '#/X' (local ref within schemas.yaml)
 * But parameters refs should point to the parameters file.
 */
function rewriteSchemaRefs(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => rewriteSchemaRefs(item));
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value.startsWith('#/components/schemas/')) {
          const schemaName = value.replace('#/components/schemas/', '');
          result[key] = `#/${schemaName}`;
        } else if (value.startsWith('#/components/parameters/')) {
          const paramName = value.replace('#/components/parameters/', '');
          result[key] = `../components/parameters.yaml#/${paramName}`;
        } else if (value.startsWith('#/components/responses/')) {
          const responseName = value.replace('#/components/responses/', '');
          result[key] = `../components/responses.yaml#/${responseName}`;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = rewriteSchemaRefs(value);
      }
    }
    return result;
  }
  return obj;
}

// ---- Group and extract paths ----

console.log('Grouping paths by resource...');
const pathsByResource = {};
const anchorsByPath = {};

for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
  const resource = classifyPath(pathKey);
  if (!pathsByResource[resource]) {
    pathsByResource[resource] = {};
  }
  const anchor = pathToAnchorName(pathKey);

  // Handle duplicate anchors within same resource file
  let finalAnchor = anchor;
  let counter = 2;
  while (pathsByResource[resource][finalAnchor] !== undefined) {
    finalAnchor = `${anchor}${counter}`;
    counter++;
  }

  pathsByResource[resource][finalAnchor] = rewriteRefs(pathItem);
  anchorsByPath[pathKey] = { resource, anchor: finalAnchor };
}

// Write path files
for (const [resource, anchors] of Object.entries(pathsByResource)) {
  const filePath = join(PATHS_DIR, `${resource}.yaml`);
  writeFileSync(filePath, dumpYaml(anchors));
  console.log(`  paths/${resource}.yaml — ${Object.keys(anchors).length} paths`);
}

// ---- Write root openapi.yaml ----

console.log('Writing new root openapi.yaml...');

const rootPaths = {};
for (const [pathKey, { resource, anchor }] of Object.entries(anchorsByPath)) {
  rootPaths[pathKey] = { '$ref': `paths/${resource}.yaml#/${anchor}` };
}

const rootComponents = {
  parameters: {},
  schemas: {},
  responses: {},
};
for (const paramName of Object.keys(parameters)) {
  rootComponents.parameters[paramName] = { '$ref': `components/parameters.yaml#/${paramName}` };
}
for (const schemaName of Object.keys(schemas)) {
  rootComponents.schemas[schemaName] = { '$ref': `components/schemas.yaml#/${schemaName}` };
}
for (const responseName of Object.keys(responses)) {
  rootComponents.responses[responseName] = { '$ref': `components/responses.yaml#/${responseName}` };
}

const root = {
  openapi: spec.openapi,
  info: spec.info,
  servers: spec.servers,
  tags: spec.tags,
  paths: rootPaths,
  components: rootComponents,
};

writeFileSync(join(API_DIR, 'openapi.yaml'), dumpYaml(root));

// ---- Summary ----

const resourceFiles = Object.keys(pathsByResource);
const totalPaths = Object.keys(anchorsByPath).length;
console.log(`\nDone!`);
console.log(`  Root: docs/api/openapi.yaml`);
console.log(`  Path files: ${resourceFiles.length} (${totalPaths} paths total)`);
console.log(`  Components: parameters.yaml (${Object.keys(parameters).length}), schemas.yaml (${Object.keys(schemas).length}), responses.yaml (${Object.keys(responses).length})`);
console.log(`\nResource files: ${resourceFiles.sort().join(', ')}`);
