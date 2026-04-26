# Diagram Styling Guide

Complete reference for coloring and styling diagrams across all four supported languages.

## Mermaid

### ERD with Domain Colors

```mermaid
erDiagram
    classDef user fill:#dbeafe,stroke:#3b82f6
    classDef order fill:#dcfce7,stroke:#22c55e
    classDef product fill:#fef3c7,stroke:#f59e0b
    classDef inventory fill:#f3e8ff,stroke:#a855f7

    USER ||--o{ ORDER : places
    USER ||--o{ ADDRESS : has
    ORDER ||--|{ ORDER_ITEM : contains
    PRODUCT ||--o{ ORDER_ITEM : "ordered as"
    PRODUCT }|--|| CATEGORY : "belongs to"
    INVENTORY }|--|| WAREHOUSE : "stored in"

    USER {
        uuid id PK
        string email UK
        string first_name
        timestamp created_at
    }

    ORDER {
        uuid id PK
        uuid user_id FK
        string status
        decimal total_amount
        timestamp order_date
    }

    PRODUCT {
        uuid id PK
        uuid category_id FK
        string name
        decimal price
        string sku UK
    }

    INVENTORY {
        uuid id PK
        uuid product_id FK
        uuid warehouse_id FK
        int quantity
    }

    USER:::user
    ADDRESS:::user
    ORDER:::order
    ORDER_ITEM:::order
    PRODUCT:::product
    CATEGORY:::product
    INVENTORY:::inventory
    WAREHOUSE:::inventory
```

**Placement rules:**
- `classDef` lines immediately after `erDiagram`, before relationships
- `:::` class assignments after all entity attribute blocks
- Supported style properties: `fill`, `stroke`, `stroke-width`, `color`

**Annotation rules:**
- Valid column annotations: `PK`, `FK`, `UK`
- NEVER combine with hyphens (no `PK-FK`)
- Use plain `FK` for columns in junction tables even if they form a composite PK

### Flowchart with Subgraphs

```mermaid
flowchart TD
    A[User visits app] --> B{Has valid session?}
    B -->|Yes| C[Load dashboard]
    B -->|No| D[Show login page]
    D --> E[Enter credentials]
    E --> F{Valid?}
    F -->|No| G[Show error] --> D
    F -->|Yes| H[Create session]
    H --> C

    subgraph Security Measures
        S[Rate limiting]
        T[IP blocking]
    end
```

- Use `flowchart` (not `graph`) for type declaration
- Reserved node IDs that need wrapping: `graph`, `subgraph`, `end`, `style`, `class`, `click`, `linkStyle`, `classDef`
- Fix: `endNode[end]` instead of bare `end`

### State Diagram

```mermaid
stateDiagram-v2
    [*] --> Draft: Create
    Draft --> Review: Submit
    Review --> Approved: Approve
    Review --> Changes: Request changes
    Changes --> Review: Resubmit
    Approved --> Published: Publish
    Published --> [*]
```

### Class Diagram

```mermaid
classDiagram
    class Plugin {
        <<interface>>
        +name: string
        +init(config) Promise~void~
        +destroy() Promise~void~
    }
    class AuthPlugin {
        +validateToken(token) boolean
    }
    AuthPlugin ..|> Plugin : implements
```

### Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant API as API Server
    participant DB as Database

    Client->>API: POST /api/resource
    API->>DB: INSERT INTO resources
    DB-->>API: OK
    API-->>Client: 201 Created
```

### XY Chart

```mermaid
xychart-beta
    title "Response Time (ms)"
    x-axis [Jan, Feb, Mar, Apr]
    y-axis "Latency" 0 --> 500
    bar [120, 95, 180, 70]
    line [140, 110, 150, 90]
```

- Always quote titles containing parentheses
- Does not support `%%{init:}%%` theme directives

## D2

### Architecture with Nested Containers

```d2
direction: right

clients: Clients {
  web: Web App {
    shape: rectangle
    style.fill: "#dbeafe"
  }
  mobile: Mobile App {
    shape: rectangle
    style.fill: "#dbeafe"
  }
}

gateway: API Gateway {
  shape: rectangle
  style.fill: "#fef3c7"
  style.stroke: "#f59e0b"
}

services: Services {
  style.fill: "#f0fdf4"

  users: User Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
  orders: Order Service {
    shape: rectangle
    style.fill: "#dcfce7"
  }
}

data: Data Stores {
  style.fill: "#fdf2f8"

  pg: PostgreSQL {
    shape: cylinder
    style.fill: "#fce7f3"
  }
  redis: Redis {
    shape: cylinder
    style.fill: "#fce7f3"
  }
}

