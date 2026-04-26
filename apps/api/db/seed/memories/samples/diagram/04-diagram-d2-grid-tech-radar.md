---
project: samples
handle: diagram-d2-grid-tech-radar
title: Technology Radar (D2)
type: diagram
subtype: diagram
tags: [example, d2, tech-radar, strategy]
---
```d2
title: |md
  # Technology Radar — Q1 2026
| {near: top-center}

adopt: Adopt {
  style.fill: "#dcfce7"
  style.stroke: "#22c55e"
  style.font-size: 16
  style.bold: true

  typescript: TypeScript
  postgres: PostgreSQL
  docker: Docker
  vitest: Vitest
  preact: Preact
  fastify: Fastify
  vite: Vite
}

trial: Trial {
  style.fill: "#dbeafe"
  style.stroke: "#3b82f6"
  style.font-size: 16
  style.bold: true

  d2: D2 Diagrams
  pgvector: pgvector
  mcp: MCP Protocol
  bun: Bun Runtime
  drizzle: Drizzle ORM
}

assess: Assess {
  style.fill: "#fef3c7"
  style.stroke: "#f59e0b"
  style.font-size: 16
  style.bold: true

  deno: Deno 2
  htmx: HTMX
  effect_ts: Effect-TS
  sqlite_wasm: SQLite WASM
  val_town: Val Town
}

hold: Hold {
  style.fill: "#fce7f3"
  style.stroke: "#ec4899"
  style.font-size: 16
  style.bold: true

  express: Express.js
  mongoose: Mongoose
  webpack: Webpack
  jest: Jest
  cra: Create React App
}

adopt -> trial: evaluate {style.stroke-dash: 5}
trial -> assess: explore {style.stroke-dash: 5}
assess -> hold: reconsider {style.stroke-dash: 5}
```
