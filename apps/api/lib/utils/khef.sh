#!/usr/bin/env bash
# khef Shell Utilities
# Source this file to get convenient functions for interacting with the khef API
#
# Usage:
#   source /path/to/khef/lib/utils/khef.sh
#
# Configuration:
#   KHEF_API_URL  - API endpoint (default: http://localhost:3100)
#   KHEF_PROJECT  - Default project handle (optional)
#   KHEF_RAW      - Set to 1 to disable jq formatting

# ============================================================================
# Configuration
# ============================================================================

KHEF_API_URL="${KHEF_API_URL:-http://localhost:3100}"
KHEF_RAW="${KHEF_RAW:-0}"

# ============================================================================
# Internal Helpers
# ============================================================================

_dm_format() {
  if [[ "$KHEF_RAW" == "1" ]] || ! command -v jq &>/dev/null; then
    cat
  else
    jq .
  fi
}

_dm_request() {
  local method="$1"
  local endpoint="$2"
  local data="$3"

  local url="${KHEF_API_URL}${endpoint}"

  if [[ -n "$data" ]]; then
    curl -s -X "$method" "$url" \
      -H "Content-Type: application/json" \
      -d "$data" | _dm_format
  else
    curl -s -X "$method" "$url" | _dm_format
  fi
}

_dm_get() { _dm_request GET "$1"; }
_dm_post() { _dm_request POST "$1" "$2"; }
_dm_put() { _dm_request PUT "$1" "$2"; }
_dm_delete() { _dm_request DELETE "$1"; }

_dm_project_or_default() {
  local project="${1:-$KHEF_PROJECT}"
  if [[ -z "$project" ]]; then
    # Use current directory name as project handle
    project="$(basename "$PWD")"
  fi
  echo "$project"
}

_dm_urlencode() {
  local string="$1"
  python3 -c "import urllib.parse; print(urllib.parse.quote('$string', safe=''))"
}

