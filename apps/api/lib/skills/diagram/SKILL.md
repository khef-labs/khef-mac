---
name: diagram
description: This skill should be used when the user asks to "create a diagram", "draw an ERD", "make a flowchart", "visualize architecture", "diagram this", or needs help creating Mermaid, D2, PlantUML, or Graphviz diagrams with colors and styling.
---

# Diagram Creation

Create richly styled diagrams as khef `diagram`-type memories using Mermaid, D2, PlantUML, or Graphviz. Diagrams are rendered via Kroki (self-hosted) and stored as code-fenced content.

## Workflow

1. **Clarify the subject** -- what to diagram (ERD, flowchart, sequence, architecture, state machine, etc.)
2. **Pick the best language** based on diagram type (see Language Selection below)
3. **Apply domain-aware color grouping** -- group entities/nodes by domain and assign a consistent color palette
4. **Wrap content in a code fence** -- `` ```mermaid ``, `` ```d2 ``, `` ```plantuml ``, or `` ```graphviz ``
5. **Save as a `diagram`-type memory** with descriptive handle, title, and relevant tags

## Language Selection

| Diagram Type | Recommended Language | Notes |
|-------------|---------------------|-------|
| ERD | **Mermaid** | `erDiagram` with `classDef` + `:::` coloring |
| Flowchart | **Mermaid** | `flowchart TD/LR` with subgraphs |
| Sequence | **Mermaid** or **D2** | Mermaid for simple, D2 for nested |
| State machine | **Mermaid** or **Graphviz** | Graphviz for complex multi-record states |
| Architecture / component | **D2** | Nested containers with per-layer styling |
| Dependency graph | **Graphviz** | `digraph` with `subgraph cluster_*` grouping |
| Class diagram | **Mermaid** | `classDiagram` with interfaces and relationships |
| Activity / workflow | **PlantUML** | `skinparam` for global theming |
| ERD (alt) | **PlantUML** | `entity` blocks with `skinparam` |
| Gantt / timeline / pie | **Mermaid** | Specialized chart types |
| Block / grid layout | **Mermaid** or **D2** | D2 for styled grids |

## Color Palette

Use Tailwind-derived colors for consistency. Group entities by domain and assign each domain a fill + stroke pair.

### Standard Domain Colors

| Domain | Fill | Stroke | Mermaid Class |
|--------|------|--------|---------------|
| User / Identity | `#dbeafe` | `#3b82f6` | `classDef user fill:#dbeafe,stroke:#3b82f6` |
| Orders / Transactions | `#dcfce7` | `#22c55e` | `classDef order fill:#dcfce7,stroke:#22c55e` |
| Products / Catalog | `#fef3c7` | `#f59e0b` | `classDef product fill:#fef3c7,stroke:#f59e0b` |
| Inventory / Storage | `#f3e8ff` | `#a855f7` | `classDef inventory fill:#f3e8ff,stroke:#a855f7` |
| External / Integration | `#f3e8ff` | `#a855f7` | (purple, same as above or use pink below) |
| Alerts / Errors | `#fee2e2` | `#ef4444` | `classDef error fill:#fee2e2,stroke:#ef4444` |
| Neutral / Archived | `#f3f4f6` | `#6b7280` | `classDef neutral fill:#f3f4f6,stroke:#6b7280` |
| Pink / Highlight | `#fce7f3` | `#ec4899` | `classDef highlight fill:#fce7f3,stroke:#ec4899` |
| Orange / Warning | `#ffedd5` | `#f97316` | `classDef warning fill:#ffedd5,stroke:#f97316` |
| Teal / Success | `#d1fae5` | `#10b981` | `classDef success fill:#d1fae5,stroke:#10b981` |

Keep to 3-5 color classes per diagram for visual clarity. More colors add noise rather than information.

## Styling by Language

Detailed syntax and examples are in `references/styling-guide.md`. Key patterns:

### Mermaid ERD

```
erDiagram
    classDef user fill:#dbeafe,stroke:#3b82f6
    classDef order fill:#dcfce7,stroke:#22c55e

    USER ||--o{ ORDER : places

    USER { uuid id PK }
    ORDER { uuid id PK }

    USER:::user
    ORDER:::order
```

- `classDef` lines go after `erDiagram`, before relationships
- `:::` assignments go after all entity attribute blocks
- Do NOT use `PK-FK` -- use plain `FK`

### D2

```
container: Label {
  style.fill: "#dcfce7"
  style.stroke: "#22c55e"

  child: Child Node {
    shape: rectangle
    style.fill: "#dcfce7"
  }
}
```

- Quote hex colors in D2: `style.fill: "#dbeafe"`
- Use nested containers for architectural grouping

### Graphviz

```
digraph G {
    node [style="filled", fontname="Helvetica"]
    subgraph cluster_domain {
        style=filled; color="#dbeafe"
        mynode [fillcolor="#93c5fd"]
    }
}
```

- Use `subgraph cluster_*` for grouped coloring
- `fillcolor` for individual nodes, `color` for cluster background

### PlantUML

```
@startuml
skinparam backgroundColor #FEFEFE
skinparam classBackgroundColor #DBEAFE
skinparam classBorderColor #3B82F6
@enduml
```

- `skinparam` sets global theming
- Combine `activityBackgroundColor`, `activityDiamondBackgroundColor`, etc. for activity diagrams

## Memory Frontmatter

When creating a diagram memory, include:

```yaml
---
project: <project-handle>
handle: <kebab-case-name>
title: <Descriptive Title>
type: diagram
tags: [relevant, tags]
svg-max-width: 1250        # Optional: override default max width
export-image-theme: light   # Optional: light or dark for PNG export
---
```

## Syntax Constraints

Follow these to avoid Kroki parse errors:

- **Mermaid flowcharts**: Use `flowchart` not `graph` for the type declaration
- **Mermaid ERD**: Never use `PK-FK` -- use plain `FK` for composite key columns
- **Mermaid ERD classDef**: Place definitions after `erDiagram`, assignments after attribute blocks
- **Mermaid XY charts**: Quote titles containing parentheses: `title "Response Time (ms)"`
- **Mermaid reserved words**: `graph`, `subgraph`, `end`, `style`, `class`, `click` cannot be bare node IDs -- wrap in brackets: `endNode[end]`
- **D2**: Always quote hex colors in `style.*` properties
- **All languages**: Wrap content in a code fence matching the language

## Tips

- Always group related entities by domain before assigning colors
- For ERDs with many tables, keep entity attribute blocks concise -- 4-6 key columns, not every field
- Test diagrams in the khef UI preview before finalizing
- For large ERDs, set `svg-max-width: 1250` in frontmatter for better readability
- When the user describes a system, infer logical domain groupings and suggest colors
- Sequence diagrams generally do not need custom colors -- Mermaid themes handle them
