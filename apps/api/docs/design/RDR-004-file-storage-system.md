# RDR-004: File Storage System

**Status:** Implemented
**Date:** 2026-01-22
**Authors:** Development Team

## Context

Users need to embed images and documents in memory content. Without native file support, users would need to:
- Host files externally and link to them
- Use base64 encoding inline (bloats content, poor UX)
- Reference local paths that aren't portable

A file upload system allows seamless embedding via standard markdown syntax.

## Decision

We implemented a file storage system with the following design choices:

### 1. Full Path Storage (not computed)

**Approach:**
```sql
CREATE TABLE files (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id),
  filename VARCHAR(255) NOT NULL,      -- e.g., "abc123.png"
  original_filename VARCHAR(255),       -- e.g., "screenshot.png"
  mime_type VARCHAR(100) NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,                   -- Full filesystem path
  created_at TIMESTAMPTZ
);
```

**Rationale:** Storing the full path per-file (rather than computing from a global setting) means:
- Existing files remain accessible when storage path changes
- No need to update all files when moving storage
- Each file is self-contained and portable

### 2. Configurable Storage Path

Storage location is configurable via the `settings` table:
- `files.storagePath` - Base directory (default: `./uploads`)
- `files.maxSizeMb` - Maximum file size (default: 10MB)

Files are organized by project: `{storagePath}/{project-handle}/{uuid}.{ext}`

### 3. File Migration on Path Change

When storage path changes, users can choose to:
- **Keep**: Save setting only; new uploads use new path, existing files stay accessible
- **Move**: Migrate all existing files to new location
- **Cancel**: Abort the change

Migration uses `fs.rename()` for same-filesystem moves (atomic) with `copyFile + unlink` fallback for cross-filesystem moves.

### 4. Allowed File Types

Security-focused allowlist:

| Category | Types | MIME |
|----------|-------|------|
| Images | png, jpeg, gif, webp | `image/*` |
| Videos | mp4, webm, mov | `video/*` |
| Documents | pdf | `application/pdf` |
| Data | csv, txt | `text/*` |
| Office | xlsx, docx | `application/vnd.openxmlformats-*` |

**Excluded:** SVG (XSS risk via embedded scripts), HTML, JS, old Office formats (.xls, .doc)

### 5. Markdown Integration

Files are referenced via standard markdown:
- Images: `![alt text](/api/files/{id})`
- Documents: `[filename](/api/files/{id})`

No custom parsing needed - existing remark/rehype pipeline handles it natively.

## API Design

### Project-Scoped Routes

```
POST   /api/projects/:projectId/files     Upload (multipart/form-data)
GET    /api/projects/:projectId/files     List files
DELETE /api/projects/:projectId/files/:id Delete file
```

### Global Routes

```
GET    /api/files/:id                     Serve file (no auth, cacheable)
POST   /api/files/migrate                 Move files to new path
```

### Upload Response

```json
{
  "id": "abc123-...",
  "url": "/api/files/abc123-...",
  "filename": "screenshot.png",
  "mime_type": "image/png",
  "size": 45678,
  "project_id": "...",
  "created_at": "..."
}
```

## Schema

```sql
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_project_id ON files(project_id);
CREATE INDEX idx_files_created_at ON files(created_at DESC);
```

## Consequences

### Positive

1. ✅ **Simple Integration** - Standard markdown syntax, no custom parsing
2. ✅ **Portable References** - Full paths mean files work regardless of settings
3. ✅ **Safe Migration** - Atomic moves with fallback for cross-filesystem
4. ✅ **Security** - Strict allowlist prevents executable uploads
5. ✅ **Configurable** - Storage path and limits adjustable without code changes
6. ✅ **Project Isolation** - Files organized by project, cascade delete on project removal

### Negative

1. ⚠️ **Disk Usage** - Files stored on server filesystem (not cloud/CDN)
2. ⚠️ **No Deduplication** - Same file uploaded twice = two copies
3. ⚠️ **No Thumbnails** - Full images served (no optimization)
4. ⚠️ **Manual Cleanup** - Orphan files (unreferenced in content) not auto-deleted

### Future Enhancements

- Drag & drop upload in editor
- Paste from clipboard
- Image gallery/picker for existing uploads
- Orphan cleanup (files not referenced in any memory)
- Thumbnails/image optimization
- Memory-file linking table for reference tracking

## Implementation

### Backend (khef)

- `db/migrate/migrations/20260122160000_create_files_table.sql`
- `db/migrate/migrations/20260122180000_add_file_path_column.sql`
- `src/routes/files.ts` - Upload, serve, delete, migrate endpoints
- Dependency: `@fastify/multipart@8`

### Frontend (khef-ui)

- `src/lib/api.ts` - `uploadFile()`, `deleteFile()`, `migrateFiles()`
- `src/pages/MemoryPage.tsx` - Upload button (Cmd+I), markdown insertion
- `src/pages/SettingsPage.tsx` - Storage path/size config with migration modal

## References

- Migration files: `db/migrate/migrations/20260122*.sql`
- Route implementation: `src/routes/files.ts`
- Settings: `files.storagePath`, `files.maxSizeMb`
