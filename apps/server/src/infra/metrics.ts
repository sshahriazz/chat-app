import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics registry.
 *
 * Philosophy:
 *   - One dedicated `Registry` so test isolation is possible (flush per
 *     run) and so we don't leak metrics registered by transitive deps
 *     that call `prom-client` directly.
 *   - Default Node.js metrics (event-loop lag, GC, heap, fds) are
 *     enabled — they're the cheapest thing to collect and are what
 *     diagnoses most Node prod incidents.
 *   - Labels are finite-cardinality only. HTTP route label uses the
 *     *Express route path* (`/api/conversations/:id`), not the raw URL
 *     — high-cardinality labels like user ids or free-text search
 *     queries would blow up scraper memory.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: "chat-app-server" });
collectDefaultMetrics({ register: registry });

// ─── HTTP ────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency by method, route template, and status code.",
  labelNames: ["method", "route", "status_code"],
  // Buckets cover sub-ms (health probes) through multi-second (search,
  // image list). Stop at 10s — anything slower is a timeout/bug, not a
  // latency to study.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Count of HTTP requests by method, route template, and status code.",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

// ─── Cache ───────────────────────────────────────────────────

export const cacheOpsTotal = new Counter({
  name: "cache_operations_total",
  help: "Cache operations labeled by namespace (session, convMembers, userProfile, convMeta), op (get/set/del/mget/mset), and result (hit/miss/ok/error).",
  labelNames: ["ns", "op", "result"],
  registers: [registry],
});

// ─── Outbox / realtime ───────────────────────────────────────

export const outboxDepth = new Gauge({
  name: "outbox_depth",
  help: "Current row count in chat_outbox. Should stay near zero — elevated values mean Centrifugo's PG consumer is behind.",
  registers: [registry],
});

export const outboxOldestAgeSeconds = new Gauge({
  name: "outbox_oldest_age_seconds",
  help: "Age of the oldest un-consumed outbox row in seconds. Pages if > a few seconds sustained.",
  registers: [registry],
});

// ─── Auth ────────────────────────────────────────────────────

export const authLockoutsTotal = new Counter({
  name: "auth_lockouts_total",
  help: "Count of sign-in attempts rejected because the account is currently locked.",
  registers: [registry],
});

/** Convenience: bump the cache counter without the caller threading
 *  labels through every call site. */
export function recordCacheOp(
  ns: string,
  op: "get" | "set" | "del" | "mget" | "mset",
  result: "hit" | "miss" | "ok" | "error",
): void {
  cacheOpsTotal.inc({ ns, op, result });
}
