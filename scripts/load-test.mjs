/**
 * Load-test harness — measures p50/p95/p99 latency, error rate, and cache hit rate
 * across all three search depths against a live MCP HTTP server.
 *
 * Produces the measured numbers that go into docs/enterprise/SLO.md.
 *
 * Prerequisites:
 *   docker compose up -d (or docker compose --profile searxng up -d)
 *   Wait for /readyz to return 200 before running.
 *
 * Usage:
 *   node scripts/load-test.mjs [options]
 *
 * Options:
 *   --base <url>        MCP server base URL (default: http://localhost:3000)
 *   --concurrency <n>   Parallel requests per depth (default: 5)
 *   --queries <n>       Total queries per depth (default: 30)
 *   --depths <list>     Comma-separated depths to test (default: fast,basic,advanced)
 *   --timeout <ms>      Per-request timeout in ms (default: 30000)
 *   --token <str>       MCP_AUTH_TOKEN if server requires auth
 *
 * Outputs:
 *   Per-depth table: p50 / p95 / p99 / errors / total
 *   Cache hit rate: read from /metrics (Prometheus text format)
 *   Exit 0 on success, 1 if any depth exceeds its SLO target.
 */

import { parseArgs } from 'node:util';

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    base:        { type: 'string',  default: 'http://localhost:3000' },
    concurrency: { type: 'string',  default: '5' },
    queries:     { type: 'string',  default: '30' },
    depths:      { type: 'string',  default: 'fast,basic,advanced' },
    timeout:     { type: 'string',  default: '30000' },
    token:       { type: 'string',  default: '' },
  },
  strict: false,
});

const BASE        = args.base;
const CONCURRENCY = parseInt(args.concurrency, 10);
const TOTAL       = parseInt(args.queries, 10);
const DEPTHS      = args.depths.split(',');
const TIMEOUT_MS  = parseInt(args.timeout, 10);
const AUTH_TOKEN  = args.token;

// ── Query corpus ──────────────────────────────────────────────────────────────
// 30 realistic queries representative of enterprise department-level usage.

const CORPUS = [
  'kubernetes pod resource limits best practices',
  'typescript async await error handling patterns',
  'postgresql index optimisation techniques',
  'react useEffect cleanup memory leaks',
  'python dataclass vs pydantic comparison',
  'nginx reverse proxy configuration ssl termination',
  'docker multi-stage build optimisation',
  'redis cluster vs sentinel high availability',
  'oauth2 pkce flow implementation guide',
  'opentelemetry tracing nodejs setup',
  'graphql n+1 problem dataloader solution',
  'terraform state management remote backend',
  'aws lambda cold start optimisation',
  'kafka consumer group rebalancing explained',
  'grpc vs rest api performance comparison',
  'linux memory pressure cgroup limits',
  'git rebase vs merge workflow strategies',
  'prometheus alertmanager routing rules',
  'elasticsearch index sharding strategy',
  'celery beat periodic tasks configuration',
  'jest mock module factory pattern',
  'webpack bundle splitting code splitting',
  'sql window functions row_number partition',
  'helm chart best practices values override',
  'istio traffic management canary deployment',
  'jsonschema validation nested objects',
  'python asyncio gather exception handling',
  'postgres explain analyse query optimisation',
  'github actions matrix strategy parallelism',
  'cloudwatch logs insights query syntax',
];

// ── SLO targets (wall-clock targets; actual numbers go into SLO.md) ───────────

const SLO_P95_MS = {
  fast:     1_000,   // snippets only, no render
  basic:    8_000,   // fetch + render, no rerank
  advanced: 20_000,  // fetch + render + cross-encoder
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
};

async function searchOnce(query, depth) {
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query, searchDepth: depth } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    if (!resp.ok) return { ok: false, durationMs, reason: `HTTP ${resp.status}` };

    const text = await resp.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch {
      const line = text.split('\n').find(l => l.startsWith('data:'));
      if (line) try { body = JSON.parse(line.slice(5).trim()); } catch { /* noop */ }
    }
    const isError = body?.result?.isError === true || body?.error != null;
    return { ok: !isError, durationMs, reason: isError ? 'tool error' : undefined };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - start, reason: err.message };
  }
}

