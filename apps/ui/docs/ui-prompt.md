# Khef UI

A fast, intuitive interface for khef's knowledge management powers: global search, project dashboards, and explorable memory graphs.

## Core Concepts

**Memory types** (12): `user-note`, `assistant-note`, `project-note`, `user-todo`, `assistant-todo`, `decision`, `command`, `context`, `api`, `pattern`, `reference`, `assistant-rule`

**Statuses** are type-specific:
- Todos: `open` → `in_progress` → `done` / `blocked` / `canceled`
- Decisions: `proposed` → `accepted` / `rejected` / `superseded`
- Patterns: `proposed` → `active` / `deprecated`
- Context: `current` → `updated` / `outdated`

**Relations** (6): `supports`, `contradicts`, `depends_on`, `follows_from`, `references`, `relates_to`

**Compact mode**: List views return `content_excerpt` by default; fetch full content on demand.

## User Flows

### 1. Global Search
Query → filter (project/type/tag/status) → sort → browse compact cards → open detail → create relation

- Debounced search bar with `q` parameter
- Filter chips: project dropdown, type multi-select, tag autocomplete, status (requires type)
- Sort: `relevance` (default when searching), `updated_at`, `created_at`, `title`
- Results: compact cards with title, type badge, status pill, tags, excerpt, score
- Detail drawer: full content, chunks, tags, relations, actions (edit, relate, delete)

### 2. Project Dashboard
Land on project → see curated sections → filter/explore → generate report

Use `GET /api/projects/{handle}/session-context` to bootstrap:
```
{
  project: { ... },
  todos: { recently_created, in_progress, recently_completed },
  recent_decisions, recent_patterns, recent_context
}
```

Sections:
- **Todos**: Kanban-style lanes (open, in_progress, done) with status toggles
- **Decisions**: Timeline cards, status badges (proposed/accepted/rejected)
- **Patterns**: Grid of active patterns with deprecation indicators
- **Context**: Scrollable cards, current vs outdated styling

Actions: type/tag filters, "Export Report" button, link to graph view.

### 3. Graph Explorer
Start from memory or project → explore relations → click nodes to navigate

- **Rendering**: Graphviz DOT generated client-side, rendered server-side via Kroki (`POST /api/diagram/preview`)
- **Two modes**: Memory-centric (`/memories/:id/graph`) and project-level (`/projects/:id/graph`)
- **Canvas**: panzoom (pan/zoom with mouse/trackpad), keyboard shortcuts (+/- zoom, 0 reset, Esc back)
- **Controls**: depth selector (1 to max_depth, auto-detected), LR/TB direction toggle, type filter chips
- **Nodes**: colored by memory type, HTML-like labels (title + type/status), clickable for SPA navigation
- **Edges**: labeled with relation type, directional arrows
- **Focus node**: root memory highlighted with thick border (memory-centric mode only)
- **Export**: SVG download button
- **Truncation**: status bar shows "Graph truncated" when max_nodes/max_edges exceeded
- **Entry points**: "Graph" button on MemoryPage (when relations exist), Network icon on ProjectPage header

### 4. File Uploads

Upload files directly into memory content from the editor.

- **Trigger**: Click image button or press `Cmd+I` while editing content
- **Allowed types**: png, jpeg, gif, webp, pdf, csv, txt, xlsx, docx
- **Max size**: Configurable via Settings (default 10MB)
- **Markdown insertion**:
  - Images: `![filename](/api/files/id)`
  - Other files: `[filename](/api/files/id)`
- **Storage**: Files stored at configurable path, organized by project handle

### 5. Settings

Configure application preferences at `/settings`.

- **Layout**: Page width (pixels)
- **Diagrams**: Default max width for SVG diagrams
- **Files**: Storage path (absolute or relative), max file size
  - Changing storage path prompts: Keep (save only), Move (migrate files), Cancel

## Data Access

