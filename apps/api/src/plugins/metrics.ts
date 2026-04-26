import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import client from 'prom-client';

// Collect default Node.js/process metrics with khef_ prefix.
// Includes: process CPU, RSS memory, heap size, event loop lag,
// active handles/requests, GC duration, and file descriptors.
// These are scraped by Prometheus at /metrics and power the
// "Khef API Metrics" widget dashboard.
client.collectDefaultMetrics({ prefix: 'khef_' });

// HTTP request duration histogram — tracks latency distribution per route.
// Buckets range from 5ms to 10s, covering fast reads through slow aggregations.
// Labels use the route pattern (e.g., /api/projects/:projectId/memories)
// rather than the actual URL to keep cardinality bounded.
const httpRequestDuration = new client.Histogram({
  name: 'khef_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Total request counter — monotonically increasing, used with rate() in PromQL
// to compute requests/second over time windows.
const httpRequestsTotal = new client.Counter({
  name: 'khef_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

// In-flight gauge — current number of requests being processed.
// Incremented on request start, decremented on response.
const httpRequestsInFlight = new client.Gauge({
  name: 'khef_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
});

// Wrapped with fastify-plugin (fp) to break Fastify's default plugin
// encapsulation. Without fp, the onRequest/onResponse hooks would only
// apply to routes registered inside this plugin — not the 60+ route
// files registered at the parent level in index.ts.
const metricsPlugin: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  fastify.addHook('onRequest', async () => {
    httpRequestsInFlight.inc();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    httpRequestsInFlight.dec();

    // routeOptions.url gives the registered pattern (e.g., /api/projects/:projectId)
    // rather than the resolved URL (e.g., /api/projects/019bfb22-...), keeping
    // the label cardinality manageable for Prometheus.
    const route = request.routeOptions?.url || request.url;
    const method = request.method;
    const statusCode = reply.statusCode.toString();

    // Skip /metrics to avoid self-referential noise from Prometheus scrapes
    if (route === '/metrics') return;

    // Fastify's reply.elapsedTime is in milliseconds; Prometheus convention is seconds
    const elapsed = reply.elapsedTime / 1000;
    httpRequestDuration.observe({ method, route, status_code: statusCode }, elapsed);
    httpRequestsTotal.inc({ method, route, status_code: statusCode });
  });

  // Prometheus scrape endpoint — returns all registered metrics in
  // OpenMetrics/text format. Scraped every 10s by the khef-metrics
  // Prometheus instance (see infra/khef-metrics/prometheus/prometheus.yml).
  fastify.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', client.register.contentType);
    return client.register.metrics();
  });

  done();
};

export default fp(metricsPlugin, { name: 'khef-metrics' });