# Resolve a project identifier (handle/name/UUID) to a UUID
_dm_resolve_project_id() {
  local ident="$1"
  if [[ -z "$ident" ]]; then
    echo ""; return 1
  fi

  # If already a UUID, return as-is
  if [[ "$ident" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo "$ident"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required to resolve project id" >&2
    return 1
  fi

  # Try handle (lowercased)
  local handle_lower
  handle_lower=$(printf '%s' "$ident" | tr '[:upper:]' '[:lower:]')
  local resp
  resp=$(curl -s "${KHEF_API_URL}/api/projects?handle=$(_dm_urlencode "$handle_lower")")
  local id
  id=$(printf '%s' "$resp" | jq -r '.projects[0].id // empty')
  if [[ -n "$id" ]]; then
    echo "$id"; return 0
  fi

  # Try name
  resp=$(curl -s "${KHEF_API_URL}/api/projects?name=$(_dm_urlencode "$ident")")
  id=$(printf '%s' "$resp" | jq -r '.projects[0].id // empty')
  if [[ -n "$id" ]]; then
    echo "$id"; return 0
  fi

  echo "Error: Project not found: $ident" >&2
  return 1
}

# ============================================================================
# Help System
# ============================================================================

kf-help() {
  local cmd="${1:-}"

  if [[ -z "$cmd" ]]; then
    cat <<'EOF'
khef Shell Utilities

CONFIGURATION
  KHEF_API_URL   API endpoint (default: http://localhost:3100)
  KHEF_PROJECT   Default project handle (optional)
  KHEF_RAW       Set to 1 to disable jq formatting (for piping)

COMMANDS
  Projects:
    kf-projects              List all projects
    kf-projects-list         List project handles only
    kf-project               Get project details
    kf-project-create        Create a new project
    kf-project-delete        Delete a project
    kf-session               Get session context

  Memories:
    kf-memories              List/search memories in a project
    kf-memory                Get a single memory
    kf-memory-create         Create a new memory
    kf-memory-update         Update an existing memory
    kf-memory-append         Append content to a memory
    kf-memory-delete         Delete a memory
    kf-memory-status         Get or set memory status
    kf-todos                 List assistant-todo titles

  Relations:
    kf-relation-create       Create a relation between memories
    kf-relation-delete       Delete a relation
    kf-graph                 Get memory relation graph
    kf-graph-health          Analyze knowledge graph health
    kf-orphans               List orphan memories (no relations)

  Tags:
    kf-tags                  List all tags
    kf-tags-list             List tag names only
    kf-tag-memories          Get memories with a specific tag
    kf-project-tags          Get tags used in a specific project
    kf-project-tags-list     List tag names in a specific project only

  Cross-project:
    kf-search                Search memories across all projects
    kf-search-titles         List titles from cross-project search only
  Types:
    kf-types                 List all memory types (with statuses)
    kf-types-list            List memory type names only
    kf-statuses              Get available statuses for a memory type
    kf-statuses-values       List status values for a memory type only

  Help:
    kf-help                  Show this help
    kf-help <command>        Show help for a specific command

EXAMPLES
  kf-projects
  kf-projects-list
  kf-session khef
  kf-memories khef --type decision
  kf-memories-titles khef --type decision
  kf-search "authentication" --type pattern
  kf-search-titles "authentication" --type pattern
  KHEF_RAW=1 kf-projects | jq '.projects[].handle'   # for piping
EOF
    return 0
  fi

  # Call the specific help function
  local help_fn="kf-${cmd}-help"
  if declare -f "$help_fn" > /dev/null 2>&1; then
    "$help_fn"
  else
    echo "No help available for: $cmd" >&2
    echo "Run 'kf-help' for a list of commands" >&2
    return 1
  fi
}

# ============================================================================
# Projects
# ============================================================================

kf-projects-help() {
  cat <<'EOF'
kf-projects - List all projects

USAGE
  kf-projects [--name <name>]

OPTIONS
  --name <name>    Filter by project name

EXAMPLES
  kf-projects | jq .
  kf-projects --name "khef" | jq '.projects[0]'
EOF
}

kf-projects() {
  local name=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      -h|--help) kf-projects-help; return 0 ;;
      *) echo "Unknown option: $1" >&2; return 1 ;;
    esac
  done

  local endpoint="/api/projects"
  if [[ -n "$name" ]]; then
    endpoint="${endpoint}?name=$(_dm_urlencode "$name")"
  fi

  _dm_get "$endpoint"
}

kf-projects-list() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "kf-projects-list - List project handles only"; return 0
  fi
  if command -v jq &>/dev/null; then
    KHEF_RAW=1 kf-projects "$@" | jq -r '.projects[].handle'
  else
    kf-projects "$@"
  fi
}

kf-project-help() {
  cat <<'EOF'
kf-project - Get project details

USAGE
  kf-project <handle|name|uuid>

ARGUMENTS
  handle    Project handle, name, or UUID

EXAMPLES
  kf-project khef | jq .
  kf-project user | jq '.project.description'
EOF
}

kf-project() {
  local project="${1:-}"

  if [[ -z "$project" || "$project" == "-h" || "$project" == "--help" ]]; then
    kf-project-help
    return 0
  fi

  # Resolve to UUID and fetch
  local project_id
  project_id="$project"
  if [[ ! "$project_id" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    project_id=$(_dm_resolve_project_id "$project") || return 1
  fi
  _dm_get "/api/projects/$project_id"
}

kf-project-create-help() {
  cat <<'EOF'
kf-project-create - Create a new project

USAGE
  kf-project-create <name> [--handle <handle>] [--description <desc>]

ARGUMENTS
  name              Project name (required)

OPTIONS
  --handle <handle>       Custom handle (auto-generated from name if not provided)
  --description <desc>    Project description

EXAMPLES
  kf-project-create "My Project" | jq .
  kf-project-create "My Project" --handle my-proj --description "A test project"
EOF
}

kf-project-create() {
  local name=""
  local handle=""
  local description=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --handle) handle="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      -h|--help) kf-project-create-help; return 0 ;;
      -*) echo "Unknown option: $1" >&2; return 1 ;;
      *)
        if [[ -z "$name" ]]; then
          name="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$name" ]]; then
    echo "Error: Project name is required" >&2
    kf-project-create-help
    return 1
  fi

  local json="{\"name\":\"$name\""
  [[ -n "$handle" ]] && json="$json,\"handle\":\"$handle\""
  [[ -n "$description" ]] && json="$json,\"description\":\"$description\""
  json="$json}"

  _dm_post "/api/projects" "$json"
}

