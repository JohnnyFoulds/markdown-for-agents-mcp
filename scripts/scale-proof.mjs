/**
 * Scale proof — verifies the plan's §6 claims against a live 3-server / 2-worker
 * Docker Compose stack.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.scale-test.yml \
 *     up -d --scale mcp-server=3 --scale mcp-worker=2
 *
 * Run: node scripts/scale-proof.mjs
 */

import { execSync } from 'node:child_process';
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
      else console.error(`    request ${i}: status=${status}, body=${JSON.stringify(body)}`);
    } catch (e) {
      console.error(`    request ${i} threw: ${e.message}`);
    }
  }
  ok('6 sequential initialize calls all 200', successes === 6, `${successes}/6 succeeded`);
}

// ── (b) Shared state: Redis is the backend for all replicas ───────────────────

console.log('\nTest (b): Shared Redis store — all 3 server containers report redis backend');
{
  // We can verify this by checking the server logs (all should log "backend=redis")
  let redisCount = 0;
  try {
    const { stdout } = await execAsync(
      'docker compose -f docker-compose.scale-test.yml logs mcp-server 2>&1 | grep "backend=redis"'
    );
    redisCount = (stdout.match(/backend=redis/g) || []).length;
  } catch { /* grep exits 1 if no match */ }
  ok('All 3 server replicas initialised with redis store', redisCount >= 3, `found ${redisCount} "backend=redis" lines`);
}

// ── (c) Shared crawl queue — job visible across all replicas ─────────────────

console.log('\nTest (c): Shared crawl queue — job submitted to replica A is visible via round-robin');
{
  // tools/call requires an initialized session in stateful mode, but in stateless
  // mode each request is independent. We use the MCP tools/call directly.
  let jobId = null;
  try {
    const { status, body, raw } = await mcpPost({
      jsonrpc: '2.0', id: 100,
      method: 'tools/call',
      params: { name: 'crawl_start', arguments: { url: 'https://example.com', maxPages: 1, maxDepth: 0 } },
    });
    ok('crawl_start → 200', status === 200, `status=${status}`);
    if (status === 200 && body?.result?.content?.[0]?.text) {
      try {
        const parsed = JSON.parse(body.result.content[0].text);
        jobId = parsed.jobId;
        ok('crawl_start returned jobId', !!jobId, `jobId=${jobId}`);
      } catch {
        ok('crawl_start returned jobId', false, `could not parse: ${body?.result?.content?.[0]?.text}`);
      }
    } else {
      ok('crawl_start returned jobId', false, `status=${status}, raw=${raw.slice(0, 200)}`);
    }
  } catch (e) {
    ok('crawl_start → 200', false, e.message);
    ok('crawl_start returned jobId', false, 'request failed');
  }

  if (jobId) {
    let statusOk = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1500);
      try {
        const sr = await mcpPost({
          jsonrpc: '2.0', id: 101 + attempt,
          method: 'tools/call',
          params: { name: 'crawl_status', arguments: { jobId } },
        });
        if (sr.status === 200 && sr.body?.result?.content?.[0]?.text) {
          const s = JSON.parse(sr.body.result.content[0].text);
          if (s.id === jobId) { statusOk = true; break; }
        }
      } catch { /* keep polling */ }
    }
    ok('crawl_status readable from any replica (shared queue)', statusOk);
  }
}

// ── (d) SIGTERM drain — one worker exits, other continues ────────────────────

console.log('\nTest (d): Graceful drain — SIGTERM one worker, other survives');
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
    try {
      await execAsync(`docker kill --signal SIGTERM ${target}`);
      await sleep(8000);  // SHUTDOWN_DRAIN_MS=5000 + buffer
      const { stdout } = await execAsync(
        'docker compose -f docker-compose.scale-test.yml ps -q mcp-worker'
      );
      const surviving = stdout.trim().split('\n').filter(Boolean);
      ok('Surviving worker still running', surviving.length >= 1, `${surviving.length} running`);
      ok('SIGTERMed worker has exited', !surviving.includes(target));
    } catch (e) {
      ok('SIGTERM handled cleanly', false, e.message);
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
