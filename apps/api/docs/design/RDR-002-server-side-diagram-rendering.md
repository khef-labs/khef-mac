# RDR-002: Server-Side Diagram Rendering

**Status:** Implemented
**Date:** 2026-01-21
**Authors:** Roger, Claude

## Context

The khef-ui currently renders Mermaid diagrams client-side using the `mermaid` JavaScript library. This causes inconsistent rendering across different machines due to:

- Font availability differences
- Browser rendering engine variations
- System-level graphics settings
- Screen resolution / DPI differences

Testing showed the same ERD diagram rendering correctly on one machine but appearing compressed/unreadable on another, despite trying various mermaid configurations (elk layout, useMaxWidth, explicit sizing).

## Decision

Implement server-side diagram rendering in khef backend, storing both the source code and rendered SVG.

### DOCX Export Rendering (Word-Compatible PNGs)

Word’s SVG renderer is limited (e.g., missing `foreignObject` text and SVG markers for arrows), which caused empty boxes or missing lines in DOCX exports. To ensure reliable output in Word and Google Drive:

- **DOCX exports render Mermaid diagrams to PNG** (not SVG).
- **Playwright rasterizes SVG → PNG** at a configurable render scale for crisp output.
- **Fallback:** If Playwright is unavailable, exports fall back to Kroki’s PNG endpoint.

Settings and controls:

- **Global settings (DB):**
  - `export.pngRenderScale` (1–4): Playwright device scale factor (sharpness).
  - `export.pngDisplayScalePercent` (10–300): Display size multiplier before max-width cap.
  - `export.imageTheme` (dark|light|neutral|forest|ocean): Diagram theme.
  - `export.diagramScale` (1–4): Legacy scale used only for Kroki PNG fallback.
- **Per-memory metadata:**
  - `export-png-render-scale`
  - `export-png-display-scale-percent`
  - `export-image-theme`
  - `export-diagram-scale` (legacy fallback)
- **Env (API):**
  - `PNG_RENDERING_ENABLED` (true|false): Enables Playwright rasterization (false forces Kroki PNG).
  - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (optional): Explicit browser path when auto-detect fails.

This keeps UI previews as SVG while producing Word-safe, high-quality PNGs in DOCX exports.

### 1. Schema Changes

Add a `rendered_content` column to the memories table for diagram-type memories:

```sql
ALTER TABLE memories ADD COLUMN rendered_content TEXT;
```

This stores the pre-rendered SVG output. The original `content` column keeps the mermaid source code.

### 2. Rendering Engine