```
# Bootstrap
GET /api/projects/{handle}/session-context

# Search (global)
GET /api/memories?q=...&project_handle=...&type=...&tag=...&status=...&sort=relevance&compact=true&limit=20&offset=0

# Search modes (advanced)
GET /api/memories?q=...&search_mode=content   # content only
GET /api/memories?q=...&search_mode=tags      # tag names only

# Single memory (full content)
GET /api/memories/{id}

# Graph traversal (returns max_depth for auto-detecting graph extent)
GET /api/memories/{id}/relations/graph?depth=2&compact=true&max_nodes=200&max_edges=400

# Project-level graph (all memories + inter-relations)
GET /api/projects/{id}/graph?max_nodes=100&max_edges=200&compact=true

# Memory relations
GET /api/relations/memory/{id}
POST /api/relations { source_memory_id, target_memory_id, relation_type }

# Status update
PUT /api/projects/{handle}/memories/{id}/status { status: "done" }

# Memory update (partial)
PATCH /api/projects/{handle}/memories/{id} { title?, content?, type?, tags? }

# Delete memory
DELETE /api/projects/{handle}/memories/{id}

# Tags
GET /api/tags
GET /api/tags/{name}/memories

# Graph health (for reports)
GET /api/projects/{handle}/graph-health

# Files
POST /api/projects/{handle}/files        # Upload (multipart/form-data)
GET /api/projects/{handle}/files         # List files
DELETE /api/projects/{handle}/files/{id} # Delete file
GET /api/files/{id}                      # Serve file (global)
POST /api/files/migrate                  # Move files to new storage path

# Settings
GET /api/settings
PATCH /api/settings { key: value, ... }
```

Response pagination: `{ memories: [...], pagination: { total_count, limit, offset, has_more } }`

## UI Components

**Layout**
- `AppShell`: nav sidebar (projects list, global search link), main content area
- `SearchPage`: SearchBar, FiltersPanel, ResultsList (infinite scroll)
- `ProjectPage`: ProjectHeader, TodoBoard, DecisionTimeline, PatternGrid, ContextList, ReportPanel
- `MemoryPage`: MemoryDetail, RelationsList, ChunkViewer
- `GraphPage`: GraphCanvas, ControlPanel, NodeDrawer

**Shared**
- `SearchBar`: debounced input, keyboard shortcut hint
- `FiltersPanel`: collapsible filter groups, active filter chips
- `MemoryCard`: compact card with type icon, status badge, tags, excerpt
- `MemoryDetail`: full content with markdown rendering, chunks accordion, tags editor
- `StatusSelect`: type-aware status dropdown with color coding
- `RelationPicker`: dropdown for relation type, memory search/select
- `GraphCanvas`: D3/Cytoscape wrapper with zoom/pan, fit, layout options
- `NodeDrawer`: side panel for selected node details and actions

**Interactions**
- `/` → focus search
- `j`/`k` → navigate results
- `Enter` → open selected
- `Esc` → close drawer/modal
- `g` → open graph for current memory
- `r` → open relation picker

## Report Generation

**Trigger**: "Generate Report" button on project page

**Template options**:
- Weekly summary: new/updated memories since last week
- Full export: all memories grouped by type
- Graph health: orphans, connectivity stats, relation distribution

**Content**:
- Header: project name, date range, summary stats
- Sections by type: decisions, patterns, context, todos
- Graph health: orphan count, relation type breakdown, largest component size
- Links: deep links back to UI for each memory

**Export formats**:
- Markdown (primary): copy to clipboard or download
- HTML: print-friendly stylesheet
- PDF: browser print → PDF

## Architecture

**Stack**: Vite + Preact + TypeScript + CSS Modules + PostCSS

**Testing**:
- Playwright suite for the memory page uses a dedicated test project created in `beforeAll`, runs serially for deterministic CRUD expectations, and deletes the project in `afterAll`.
- Tests prefer `KHEF_API_URL` / `KHEF_PROXY_TARGET` for API access, with a fallback to `http://localhost:3201/api`.

