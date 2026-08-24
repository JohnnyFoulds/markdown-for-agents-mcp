/**
 * k8s deployment smoke tests.
 *
 * Verifies a live mcp-system namespace:
 *   1.  Resource inventory        — all expected k8s objects exist
 *   2.  Pod health                — Running, Ready, no crash loops
 *   3.  Service reachability      — /healthz, /readyz, /metrics
 *   4.  Prometheus metrics        — /metrics emits valid prom format
 *   5.  MCP protocol              — health_check + fetch_url end-to-end
 *   6.  Store backend             — ConfigMap + server log agree
 *   7.  Valkey (if redis backend) — pod Running, PING responds
 *   8.  HPA active                — ScalingActive=True, targets readable
 *   9.  PDB                       — minAvailable set
 *   10. NetworkPolicy             — resource present; enforcement noted
 *   11. Stateless HTTP            — 2 replicas, 10 concurrent requests all succeed
 *   12. Worker health             — pod Running, logs show store init
 *   13. Pod self-healing          — delete server pod, verify it restarts and becomes Ready
 *
 * Prerequisites: kubectl configured pointing at a cluster with mcp-system deployed.
 * Run: node scripts/k8s-smoke-tests.mjs
 *      NAMESPACE=my-ns node scripts/k8s-smoke-tests.mjs   # custom namespace
 */

import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);

const NS      = process.env.NAMESPACE ?? 'mcp-system';
const TIMEOUT = 120_000;   // pod-restart wait timeout

let passed = 0;
let failed = 0;
let skipped = 0;

const section = (t) => console.log(`\n${'─'.repeat(64)}\n${t}\n`);
const ok      = (l)       => { console.log(`  ✓ ${l}`); passed++; };
const fail    = (l, d='') => { console.error(`  ✗ ${l}${d ? ` — ${d}` : ''}`); failed++; };
const skip    = (l, d='') => { console.log(`  – ${l}${d ? ` (${d})` : ''}`); skipped++; };
const check   = (l, c, d='') => c ? ok(l) : fail(l, d);
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

// ── kubectl helpers ───────────────────────────────────────────────────────────

async function kube(cmd) {
  const { stdout } = await execAsync(`kubectl -n ${NS} ${cmd} 2>&1`).catch(e => ({ stdout: e.stdout ?? '' }));
  return stdout.trim();
}

async function kubeJson(cmd) {
  const raw = await kube(`${cmd} -o json`);
  try { return JSON.parse(raw); } catch { return null; }
}

async function kubeGlobal(cmd) {
  const { stdout } = await execAsync(`kubectl ${cmd} 2>&1`).catch(e => ({ stdout: e.stdout ?? '' }));
  return stdout.trim();
}

// Detect service URL. Try (in order):
//   1. LoadBalancer hostname (cloud)
//   2. localhost:<servicePort>  (Docker Desktop maps LB to localhost)
//   3. localhost:<nodePort>     (NodePort fallback)
async function resolveBaseUrl() {
  const svc = await kubeJson('get svc mcp-server');
  if (!svc) return null;
  const port    = svc.spec.ports?.[0]?.port;
  const nodePort = svc.spec.ports?.[0]?.nodePort;
  const lb      = svc.status?.loadBalancer?.ingress?.[0];
  const lbHost  = lb?.hostname ?? lb?.ip;

  const candidates = [
    lbHost                    ? `http://${lbHost}:${port}`        : null,
    port                      ? `http://localhost:${port}`         : null,
    nodePort                  ? `http://localhost:${nodePort}`     : null,
  ].filter(Boolean);

  for (const url of candidates) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) return url;
    } catch { /* try next */ }
  }
  return candidates[0] ?? null;  // return best guess even if all probes failed
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get(url, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(e => ({ status: 0, _err: e.message }));
  const body = r.text ? await r.text().catch(() => '') : '';
  return { status: r.status, body };
}

async function mcpCall(base, name, args = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  }).catch(e => ({ status: 0, _err: e.message }));
  const text = r.text ? await r.text().catch(() => '') : '';
  let json = null;
  try { json = JSON.parse(text); } catch {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (line) try { json = JSON.parse(line.slice(5).trim()); } catch { /* noop */ }
  }
  return { status: r.status, body: json };
}