kf-project-delete-help() {
  cat <<'EOF'
kf-project-delete - Delete a project

USAGE
  kf-project-delete <handle|name|uuid>

ARGUMENTS
  handle    Project handle, name, or UUID

NOTE
  The reserved "user" project cannot be deleted.
  Deleting a project will cascade delete all its memories.

EXAMPLES
  kf-project-delete my-project
EOF
}

kf-project-delete() {
  local project="${1:-}"

  if [[ -z "$project" || "$project" == "-h" || "$project" == "--help" ]]; then
    kf-project-delete-help
    return 0
  fi

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_delete "/api/projects/$project_id"
}

kf-session-help() {
  cat <<'EOF'
kf-session - Get session context for a project

USAGE
  kf-session [project]

ARGUMENTS
  project    Project handle, name, or UUID (uses KHEF_PROJECT if not provided)

RETURNS
  Project info, open/in-progress todos, recent decisions,
  patterns, and context - all in one call.

EXAMPLES
  kf-session khef | jq .
  kf-session khef | jq '.todos.recently_created[].title'
EOF
}

kf-session() {
  local project

  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-session-help
    return 0
  fi

  project="$(_dm_project_or_default "$1")" || return 1
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_get "/api/projects/$project_id/session-context"
}

# ============================================================================
# Memories
# ============================================================================

kf-memories-help() {
  cat <<'EOF'
kf-memories - List and search memories in a project

USAGE
  kf-memories [project] [OPTIONS]

ARGUMENTS
  project    Project handle (uses KHEF_PROJECT if not provided)

OPTIONS
  --search <query>    Full-text search
  --type <type>       Filter by memory type
  --tag <tag>         Filter by tag
  --status <status>   Filter by status
  --limit <n>         Results per page (default: 20)
  --offset <n>        Skip results (default: 0)

MEMORY TYPES
  user-note, assistant-note, project-note, user-todo, assistant-todo,
  decision, command, context, api, pattern, reference, assistant-rule

EXAMPLES
  kf-memories khef | jq '.memories[].title'
  kf-memories khef --type decision | jq .
  kf-memories khef --search "authentication" --type pattern
  kf-memories --tag architecture | jq '.memories[].title'
EOF
}

kf-memories() {
  local project=""
  local search=""
  local type=""
  local tag=""
  local status=""
  local limit=""
  local offset=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --search) search="$2"; shift 2 ;;
      --type) type="$2"; shift 2 ;;
      --tag) tag="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      --offset) offset="$2"; shift 2 ;;
      -h|--help) kf-memories-help; return 0 ;;
      -*) echo "Unknown option: $1" >&2; return 1 ;;
      *)
        if [[ -z "$project" ]]; then
          project="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  project="$(_dm_project_or_default "$project")" || return 1
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1

  local params=""
  [[ -n "$search" ]] && params="${params}&search=$(_dm_urlencode "$search")"
  [[ -n "$type" ]] && params="${params}&type=$(_dm_urlencode "$type")"
  [[ -n "$tag" ]] && params="${params}&tag=$(_dm_urlencode "$tag")"
  [[ -n "$status" ]] && params="${params}&status=$(_dm_urlencode "$status")"
  [[ -n "$limit" ]] && params="${params}&limit=$limit"
  [[ -n "$offset" ]] && params="${params}&offset=$offset"

  # Remove leading &
  params="${params#&}"

  local endpoint="/api/projects/$project_id/memories"
  [[ -n "$params" ]] && endpoint="${endpoint}?${params}"

  _dm_get "$endpoint"
}

kf-memory-help() {
  cat <<'EOF'
kf-memory - Get a single memory by ID

USAGE
  kf-memory <project> <memory-id>

ARGUMENTS
  project      Project handle, name, or UUID
  memory-id    Memory UUID

EXAMPLES
  kf-memory khef 019b6790-3574-70e3-918f-e40a5734f0d1 | jq .
EOF
}

