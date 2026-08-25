import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// MCP tool layer
export const toolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool invocations',
  labelNames: ['tool', 'outcome'] as const,
  registers: [registry],
});

export const toolDurationSeconds = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'MCP tool handler latency',
  labelNames: ['tool'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const inflightRequests = new Gauge({
  name: 'mcp_inflight_requests',
  help: 'In-flight MCP tool calls — used by HPA',
  registers: [registry],
});

// HTTP fetch layer
export const fetchRequestsTotal = new Counter({
  name: 'fetch_requests_total',
  help: 'Total page fetch attempts by render tier',
  labelNames: ['tier', 'outcome'] as const,
  registers: [registry],
});

export const fetchDurationSeconds = new Histogram({
  name: 'fetch_duration_seconds',
  help: 'Page fetch latency by render tier',
  labelNames: ['tier'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30],
  registers: [registry],
});

export const fetchEscalationsTotal = new Counter({
  name: 'fetch_escalations_total',
  help: 'Render tier escalations — ladder health signal',
  labelNames: ['from_tier', 'to_tier', 'reason'] as const,
  registers: [registry],
});

// Browser pool
export const browserPoolBrowsers = new Gauge({
  name: 'browser_pool_browsers',
  help: 'Live browser instances in the pool',
  registers: [registry],
});

export const browserPoolContexts = new Gauge({
  name: 'browser_pool_contexts',
  help: 'Active page contexts in the pool',
  registers: [registry],
});

export const browserPoolInUse = new Gauge({
  name: 'browser_pool_in_use',
  help: 'Page contexts currently serving a request',
  registers: [registry],
});

export const browserPoolQueued = new Gauge({
  name: 'browser_pool_queued',
  help: 'Requests waiting for a pool slot',
  registers: [registry],
});

export const browserRecyclesTotal = new Counter({
  name: 'browser_recycles_total',
  help: 'Browser instance recycling events',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const browserLaunchDurationSeconds = new Histogram({
  name: 'browser_launch_duration_seconds',
  help: 'Time to launch a new browser instance',
  buckets: [0.5, 1, 2, 3, 5, 10],
  registers: [registry],
});

// Search provider layer
export const searchProviderRequestsTotal = new Counter({
  name: 'search_provider_requests_total',
  help: 'Search provider requests — cost attribution',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

export const searchDegradedTotal = new Counter({
  name: 'search_degraded_total',
  help: 'Search degradation events — provider blocked, breaker open, or forced fallthrough',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const searchCacheTotal = new Counter({
  name: 'search_cache_total',
  help: 'Search result cache hits and misses',
  labelNames: ['result'] as const,
  registers: [registry],
});

// Reranker
export const rerankDurationSeconds = new Histogram({
  name: 'rerank_duration_seconds',
  help: 'Cross-encoder rerank latency',
  labelNames: ['backend'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const rerankerReady = new Gauge({
  name: 'reranker_ready',
  help: '1 when the reranker has completed warmup and is ready to score; 0 otherwise',
  registers: [registry],
});

// Store layer
export const storeOperationsTotal = new Counter({
  name: 'store_operations_total',
  help: 'Store backend operations',
  labelNames: ['backend', 'op', 'result'] as const,
  registers: [registry],
});

// Rate limiter
export const rateLimitWaitsSeconds = new Histogram({
  name: 'rate_limit_waits_seconds',
  help: 'Time spent waiting for a rate-limit token',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});

// Crawl queue — used by worker HPA
export const crawlQueueDepth = new Gauge({
  name: 'crawl_queue_depth',
  help: 'Pending crawl queue items — used by worker HPA',
  labelNames: ['job'] as const,
  registers: [registry],
});

export const crawlPagesTotal = new Counter({
  name: 'crawl_pages_total',
  help: 'Crawled pages by status',
  labelNames: ['job', 'status'] as const,
  registers: [registry],
});

// Security
export const ssrfViolationsTotal = new Counter({
  name: 'ssrf_violations_total',
  help: 'Blocked SSRF attempts by detection stage',
  labelNames: ['stage'] as const,
  registers: [registry],
});

export const robotsDeniedTotal = new Counter({
  name: 'robots_denied_total',
  help: 'Requests blocked by robots.txt',
  registers: [registry],
});

// RFC 9111 shared-cache policy (POPIA Phase 1)
export const cacheNotStoredTotal = new Counter({
  name: 'cache_not_stored_total',
  help: 'Page cache entries not stored due to RFC 9111 policy: no_store | private | authorization | cookie | set_cookie | vary_star',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// Per-caller identity (FSP readiness — s19/s22)
// NEVER add a label that carries a detected value — only classification labels
// (present/absent, rejection reason).  This lets operators track what fraction
// of traffic is sending identity without pushing personal information into metrics.
export const callerIdentityTotal = new Counter({
  name: 'caller_identity_total',
  help: 'Requests classified by whether a valid x-mcp-caller-id header was present. ' +
    'present=true/reason=ok: header present and valid. ' +
    'present=false: header absent, too_long, bad_chars, or multi_value.',
  labelNames: ['present', 'reason'] as const,
  registers: [registry],
});

// Audit trail (POPIA Phase 4 — s22)
export const auditEventsTotal = new Counter({
  name: 'audit_events_total',
  help: 'Audit events emitted to the container log stream (POPIA s22). ' +
    'pii_detected=true means at least one PII class was observed; ' +
    'popia_mode reflects POPIA_MODE at emission time.',
  labelNames: ['tool', 'outcome', 'pii_detected', 'popia_mode'] as const,
  registers: [registry],
});

// PII detection (POPIA Phase 6 — s10, s19, s105)
// NEVER add a label that captures a detected value or data sample —
// that would push personal information into the /metrics scrape endpoint.
export const piiDetectionsTotal = new Counter({
  name: 'pii_detections_total',
  help: 'PII classes detected in tool arguments, by class and enforcement action taken.',
  labelNames: ['class', 'action'] as const,
  registers: [registry],
});

export const piiScanTruncatedTotal = new Counter({
  name: 'pii_scan_truncated_total',
  help: 'Tool argument scans capped at 8 KB — silent under-scanning is visible here.',
  labelNames: ['tool'] as const,
  registers: [registry],
});

// Retention sweep (POPIA Phase 2 — s14)
export const retentionPurgedTotal = new Counter({
  name: 'retention_purged_total',
  help: 'Records deleted by the periodic retention sweep',
  labelNames: ['backend', 'entity'] as const,
  registers: [registry],
});

export const retentionLastSweepTimestamp = new Gauge({
  name: 'retention_last_sweep_timestamp_seconds',
  help: 'Unix timestamp of the last successful retention sweep — alert if no sweep in 2h',
  registers: [registry],
});
