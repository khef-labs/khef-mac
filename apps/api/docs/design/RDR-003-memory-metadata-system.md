# RDR-003: Memory Metadata System

**Status:** Proposed
**Date:** 2026-01-21
**Authors:** Roger, Claude

## Context

Memories need configurable settings that vary per instance. The immediate use case is `svg-max-width` for diagram memories - allowing each diagram to specify its preferred rendering width.

A dedicated column (`max_width` on memories) would work but doesn't scale well:
- Schema changes required for each new setting
- Pollutes the memories table with nullable columns
- Settings are scattered across the schema

We need a flexible, normalized approach that:
- Allows arbitrary metadata per memory
- Centralizes field definitions
- Supports multiple entity types (memories now, potentially projects/tags later)
- Enforces consistency via foreign keys

## Decision

Implement a three-table normalized metadata system:

### Schema

```sql
-- Defines available metadata fields per entity type
CREATE TABLE metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(50) NOT NULL,    -- 'memory', 'project', etc.
  field VARCHAR(100) NOT NULL,          -- 'svg-max-width', 'render-engine'
  description TEXT,
  value_type VARCHAR(20) DEFAULT 'string',  -- 'integer', 'string', 'boolean'
  default_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_type, field)
);

-- Stores actual values per memory
CREATE TABLE memory_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  metadata_id UUID NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_id, metadata_id)
);

-- Index for efficient lookups
CREATE INDEX idx_memory_metadata_memory_id ON memory_metadata(memory_id);
CREATE INDEX idx_metadata_entity_type ON metadata(entity_type);
```

### Relationships

```
memories (1) ----< memory_metadata >---- (1) metadata
              memory_id          metadata_id
              value
```

- `metadata` defines what fields exist (e.g., `(memory, svg-max-width)`)
- `memory_metadata` stores values for specific memories
- A memory can have multiple metadata values
- A metadata field can be used by multiple memories

### Seed Data

```sql
INSERT INTO metadata (entity_type, field, description, value_type, default_value)
VALUES
  ('memory', 'svg-max-width', 'Maximum width in pixels for SVG diagram rendering', 'integer', '800'),
  ('memory', 'svg-theme', 'Theme override for diagram rendering', 'string', NULL);
```

### API Changes

#### Get Memory Response

Include metadata in memory responses:

```json
{
  "id": "...",
  "title": "Architecture Diagram",
  "type": "diagram",
  "content": "...",
  "metadata": {
    "svg-max-width": "600"
  }
}
```

#### Update Memory Metadata

```
PATCH /api/projects/:projectId/memories/:memoryId
Content-Type: application/json

{
  "metadata": {
    "svg-max-width": "1200"
  }
}
```

Or dedicated endpoint:

```
PUT /api/projects/:projectId/memories/:memoryId/metadata/:field
Content-Type: application/json

{
  "value": "1200"
}
```

#### List Available Metadata Fields

```
GET /api/metadata?entity_type=memory

Response:
{
  "fields": [
    {
      "field": "svg-max-width",
      "description": "Maximum width in pixels for SVG diagram rendering",
      "value_type": "integer",
      "default_value": "800"
    }
  ]
}
```

### UI Integration

In the Memory detail page metadata panel, show metadata fields relevant to the memory type:

```
METADATA
────────────────────────
TITLE
Architecture Diagram

TYPE          STATUS
Diagram       Active

MAX WIDTH              <-- New field for diagram type
600 px
```

The UI should:
1. Fetch available metadata fields for entity type
2. Display fields relevant to memory type (e.g., `svg-*` for diagrams)
3. Allow editing via the metadata edit mode
4. Use `default_value` when no value is set

## Consequences

### Positive

1. **Flexible** - Add new metadata fields without schema migrations
2. **Normalized** - Field definitions centralized, no duplication
3. **Extensible** - Same pattern works for projects, tags, etc.
4. **Consistent** - FK constraints prevent typos in field names
5. **Discoverable** - API can list available fields per entity type
6. **Type hints** - `value_type` enables validation and UI input types

### Negative

1. **Extra joins** - Fetching memory with metadata requires join
2. **Text values** - All values stored as TEXT, need casting
3. **More tables** - Increases schema complexity
4. **Migration** - Need to seed initial metadata fields

### Mitigations

- **Joins:** Include metadata in standard memory queries via LEFT JOIN or subquery
- **Casting:** Handle in application layer, `value_type` indicates how to cast
- **Complexity:** Well-documented, follows standard EAV pattern

## Implementation Plan

### Phase 1: Database Schema
- [ ] Create `metadata` table
- [ ] Create `memory_metadata` table
- [ ] Add indexes
- [ ] Seed initial fields (`svg-max-width`)

### Phase 2: API - Read
- [ ] Include metadata in GET memory responses
- [ ] Add GET /api/metadata endpoint for available fields

### Phase 3: API - Write
- [ ] Accept metadata in PATCH memory requests
- [ ] Validate against `value_type`
- [ ] Handle upsert logic for memory_metadata

### Phase 4: UI
- [ ] Update Memory type to include metadata
- [ ] Display metadata in detail panel
- [ ] Allow editing metadata fields
- [ ] Use metadata values in diagram rendering

## Alternatives Considered

### 1. Dedicated Column

```sql
ALTER TABLE memories ADD COLUMN max_width INTEGER;
```

**Rejected:** Doesn't scale. Each new setting requires migration.

### 2. JSON Column

```sql
ALTER TABLE memories ADD COLUMN metadata JSONB;
```

**Rejected:** No schema enforcement, hard to query/index specific fields, no central definition of valid fields.

### 3. Key-Value Table (Simpler)

```sql
CREATE TABLE memory_metadata (
  memory_id UUID,
  key VARCHAR(100),
  value TEXT
);
```

**Rejected:** No central field definitions, prone to typos, no type hints.

## References

- [Entity-Attribute-Value model](https://en.wikipedia.org/wiki/Entity%E2%80%93attribute%E2%80%93value_model)
- WordPress postmeta pattern
- RDR-002: Server-Side Diagram Rendering (motivation for svg-max-width)