kf-memory() {
  if [[ "$1" == "-h" || "$1" == "--help" || $# -lt 2 ]]; then
    kf-memory-help
    return 0
  fi

  local project="$1"
  local memory_id="$2"
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_get "/api/projects/$project_id/memories/$memory_id"
}

kf-memory-create-help() {
  cat <<'EOF'
kf-memory-create - Create a new memory

USAGE
  kf-memory-create <project> <type> <handle> <title> <content> [--tags <t1,t2,...>]

ARGUMENTS
  project    Project handle (or uses KHEF_PROJECT)
  type       Memory type
  handle     Memory handle (kebab-case, unique within project)
  title      Memory title (max 200 chars, unique within project)
  content    Memory content

OPTIONS
  --tags <tags>    Comma-separated list of tags

MEMORY TYPES
  user-note, assistant-note, project-note, user-todo, assistant-todo,
  decision, command, context, api, pattern, reference, assistant-rule

EXAMPLES
  kf-memory-create khef decision use-postgresql "Chose PostgreSQL" "Chose PG for ACID compliance"
  kf-memory-create user user-note git-preferences "Git preferences" "Always rebase" --tags "git,workflow"
EOF
}

kf-memory-create() {
  local project=""
  local type=""
  local handle=""
  local title=""
  local content=""
  local tags=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tags) tags="$2"; shift 2 ;;
      -h|--help) kf-memory-create-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$project" ]]; then
          project="$1"
        elif [[ -z "$type" ]]; then
          type="$1"
        elif [[ -z "$handle" ]]; then
          handle="$1"
        elif [[ -z "$title" ]]; then
          title="$1"
        elif [[ -z "$content" ]]; then
          content="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$project" || -z "$type" || -z "$handle" || -z "$title" || -z "$content" ]]; then
    echo "Error: project, type, handle, title, and content are required" >&2
    kf-memory-create-help
    return 1
  fi

  # Escape strings for JSON
  local json_title
  local json_content
  json_title=$(printf '%s' "$title" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  json_content=$(printf '%s' "$content" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

  local json="{\"type\":\"$type\",\"handle\":\"$handle\",\"title\":$json_title,\"content\":$json_content"

  if [[ -n "$tags" ]]; then
    # Convert comma-separated tags to JSON array
    local tags_json
    tags_json=$(echo "$tags" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip().split(",")))')
    json="$json,\"tags\":$tags_json"
  fi

  json="$json}"

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_post "/api/projects/$project_id/memories" "$json"
}

kf-memory-update-help() {
  cat <<'EOF'
kf-memory-update - Update an existing memory

USAGE
  kf-memory-update <project> <memory-id> [OPTIONS]

ARGUMENTS
  project      Project handle
  memory-id    Memory UUID

OPTIONS
  --title <title>      New title
  --content <content>  New content
  --type <type>        New type
  --tags <t1,t2,...>   Replace all tags (use "" to clear)

EXAMPLES
  kf-memory-update khef abc-123 --title "New Title"
  kf-memory-update khef abc-123 --content "Updated content" --tags "new,tags"
EOF
}

kf-memory-update() {
  local project=""
  local memory_id=""
  local title=""
  local content=""
  local type=""
  local tags=""
  local has_tags=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --content) content="$2"; shift 2 ;;
      --type) type="$2"; shift 2 ;;
      --tags) tags="$2"; has_tags=true; shift 2 ;;
      -h|--help) kf-memory-update-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$project" ]]; then
          project="$1"
        elif [[ -z "$memory_id" ]]; then
          memory_id="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$project" || -z "$memory_id" ]]; then
    echo "Error: project and memory-id are required" >&2
    kf-memory-update-help
    return 1
  fi

  local json="{"
  local first=true

  if [[ -n "$title" ]]; then
    local json_title
    json_title=$(printf '%s' "$title" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    json="${json}\"title\":$json_title"
    first=false
  fi

  if [[ -n "$content" ]]; then
    local json_content
    json_content=$(printf '%s' "$content" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    [[ "$first" == false ]] && json="${json},"
    json="${json}\"content\":$json_content"
    first=false
  fi

  if [[ -n "$type" ]]; then
    [[ "$first" == false ]] && json="${json},"
    json="${json}\"type\":\"$type\""
    first=false
  fi

  if [[ "$has_tags" == true ]]; then
    local tags_json
    if [[ -z "$tags" ]]; then
      tags_json="[]"
    else
      tags_json=$(echo "$tags" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip().split(",")))')
    fi
    [[ "$first" == false ]] && json="${json},"
    json="${json}\"tags\":$tags_json"
  fi

  json="${json}}"

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_put "/api/projects/$project_id/memories/$memory_id" "$json"
}