Use [Kroki](https://kroki.io/) as a Docker sidecar for rendering:

```yaml
# docker-compose.yml
services:
  kroki:
    image: yuzutech/kroki
    ports:
      - "8000:8000"
```

**Why Kroki:**
- Supports multiple diagram types (mermaid, d2, plantuml, graphviz, etc.)
- Self-hosted = no data leaves the network
- Single consistent rendering environment
- Well-maintained, active project

**Alternative considered:** `mermaid-cli` with Puppeteer. More direct but heavier dependency, and Kroki gives us flexibility to support other diagram formats later.

### 3. API Changes

#### New Preview Endpoint

```
POST /api/preview/diagram
Content-Type: application/json

{
  "type": "mermaid",
  "content": "graph TD\n  A --> B"
}

Response:
{
  "svg": "<svg>...</svg>"
}
```

Used by UI for live preview while editing.

#### Memory Create/Update

When creating or updating a diagram-type memory:
1. Validate the diagram syntax by rendering it
2. Store source in `content`, rendered SVG in `rendered_content`
3. Return both in the response

```typescript
// On create/update of diagram memory
if (memoryType === 'diagram') {
  const svg = await renderDiagram(content)
  await db.query(
    'UPDATE memories SET content = $1, rendered_content = $2 WHERE id = $3',
    [content, svg, memoryId]
  )
}
```

#### Memory Response

Include `rendered_content` in memory responses:

```json
{
  "id": "...",
  "type": "diagram",
  "content": "```mermaid\ngraph TD...\n```",
  "rendered_content": "<svg>...</svg>",
  ...
}
```

### 4. UI Changes

#### View Mode
- Display `rendered_content` (SVG) directly
- No client-side mermaid rendering needed
- Remove mermaid dependency from client bundle

#### Edit Mode
- Textarea shows raw mermaid source (`content`)
- Edit/Preview toggle:
  - **Edit**: Show textarea
  - **Preview**: Call `POST /api/preview/diagram`, display returned SVG

#### On Save
- Send source to backend
- Backend renders and stores both versions
- UI updates to show new `rendered_content`

### 5. Diagram Detection

Two approaches:

**Option A: Diagram memory type only**
- Only render for `type: 'diagram'` memories
- Simple, explicit

**Option B: Detect mermaid blocks in any memory**
- Scan content for ` ```mermaid ` blocks
- Render and replace inline
- More flexible but complex

**Recommendation:** Start with Option A. Can extend to Option B later if needed.

## Security Considerations

### SVG Sanitization

Kroki returns raw SVG which is injected into the DOM. Malicious diagram content could potentially include:

- `<script>` tags (blocked by browsers when injected via innerHTML, but defense-in-depth)
- Event handlers (`onclick`, `onload`, `onerror`, etc.)
- External resource references (`<image href="http://...">`)
- CSS-based attacks (`url()` in styles)

**Mitigation:** Sanitize SVG output before returning to clients:

```typescript
function sanitizeSvg(svg: string): string {
  return svg
    // Remove script tags
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // Remove event handlers
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    // Remove javascript: URLs
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '')
    // Remove external image references (optional - may want to allow data: URIs)
    .replace(/<image[^>]*href\s*=\s*["']https?:[^"']*["'][^>]*>/gi, '')
}
```

**Known CVEs:**
- CVE-2023-0050: Stored XSS via Kroki in GitLab (GitLab didn't sanitize SVG)
- CVE-2021-22203: File read via PlantUML includes (GitLab-specific)

Since Kroki runs locally and we control the input, risk is low. Sanitization provides defense-in-depth.

## Consequences

### Positive

1. ✅ **Consistent rendering** - Same output on all clients
2. ✅ **Smaller client bundle** - Remove mermaid (~500KB+ gzipped)
3. ✅ **Faster page loads** - No client-side rendering delay
4. ✅ **Future flexibility** - Kroki supports D2, PlantUML, Graphviz, etc.
5. ✅ **Editable source** - Original mermaid code preserved
6. ✅ **Works offline** - SVG is pre-rendered, no runtime dependency

### Negative

1. ⚠️ **Docker dependency** - Requires Kroki sidecar
2. ⚠️ **Storage overhead** - SVG can be large for complex diagrams
3. ⚠️ **Preview latency** - Network round-trip for live preview
4. ⚠️ **Re-render on edit** - Must re-render when content changes

### Mitigations

- **Storage:** SVGs compress well, can gzip in DB or use CDN
- **Preview latency:** Debounce preview requests, show loading state
- **Docker:** Document in setup, add to docker-compose.yml

## Implementation Plan

### Phase 1: Backend Infrastructure
- [ ] Add Kroki to docker-compose.yml
- [ ] Create diagram rendering service (`src/services/diagram.ts`)
- [ ] Add `rendered_content` column to memories table
- [ ] Implement `POST /api/preview/diagram` endpoint

### Phase 2: Memory Integration
- [ ] Update memory create/update to render diagrams
- [ ] Include `rendered_content` in memory responses
- [ ] Handle rendering errors gracefully

### Phase 3: UI Updates
- [ ] Remove client-side mermaid dependency
- [ ] Update MemoryPage to display `rendered_content`
- [ ] Implement preview API call in edit mode
- [ ] Add loading states for preview

### Phase 4: Migration
- [ ] Script to render existing diagram memories
- [ ] Backfill `rendered_content` for existing data

## API Reference

### Preview Endpoint

```
POST /api/diagram/preview

Request:
{
  "type": "mermaid" | "d2" | "plantuml" | "graphviz",
  "content": "diagram source code",
  "theme": "dark" | "light",      // optional, default: "dark"
  "maxWidth": 800                  // optional, scales SVG to fit within this width
}

Response (success):
{
  "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\">...</svg>"
}

Response (error - validation):
{
  "error": "Missing required fields: type and content"
}

Response (error - render):
{
  "error": "Failed to render mermaid diagram: Parse error at line 3"
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Diagram type: `mermaid`, `d2`, `plantuml`, `graphviz` |
| `content` | string | Yes | Diagram source code |
| `theme` | string | No | Color theme: `dark` (default), `light` |
| `maxWidth` | number | No | Maximum width in pixels. SVG is scaled proportionally if it exceeds this width. |

#### Themes

For Mermaid diagrams, the `theme` parameter applies a custom configuration:

- **dark**: Indigo-based dark theme with light text colors optimized for dark UI backgrounds
- **light**: Default Mermaid theme for light UI backgrounds

#### maxWidth Scaling

When `maxWidth` is specified and the rendered SVG width exceeds it:
1. The scale factor is calculated: `scale = maxWidth / originalWidth`
2. Both width and height are scaled proportionally to preserve aspect ratio
3. The SVG `width` and `height` attributes are updated

If the SVG is already within the `maxWidth` bounds, it's returned unchanged.

### Kroki Integration

Internal service call:

```typescript
async function renderDiagram(type: string, content: string): Promise<string> {
  const response = await fetch(`http://kroki:8000/${type}/svg`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  })

  if (!response.ok) {
    throw new DiagramRenderError(await response.text())
  }

  return response.text()
}
```

## References

- [Kroki Documentation](https://kroki.io/)
- [Mermaid Live Editor](https://mermaid.live/) - For testing diagram syntax
- Original issue: Client-side mermaid renders differently across machines
