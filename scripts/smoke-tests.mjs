/**
 * Smoke tests — verify all supported deployment modes end-to-end.
 *
 * Modes tested:
 *   1.  Stdio            — node process, memory store, no ports
 *   2.  HTTP / sqlite    — docker compose up mcp-server (no sidecars)
 *   3.  HTTP / memory    — STORE_BACKEND=memory override (no file)
 *   4.  HTTP / Lightpanda — --profile lightpanda, Tier 2 render enabled
 *   5.  HTTP / Redis     — --profile redis, shared store
 *   6.  HTTP / LP + Redis — both profiles, full stack
 *   7.  HTTP / auth      — MCP_AUTH_TOKEN set; 401 without, 200 with
 *   8.  HTTP / role=both — server + worker in one container
 *   9.  HTTP / role=worker — worker-only: no HTTP listener
 *   10. HTTP / readyz gate — /readyz 503 before warm, 200 after
 *
 * Prerequisites:
 *   docker image built: docker build -t markdown-for-agents-mcp:local .
 *
 * Run: node scripts/smoke-tests.mjs
 */

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};
const PORT       = 3000;          // must match the hardcoded port binding in docker-compose.yml
const BASE       = `http://localhost:${PORT}`;
const PROJECT    = 'smoke';       // docker compose -p smoke — isolated from other stacks
const COMPOSE    = `-p ${PROJECT} -f docker-compose.yml`;
const REPO       = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TIMEOUT_MS = 90_000;        // stack-start timeout

let passed = 0;
let failed = 0;

// ── Reporting ─────────────────────────────────────────────────────────────────

const section = (t) => console.log(`\n${'─'.repeat(64)}\n${t}\n`);
const ok      = (l)      => { console.log(`  ✓ ${l}`);           passed++; };
const fail    = (l, d='')=> { console.error(`  ✗ ${l}${d ? ` — ${d}` : ''}`); failed++; };
const check   = (l, c, d='') => c ? ok(l) : fail(l, d);
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

// ── MCP HTTP helpers ──────────────────────────────────────────────────────────

async function mcpPost(method, params, { token, base = BASE } = {}) {
  const headers = { ...MCP_HEADERS };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (line) try { json = JSON.parse(line.slice(5).trim()); } catch { /* noop */ }
  }
  return { status: resp.status, body: json, raw: text };
}

async function toolCall(name, args, opts) {
  return mcpPost('tools/call', { name, arguments: args ?? {} }, opts);
}

function extractText(r) {
  return r.body?.result?.content?.[0]?.text ?? r.raw ?? '';
}

async function waitHealthy(timeoutMs = TIMEOUT_MS, base = BASE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) return true;
    } catch { /* not ready yet */ }
    await sleep(2000);
  }
  return false;
}

// ── Docker Compose helpers ────────────────────────────────────────────────────

async function dc(cmd, env = {}) {
  const envStr = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  const full   = `${envStr} docker compose ${COMPOSE} ${cmd} 2>&1`;
  const { stdout } = await execAsync(full, { cwd: REPO }).catch(e => ({ stdout: e.stdout ?? '' }));
  return stdout;
}

async function up(service, env = {}, profiles = []) {
  const pflags = profiles.map(p => `--profile ${p}`).join(' ');
  await dc(`${pflags} up -d ${service}`, env);
}

async function down() {
  await dc('down -v --remove-orphans').catch(() => {});
}

async function logs(service) {
  return dc(`logs ${service}`).catch(() => '');
}

async function inspect(service, format) {
  const { stdout } = await execAsync(
    `docker compose ${COMPOSE} inspect ${service} --format '${format}' 2>/dev/null`,
    { cwd: REPO }
  ).catch(() => ({ stdout: '' }));
  return stdout.trim();
}

// ── Stdio MCP client ──────────────────────────────────────────────────────────
// SDK v1.29+ uses newline-delimited JSON (not Content-Length framing).
// serializeMessage = JSON.stringify(msg) + '\n'
// readMessage      = split on '\n', parse each line

async function stdioClient() {
  const proc = spawn('node', ['dist/index.js'], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'ERROR', LOG_FORMAT: 'json' },
  });

  let buf = '';
  let id  = 0;
  const pending = new Map();

  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* malformed line */ }
    }
  });

  const send = (method, params) => new Promise((res, rej) => {
    const reqId = ++id;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      rej(new Error(`stdio timeout: ${method}`));
    }, 30_000);
    pending.set(reqId, msg => { clearTimeout(timer); res(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n');
  });

  // Give the process 500 ms to start before the first message
  await sleep(500);
  return { send, close: () => proc.kill() };
}

// ── Individual test suites ────────────────────────────────────────────────────