kf-memory-append-help() {
  cat <<'EOF'
kf-memory-append - Append content to an existing memory

USAGE
  kf-memory-append <project> <memory-id> <content> [--separator <sep>]

ARGUMENTS
  project      Project handle
  memory-id    Memory UUID
  content      Content to append

OPTIONS
  --separator <sep>    Separator between existing and new content (default: "\n\n")

EXAMPLES
  kf-memory-append khef abc-123 "Additional notes"
  kf-memory-append khef abc-123 "- Item 2" --separator "\n"
EOF
}

kf-memory-append() {
  local project=""
  local memory_id=""
  local content=""
  local separator=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --separator) separator="$2"; shift 2 ;;
      -h|--help) kf-memory-append-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$project" ]]; then
          project="$1"
        elif [[ -z "$memory_id" ]]; then
          memory_id="$1"
        elif [[ -z "$content" ]]; then
          content="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$project" || -z "$memory_id" || -z "$content" ]]; then
    echo "Error: project, memory-id, and content are required" >&2
    kf-memory-append-help
    return 1
  fi

  # Escape content for JSON
  local json_content
  json_content=$(printf '%s' "$content" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

  local json="{\"content\":$json_content"

  if [[ -n "$separator" ]]; then
    local json_separator
    json_separator=$(printf '%s' "$separator" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    json="$json,\"separator\":$json_separator"
  fi

  json="$json}"

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_post "/api/projects/$project_id/memories/$memory_id/append" "$json"
}

kf-memory-delete-help() {
  cat <<'EOF'
kf-memory-delete - Delete a memory

USAGE
  kf-memory-delete <project> <memory-id>

ARGUMENTS
  project      Project handle
  memory-id    Memory UUID

EXAMPLES
  kf-memory-delete khef 019b6790-3574-70e3-918f-e40a5734f0d1
EOF
}

kf-memory-delete() {
  if [[ "$1" == "-h" || "$1" == "--help" || $# -lt 2 ]]; then
    kf-memory-delete-help
    return 0
  fi

  local project="$1"
  local memory_id="$2"

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_delete "/api/projects/$project_id/memories/$memory_id"
}

kf-memory-status-help() {
  cat <<'EOF'
kf-memory-status - Get or set memory status

USAGE
  kf-memory-status <project> <memory-id> [new-status]

ARGUMENTS
  project      Project handle
  memory-id    Memory UUID
  new-status   New status value (optional - omit to get current status)

COMMON STATUSES
  Todos:     open, in_progress, done
  Decisions: proposed, accepted, rejected, deprecated
  Rules:     active, deprecated

EXAMPLES
  kf-memory-status khef abc-123                    # Get status
  kf-memory-status khef abc-123 done              # Set status
  kf-memory-status khef abc-123 in_progress
EOF
}

kf-memory-status() {
  if [[ "$1" == "-h" || "$1" == "--help" || $# -lt 2 ]]; then
    kf-memory-status-help
    return 0
  fi

  local project="$1"
  local memory_id="$2"
  local new_status="${3:-}"

  if [[ -z "$new_status" ]]; then
    # Get status
    local project_id
    project_id=$(_dm_resolve_project_id "$project") || return 1
    _dm_get "/api/projects/$project_id/memories/$memory_id/status"
  else
    # Set status
    local project_id
    project_id=$(_dm_resolve_project_id "$project") || return 1
    _dm_put "/api/projects/$project_id/memories/$memory_id/status" \
      "{\"status\":\"$new_status\"}"
  fi
}

kf-todos-help() {
  cat <<'EOF'
kf-todos - List assistant-todo titles

USAGE
  kf-todos [project] [OPTIONS]

ARGUMENTS
  project    Project handle (defaults to current directory name)

OPTIONS
  --open          Show open todos (default)
  --in-progress   Show in-progress todos
  --done          Show done todos
  --all           Show all todos

EXAMPLES
  kf-todos                        # Open todos for current dir project
  kf-todos khef --done         # Completed todos
  kf-todos --in-progress          # In-progress todos
  kf-todos --all                  # All todos
EOF
}

kf-todos() {
  local project=""
  local status="open"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --open) status="open"; shift ;;
      --in-progress) status="in_progress"; shift ;;
      --done) status="done"; shift ;;
      --all) status=""; shift ;;
      -h|--help) kf-todos-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$project" ]]; then
          project="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  project="$(_dm_project_or_default "$project")" || return 1

  local params="type=assistant-todo"
  [[ -n "$status" ]] && params="${params}&status=$(_dm_urlencode "$status")"

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  local endpoint="/api/projects/$project_id/memories?${params}"

  if command -v jq &>/dev/null && [[ "$KHEF_RAW" != "1" ]]; then
    _dm_get "$endpoint" | jq -r '.memories[] | .title'
  else
    _dm_get "$endpoint"
  fi
}