async function runBatch(queries, depth, concurrency) {
  const results = [];
  const queue = [...queries];
  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift();
      results.push(await searchOnce(q, depth));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function getCacheStats() {
  try {
    const resp = await fetch(`${BASE}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const text = await resp.text();
    const hitLine  = text.split('\n').find(l => l.includes('search_cache_total') && l.includes('"hit"'));
    const missLine = text.split('\n').find(l => l.includes('search_cache_total') && l.includes('"miss"'));
    const hits  = hitLine  ? parseFloat(hitLine.split(' ').pop())  : 0;
    const misses = missLine ? parseFloat(missLine.split(' ').pop()) : 0;
    return { hits, misses, rate: hits + misses > 0 ? (hits / (hits + misses) * 100).toFixed(1) : '0.0' };
  } catch {
    return null;
  }
}

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/readyz`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(64)}`);
console.log('markdown-for-agents-mcp — load test');
console.log(`${'='.repeat(64)}`);
console.log(`  base        : ${BASE}`);
console.log(`  concurrency : ${CONCURRENCY}`);
console.log(`  queries     : ${TOTAL} per depth`);
console.log(`  depths      : ${DEPTHS.join(', ')}`);
console.log(`  timeout     : ${TIMEOUT_MS}ms`);
console.log();

process.stdout.write('Waiting for /readyz ...');
const ready = await waitReady();
if (!ready) {
  console.error('\nServer did not become ready within 30s. Is it running?');
  process.exit(1);
}
console.log(' OK\n');

// Read cache stats before the run so we can compute delta
const cacheBefore = await getCacheStats();

const depthResults = {};
let overallOk = true;

for (const depth of DEPTHS) {
  const queries = CORPUS.slice(0, TOTAL).concat(
    CORPUS.length < TOTAL
      ? Array.from({ length: TOTAL - CORPUS.length }, (_, i) => `${CORPUS[i % CORPUS.length]} (run ${Math.floor(i / CORPUS.length) + 2})`)
      : [],
  ).slice(0, TOTAL);

  process.stdout.write(`Running ${TOTAL} × "${depth}" at concurrency ${CONCURRENCY} ...`);
  const runs = await runBatch(queries, depth, CONCURRENCY);
  console.log(` done`);

  const durations = runs.filter(r => r.ok).map(r => r.durationMs).sort((a, b) => a - b);
  const errors    = runs.filter(r => !r.ok);
  const errorRate = (errors.length / runs.length * 100).toFixed(1);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const p99 = percentile(durations, 99);
  const sloTarget = SLO_P95_MS[depth];
  const sloPass   = p95 <= sloTarget;
  if (!sloPass) overallOk = false;

  depthResults[depth] = { runs: runs.length, errors: errors.length, errorRate, p50, p95, p99, sloTarget, sloPass };

  if (errors.length > 0) {
    const reasons = errors.slice(0, 3).map(e => e.reason).join(', ');
    console.log(`  Errors (first 3): ${reasons}`);
  }
}

// Cache stats delta
const cacheAfter = await getCacheStats();

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(64)}`);
console.log('Results');
console.log(`${'─'.repeat(64)}`);
console.log(`${'Depth'.padEnd(10)} ${'Queries'.padStart(7)} ${'Errors'.padStart(7)} ${'Error%'.padStart(7)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'SLO p95'.padStart(9)} ${'Pass'.padStart(6)}`);
console.log(`${'-'.repeat(10)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(6)}`);

for (const [depth, r] of Object.entries(depthResults)) {
  const pass = r.sloPass ? '✓' : '✗';
  console.log(
    `${depth.padEnd(10)} ${String(r.runs).padStart(7)} ${String(r.errors).padStart(7)} ${(r.errorRate + '%').padStart(7)} ` +
    `${fmt(r.p50).padStart(8)} ${fmt(r.p95).padStart(8)} ${fmt(r.p99).padStart(8)} ` +
    `${('≤' + fmt(r.sloTarget)).padStart(9)} ${pass.padStart(6)}`,
  );
}

if (cacheBefore && cacheAfter) {
  const deltaHits   = cacheAfter.hits   - cacheBefore.hits;
  const deltaMisses = cacheAfter.misses - cacheBefore.misses;
  const totalReqs   = deltaHits + deltaMisses;
  const hitRate     = totalReqs > 0 ? (deltaHits / totalReqs * 100).toFixed(1) : '0.0';
  console.log(`\nCache hit rate (this run): ${hitRate}% (${deltaHits} hits / ${totalReqs} total)`);
} else {
  console.log('\nCache stats: /metrics not reachable — skipped');
}

console.log();
if (!overallOk) {
  console.error('One or more depths exceeded their p95 SLO target. Review the numbers above');
  console.error('and update SLO targets in docs/enterprise/SLO.md with the measured values.');
  process.exit(1);
} else {
  console.log('All depths within SLO targets.');
  console.log('Update docs/enterprise/SLO.md with the measured p50/p95/p99 values above.');
}
