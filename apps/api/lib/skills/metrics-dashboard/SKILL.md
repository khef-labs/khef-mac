---
name: metrics-dashboard
description: This skill should be used when the user asks to "create a metrics dashboard", "add a prometheus widget", "monitor this service", "build an observability dashboard", or needs to create live metrics widgets that query Prometheus and render in khef.
---

# Metrics Dashboard

Create config-driven Prometheus metrics dashboard widgets that render live in khef as widget memories.

## Prerequisites

The metrics stack must be running. If unsure, check health first:

```bash
npm run metrics:up          # Start Prometheus + exporters
curl localhost:3201/api/metrics/health  # Verify proxy is working
```

The stack includes Prometheus, postgres-exporter, and redis-exporter. Config lives in `infra/khef-metrics/`.

## How It Works

Widget memories contain self-contained HTML that:
1. Reads a JSON config block (`<script type="application/json" id="dashboard-config">`)
2. Queries Prometheus via the khef API proxy (`/api/metrics/query`)
3. Renders panels (KPIs, charts, tables, bars, gauges) with auto-refresh

The proxy at `/api/metrics` forwards PromQL to Prometheus, eliminating CORS issues. The Prometheus URL is configurable via the `metrics.prometheus.url` setting or `PROMETHEUS_URL` env var.

## Creating a Dashboard

### 1. Discover Available Metrics

Query Prometheus to find what metrics exist for the target service:

```
GET /api/metrics/label/__name__/values
```

Or search for specific prefixes:

```
GET /api/metrics/query?query={__name__=~"prefix_.*"}
```

### 2. Write the Dashboard Config

The config is a JSON object with these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Dashboard title displayed in the header |
| `api` | No | Metrics proxy path (default: `/api/metrics`). Use full URL for remote Prometheus. |
| `refresh` | No | Refresh interval in ms (default: `5000`) |
| `panels` | Yes | Array of panel definitions |

### 3. Panel Types

#### `kpi` — Single Value Card

```json
{
  "type": "kpi",
  "title": "Request Rate",
  "query": "sum(rate(http_requests_total[1m]))",
  "format": "number",
  "decimals": 2,
  "unit": "req/s",
  "sub": {
    "query": "sum(http_requests_total)",
    "format": "si",
    "template": "{v} total requests"
  }
}
```

#### `chart` — Time-Series Area Chart

```json
{
  "type": "chart",
  "title": "Traffic (5m)",
  "query": "sum(rate(http_requests_total[30s]))",
  "range": 300,
  "step": 15,
  "color": "#8b5cf6",
  "yLabel": "req/s"
}
```

#### `table` — Multi-Column Table

```json
{
  "type": "table",
  "title": "Top Routes",
  "columns": [
    { "header": "Route", "field": "route" },
    { "header": "Count", "field": "_count", "align": "right", "decimals": 0 }
  ],
  "queries": {
    "_count": "sum by (route) (http_requests_total)"
  },
  "keyFields": ["route"],
  "sortBy": "_count",
  "sortDir": "desc",
  "limit": 10,
  "transforms": { "_avg": "mul1000" }
}
```

#### `bars` — Horizontal Bar Chart

```json
{
  "type": "bars",
  "title": "Table Sizes",
  "query": "pg_stat_user_tables_table_size_bytes",
  "labelField": "relname",
  "valueFormat": "bytes",
  "color": "#3b82f6",
  "limit": 10
}
```

#### `gauge` — Value with Meter Bar

```json
{
  "type": "gauge",
  "title": "Memory Used",
  "query": "redis_memory_used_bytes",
  "format": "bytes",
  "maxQuery": "redis_memory_max_bytes",
  "maxLabel": "no limit",
  "sub": { "query": "redis_memory_used_peak_bytes", "format": "bytes", "template": "peak: {v}" }
}
```

#### `kvgrid` — Key-Value Info Grid

```json
{
  "type": "kvgrid",
  "title": "Server Info",
  "items": [
    { "label": "Frag Ratio", "query": "redis_mem_fragmentation_ratio", "format": "number", "decimals": 2 },
    { "label": "RSS", "query": "redis_memory_used_rss_bytes", "format": "bytes" }
  ]
}
```

### 4. Format Options

| Format | Output | Example |
|--------|--------|---------|
| `number` | Fixed decimal | `65.2` |
| `integer` | Rounded whole number | `16` |
| `bytes` | Human-readable bytes | `257.9 MB` |
| `si` | SI suffixes (K, M, B) | `16M` |
| `percent` | Percentage | `98.67%` |
| `duration` | Days/hours/minutes | `5d 3h` |
| `duration_ms` | Seconds to milliseconds | `12.5` |

### 5. Create the Widget Memory

Use `create_memory` with type `widget`. The content is the full HTML document containing:
1. The CSS (use the shared dark theme styles from existing dashboard widgets)
2. The JSON config in a `<script type="application/json" id="dashboard-config">` tag
3. The renderer JavaScript

Fetch an existing dashboard widget for the renderer template:

```
get_memory_by_handle(handle: "widget-prometheus-dashboard", project_id: "khef")
```

Copy the HTML structure and renderer JS. Replace only the JSON config block with the new dashboard's panels.

### 6. Add to a Collection

Group related dashboards in a collection with grid view:

```
add_to_collection(project_id: "...", collection_id: "...", memory_id: "...")
```

The khef project has an "Observability Dashboards" collection (`handle: observability-dashboards`).

## Reference Dashboards

Three reference dashboards exist in the khef project:

| Handle | Metrics Source | Key Panels |
|--------|---------------|------------|
| `widget-prometheus-dashboard` | khef API (`khef_*`) | Request rate, latency, memory, event loop, routes table |
| `widget-postgres-dashboard` | PostgreSQL (`pg_*`) | DB size, connections, tx rate, cache hit, table sizes, table activity |
| `widget-redis-dashboard` | Redis (`redis_*`) | Memory gauge, clients, commands/sec, hit rate, keys, server info |

## Adding Prometheus Exporters

To monitor a new service, add an exporter to `infra/khef-metrics/docker-compose.yml` and a scrape config to `infra/khef-metrics/prometheus/prometheus.yml`. Common exporters:

| Service | Exporter Image | Default Port |
|---------|---------------|-------------|
| PostgreSQL | `prometheuscommunity/postgres-exporter` | 9187 |
| Redis | `oliver006/redis_exporter` | 9121 |
| MySQL | `prom/mysqld-exporter` | 9104 |
| MongoDB | `percona/mongodb_exporter` | 9216 |
| Nginx | `nginx/nginx-prometheus-exporter` | 9113 |
| Node.js | Built-in via `prom-client` | app port |

After adding an exporter, restart the metrics stack: `npm run metrics:restart`.

## For Company/Remote Prometheus

Set the Prometheus URL in khef settings:

```
PATCH /api/settings { "metrics.prometheus.url": "https://prometheus.company.internal" }
```

Or set `PROMETHEUS_URL` env var. All widgets automatically route through the proxy — no widget changes needed.

## Tips

- Start by discovering metrics with `/api/metrics/labels` before writing queries
- Use `rate()` for counters (e.g., `rate(http_requests_total[1m])`) — never display raw counter values
- Keep panel count reasonable (6-10 panels) — too many slows refresh
- Use `si` format for large numbers, `bytes` for memory/disk, `duration_ms` for latencies
- The renderer auto-resolves the API URL from `document.referrer` — no hardcoding needed
- Test PromQL queries via `curl localhost:3201/api/metrics/query?query=...` before embedding