# ============================================================================
# Relations
# ============================================================================

kf-relation-create-help() {
  cat <<'EOF'
kf-relation-create - Create a relation between two memories

USAGE
  kf-relation-create <source-id> <target-id> <relation-type>

ARGUMENTS
  source-id       Source memory UUID
  target-id       Target memory UUID
  relation-type   Type of relation

RELATION TYPES
  relates_to    General relationship
  contradicts   Conflicting information
  supports      Supporting evidence
  depends_on    Dependency
  follows_from  Temporal sequence
  references    Reference link

NOTE
  Cross-project relations are only allowed when one memory is in the "user" project.

EXAMPLES
  kf-relation-create abc-123 def-456 supports
  kf-relation-create abc-123 def-456 depends_on
EOF
}

kf-relation-create() {
  if [[ "$1" == "-h" || "$1" == "--help" || $# -lt 3 ]]; then
    kf-relation-create-help
    return 0
  fi

  local source_id="$1"
  local target_id="$2"
  local relation_type="$3"

  _dm_post "/api/relations" \
    "{\"source_memory_id\":\"$source_id\",\"target_memory_id\":\"$target_id\",\"relation_type\":\"$relation_type\"}"
}

kf-relation-delete-help() {
  cat <<'EOF'
kf-relation-delete - Delete a relation

USAGE
  kf-relation-delete <relation-id>

ARGUMENTS
  relation-id    Relation UUID

EXAMPLES
  kf-relation-delete abc-123
EOF
}

kf-relation-delete() {
  if [[ "$1" == "-h" || "$1" == "--help" || -z "$1" ]]; then
    kf-relation-delete-help
    return 0
  fi

  _dm_delete "/api/relations/$1"
}

kf-graph-help() {
  cat <<'EOF'
kf-graph - Get memory relation graph

USAGE
  kf-graph <memory-id> [--depth <n>]

ARGUMENTS
  memory-id    Starting memory UUID

OPTIONS
  --depth <n>    Traversal depth (default: 2)

RETURNS
  nodes: Array of memories in the graph
  edges: Array of relations between them

EXAMPLES
  kf-graph abc-123 | jq '.nodes[].title'
  kf-graph abc-123 --depth 3 | jq '.edges'
EOF
}

kf-graph() {
  local memory_id=""
  local depth=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --depth) depth="$2"; shift 2 ;;
      -h|--help) kf-graph-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$memory_id" ]]; then
          memory_id="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  if [[ -z "$memory_id" ]]; then
    kf-graph-help
    return 1
  fi

  local endpoint="/api/relations/memory/$memory_id/graph"
  [[ -n "$depth" ]] && endpoint="${endpoint}?depth=$depth"

  _dm_get "$endpoint"
}

kf-graph-health-help() {
  cat <<'EOF'
kf-graph-health - Analyze knowledge graph health for a project

USAGE
  kf-graph-health [project]

ARGUMENTS
  project    Project handle (defaults to current directory name)

OUTPUT
  Returns graph health metrics including:
  - Total memories, orphan count, connection rate
  - Connected components analysis
  - Relation type distribution
  - Per-type memory stats

EXAMPLES
  kf-graph-health                           # Current dir project
  kf-graph-health khef                   # Specific project
  kf-graph-health | jq '.summary'           # Just the summary
  kf-graph-health | jq '.orphan_memories[]' # List orphans
EOF
}