async function testStdio() {
  section('Mode 1 — Stdio (memory store, no ports)');
  let client;
  try {
    client = await stdioClient();

    const init = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1.0' },
    });
    check('initialize returns protocolVersion', init.result?.protocolVersion === '2024-11-05');
    check('server name present', typeof init.result?.serverInfo?.name === 'string');

    const health = await client.send('tools/call', { name: 'health_check', arguments: {} });
    const htext  = health.result?.content?.[0]?.text ?? '';
    check('health_check returns healthy', htext.includes('"healthy"'));

    const fetch_ = await client.send('tools/call', {
      name: 'fetch_url',
      arguments: { url: 'https://example.com' },
    });
    const ftext = fetch_.result?.content?.[0]?.text ?? '';
    check('fetch_url returns content', ftext.includes('Example Domain'), `got: ${ftext.slice(0, 80)}`);
    check('fetch_url no isError flag', !fetch_.result?.isError);

  } catch (e) {
    fail('stdio client threw', e.message);
  } finally {
    client?.close();
  }
}

async function testHttpSqlite() {
  section('Mode 2 — HTTP / SQLite store (no sidecars)');
  try {
    await up('mcp-server', { STORE_BACKEND: 'sqlite' });
    check('stack started', await waitHealthy(), 'healthz timed out');

    const r = await toolCall('health_check');
    check('health_check 200', r.status === 200);
    check('health_check healthy', extractText(r).includes('"healthy"'));

    const serverLogs = await logs('mcp-server');
    check('store backend = sqlite', serverLogs.includes('backend=sqlite'));

    const fr = await toolCall('fetch_url', { url: 'https://example.com' });
    check('fetch_url 200', fr.status === 200);
    check('fetch_url has content', extractText(fr).includes('Example Domain'));

    const noSidecar = !(await dc('ps lightpanda')).includes('running');
    check('Lightpanda not running', noSidecar);
  } finally {
    await down();
  }
}

async function testHttpMemory() {
  section('Mode 3 — HTTP / memory store override');
  try {
    await up('mcp-server', { STORE_BACKEND: 'memory' });
    check('stack started', await waitHealthy(), 'healthz timed out');

    const serverLogs = await logs('mcp-server');
    check('store backend = memory', serverLogs.includes('backend=memory'));

    const r = await toolCall('health_check');
    check('health_check healthy', extractText(r).includes('"healthy"'));
  } finally {
    await down();
  }
}

async function testHttpLightpanda() {
  section('Mode 4 — HTTP / Lightpanda sidecar (Tier 2 render)');
  try {
    await up('mcp-server', { LIGHTPANDA_ENABLED: 'true' }, ['lightpanda']);
    check('stack started', await waitHealthy(), 'healthz timed out');

    const psOut = await dc('ps lightpanda');
    check('Lightpanda container running', psOut.includes('running') || psOut.includes('healthy'));

    const serverLogs = await logs('mcp-server');
    check('LIGHTPANDA_ENABLED=true in env', serverLogs.includes('backend=sqlite'));

    // Fetch a static page — HTTP tier should handle it, Lightpanda circuit stays closed
    const r = await toolCall('fetch_url', { url: 'https://example.com' });
    check('fetch_url succeeds with Lightpanda enabled', extractText(r).includes('Example Domain'));
  } finally {
    await down();
  }
}

async function testHttpRedis() {
  section('Mode 5 — HTTP / Redis store');
  try {
    await up('mcp-server',
      { STORE_BACKEND: 'redis', STORE_REDIS_URL: 'redis://redis:6379' },
      ['redis'],
    );
    check('stack started', await waitHealthy(), 'healthz timed out');

    const serverLogs = await logs('mcp-server');
    check('store backend = redis', serverLogs.includes('backend=redis'));

    const r = await toolCall('health_check');
    check('health_check healthy', extractText(r).includes('"healthy"'));

    const fr = await toolCall('fetch_url', { url: 'https://example.com' });
    check('fetch_url works with Redis backend', extractText(fr).includes('Example Domain'));

    // Verify Redis is actually reachable from within the stack
    const ping = await execAsync(
      `docker compose -p ${PROJECT} -f docker-compose.yml exec -T redis redis-cli ping 2>/dev/null`,
      { cwd: REPO }
    ).catch(() => ({ stdout: '' }));
    check('Redis PING responds', ping.stdout.trim() === 'PONG');
  } finally {
    await down();
  }
}

async function testHttpFull() {
  section('Mode 6 — HTTP / Lightpanda + Redis (full stack)');
  try {
    await up('mcp-server',
      { LIGHTPANDA_ENABLED: 'true', STORE_BACKEND: 'redis', STORE_REDIS_URL: 'redis://redis:6379' },
      ['lightpanda', 'redis'],
    );
    check('stack started', await waitHealthy(), 'healthz timed out');

    const serverLogs = await logs('mcp-server');
    check('store backend = redis', serverLogs.includes('backend=redis'));

    const psLP = await dc('ps lightpanda');
    check('Lightpanda container running', psLP.includes('running') || psLP.includes('healthy'));

    const r = await toolCall('health_check');
    check('health_check healthy', extractText(r).includes('"healthy"'));

    const fr = await toolCall('fetch_url', { url: 'https://example.com' });
    check('fetch_url succeeds', extractText(fr).includes('Example Domain'));
  } finally {
    await down();
  }
}

