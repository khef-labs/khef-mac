#!/usr/bin/env node
/*
  sync:user-rules-to-disk
  - Fetch assistant-rule memories from the 'user' project via the khef API
  - Delegate to agent-specific updaters to determine which files to update
    (e.g., ~/.codex/AGENTS.md or ~/.claude/CLAUDE.md), and which headings/descriptions
  - No-ops if agent-specific target directories do not exist
  - Idempotent: replaces the Khef rules section with latest rules
*/

const dotenv = require('dotenv');
const { expand } = require('dotenv-expand');
expand(dotenv.config());

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyCodexRules } = require('./agents/codex');
const { applyClaudeRules } = require('./agents/claude');

const API_BASE = process.env.KHEF_API_URL || `http://localhost:${process.env.PORT || 3100}`;
const PROJECT_HANDLE = 'user';

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

async function fetchUserAgentRules() {
  // Use project_handle to allow non-UUID identifiers (e.g., reserved 'user' project)
  // Filter by status=active to exclude deprecated/inactive rules
  const url = `${API_BASE}/api/memories?project_handle=${encodeURIComponent(
    PROJECT_HANDLE
  )}&type=assistant-rule&status=active&limit=1000`;
  const resp = await requestJson(url);
  if (resp && Array.isArray(resp.memories)) {
    return resp.memories;
  }
  throw new Error('Unexpected response; expected an object with a memories array.');
}

async function main() {
  try {
    const rules = await fetchUserAgentRules();
    const results = [];

    // Delegate to agent-specific handlers
    results.push(...applyCodexRules(rules));
    results.push(...applyClaudeRules(rules));

    if (results.length === 0) {
      const codexTarget = path.join(os.homedir(), '.codex', 'AGENTS.md');
      const claudeTarget = path.join(os.homedir(), '.claude', 'CLAUDE.md');
      const anyTargetExists = fs.existsSync(codexTarget) || fs.existsSync(claudeTarget);
      if (anyTargetExists) {
        console.log('No changes. Agent rules are already up to date.');
      } else {
        console.log('No agent rule files detected; nothing to sync.');
        console.log('Tip: create ~/.codex/AGENTS.md or ~/.claude/CLAUDE.md to enable syncing.');
      }
    } else {
      for (const r of results) {
        console.log(`Updated ${r.target} with Khef agent rules.`);
      }
    }
  } catch (err) {
    console.error('Failed to sync user rules:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