kf-graph-health() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-graph-health-help
    return 0
  fi

  local project="$(_dm_project_or_default "$1")" || return 1
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_get "/api/projects/$project_id/graph-health"
}

kf-orphans-help() {
  cat <<'EOF'
kf-orphans - List orphan memories (no relations)

USAGE
  kf-orphans [project]

ARGUMENTS
  project    Project handle (defaults to current directory name)

OUTPUT
  Lists memories that have no incoming or outgoing relations.
  These are candidates for linking to build a connected knowledge graph.

EXAMPLES
  kf-orphans                      # Current dir project
  kf-orphans khef              # Specific project
  kf-orphans | jq '.[].title'     # Just titles
EOF
}

kf-orphans() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-orphans-help
    return 0
  fi

  local project="$(_dm_project_or_default "$1")" || return 1
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_get "/api/projects/$project_id/graph-health" | jq '.orphan_memories'
}

# ============================================================================
# Tags
# ============================================================================

kf-tags-help() {
  cat <<'EOF'
kf-tags - List all tags

USAGE
  kf-tags

EXAMPLES
  kf-tags | jq '.tags[].name'
EOF
}

kf-tags() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-tags-help
    return 0
  fi

  _dm_get "/api/tags"
}

kf-tags-list() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "kf-tags-list - List tag names only"; return 0
  fi
  if command -v jq &>/dev/null; then
    KHEF_RAW=1 kf-tags | jq -r '.tags[].name'
  else
    kf-tags
  fi
}

kf-tag-memories-help() {
  cat <<'EOF'
kf-tag-memories - Get all memories with a specific tag

USAGE
  kf-tag-memories <tag-name>

ARGUMENTS
  tag-name    Name of the tag

EXAMPLES
  kf-tag-memories architecture | jq '.memories[].title'
  kf-tag-memories git | jq '.memories[] | {title, type}'
EOF
}

kf-tag-memories() {
  if [[ "$1" == "-h" || "$1" == "--help" || -z "$1" ]]; then
    kf-tag-memories-help
    return 0
  fi

  _dm_get "/api/tags/$(_dm_urlencode "$1")/memories"
}

kf-project-tags-list() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "kf-project-tags-list [project] - List tag names for a project"; return 0
  fi
  local project
  project="$(_dm_project_or_default "$1")" || return 1
  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  if command -v jq &>/dev/null; then
    _dm_get "/api/projects/$project_id/tags" | jq -r '.tags[].name'
  else
    _dm_get "/api/projects/$project_id/tags"
  fi
}

kf-types-help() {
  cat <<'EOF'
kf-types - List all memory types with available statuses

USAGE
  kf-types

RETURNS
  Array of memory types with description and statuses (value, display_name)

EXAMPLES
  kf-types | jq '.memory_types[].type'
  kf-types | jq '.memory_types[] | {type, statuses: [.statuses[].value]}'
EOF
}

kf-types() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-types-help
    return 0
  fi

  _dm_get "/api/memory-types"
}

kf-types-list() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "kf-types-list - List memory type names only"; return 0
  fi
  if command -v jq &>/dev/null; then
    _dm_get "/api/memory-types" | jq -r '.memory_types[].type'
  else
    _dm_get "/api/memory-types"
  fi
}

kf-statuses-values() {
  if [[ "$1" == "-h" || "$1" == "--help" || -z "$1" ]]; then
    echo "kf-statuses-values <memory-type> - List status values for a type"; return 0
  fi
  local type="$1"
  if command -v jq &>/dev/null; then
    _dm_get "/api/memory-types/$(_dm_urlencode "$type")/statuses" | jq -r '.statuses[].value'
  else
    _dm_get "/api/memory-types/$(_dm_urlencode "$type")/statuses"
  fi
}