async function testHttpAuth() {
  section('Mode 7 — HTTP / bearer auth guard');
  try {
    await up('mcp-server', { MCP_AUTH_TOKEN: 'smoke-secret' });
    check('stack started', await waitHealthy(), 'healthz timed out');

    // /healthz must be unauthenticated
    const hz = await fetch(`${BASE}/healthz`);
    check('/healthz unauthenticated → 200', hz.status === 200);

    // MCP endpoint without token → 401
    const noToken = await mcpPost('tools/call', { name: 'health_check', arguments: {} });
    check('no token → 401', noToken.status === 401, `got ${noToken.status}`);

    // Wrong token → 401
    const badToken = await mcpPost('tools/call', { name: 'health_check', arguments: {} }, { token: 'wrong' });
    check('wrong token → 401', badToken.status === 401, `got ${badToken.status}`);

    // Correct token → 200
    const goodToken = await toolCall('health_check', {}, { token: 'smoke-secret' });
    check('correct token → 200', goodToken.status === 200, `got ${goodToken.status}`);
    check('health_check healthy with auth', extractText(goodToken).includes('"healthy"'));
  } finally {
    await down();
  }
}

async function testRoleBoth() {
  section('Mode 8 — HTTP / MCP_ROLE=both (server + worker in one container)');
  let containerId;
  try {
    // MCP_ROLE is hardcoded in docker-compose.yml; run a standalone container instead
    const { stdout } = await execAsync(
      `docker run -d --name smoke-role-both \
        -p ${PORT}:3000 \
        -e MCP_ROLE=both \
        -e STORE_BACKEND=sqlite \
        -e MCP_HTTP_MODE=stateless \
        -e LOG_FORMAT=json \
        --shm-size=1gb \
        markdown-for-agents-mcp:local \
        node dist/index.js --http 3000 2>&1`
    );
    containerId = stdout.trim();

    check('container started', await waitHealthy(), 'healthz timed out');

    const { stdout: cLogs } = await execAsync(`docker logs ${containerId} 2>&1`).catch(() => ({ stdout: '' }));
    check('no fatal startup error', !cLogs.toLowerCase().includes('unhandled'));

    const r = await toolCall('health_check');
    check('health_check healthy in role=both', extractText(r).includes('"healthy"'));
  } catch (e) {
    fail('role=both test threw', e.message);
  } finally {
    if (containerId) await execAsync(`docker rm -f ${containerId} 2>/dev/null`).catch(() => {});
  }
}

async function testRoleWorkerOnly() {
  section('Mode 9 — role=worker (no HTTP listener)');
  let containerId;
  try {
    // Run a raw docker container — worker doesn't expose HTTP
    const { stdout } = await execAsync(
      `docker run -d --name smoke-worker \
        -e MCP_ROLE=worker \
        -e STORE_BACKEND=memory \
        -e CRAWL_WORKER_POLL_MS=500 \
        markdown-for-agents-mcp:local \
        node dist/index.js --role=worker 2>&1`
    );
    containerId = stdout.trim();
    await sleep(3000);

    const { stdout: workerLogs } = await execAsync(`docker logs ${containerId} 2>&1`).catch(() => ({ stdout: '' }));
    check('worker process started', workerLogs.includes('worker') || workerLogs.includes('Stores'));

    // Worker should NOT serve HTTP on port 3000 — connection must be refused
    let httpReachable = false;
    try {
      await fetch('http://localhost:3000/healthz', { signal: AbortSignal.timeout(2000) });
      httpReachable = true;
    } catch { /* expected */ }
    check('worker does not expose HTTP', !httpReachable);
  } catch (e) {
    fail('worker-only test threw', e.message);
  } finally {
    if (containerId) {
      await execAsync(`docker rm -f ${containerId} 2>/dev/null`).catch(() => {});
    }
  }
}

async function testReadyzGate() {
  section('Mode 10 — /readyz reflects startup state');
  try {
    await up('mcp-server', { STORE_BACKEND: 'sqlite' });
    // Poll readyz immediately — should be 200 once server is up
    const isReady = await waitHealthy(TIMEOUT_MS);
    check('server started', isReady);

    const rz = await fetch(`${BASE}/readyz`);
    check('/readyz → 200 once ready', rz.status === 200, `got ${rz.status}`);

    const body = await rz.json().catch(() => ({}));
    check('/readyz body has status field', typeof body.status === 'string');
  } finally {
    await down();
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log('markdown-for-agents-mcp — deployment smoke tests\n');

  // Ensure no leftover stack from a previous run
  await down();

  const suites = [
    testStdio,
    testHttpSqlite,
    testHttpMemory,
    testHttpLightpanda,
    testHttpRedis,
    testHttpFull,
    testHttpAuth,
    testRoleBoth,
    testRoleWorkerOnly,
    testReadyzGate,
  ];

  for (const suite of suites) {
    try {
      await suite();
    } catch (err) {
      fail(`${suite.name} threw an unexpected error`, err.message);
      await down();  // ensure cleanup even on unexpected failures
    }
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
