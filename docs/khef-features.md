# Khef Features

Everything in Khef — from memory types to pipeline orchestration.

## Memory Types

- Decisions with rationale
- Reusable patterns
- Context — architecture, schemas, env
- Todos for you and your AI
- Agent rules and guidelines
- Commands and CLI reference
- Diagrams and visual docs
- References and API docs
- Canvas — interactive HTML/JS/CSS
- Video with inline player
- CSV with spreadsheet rendering
- Google Docs with live sync
- Custom user-defined types
- Type-specific status workflows

## AI Integration

- Claude Code via MCP (140+ tools)
- OpenAI Codex CLI via MCP
- Google Gemini conversations
- Assistant chat — cross-model routing
- One-call session bootstrap
- UUID handoff between agents
- Task routing and assignment
- Custom slash commands and skills
- Prompt template management
- Hooks — search-first gates, lifecycle
- Live messages between sessions
- Session nicknames and lineage

## Knowledge Graph

- 11 typed relations
- Interactive graph explorer
- Clickable nodes for SPA navigation
- Configurable traversal depth (1-4)
- LR / TB direction toggle
- Type-based color-coded nodes
- Type filter chips
- Graph health analysis
- Orphan memory detection
- SVG export and pan/zoom

## Search — 6 Backends

- Full-text keyword search
- Semantic vector similarity
- Source code search (pgvector)
- Commit message search
- Session transcript search
- Slack message search
- Document search (PDF, markdown)
- Cross-project queries
- Filter by type, tag, status, date
- Pinned filter and UUID batch lookup

## Memory Editor

- Rich markdown with GFM
- 90+ language syntax highlighting
- Auto-generated table of contents
- Focus mode (distraction-free)
- Inline handle and metadata editing
- Pin / unpin memories
- Keyboard shortcuts (save, edit, nav)
- Section-based editing for large docs

## Rich Content Types

- Canvas — sandboxed HTML/JS/CSS
- Widgets, animations, prototypes, quizzes
- Video with inline player and notes
- CSV with interactive spreadsheet
- Diagrams — Mermaid, D2, PlantUML, Graphviz
- Live preview while editing
- High-quality PNG export
- Multiple color themes and sizing

## Snapshots & Comments

- Snapshots for memories and configs
- Browse and compare versions
- Restore to any previous snapshot
- Bulk delete old snapshots
- Comments anchored to text excerpts
- Active / resolved status tracking
- Orphan detection on content edits
- Comments on plans and diffs too

## Collections

- Curated ordered lists of memories
- Drag-and-drop reordering
- Project-scoped or cross-project
- Add / remove memories freely
- Slideshow presentation mode

## Status Workflows

- Type-specific statuses
- Todos: open → in_progress → done
- Decisions: proposed → accepted
- Custom statuses per type

## Kvec Embeddings

- Local sentence-transformers model
- Source code embedding and search
- Commit message embedding
- Document embedding (PDF, markdown)
- Session transcript embedding
- Memory embedding and semantic search
- pgvector with 768-dim vectors
- Collection management UI

## Kdag Pipelines

- Multi-step job definitions
- Prompt, map_reduce, and code steps
- Per-step agent and model overrides
- Custom input types
- Job execution and run tracking
- Definition snapshots and versioning
- Export / import definitions
- Definition editor UI

## Gemini & Assistant Chat

- Chat with Google Gemini models
- Model selector (Pro, Flash, etc.)
- Streaming responses
- Save responses as memories
- Edit titles, copy messages
- Token usage per message
- Assistant chat — route to any model
- Claude, Codex, Gemini in one tool

## Slack Integration

- Register and sync channels
- Ingest Slack export archives
- Full-text and semantic search
- Source file metadata tracking
- Channel browser in UI

## Live Messages

- Send messages between sessions
- iTerm2 delivery via escape sequences
- Broadcast via session nicknames
- Unread count on every prompt

## Session Management

- Browse conversations by project
- Synced transcripts with embeddings
- Keyword, fulltext, and semantic search
- Filter by user / assistant / tool
- Formatted and raw JSON views
- Active session tracking and heartbeat
- Session nicknames and lineage
- Export as markdown or JSON
- Bulk cleanup tools

## Files & Media

- Drag-and-drop file upload
- Image preview and lightbox
- Full-screen pan and zoom viewer
- Audio playback (MP3, WAV)
- Text-to-speech with voice selection
- Project file manager with orphan cleanup
- File download and deletion

## Google Integration

- Import from Google Docs
- Full-resolution image extraction
- Export to Google Drive folder
- Source link and last-sync tracking

## Export Options

- Markdown with frontmatter
- PDF with embedded diagrams
- DOCX with embedded diagrams
- Slack-formatted mrkdwn
- Bulk ZIP export
- Seed file generation
- Copy to clipboard
- Google Drive sync

## Agent Management

- User and project-scoped agents
- Model and permission config
- Instructions editor with preview
- MCP server health monitoring
- Stale / unavailable detection
- Manage prompts and skills
- Sync built-in commands

## Config Syncing

- Rules sync to CLAUDE.md
- Knowledge to project files
- Bidirectional sync
- Auto-discovery of configs

## Plans & Diffs

- Browse implementation plans
- Rendered markdown with diagrams
- Version history per plan
- Anchored comments on plans
- Auto project association
- Browse git commits per project
- View file diffs per commit
- Annotate commits with notes
- Anchored comments on diff lines

## Editor

- File browser with folder tree
- Code editing with syntax highlighting
- Cmd+Shift+O to open folders
- Toggle hidden files (.claude, etc.)
- Path input modal for navigation

## Stats Dashboard

- Memory, project, tag, relation counts
- Distribution by type and project
- Top tags and relation types
- File count and total size
- Database size

## UI & Navigation

- Dark theme throughout
- Collapsible sidebar
- Right-click context menus
- Prev/next arrows in filtered lists
- Filter state persistence
- Project favorites
- Keyboard shortcuts throughout
- Skeleton loaders & toast notifications