kf-memories-titles() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    echo "kf-memories-titles [project] [filters] - List memory titles"; return 0
  fi
  if ! command -v jq &>/dev/null; then
    kf-memories "$@"; return 0
  fi
  KHEF_RAW=1 kf-memories "$@" | jq -r '.memories[].title'
}

kf-search-titles() {
  if [[ "$1" == "-h" || "$1" == "--help" || -z "$1" ]]; then
    echo "kf-search-titles <query> [filters] - List titles from cross-project search"; return 0
  fi
  if ! command -v jq &>/dev/null; then
    kf-search "$@"; return 0
  fi
  KHEF_RAW=1 kf-search "$@" | jq -r '.memories[].title'
}

# ============================================================================
# Cross-project Search
# ============================================================================

kf-search-help() {
  cat <<'EOF'
kf-search - Search memories across all projects

USAGE
  kf-search <query> [OPTIONS]

ARGUMENTS
  query    Full-text search query

OPTIONS
  --type <type>       Filter by memory type
  --tag <tag>         Filter by tag
  --status <status>   Filter by status
  --limit <n>         Results per page (default: 20)
  --offset <n>        Skip results (default: 0)

EXAMPLES
  kf-search "authentication" | jq '.memories[].title'
  kf-search "database" --type decision | jq .
  kf-search "git" --type pattern --tag workflow
EOF
}

kf-search() {
  local search=""
  local type=""
  local tag=""
  local status=""
  local limit=""
  local offset=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type) type="$2"; shift 2 ;;
      --tag) tag="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      --offset) offset="$2"; shift 2 ;;
      -h|--help) kf-search-help; return 0 ;;
      -*)
        echo "Unknown option: $1" >&2
        return 1
        ;;
      *)
        if [[ -z "$search" ]]; then
          search="$1"
        else
          echo "Unexpected argument: $1" >&2
          return 1
        fi
        shift
        ;;
    esac
  done

  local params=""
  [[ -n "$search" ]] && params="${params}&search=$(_dm_urlencode "$search")"
  [[ -n "$type" ]] && params="${params}&type=$(_dm_urlencode "$type")"
  [[ -n "$tag" ]] && params="${params}&tag=$(_dm_urlencode "$tag")"
  [[ -n "$status" ]] && params="${params}&status=$(_dm_urlencode "$status")"
  [[ -n "$limit" ]] && params="${params}&limit=$limit"
  [[ -n "$offset" ]] && params="${params}&offset=$offset"

  # Remove leading &
  params="${params#&}"

  local endpoint="/api/memories"
  [[ -n "$params" ]] && endpoint="${endpoint}?${params}"

  _dm_get "$endpoint"
}

# ============================================================================
# Memory Type Statuses
# ============================================================================

kf-statuses-help() {
  cat <<'EOF'
kf-statuses - Get available statuses for a memory type

USAGE
  kf-statuses <memory-type>

ARGUMENTS
  memory-type    Memory type to get statuses for

EXAMPLES
  kf-statuses user-todo | jq '.statuses[].status_value'
  kf-statuses decision | jq .
EOF
}

kf-statuses() {
  if [[ "$1" == "-h" || "$1" == "--help" || -z "$1" ]]; then
    kf-statuses-help
    return 0
  fi

  _dm_get "/api/memory-types/$(_dm_urlencode "$1")/statuses"
}

# ============================================================================
# Project Tags
# ============================================================================

kf-project-tags-help() {
  cat <<'EOF'
kf-project-tags - Get tags used in a specific project

USAGE
  kf-project-tags [project]

ARGUMENTS
  project    Project handle (uses KHEF_PROJECT if not provided)

EXAMPLES
  kf-project-tags khef | jq '.tags[] | {name, usage_count}'
EOF
}

kf-project-tags() {
  if [[ "$1" == "-h" || "$1" == "--help" ]]; then
    kf-project-tags-help
    return 0
  fi

  local project
  project="$(_dm_project_or_default "$1")" || return 1

  local project_id
  project_id=$(_dm_resolve_project_id "$project") || return 1
  _dm_get "/api/projects/$project_id/tags"
}

# ============================================================================
# Initialization Message
# ============================================================================

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  # Script is being sourced
  echo "khef utilities loaded. Run 'kf-help' for usage." >&2
fi