**Routing** (URL-driven state):
```
/                     → redirect to /search
/search?q=...&...     → global search with filters
/projects             → project list
/projects/{handle}    → project dashboard
/projects/{handle}/graph → project-scoped graph
/memories/{id}        → memory detail
/memories/{id}/graph  → memory-centric graph
```

**Data fetching**:
- SWR-style with stale-while-revalidate
- Compact results cached; full content fetched on demand
- Optimistic updates for status changes

**State**:
- URL params → filter/sort state (querystring)
- Local component state for UI (drawer open, selected node)
- Optional: persist recent searches, saved graph presets

## Performance

- **Compact-first**: all list views use `compact=true`
- **Lazy hydration**: fetch full content only when detail opened
- **Infinite scroll**: load 20 results at a time, intersection observer
- **Skeleton loading**: card and detail placeholders during fetch
- **Graph limits**: default 200 nodes, 400 edges; show truncation indicator
- **Debounce**: 200ms on search input

## Future Enhancements

- **Graph overlays**: color by type/status/tags, edge type toggles
- **Saved views**: named graph presets per project, permalink sharing
- **Inline relation authoring**: drag-to-connect with type picker
- **Link suggestions**: surface similar memories for one-click relation creation
- **Graph-driven search**: "filter to graph nodes" and "expand by 1 hop"
- **Real-time updates**: WebSocket for collaborative editing (not in scope)

## Kickoff Tasks

1. API client with typed methods matching endpoints above
2. Search page: SearchBar + FiltersPanel + ResultsList (compact cards, infinite scroll)
3. Project dashboard: session-context bootstrap, TodoBoard, DecisionTimeline
4. Memory detail: full content, chunks, relations list, status editor
5. Graph canvas MVP: depth control, type filters, node tooltips, selection drawer

No access control or multi-tenant considerations needed.

## CSS & Library Specs (dev-guide style)

**Styling Approach**
- CSS Modules + PostCSS (postcss-nested, autoprefixer)
- Global tokens in `tokens.css` and base resets in `base.css`
- Theme via `data-theme` (light/dark) respecting `prefers-color-scheme`
- `clsx` for class composition; semantic CSS modules for components

**Design Tokens (tokens.css)**
- Colors: `--bg`, `--fg`, `--surface`, `--muted`, `--accent`, `--accent-fg`
- Graph colors by type: `--node-decision`, `--node-pattern`, `--node-context`, `--node-todo`
- Spacing: 4px scale (`--space-1: 4px` … `--space-12: 48px`)
- Radius/Shadows: `--radius-sm: 6px`, `--radius-md: 10px`, `--shadow-1`, `--shadow-2`
- Typography: Inter/system stack, mono for code; size scale 12/14/16/18/20/24

**Base & A11y**
- `color-scheme: light dark`; focus-visible rings using `--accent` with offset
- High-contrast badges and buttons; keyboard shortcuts surfaced in UI

**Component Primitives (CSS Modules)**
- Card (surface bg, radius md, shadow-1, padding `var(--space-4)`)
- Panel (layout regions: sidebar/main)
- Badge/Tag (typed variants: decision/pattern/context/todo)
- Button (primary/subtle/destructive); Field/Toolbar (dense filter groups)

**Client Libraries**
- Routing/Data: `wouter-preact`, `ky` HTTP client, simple SWR hook
- Graph: `cytoscape`, `cytoscape-cose-bilkent`, `cytoscape-dagre` (+ export to image)
- Markdown/Reports: `remark`, `rehype`, `rehype-highlight`, `html-to-image`, `jspdf`
- UI utilities: `lucide-preact` (icons), `date-fns` (dates), `fuse.js` (local quick-filter)

**Performance**
- Compact-first API usage; lazy full fetch on expand
- Infinite scroll with IntersectionObserver; skeletons for cards/detail
- Graph caps (`max_nodes`, `max_edges`); truncated flag with "Load more"