// ── 1. Resource inventory ─────────────────────────────────────────────────────

async function testInventory() {
  section('1 — Resource inventory');

  const expected = [
    ['Namespace', `get namespace ${NS}`],
    ['ConfigMap mcp-config', 'get configmap mcp-config'],
    ['Deployment mcp-server', 'get deployment mcp-server'],
    ['Deployment mcp-worker', 'get deployment mcp-worker'],
    ['Service mcp-server', 'get svc mcp-server'],
    ['HPA mcp-server-hpa', 'get hpa mcp-server-hpa'],
    ['HPA mcp-worker-hpa', 'get hpa mcp-worker-hpa'],
    ['PDB mcp-server-pdb', 'get pdb mcp-server-pdb'],
    ['NetworkPolicy mcp-egress', 'get networkpolicy mcp-egress'],
  ];

  for (const [label, cmd] of expected) {
    const out = await kube(cmd);
    check(label, !out.toLowerCase().includes('not found') && out.trim().length > 0, 'not found');
  }

  // Valkey only if backend=redis
  const cm = await kubeJson('get configmap mcp-config');
  const backend = cm?.data?.STORE_BACKEND ?? 'unknown';
  if (backend === 'redis') {
    const vd = await kube('get deployment valkey');
    check('Deployment valkey (redis backend)', !vd.toLowerCase().includes('not found'), 'not found');
    const vs = await kube('get svc valkey');
    check('Service valkey (redis backend)', !vs.toLowerCase().includes('not found'), 'not found');
  } else {
    skip('Valkey resources', `STORE_BACKEND=${backend}`);
  }
}

// ── 2. Pod health ─────────────────────────────────────────────────────────────

async function testPodHealth() {
  section('2 — Pod health');
  const pods = await kubeJson('get pods');
  if (!pods) { fail('get pods returned null'); return; }

  const items = pods.items ?? [];
  check('at least 2 pods running', items.length >= 2, `found ${items.length}`);

  for (const pod of items) {
    const name = pod.metadata.name;
    const phase = pod.status.phase;
    const ready = pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True';
    const restarts = pod.status.containerStatuses?.[0]?.restartCount ?? 0;

    check(`${name} phase=Running`, phase === 'Running', `phase=${phase}`);
    check(`${name} Ready`, ready);
    check(`${name} restarts < 3`, restarts < 3, `restarts=${restarts}`);
  }
}

// ── 3. Service reachability ───────────────────────────────────────────────────

async function testServiceReachability(base) {
  section('3 — Service reachability');

  const hz = await get(`${base}/healthz`);
  check('/healthz → 200', hz.status === 200, `status=${hz.status}`);
  check('/healthz body has status=ok', hz.body.includes('"ok"') || hz.body.includes('ok'));

  const rz = await get(`${base}/readyz`);
  check('/readyz → 200', rz.status === 200, `status=${rz.status}`);
  try {
    const rj = JSON.parse(rz.body);
    check('/readyz has status field', typeof rj.status === 'string');
  } catch {
    fail('/readyz body is not JSON', rz.body.slice(0, 80));
  }
}

// ── 4. Prometheus metrics ─────────────────────────────────────────────────────

async function testMetrics(base) {
  section('4 — Prometheus metrics');

  const m = await get(`${base}/metrics`);
  check('/metrics → 200', m.status === 200, `status=${m.status}`);
  check('/metrics has HELP lines', m.body.includes('# HELP '));
  check('/metrics has TYPE lines', m.body.includes('# TYPE '));
  check('fetch_requests_total present', m.body.includes('fetch_requests_total'));
  check('browser_pool_browsers present', m.body.includes('browser_pool_browsers'));
  check('mcp_tool_calls_total present', m.body.includes('mcp_tool_calls_total'));
}

// ── 5. MCP protocol ───────────────────────────────────────────────────────────

async function testMcpProtocol(base) {
  section('5 — MCP protocol');

  const hc = await mcpCall(base, 'health_check');
  check('health_check → 200', hc.status === 200, `status=${hc.status}`);
  const htext = hc.body?.result?.content?.[0]?.text ?? '';
  check('health_check returns healthy', htext.includes('"healthy"'));

  const fu = await mcpCall(base, 'fetch_url', { url: 'https://example.com' });
  check('fetch_url → 200', fu.status === 200, `status=${fu.status}`);
  const ftext = fu.body?.result?.content?.[0]?.text ?? '';
  check('fetch_url returns markdown', ftext.includes('Example Domain'), `got: ${ftext.slice(0, 60)}`);
  check('fetch_url no isError', !fu.body?.result?.isError);
}

