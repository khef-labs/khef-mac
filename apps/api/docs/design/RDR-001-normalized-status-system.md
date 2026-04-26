# RDR-001: Normalized Polymorphic Status System

**Status:** Approved (Schema Implemented, Code Refactor Pending)
**Date:** 2025-12-28
**Authors:** Development Team

## Context

The original khef schema used an `active` boolean column to mark memories as deprecated/inactive. With the introduction of status tracking for different memory types (e.g., todos have "backlog/in_progress/done", decisions have "proposed/accepted/rejected"), the `active` column became redundant and less expressive.

Additionally, the initial status design used:
- A separate `memory_statuses` join table
- VARCHAR memory_type references (not normalized)
- No referential integrity between status and memory type

## Decision

We are refactoring to a fully normalized schema with:

### 1. Memory Types as Table (not ENUM)

**Before:**
```sql
CREATE TYPE memory_type AS ENUM ('note', 'todo', 'decision', ...);

CREATE TABLE memories (
  type memory_type NOT NULL,
  ...
);
```

**After:**
```sql
CREATE TABLE memory_types (
  id UUID PRIMARY KEY,
  name VARCHAR(50) UNIQUE,
  description TEXT
);

CREATE TABLE memories (
  memory_type_id UUID NOT NULL REFERENCES memory_types(id),
  ...
);
```

**Rationale:** Enables metadata storage (descriptions), proper FK constraints, and easier schema evolution.

### 2. Status as Column (not Join Table)

**Before:**
```sql
CREATE TABLE memory_statuses (
  memory_id UUID PRIMARY KEY,
  status VARCHAR(50),
  updated_at TIMESTAMPTZ
);
```

**After:**
```sql
CREATE TABLE memories (
  status_id UUID REFERENCES memory_type_statuses(id),
  status_updated_at TIMESTAMPTZ,
  ...
);
```

**Rationale:** Status is an attribute of a memory, not a separate entity. Simpler queries (no LEFT JOIN needed), nullable for "no status set".

### 3. Remove `active` Column

**Before:**
```sql
CREATE TABLE memories (
  active BOOLEAN NOT NULL DEFAULT TRUE,
  ...
);
```

**After:**
Status values express lifecycle state more precisely:
- `decision` with status='superseded' (more specific than active=false)
- `assistant-rule` with status='deprecated'
- No status = implicitly current/active

**Rationale:** Single source of truth, more expressive, eliminates redundancy.

### 4. Normalized Status Definitions

```sql
CREATE TABLE memory_type_statuses (
  id UUID PRIMARY KEY,
  memory_type_id UUID NOT NULL REFERENCES memory_types(id),
  status_value VARCHAR(50) NOT NULL,
  display_name VARCHAR(100),
  description TEXT,
  sort_order INTEGER,
  UNIQUE (memory_type_id, status_value)
);
```

**Rationale:**
- FK constraint prevents invalid status/type combinations
- Discoverable via API (`/api/memory-types/:type/statuses`)
- Self-documenting with display_name and description

### 5. Validation Trigger

```sql
CREATE TRIGGER validate_memory_status_type
  BEFORE INSERT OR UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION validate_memory_status_matches_type();
```

Ensures a memory can only have a status that belongs to its type.

## Final Schema

```
memory_types (1) ────< memory_type_statuses (many)
     │                        │
     │                        │
     └────< memories >────────┘
           (many)    (0..1 status)
```

**memories table:**
- `memory_type_id UUID NOT NULL` → FK to memory_types
- `status_id UUID` → FK to memory_type_statuses (nullable)
- `status_updated_at TIMESTAMPTZ` → tracks status changes
- ~~`type memory_type`~~ → removed (replaced by memory_type_id)
- ~~`active BOOLEAN`~~ → removed (use status instead)

## Consequences

### Positive

1. ✅ **Proper Normalization** - Single source of truth for types and statuses
2. ✅ **Referential Integrity** - FK constraints prevent invalid states
3. ✅ **More Expressive** - Status values are type-specific and semantic
4. ✅ **Discoverable** - Agents can query available statuses via API
5. ✅ **Simpler Queries** - Status is a column, not a join table
6. ✅ **Extensible** - Easy to add metadata, new types, new statuses

### Negative

1. ⚠️ **Breaking Change** - Every existing query must be updated
2. ⚠️ **Migration Complexity** - Need to migrate existing data
3. ⚠️ **More JOINs** - Queries need to JOIN memory_types to get type name
4. ⚠️ **Lookup Overhead** - Creating memories requires looking up memory_type_id

### Migration Impact

**Files Requiring Updates:**
- `src/types/index.ts` - Update Memory interface, input types
- `src/routes/project-memories.ts` - ~200+ lines of SQL queries
- `src/routes/memory-types.ts` - Update to return memory_type_id
- `mcp-server/src/index.ts` - Update all tool schemas and queries
- Tests - All existing tests will break

**Estimated Effort:** 2-3 hours of careful refactoring

## Implementation Plan

### Phase 1: Schema (✅ Completed)
- [x] Create memory_types table
- [x] Add seed data for 8 memory types
- [x] Update memory_type_statuses with memory_type_id FK
- [x] Modify memories table (add memory_type_id, status_id, remove type, active)
- [x] Add validation trigger
- [x] Update indexes

### Phase 2: Code Refactor (Pending)
- [ ] Update TypeScript types
- [ ] Refactor API routes to use JOINs
- [ ] Update MCP server tools
- [ ] Fix all tests
- [ ] Test migration path

### Phase 3: Migration (Pending)
- [ ] Write data migration script
- [ ] Test on sample data
- [ ] Run migration on dev database

## Query Pattern Examples

### Before (ENUM + active column):
```sql
SELECT * FROM memories
WHERE type = 'decision'
  AND active = true;
```

### After (Normalized):
```sql
SELECT m.*, mt.name as type_name, mts.status_value
FROM memories m
JOIN memory_types mt ON m.memory_type_id = mt.id
LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
WHERE mt.name = 'decision'
  AND (m.status_id IS NULL OR mts.status_value NOT IN ('rejected', 'superseded'));
```

### Getting Active Agent Rules:
```sql
SELECT m.*
FROM memories m
JOIN memory_types mt ON m.memory_type_id = mt.id
LEFT JOIN memory_type_statuses mts ON m.status_id = mts.id
WHERE mt.name = 'assistant-rule'
  AND (m.status_id IS NULL OR mts.status_value = 'active');
```

## References

- Schema File: `db/schema.sql`

## Status Values by Type

### Defined in Database

- **todo**: backlog → todo → in_progress → done / canceled
- **decision**: proposed → accepted / rejected / superseded
- **note**: draft → reviewed → archived
- **context**: current → outdated / updated
- **pattern**: proposed → active → deprecated
- **api**: draft → stable → deprecated
- **reference**: active → outdated / broken
- **assistant-rule**: active → deprecated

Agents discover valid statuses via: `GET /api/memory-types/:type/statuses`
