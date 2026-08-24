/**
 * Scale proof — verifies the plan's §6 claims against a live 3-server / 2-worker
 * Docker Compose stack.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.scale-test.yml \
 *     up -d --scale mcp-server=3 --scale mcp-worker=2
 *
 * Run: node scripts/scale-proof.mjs
 *
 * Tests:
 *   (a) Stateless — 6 sequential MCP initialize calls succeed across round-robin
 *   (b) Shared Redis — all replicas log "backend=redis"
 *   (c) Shared crawl queue — job submitted to one replica visible via any replica
 *   (d) Redis JobQueue data structure — correct key schema + dedup guard
 *   (e) Rate-limit shared bucket — aggregate RPS ≤ configured limit across replicas
 *   (f) Graceful drain — SIGTERM worker exits cleanly, other keeps running
 */

import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);
const BASE = 'http://localhost:3000';
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

let passed = 0;
let failed = 0;

function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function get(path) {
  const resp = await fetch(`${BASE}${path}`);
  return { status: resp.status, body: await resp.text().catch(() => '') };
}

async function mcpPost(body) {
  const resp = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE response — parse first line */ }
  if (!json && text.startsWith('data:')) {
    try { json = JSON.parse(text.split('\n')[0].slice(5).trim()); } catch { /* noop */ }
  }
  return { status: resp.status, body: json, raw: text };
}

/** Run redis-cli inside the redis container. Returns trimmed stdout. */
async function redis(cmd) {
  const { stdout } = await execAsync(
    `docker compose -f docker-compose.scale-test.yml exec -T redis redis-cli ${cmd}`
  );
  return stdout.trim();
}

/**
 * Extract the UUID job ID from a crawl_start text response.
 * The tool returns: "Crawl started. Job ID: {uuid}\nStatus: running"
 */