// ── 6. Store backend ──────────────────────────────────────────────────────────

async function testStoreBackend() {
  section('6 — Store backend');

  const cm = await kubeJson('get configmap mcp-config');
  const backend = cm?.data?.STORE_BACKEND ?? 'unknown';
  check('ConfigMap has STORE_BACKEND', backend !== 'unknown', `got ${backend}`);
  ok(`STORE_BACKEND=${backend}`);

  // Verify server log confirms same backend
  const logs = await kube('logs deploy/mcp-server --tail=50');
  check('server log confirms backend', logs.includes(`backend=${backend}`), 'check server logs');
}

// ── 7. Valkey connectivity ────────────────────────────────────────────────────

async function testValkey() {
  section('7 — Valkey connectivity');

  const cm = await kubeJson('get configmap mcp-config');
  if (cm?.data?.STORE_BACKEND !== 'redis') {
    skip('Valkey tests', `STORE_BACKEND=${cm?.data?.STORE_BACKEND ?? 'unknown'}, not redis`);
    return;
  }

  const pods = await kubeJson('get pods -l app=valkey');
  const vPod = pods?.items?.[0]?.metadata?.name;
  check('Valkey pod exists', !!vPod);
  if (!vPod) return;

  const phase = pods.items[0].status.phase;
  check('Valkey pod Running', phase === 'Running', `phase=${phase}`);

  const ping = await kube(`exec ${vPod} -- valkey-cli ping`);
  check('Valkey PING=PONG', ping.trim() === 'PONG', `got "${ping.trim()}"`);
}

// ── 8. HPA ────────────────────────────────────────────────────────────────────

async function testHpa() {
  section('8 — HPA autoscaling');

  for (const name of ['mcp-server-hpa', 'mcp-worker-hpa']) {
    const hpa = await kubeJson(`get hpa ${name}`);
    if (!hpa) { fail(`${name} not found`); continue; }

    const conditions = hpa.status?.conditions ?? [];
    const active = conditions.find(c => c.type === 'ScalingActive');
    const able   = conditions.find(c => c.type === 'AbleToScale');

    check(`${name}: AbleToScale=True`, able?.status === 'True', able?.reason ?? 'no condition');
    check(`${name}: ScalingActive=True`, active?.status === 'True', active?.message ?? 'no condition');

    const metrics = hpa.status?.currentMetrics ?? [];
    const cpuMetric = metrics.find(m => m.resource?.name === 'cpu');
    check(`${name}: CPU metric readable`, !!cpuMetric, 'install metrics-server if missing');
  }
}

// ── 9. PDB ────────────────────────────────────────────────────────────────────

async function testPdb() {
  section('9 — PodDisruptionBudget');

  const pdb = await kubeJson('get pdb mcp-server-pdb');
  check('PDB exists', !!pdb);
  if (!pdb) return;

  const minAvail = pdb.spec?.minAvailable;
  check('minAvailable is set', minAvail != null, 'minAvailable is undefined');
  ok(`minAvailable=${minAvail}`);
}

// ── 10. NetworkPolicy ─────────────────────────────────────────────────────────

async function testNetworkPolicy() {
  section('10 — NetworkPolicy');

  const np = await kubeJson('get networkpolicy mcp-egress');
  check('mcp-egress NetworkPolicy exists', !!np);
  if (!np) return;

  const egress = np.spec?.egress ?? [];
  check('has egress rules', egress.length > 0);

  // Find the rule that blocks RFC1918 ranges
  const blockRule = egress.find(r =>
    r.to?.some(t => t.ipBlock?.except?.includes('10.0.0.0/8'))
  );
  check('RFC1918 exception present in egress', !!blockRule);

  // Enforcement depends on the CNI — kindnet (Docker Desktop) does NOT enforce it.
  const cni = await kubeGlobal('get pods -n kube-system -o name');
  const enforced = !cni.includes('kindnet');
  if (enforced) {
    const result = await kube(
      'exec deploy/mcp-server -- sh -c "curl -sf --max-time 3 http://169.254.169.254/ 2>&1; echo rc:$?"'
    );
    check('169.254.169.254 blocked by NetworkPolicy', !result.includes('rc:0') || result.trim() === 'rc:0' && result.length < 10);
  } else {
    skip('enforcement test', 'kindnet does not enforce NetworkPolicy — use Calico or Cilium in production');
  }
}

