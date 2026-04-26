#!/usr/bin/env node
/*
  sync:project-knowledge-to-disk
  - Fetch project knowledge (commands, context, patterns) via the khef API
  - Write KF-PROJECT-KNOWLEDGE.md to the project directory
  - Ensure CLAUDE.local.md imports it via @./KF-PROJECT-KNOWLEDGE.md
  - Defaults project handle to the current directory name; accepts override via CLI arg
  - Idempotent: compares normalized content to avoid unnecessary writes
*/

const dotenv = require('dotenv');
const { expand } = require('dotenv-expand');
expand(dotenv.config());

const path = require('path');
const http = require('http');
const https = require('https');

const { applyProjectClaudeKnowledge } = require('./agents/claude');

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

async function fetchProjectKnowledge(projectHandle) {
  const url = `${API_BASE}/api/projects/${encodeURIComponent(projectHandle)}/knowledge`;
  return requestJson(url);
}

function printUsageAndExit() {
  const self = path.basename(process.argv[1] || 'sync:project-knowledge-to-disk');
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
    const knowledge = await fetchProjectKnowledge(projectHandle);
    const results = [];

    results.push(...applyProjectClaudeKnowledge(knowledge, locationArg, projectHandle));

    const changes = results.filter((r) => r.action !== 'unchanged');
    if (changes.length === 0) {
      console.log('No changes. Project knowledge is already up to date.');
    } else {
      for (const r of changes) {
        const verb = r.action === 'created' ? 'Created' : 'Updated';
        console.log(`${verb} ${r.target}`);
      }
    }
  } catch (err) {
    console.error('Failed to sync project knowledge:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
