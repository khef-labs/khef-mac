#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_DIR="${HOME}/.codex"
CONFIG_PATH="${CODEX_DIR}/config.toml"
AGENTS_PATH="${CODEX_DIR}/AGENTS.md"
MCP_ENTRY="${ROOT_DIR}/apps/api/mcp-server/build/index.js"
API_URL="${KHEF_API_URL:-http://localhost:3201}"
INSTALL_CODEKS=0
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: scripts/setup-codex.sh [options]

Bootstraps Codex CLI for khef on a fresh machine.

Options:
  --api-url <url>       Override KHEF API URL (default: ${API_URL})
  --skip-build          Do not run npm run mcp:build
  --install-codeks      Install the codeks launcher alias into your shell profile
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
    --install-codeks)
      INSTALL_CODEKS=1
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

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex is not in PATH" >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/package.json" ]]; then
  echo "Error: could not find khef repo root from ${ROOT_DIR}" >&2
  exit 1
fi

if [[ ${SKIP_BUILD} -eq 0 ]]; then
  echo "Building khef MCP server..."
  (cd "${ROOT_DIR}" && npm run mcp:build)
fi

if [[ ! -f "${MCP_ENTRY}" ]]; then
  echo "Error: MCP build output not found at ${MCP_ENTRY}" >&2
  echo "Run: npm run mcp:build" >&2
  exit 1
fi

mkdir -p "${CODEX_DIR}"

if [[ ! -f "${AGENTS_PATH}" ]]; then
  cat > "${AGENTS_PATH}" <<'EOF'
# Codex Global Instructions

This file exists so khef can discover Codex as an installed assistant on this machine.

Project-specific instructions should live in repository `AGENTS.md` or `AGENTS.local.md` files.
User-level khef rules can later be synced here with:

`npm run sync:user-rules-to-disk`
EOF
  echo "Created ${AGENTS_PATH}"
else
  echo "Keeping existing ${AGENTS_PATH}"
fi

KHEF_BLOCK=$(cat <<EOF
[mcp_servers.khef]
command = "node"
args = ["${MCP_ENTRY}"]
startup_timeout_sec = 15
tool_timeout_sec = 60

[mcp_servers.khef.env]
KHEF_API_URL = "${API_URL}"
EOF
)

if [[ -f "${CONFIG_PATH}" ]]; then
  if rg -n '^\[mcp_servers\.khef\]$' "${CONFIG_PATH}" >/dev/null 2>&1; then
    echo "Keeping existing khef MCP entry in ${CONFIG_PATH}"
  else
    {
      printf '\n'
      printf '%s\n' "${KHEF_BLOCK}"
      printf '\n'
    } >> "${CONFIG_PATH}"
    echo "Appended khef MCP entry to ${CONFIG_PATH}"
  fi
else
  printf '%s\n' "${KHEF_BLOCK}" > "${CONFIG_PATH}"
  echo "Created ${CONFIG_PATH}"
fi

mkdir -p "${CODEX_DIR}/prompts"

if [[ ${INSTALL_CODEKS} -eq 1 ]]; then
  bash "${ROOT_DIR}/lib/shell/codeks.sh" --install
fi

cat <<EOF

Codex bootstrap complete.

What this sets up:
- Codex MCP config at ${CONFIG_PATH}
- Discoverable Codex instructions file at ${AGENTS_PATH}
- khef MCP server path: ${MCP_ENTRY}
- KHEF API URL: ${API_URL}

Why this matters:
- khef only shows Codex in the Assistants page after at least one global Codex config file is discovered.
- On a fresh machine, creating ~/.codex/config.toml or ~/.codex/AGENTS.md is enough to make Codex discoverable.

Next steps:
1. Restart Codex so it reloads ~/.codex/config.toml.
2. Restart the khef API, or open the Codex assistant page and trigger config discovery.
3. In Codex, run /mcp and confirm the khef server appears.
4. Optional: run npm run sync:user-rules-to-disk to populate ~/.codex/AGENTS.md with khef-managed rules.
EOF