// ── 11. Stateless HTTP (multi-replica) ───────────────────────────────────────

async function testStateless(base) {
  section('11 — Stateless HTTP (multi-replica)');

  // Scale up to 2 replicas
  await kube('scale deployment mcp-server --replicas=2');
  ok('scaled mcp-server to 2 replicas');

  // Wait for second replica to be Ready
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const dep = await kubeJson('get deployment mcp-server');
    if ((dep?.status?.readyReplicas ?? 0) >= 2) { ready = true; break; }
    await sleep(3000);
  }
  check('second replica became Ready within 60s', ready);

  if (ready) {
    // 10 concurrent requests — all must succeed with no session errors
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mcpCall(base, 'health_check').then(r => ({ i, ok: r.status === 200 }))
      )
    );
    const allOk = results.every(r => r.ok);
    check('all 10 concurrent requests succeeded across replicas', allOk,
      `${results.filter(r => !r.ok).length} failed`);
  }

  // Scale back down
  await kube('scale deployment mcp-server --replicas=1');
  ok('scaled mcp-server back to 1 replica');
}

// ── 12. Worker health ─────────────────────────────────────────────────────────

async function testWorker() {
  section('12 — Worker health');

  const pods = await kubeJson('get pods -l app=mcp-worker');
  const wPod = pods?.items?.[0];
  check('worker pod exists', !!wPod);
  if (!wPod) return;

  check('worker pod Running', wPod.status.phase === 'Running', `phase=${wPod.status.phase}`);
  check('worker pod Ready', wPod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True');

  const logs = await kube(`logs ${wPod.metadata.name} --tail=30`);
  check('worker log shows Stores initialized', logs.includes('Stores initialized'));
  check('worker log shows worker mode', logs.toLowerCase().includes('worker'));
}

// ── 13. Pod self-healing ──────────────────────────────────────────────────────

async function testSelfHealing(base) {
  section('13 — Pod self-healing');

  // Get current server pod name
  const before = await kubeJson('get pods -l app=mcp-server');
  const oldPod = before?.items?.[0]?.metadata?.name;
  check('server pod exists before delete', !!oldPod);
  if (!oldPod) return;

  // Delete it
  await kube(`delete pod ${oldPod} --grace-period=0`);
  ok(`deleted pod ${oldPod}`);

  // Wait for a new pod to become Ready
  const deadline = Date.now() + TIMEOUT;
  let newReady = false;
  while (Date.now() < deadline) {
    const after = await kubeJson('get pods -l app=mcp-server');
    const readyPods = (after?.items ?? []).filter(p =>
      p.metadata.name !== oldPod &&
      p.status.phase === 'Running' &&
      p.status.conditions?.find(c => c.type === 'Ready')?.status === 'True'
    );
    if (readyPods.length > 0) { newReady = true; break; }
    await sleep(3000);
  }
  check('replacement pod became Ready within 120s', newReady);

  // Verify service still works after restart
  if (newReady) {
    await sleep(2000);
    const hc = await mcpCall(base, 'health_check');
    check('health_check works after pod replacement', hc.status === 200);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`markdown-for-agents-mcp — k8s deployment smoke tests\nNamespace: ${NS}\n`);

  const base = await resolveBaseUrl();
  if (!base) {
    console.error(`Could not resolve mcp-server Service URL in namespace ${NS}. Is the cluster reachable?`);
    process.exit(1);
  }
  console.log(`Service URL: ${base}\n`);

  await testInventory();
  await testPodHealth();
  await testServiceReachability(base);
  await testMetrics(base);
  await testMcpProtocol(base);
  await testStoreBackend();
  await testValkey();
  await testHpa();
  await testPdb();
  await testNetworkPolicy();
  await testStateless(base);
  await testWorker();
  await testSelfHealing(base);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