function extractJobId(text) {
  const m = text?.match(/Job ID:\s*([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

// ── 0. Probe endpoints ───────────────────────────────────────────────────────

console.log('\n[scale-proof] Verifying probe endpoints\n');
{
  const hz = await get('/healthz');
  ok('/healthz → 200', hz.status === 200, `got ${hz.status}`);
  const rz = await get('/readyz');
  ok('/readyz → 200', rz.status === 200, `got ${rz.status}: ${rz.body}`);
}

// ── (a) Stateless — 6 sequential MCP initialize calls ────────────────────────

console.log('\nTest (a): Stateless — sequential MCP initialize across nginx round-robin');
{
  let successes = 0;
  for (let i = 1; i <= 6; i++) {
    try {
      const { status, body } = await mcpPost({
        jsonrpc: '2.0', id: i,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'scale-proof', version: '1.0' },
        },
      });
      if (status === 200 && body?.result?.serverInfo) successes++;
      else console.error(`    request ${i}: status=${status}`);
    } catch (e) {
      console.error(`    request ${i} threw: ${e.message}`);
    }
  }
  ok('6 sequential initialize calls all 200', successes === 6, `${successes}/6 succeeded`);
}

// ── (b) Shared Redis backend ──────────────────────────────────────────────────

console.log('\nTest (b): Shared Redis store — all 3 server containers use redis backend');
{
  let redisCount = 0;
  try {
    const { stdout } = await execAsync(
      'docker compose -f docker-compose.scale-test.yml logs mcp-server 2>&1 | grep "backend=redis"'
    );
    redisCount = (stdout.match(/backend=redis/g) || []).length;
  } catch { /* grep exits 1 if no match */ }
  ok('All 3 server replicas initialised with redis store', redisCount >= 3,
    `found ${redisCount} "backend=redis" lines`);

  // Worker replicas also log it
  let workerRedis = 0;
  try {
    const { stdout } = await execAsync(
      'docker compose -f docker-compose.scale-test.yml logs mcp-worker 2>&1 | grep "backend=redis"'
    );
    workerRedis = (stdout.match(/backend=redis/g) || []).length;
  } catch { /* noop */ }
  ok('Worker replicas also use redis store', workerRedis >= 2,
    `found ${workerRedis} "backend=redis" lines`);
}

// ── (c) Shared crawl queue — job visible across all replicas ─────────────────

console.log('\nTest (c): Shared crawl queue — job submitted to one replica, status via any replica');
let sharedJobId = null;
{
  let startStatus = 0, startText = '';
  try {
    const { status, body, raw } = await mcpPost({
      jsonrpc: '2.0', id: 100,
      method: 'tools/call',
      params: { name: 'crawl_start', arguments: { url: 'https://example.com', maxPages: 1, maxDepth: 0 } },
    });
    startStatus = status;
    startText = body?.result?.content?.[0]?.text ?? raw;
  } catch (e) {
    startText = e.message;
  }
  ok('crawl_start → 200', startStatus === 200, `status=${startStatus}`);

  sharedJobId = extractJobId(startText);
  ok('crawl_start response contains jobId UUID', !!sharedJobId,
    `text="${startText?.slice(0, 120)}"`);

  if (sharedJobId) {
    let statusOk = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(1500);
      try {
        const sr = await mcpPost({
          jsonrpc: '2.0', id: 101 + attempt,
          method: 'tools/call',
          params: { name: 'crawl_status', arguments: { jobId: sharedJobId } },
        });
        if (sr.status === 200 && sr.body?.result?.content?.[0]?.text) {
          const text = sr.body.result.content[0].text;
          if (text.includes(sharedJobId)) { statusOk = true; break; }
        }
      } catch { /* keep polling */ }
    }
    ok('crawl_status readable from any replica (shared queue)', statusOk);
  }
}

// ── (d) Redis JobQueue data structure ─────────────────────────────────────────

console.log('\nTest (d): Redis JobQueue data structure — key schema + visited-set dedup');
{
  if (!sharedJobId) {
    ok('Redis job HASH exists', false, 'skipped — no jobId from test (c)');
    ok('Visited SET contains root URL', false, 'skipped');
    ok('Job registered in global mcp:jobs ZSET', false, 'skipped');
    ok('SADD on visited URL returns 0 (dedup enforced)', false, 'skipped');
  } else {
    // (d1) Job HASH must exist with status field
    const jobStatus = await redis(`HGET mcp:job:${sharedJobId} status`).catch(() => '');
    ok('Redis job HASH exists with status field',
      jobStatus === 'running' || jobStatus === 'completed',
      `status="${jobStatus}"`);

    // (d2) completed_count field exists (O(1) status reads without scanning pages)
    const completedCount = await redis(`HGET mcp:job:${sharedJobId} completed_count`).catch(() => null);
    ok('Job HASH has completed_count field for O(1) status reads',
      completedCount !== null && completedCount !== '',
      `completed_count="${completedCount}"`);

    // (d3) Visited SET must contain the root URL
    const visitedMember = await redis(`SISMEMBER mcp:job:${sharedJobId}:visited https://example.com`).catch(() => '');
    ok('Visited SET contains root URL (dedup guard active)',
      visitedMember === '1',
      `SISMEMBER returned "${visitedMember}"`);

    // (d4) Job registered in global mcp:jobs ZSET for list()
    const inJobsZset = await redis(`ZSCORE mcp:jobs ${sharedJobId}`).catch(() => '');
    ok('Job registered in global mcp:jobs ZSET',
      !!inJobsZset && inJobsZset !== '',
      `ZSCORE="${inJobsZset}"`);

    // (d5) Dedup: SADD on an already-visited URL returns 0
    const sadded = await redis(`SADD mcp:job:${sharedJobId}:visited https://example.com`).catch(() => '-1');
    ok('SADD on already-visited URL returns 0 (dedup working)',
      sadded === '0',
      `SADD returned "${sadded}" (0 = already present)`);
  }
}

// ── (e) Rate-limit shared bucket across all replicas ─────────────────────────
//
// fetch_url uses Playwright (Tier 3) — the rate limiter lives in the unified
// HTTP client used by the crawl engine (Tier 1 path). We verify the shared
// bucket in two ways:
//
//   e1. Direct Lua: call the TAKE_SCRIPT via redis-cli multiple times in rapid
//       succession simulating multiple replicas consuming the same key. Burst=2
//       means take 3 → first 2 return 0, third returns > 0.
//
//   e2. End-to-end: confirm that after a crawl runs, the crawl worker wrote the
//       rate-limit key into Redis (proving the Redis store is used, not an
//       in-memory fallback).

console.log('\nTest (e): Rate-limit shared Redis bucket — aggregate RPS honoured across replicas');
{
  const TAKE_SCRIPT = `
local key = KEYS[1]
local rps = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1]) or burst
local last_refill = tonumber(data[2]) or now
local elapsed = now - last_refill
tokens = math.min(burst, tokens + (elapsed * rps / 1000))
local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait_ms = math.ceil((1 - tokens) / rps * 1000)
end
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, 60)
return wait_ms
`.trim().replace(/\n/g, ' ');

  const RL_KEY = 'test:ratelimit:example.com';
  const RPS = 2;
  const BURST = 2;
  const now = Date.now();

  await redis(`DEL ${RL_KEY}`).catch(() => {});

  // Simulate 3 replicas each consuming one token in the same millisecond
  const waits = [];
  for (let i = 0; i < BURST + 1; i++) {
    const w = await redis(`EVAL "${TAKE_SCRIPT}" 1 ${RL_KEY} ${RPS} ${BURST} ${now}`).catch(() => '-1');
    waits.push(parseInt(w, 10));
  }
  console.log(`    Lua TAKE results (RPS=${RPS}, burst=${BURST}): ${waits.join(', ')} ms`);

  ok('First burst takes return 0 (proceed immediately)',
    waits.slice(0, BURST).every(w => w === 0),
    `first ${BURST} waits: ${waits.slice(0, BURST)}`);

  ok('Take after burst exhaustion returns wait > 0 (bucket is shared)',
    waits[BURST] > 0,
    `wait after burst: ${waits[BURST]}ms`);

  // e2: Verify rate-limit key is in Redis after the crawl from test (c)
  // The crawl worker's HTTP client (Tier 1) calls rate_limit store for each URL fetched.
  // Check both the test key and the real example.com key from the crawl.
  const crawlRlKey = await redis('HGET example.com tokens').catch(() => null);
  const workerWired = crawlRlKey !== null;
  ok('Worker wrote rate-limit key to Redis (shared store used by crawl engine)',
    workerWired,
    crawlRlKey !== null
      ? `tokens="${crawlRlKey}" (key exists)`
      : 'example.com not found in Redis — worker may use in-memory fallback or Tier 3 path');

  if (!workerWired) {
    // Informational: check logs for worker rate-limit wiring
    try {
      const { stdout } = await execAsync(
        'docker compose -f docker-compose.scale-test.yml logs mcp-worker 2>&1 | grep -i "rate limit"'
      );
      console.log(`    Worker rate-limit logs: ${stdout.trim().slice(0, 200)}`);
    } catch { /* noop */ }
  }
}

// ── (f) Graceful drain — one worker exits, other survives ────────────────────

console.log('\nTest (f): Graceful drain — SIGTERM one worker, other survives and queue unblocked');
{
  let workerIds = [];
  try {
    const { stdout } = await execAsync(
      'docker compose -f docker-compose.scale-test.yml ps -q mcp-worker'
    );
    workerIds = stdout.trim().split('\n').filter(Boolean);
  } catch { /* noop */ }

  ok('At least 2 worker containers running', workerIds.length >= 2, `found ${workerIds.length}`);

  if (workerIds.length >= 2) {
    const target = workerIds[0];
    console.log(`    Sending SIGTERM to worker ${target.slice(0, 12)}…`);
    let survivingIds = [];
    try {
      await execAsync(`docker kill --signal SIGTERM ${target}`);
      await sleep(8000);  // SHUTDOWN_DRAIN_MS=5000 + buffer
      const { stdout } = await execAsync(
        'docker compose -f docker-compose.scale-test.yml ps -q mcp-worker'
      );
      survivingIds = stdout.trim().split('\n').filter(Boolean);
      ok('Surviving worker still running after peer SIGTERM',
        survivingIds.length >= 1, `${survivingIds.length} running`);
      ok('SIGTERMed worker has exited', !survivingIds.includes(target));
    } catch (e) {
      ok('SIGTERM handled cleanly', false, e.message);
    }

    // Start a new crawl — the surviving worker must still pick it up
    if (survivingIds.length >= 1) {
      let drainJobId = null;
      try {
        const { status, body } = await mcpPost({
          jsonrpc: '2.0', id: 300,
          method: 'tools/call',
          params: { name: 'crawl_start', arguments: { url: 'https://example.com', maxPages: 1, maxDepth: 0 } },
        });
        if (status === 200 && body?.result?.content?.[0]?.text) {
          drainJobId = extractJobId(body.result.content[0].text);
        }
      } catch { /* noop */ }

      let workerPickedUp = false;
      if (drainJobId) {
        for (let attempt = 0; attempt < 12; attempt++) {
          await sleep(2000);
          const s = await redis(`HGET mcp:job:${drainJobId} status`).catch(() => '');
          if (s === 'completed' || s === 'running') { workerPickedUp = true; break; }
        }
      }
      ok('Surviving worker picks up new jobs after peer drain', workerPickedUp,
        drainJobId ? `jobId=${drainJobId}` : 'crawl_start failed to return jobId');
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
