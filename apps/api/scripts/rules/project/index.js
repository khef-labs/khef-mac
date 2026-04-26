#!/usr/bin/env node
/*
  sync:project-rules-to-disk
  - Fetch assistant-rule memories for a specific project via the khef API
  - Upsert a generated rules block into <project>/AGENTS.local.md and <project>/CLAUDE.local.md
  - Defaults project handle to the current directory name; accepts override via CLI arg
  - Idempotent: replaces the Khef rules section between markers
*/

const dotenv = require('dotenv');
const { expand } = require('dotenv-expand');
expand(dotenv.config());

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const { applyProjectCodexRules } = require('./agents/codex');
const { applyProjectClaudeRules } = require('./agents/claude');

const API_BASE = process.env.KHEF_API_URL || `http://localhost:${process.env.PORT || 3100}`;

function requestJson(urlStr) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data || 'null'));
              } catch (e) {
                reject(new Error('Failed to parse JSON'));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function fetchProjectAgentRules(projectHandle) {
  // Use project_handle to resolve the project from its slug/handle
  // Filter by status=active to exclude deprecated/inactive rules
  const url = `${API_BASE}/api/memories?project_handle=${encodeURIComponent(
    projectHandle
  )}&type=assistant-rule&status=active&limit=1000`;
  const resp = await requestJson(url);
  if (resp && Array.isArray(resp.memories)) {
    return resp.memories;
  }
  throw new Error('Unexpected response; expected an object with a memories array.');
}

function printUsageAndExit() {
  const self = path.basename(process.argv[1] || 'sync:project-rules-to-disk');
  console.log(`Usage:\n  ${self} [<project-handle>] [<location>]\n\nExamples:\n  ${self}\n  ${self} khef\n  ${self} my-project ~/projects/my-project`);
  process.exit(0);
}

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2).filter(Boolean);
  if (args.includes('-h') || args.includes('--help')) return printUsageAndExit();

  const defaultHandle = path.basename(cwd);
  const projectHandle = args[0] || defaultHandle;
  const locationArg = args[1] ? path.resolve(args[1]) : cwd;

  try {
    const rules = await fetchProjectAgentRules(projectHandle);
    const results = [];

    results.push(...applyProjectCodexRules(rules || [], locationArg, projectHandle));
    results.push(...applyProjectClaudeRules(rules || [], locationArg, projectHandle));

    if (results.length === 0) {
      if (!rules || rules.length === 0) {
        console.log('No project agent rules found; no generated sections to remove.');
      } else {
        console.log('No changes. Project rules are already up to date.');
      }
    } else {
      for (const r of results) {
        console.log(`Updated ${r.target} with Khef agent rules for project "${projectHandle}".`);
      }
    }
  } catch (err) {
    console.error('Failed to sync project rules:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
