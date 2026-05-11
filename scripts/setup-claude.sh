#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_JSON="${HOME}/.claude.json"
MCP_ENTRY="${ROOT_DIR}/apps/api/mcp-server/build/index.js"
API_URL="${KHEF_API_URL:-http://localhost:3201}"
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: scripts/setup-claude.sh [options]

Register khef's MCP server with Claude Code by injecting an entry into ~/.claude.json.
Idempotent — keeps an existing khef entry as-is.

Options:
  --api-url <url>       Override KHEF API URL (default: ${API_URL})
  --skip-build          Do not run npm run mcp:build
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="${2:?missing value for --api-url}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${ROOT_DIR}/package.json" ]]; then
  echo "Error: could not find khef repo root from ${ROOT_DIR}" >&2
  exit 1
fi

if [[ ${SKIP_BUILD} -eq 0 ]]; then
  if [[ ! -f "${MCP_ENTRY}" ]]; then
    echo "Building khef MCP server..."
    (cd "${ROOT_DIR}" && npm run mcp:build)
  fi
fi

if [[ ! -f "${MCP_ENTRY}" ]]; then
  echo "Error: MCP build output not found at ${MCP_ENTRY}" >&2
  echo "Run: npm run mcp:build" >&2
  exit 1
fi

# Use node (already required by the project) for JSON manipulation — no jq dep.
MCP_ENTRY="${MCP_ENTRY}" API_URL="${API_URL}" CLAUDE_JSON="${CLAUDE_JSON}" node <<'NODE'
const fs = require('fs');
const path = require('path');

const claudeJson = process.env.CLAUDE_JSON;
const mcpEntry = process.env.MCP_ENTRY;
const apiUrl = process.env.API_URL;

let config = {};
if (fs.existsSync(claudeJson)) {
  try {
    config = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
  } catch (err) {
    console.error(`Refusing to overwrite malformed ${claudeJson}: ${err.message}`);
    console.error('Fix or remove the file and rerun setup.');
    process.exit(1);
  }
}

if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  console.error(`${claudeJson} root is not a JSON object; refusing to modify.`);
  process.exit(1);
}

config.mcpServers = config.mcpServers || {};

if (config.mcpServers.khef) {
  const existing = config.mcpServers.khef;
  const args = existing.args || [];
  const env = existing.env || {};
  if (args[0] === mcpEntry && env.KHEF_API_URL === apiUrl) {
    console.log(`Keeping existing khef MCP entry in ${claudeJson}`);
    process.exit(0);
  }
  console.log(`Updating khef MCP entry in ${claudeJson}`);
} else {
  console.log(`Adding khef MCP entry to ${claudeJson}`);
}

config.mcpServers.khef = {
  type: 'stdio',
  command: 'node',
  args: [mcpEntry],
  env: {
    KHEF_API_URL: apiUrl,
  },
};

// Best-effort backup of the existing file before writing.
if (fs.existsSync(claudeJson)) {
  const backup = `${claudeJson}.bak.${Date.now()}`;
  fs.copyFileSync(claudeJson, backup);
  console.log(`Backed up previous config to ${backup}`);
}

fs.writeFileSync(claudeJson, JSON.stringify(config, null, 2) + '\n');
console.log(`Wrote ${claudeJson}`);
NODE

cat <<EOF

Claude Code MCP registration complete.

Next steps:
1. Restart Claude Code so it reloads ~/.claude.json.
2. In a Claude session, run /mcp and confirm the khef server appears.
EOF
