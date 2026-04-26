# khef Documentation

Project memory API documentation and design records.

## API Documentation

Interactive API documentation powered by OpenAPI 3.0 ([spec](api/openapi.yaml)):

- **[ReDoc UI](api/index.html)** - Clean, three-panel API reference
- **[Swagger UI](api/swagger.html)** - Interactive API explorer with try-it-out

## Guides

- **[Manual Testing Guide](guides/manual-testing.md)** - Step-by-step testing workflows with curl examples

## Design Records

Recommendation Decision Records (RDRs) documenting architectural decisions:

- **[RDR-001: Normalized Status System](design/RDR-001-normalized-status-system.md)** - Polymorphic memory status tracking with type-specific values
- **[RDR-002: Server-Side Diagram Rendering](design/RDR-002-server-side-diagram-rendering.md)** - Diagram rendering via Kroki for consistent SVG output across clients
- **[RDR-003: Memory Metadata System](design/RDR-003-memory-metadata-system.md)** - Flexible key-value metadata for memories using normalized EAV pattern
- **[RDR-004: File Storage System](design/RDR-004-file-storage-system.md)** - Project-scoped file uploads with configurable storage and migration support