clients.web -> gateway
clients.mobile -> gateway
gateway -> services.users
gateway -> services.orders
services.users -> data.pg
services.orders -> data.redis
```

**Key D2 styling properties:**
- `style.fill` -- background color (must quote hex values)
- `style.stroke` -- border color
- `style.font-size` -- text size (integer)
- `style.bold` -- bold text (true/false)
- `style.stroke-dash` -- dashed lines (integer, e.g., 5)
- `shape` -- rectangle, cylinder, circle, diamond, oval, hexagon, etc.

### Grid / Categorized Layout

```d2
adopt: Adopt {
  style.fill: "#dcfce7"
  style.stroke: "#22c55e"
  style.font-size: 16
  style.bold: true

  item1: TypeScript
  item2: PostgreSQL
}

trial: Trial {
  style.fill: "#dbeafe"
  style.stroke: "#3b82f6"
  style.font-size: 16
  style.bold: true

  item1: pgvector
  item2: MCP Protocol
}

adopt -> trial: evaluate {style.stroke-dash: 5}
```

## Graphviz

### Dependency Graph with Cluster Coloring

```graphviz
digraph dependencies {
    rankdir=LR
    node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11]
    edge [color="#666666"]

    subgraph cluster_app {
        label="Application"
        style=filled
        color="#dbeafe"
        fontname="Helvetica"
        api [label="@app/api", fillcolor="#93c5fd"]
        ui [label="@app/ui", fillcolor="#93c5fd"]
    }

    subgraph cluster_packages {
        label="Packages"
        style=filled
        color="#dcfce7"
        fontname="Helvetica"
        kvec [label="@pkg/kvec", fillcolor="#86efac"]
    }

    api -> kvec
    ui -> api [style=dashed, label="HTTP"]
}
```

**Key Graphviz patterns:**
- `subgraph cluster_*` prefix required for grouping (the `cluster_` prefix is special)
- `color` on subgraph = background fill
- `fillcolor` on nodes = individual node fill (requires `style="filled"`)
- Global `node [...]` sets defaults for all nodes

### State Machine with Record Nodes

```graphviz
digraph states {
    rankdir=LR
    node [shape=Mrecord, style="filled", fontname="Helvetica", fontsize=10]
    edge [fontname="Helvetica", fontsize=9, color="#6B7280"]

    start [shape=point, width=0.2, fillcolor="#000000"]
    draft [label="{Draft|editable}", fillcolor="#DBEAFE"]
    review [label="{In Review|assigned}", fillcolor="#FEF3C7"]
    approved [label="{Approved|signed off}", fillcolor="#DCFCE7"]
    rejected [label="{Rejected|declined}", fillcolor="#FEE2E2"]

    start -> draft [label="create"]
    draft -> review [label="submit"]
    review -> approved [label="approve"]
    review -> rejected [label="reject"]
}
```

- `Mrecord` shape gives rounded multi-section nodes
- Use `{Title|subtitle}` syntax for multi-line record labels
- `point` shape for start/end markers

## PlantUML

### ERD with skinparam

```plantuml
@startuml
skinparam backgroundColor #FEFEFE
skinparam classBackgroundColor #DBEAFE
skinparam classBorderColor #3B82F6

entity "users" as user {
    * id : uuid <<PK>>
    --
    * email : varchar(255)
    display_name : varchar(100)
}

entity "documents" as doc {
    * id : uuid <<PK>>
    --
    * created_by : uuid <<FK>>
    * title : varchar(200)
}

user ||--o{ doc : creates
@enduml
```

### Activity Diagram with Themed Decisions

```plantuml
@startuml
skinparam backgroundColor #FEFEFE
skinparam activityBackgroundColor #E8F4FD
skinparam activityBorderColor #3B82F6
skinparam activityDiamondBackgroundColor #FEF3C7
skinparam activityDiamondBorderColor #F59E0B
skinparam arrowColor #6B7280

start
:User action;
if (Valid?) then (yes)
  :Process;
else (no)
  :Show error;
endif
stop
@enduml
```

**Common skinparam properties:**
- `backgroundColor` -- canvas background
- `classBackgroundColor` / `classBorderColor` -- entity fills
- `activityBackgroundColor` / `activityBorderColor` -- action boxes
- `activityDiamondBackgroundColor` / `activityDiamondBorderColor` -- decision diamonds
- `arrowColor` -- connector lines
- `noteBackgroundColor` / `noteBorderColor` -- note styling
