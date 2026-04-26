#!/usr/bin/env bash
#
# seed-and-sync: Load seed files into DB, then regenerate KF-*.md files on disk.
#
# Usage:
#   npm run db:seed:sync              # Seed all projects, sync user rules + knowledge
#   npm run db:seed:sync -- khef      # Seed khef project, sync its rules + knowledge
#   npm run db:seed:sync -- user      # Seed user project, sync user rules + knowledge
#
# Requires: khef API running (default http://localhost:3201)

set -euo pipefail

PROJECT="${1:-}"
API_BASE="${KHEF_API_URL:-http://localhost:${PORT:-3201}}"

# Verify API is reachable
if ! curl -sf "$API_BASE/health" > /dev/null 2>&1; then
  echo "Error: khef API not reachable at $API_BASE"
  echo "Start the API first: npm run dev:api"
  exit 1
fi

# Step 1: Seed DB
echo "Seeding database..."
SEED_LOG=$(mktemp)
trap 'rm -f "$SEED_LOG"' EXIT
if [ -n "$PROJECT" ]; then
  npm run db:seed --prefix "$(dirname "$0")/.." -- "$PROJECT" >"$SEED_LOG" 2>&1 || true
else
  npm run db:seed --prefix "$(dirname "$0")/.." >"$SEED_LOG" 2>&1 || true
fi
# Show progress lines
grep -E '(✓|Seed completed|Seeding)' "$SEED_LOG" || true
# Check for failure
if ! grep -q 'Seed completed' "$SEED_LOG"; then
  echo ""
  echo "ERROR: Seeding failed. Full output:"
  cat "$SEED_LOG"
  exit 1
fi
echo ""

# Step 2: Sync rules + knowledge to disk
# Determine which projects to sync
if [ -n "$PROJECT" ]; then
  PROJECTS=("$PROJECT")
else
  # Sync user project (always) plus any project with a configured path
  PROJECTS=("user")
  # Discover projects with paths from the API
  OTHER_PROJECTS=$(curl -sf "$API_BASE/api/projects" | \
    node -e "const d=require('fs').readFileSync(0,'utf8');const p=JSON.parse(d).projects||[];p.filter(x=>x.path&&x.handle!=='user').forEach(x=>console.log(x.handle))" 2>/dev/null || true)
  if [ -n "$OTHER_PROJECTS" ]; then
    while IFS= read -r p; do
      PROJECTS+=("$p")
    done <<< "$OTHER_PROJECTS"
  fi
fi

for handle in "${PROJECTS[@]}"; do
  echo "Syncing $handle..."

  # Sync rules
  RULES_RESULT=$(curl -sf -X POST "$API_BASE/api/rules/sync/project/$handle" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || echo '{"error":"rules sync failed"}')

  echo "$RULES_RESULT" | node -e "
    const d=require('fs').readFileSync(0,'utf8');const r=JSON.parse(d);
    if(r.error){console.log('  rules: ERROR — '+r.error)}
    else{const c=(r.results||[]).filter(x=>x.action!=='unchanged');
    if(c.length)c.forEach(x=>console.log('  rules: '+x.action+' '+x.target));
    else console.log('  rules: up to date')}
  " 2>/dev/null || echo "  rules: error (parse failure)"

  # Sync knowledge
  KNOWLEDGE_RESULT=$(curl -sf -X POST "$API_BASE/api/projects/$handle/knowledge/sync" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || echo '{"error":"knowledge sync failed"}')

  echo "$KNOWLEDGE_RESULT" | node -e "
    const d=require('fs').readFileSync(0,'utf8');const r=JSON.parse(d);
    if(r.error){console.log('  knowledge: ERROR — '+r.error)}
    else{const c=(r.results||[]).filter(x=>x.action!=='unchanged');
    if(c.length)c.forEach(x=>console.log('  knowledge: '+x.action+' '+x.target));
    else console.log('  knowledge: up to date')}
  " 2>/dev/null || echo "  knowledge: error (parse failure)"

  # Sync glossary
  GLOSSARY_RESULT=$(curl -sf -X POST "$API_BASE/api/projects/$handle/knowledge/glossary/sync" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null || echo '{"error":"glossary sync failed"}')

  echo "$GLOSSARY_RESULT" | node -e "
    const d=require('fs').readFileSync(0,'utf8');const r=JSON.parse(d);
    if(r.error){console.log('  glossary: ERROR — '+r.error)}
    else{const c=(r.results||[]).filter(x=>x.action!=='unchanged');
    if(c.length)c.forEach(x=>console.log('  glossary: '+x.action+' '+x.target));
    else console.log('  glossary: up to date')}
  " 2>/dev/null || echo "  glossary: error (parse failure)"
done

# Step 3: Sync built-in commands and skills to user-level directories
echo "Syncing commands and skills..."
for assistant in claude-code codex-cli; do
  CMD_RESULT=$(curl -sf -X POST "$API_BASE/api/assistants/$assistant/commands/sync" \
    2>/dev/null || echo '{"error":"commands sync failed"}')

  echo "$CMD_RESULT" | node -e "
    const d=require('fs').readFileSync(0,'utf8');const r=JSON.parse(d);
    if(r.error){console.log('  $assistant: ERROR — '+r.error)}
    else{const c=(r.results||[]).filter(x=>x.action!=='unchanged');
    if(c.length)c.forEach(x=>console.log('  $assistant: '+x.action+' '+x.name));
    else console.log('  $assistant: up to date')}
  " 2>/dev/null || echo "  $assistant: error (parse failure)"
done

echo ""
echo "Done."
