/**
 * DAST — Dynamic Application Security Testing
 *
 * Probes a running MCP HTTP server for common web security issues.
 * Does NOT require ZAP or any external tool — uses Node.js fetch only.
 *
 * Checks:
 *   1. Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
 *   2. Authentication bypass (unauthenticated access to /mcp and /metrics)
 *   3. Method enforcement (GET/PUT/PATCH on tool endpoints)
 *   4. Path traversal probes
 *   5. Injection probes in tool arguments (XSS, SQLi, SSTI payloads)
 *   6. CORS misconfiguration
 *   7. Error disclosure (stack traces, internal paths in 4xx/5xx responses)
 *   8. SSRF via tool arguments (private IP / cloud metadata probes)
 *
 * Produces:
 *   security-reports/dast-results.json    structured findings
 *   security-reports/dast-report.md       human + LLM readable summary
 *
 * Prerequisites:
 *   The server must be running and /healthz must return 200.
 *   docker compose up -d  (or k8s port-forward)
 *
 * Usage:
 *   node scripts/scan-dast.mjs --base http://localhost:3000
 *   node scripts/scan-dast.mjs --base http://localhost:3000 --token MY_AUTH_TOKEN
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base:  { type: 'string', default: 'http://localhost:3000' },
    token: { type: 'string', default: '' },
  },
  strict: false,
});

const BASE   = args.base.replace(/\/$/, '');
const TOKEN  = args.token;
const OUT    = 'security-reports';
mkdirSync(OUT, { recursive: true });

const findings = [];
const passed   = [];
let totalChecks = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function finding(severity, id, description, detail = '') {
  findings.push({ severity, id, description, detail });
  console.error(`  [${severity}] ${id}: ${description}`);
}
function pass(id, note = '') {
  passed.push({ id, note });
  console.log(`  [PASS] ${id}${note ? ': ' + note : ''}`);
}

async function probe(method, path, opts = {}) {
  totalChecks++;
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: Object.fromEntries(res.headers), body: text };
  } catch (err) {
    return { status: 0, headers: {}, body: '', error: err.message };
  }
}

// Auth headers for legitimate requests
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// ── Pre-flight: confirm server is up ─────────────────────────────────────────

console.log(`[ DAST ] Target: ${BASE}`);
const health = await probe('GET', '/healthz');
if (health.status !== 200) {
  console.error(`[ DAST ] Server not reachable (GET /healthz → ${health.status}). Start the server first.`);
  process.exit(2);
}
console.log('[ DAST ] Server is up — starting probes\n');

// ── 1. Security headers ───────────────────────────────────────────────────────

console.log('[ DAST ] 1. Security headers');
const hRes = await probe('GET', '/healthz');
const h = hRes.headers;

const required = [
  ['x-content-type-options', 'nosniff',          'Prevents MIME-type sniffing attacks'],
  ['x-frame-options',        /DENY|SAMEORIGIN/i, 'Prevents clickjacking'],
  ['x-xss-protection',       /1/,                'Legacy XSS filter (belt-and-braces)'],
];
const recommended = [
  ['strict-transport-security', /.+/,            'HSTS — ensures HTTPS-only once deployed'],
  ['content-security-policy',   /.+/,            'CSP — limits resource origins'],
  ['referrer-policy',           /.+/,            'Controls Referer header leakage'],
  ['permissions-policy',        /.+/,            'Disables unnecessary browser features'],
];

for (const [name, expected, desc] of required) {
  const val = h[name] ?? '';
  const ok  = typeof expected === 'string' ? val.toLowerCase().includes(expected) : expected.test(val);
  if (ok) pass(`HEADER_${name.toUpperCase().replace(/-/g,'_')}`, val);
  else finding('MODERATE', `MISSING_HEADER_${name.toUpperCase().replace(/-/g,'_')}`, `Missing security header: ${name}`, desc);
}
for (const [name, , desc] of recommended) {
  const val = h[name] ?? '';
  if (val) pass(`HEADER_${name.toUpperCase().replace(/-/g,'_')}`, val);
  else finding('LOW', `MISSING_HEADER_${name.toUpperCase().replace(/-/g,'_')}`, `Missing recommended header: ${name}`, desc);
}

// ── 2. Authentication bypass ──────────────────────────────────────────────────

console.log('\n[ DAST ] 2. Authentication bypass');

// /mcp must reject unauthenticated requests when TOKEN is set
if (TOKEN) {
  const unauth = await probe('POST', '/mcp', {
    body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
  });
  if (unauth.status === 401 || unauth.status === 403) {
    pass('AUTH_MCP_UNAUTHENTICATED', `→ ${unauth.status}`);
  } else {
    finding('HIGH', 'AUTH_BYPASS_MCP',
      `/mcp returned ${unauth.status} without Authorization header — auth may not be enforced`,
      `Expected 401/403, got ${unauth.status}`);
  }
} else {
  finding('LOW', 'AUTH_NO_TOKEN',
    'No --token provided — authentication bypass checks skipped',
    'Run with --token MY_AUTH_TOKEN to test auth enforcement');
}

// /metrics should not require auth but also not leak internal data to the internet
const metrics = await probe('GET', '/metrics');
if (metrics.status === 200) {
  pass('METRICS_ACCESSIBLE', '/metrics reachable (expected — restrict at ingress in production)');
} else {
  finding('LOW', 'METRICS_BLOCKED', `/metrics returned ${metrics.status} — ensure Prometheus can still scrape`);
}

// Health endpoints must be unauthenticated
for (const path of ['/healthz', '/readyz']) {
  const r = await probe('GET', path);
  if (r.status === 200) pass(`PROBE_${path.slice(1).toUpperCase()}_UNAUTHED`, 'probe endpoints accessible without auth');
  else finding('MODERATE', `PROBE_BLOCKED_${path.slice(1).toUpperCase()}`,
    `${path} returned ${r.status} — Kubernetes probes will fail if this requires auth`);
}

// ── 3. Method enforcement ─────────────────────────────────────────────────────

console.log('\n[ DAST ] 3. HTTP method enforcement');

for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
  const r = await probe(method, '/mcp', { headers: authHeaders });
  if ([405, 404, 400].includes(r.status)) {
    pass(`METHOD_${method}_REJECTED`, `→ ${r.status}`);
  } else if (r.status === 200 && method !== 'POST') {
    finding('MODERATE', `METHOD_${method}_ACCEPTED`,
      `${method} /mcp returned 200 — only POST should be accepted`,
      r.body.slice(0, 200));
  }
}

// ── 4. Path traversal ─────────────────────────────────────────────────────────

console.log('\n[ DAST ] 4. Path traversal probes');

const traversalPaths = [
  '/../../etc/passwd',
  '/%2e%2e/%2e%2e/etc/passwd',
  '/mcp/../../../etc/passwd',
  '/healthz/../../../../etc/shadow',
];
for (const p of traversalPaths) {
  const r = await probe('GET', p, { headers: authHeaders });
  if (r.body.includes('root:') || r.body.includes('/bin/bash')) {
    finding('CRITICAL', 'PATH_TRAVERSAL', `Path traversal succeeded: ${p}`, r.body.slice(0, 200));
  } else {
    pass('PATH_TRAVERSAL_BLOCKED', `${p} → ${r.status}`);
  }
}

// ── 5. Injection probes via tool arguments ────────────────────────────────────

console.log('\n[ DAST ] 5. Injection probes');

const mcpPost = (body) => probe('POST', '/mcp', { headers: { ...authHeaders, 'Content-Type': 'application/json' }, body });

const injectionPayloads = [
  { label: 'XSS in query',    payload: '<script>alert(1)</script>' },
  { label: 'SQLi in query',   payload: "' OR '1'='1" },
  { label: 'SSTI',            payload: '{{7*7}}' },
  { label: 'Path traversal',  payload: '../../etc/passwd' },
  { label: 'Null byte',       payload: 'test\x00injection' },
];

for (const { label, payload } of injectionPayloads) {
  const r = await mcpPost({
    jsonrpc: '2.0',
    method:  'tools/call',
    id:      1,
    params:  { name: 'web_search', arguments: { query: payload } },
  });
  // Look for reflection of raw payload or command output in the response
  if (r.body.includes('<script>') && r.body.includes('alert(1)')) {
    finding('HIGH', 'XSS_REFLECTION', `XSS payload reflected unescaped: ${label}`, r.body.slice(0, 300));
  } else if (r.body.includes('root:x:0:0') || r.body.includes('/etc/passwd')) {
    finding('CRITICAL', 'INJECTION_LFI', `LFI/injection succeeded: ${label}`, r.body.slice(0, 300));
  } else if (r.body.includes('49') && payload.includes('7*7')) {
    finding('HIGH', 'SSTI_EXECUTION', 'SSTI template expression evaluated in response', r.body.slice(0, 300));
  } else {
    pass(`INJECTION_SAFE_${label.replace(/\W+/g, '_').toUpperCase()}`);
  }
}

// ── 6. CORS misconfiguration ──────────────────────────────────────────────────

console.log('\n[ DAST ] 6. CORS misconfiguration');

const corsRes = await probe('OPTIONS', '/mcp', {
  headers: { ...authHeaders, Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
});
const acao = corsRes.headers['access-control-allow-origin'] ?? '';
if (acao === '*' || acao === 'https://evil.example.com') {
  finding('MODERATE', 'CORS_WILDCARD',
    `CORS allows arbitrary origins: Access-Control-Allow-Origin: ${acao}`,
    'Restrict to known origins if the server is accessible from browsers');
} else {
  pass('CORS_RESTRICTED', `ACAO: "${acao || '(not set)'}"`)  ;
}

// ── 7. Error disclosure ───────────────────────────────────────────────────────

console.log('\n[ DAST ] 7. Error disclosure');

const malformed = await probe('POST', '/mcp', {
  headers: authHeaders,
  body: '{"this is": "not valid json for mcp"',
});
const leaksStack = /at \w+\s*\(|Error: .{20,}|node_modules\//i.test(malformed.body);
const leaksPath  = /\/home\/|\/app\/|\/Users\//.test(malformed.body);
if (leaksStack) finding('MODERATE', 'ERROR_STACK_DISCLOSURE', 'Stack trace visible in error response', malformed.body.slice(0, 400));
else pass('ERROR_STACK_HIDDEN');
if (leaksPath)  finding('LOW', 'ERROR_PATH_DISCLOSURE', 'Internal file path visible in error response', malformed.body.slice(0, 400));
else pass('ERROR_PATH_HIDDEN');

// ── 8. SSRF via tool arguments ────────────────────────────────────────────────

console.log('\n[ DAST ] 8. SSRF via tool arguments');

const ssrfTargets = [
  { label: 'localhost',         url: 'http://localhost/admin' },
  { label: 'AWS metadata',      url: 'http://169.254.169.254/latest/meta-data/' },
  { label: 'RFC1918 10.x',      url: 'http://10.0.0.1/' },
  { label: 'RFC1918 192.168.x', url: 'http://192.168.1.1/' },
];
for (const { label, url } of ssrfTargets) {
  const r = await mcpPost({
    jsonrpc: '2.0', method: 'tools/call', id: 1,
    params: { name: 'fetch_url', arguments: { url } },
  });
  const body = r.body;
  // A successful SSRF would return actual content from the target
  if (body.includes('ami-id') || body.includes('instance-type') || body.includes('security-groups')) {
    finding('CRITICAL', 'SSRF_METADATA', `SSRF succeeded — cloud metadata retrieved: ${label}`, body.slice(0, 300));
  } else if (r.status === 200 && body.length > 100 && !body.includes('isError') && !body.includes('blocked')) {
    finding('HIGH', `SSRF_${label.replace(/\W+/g,'_').toUpperCase()}`,
      `SSRF may have succeeded for ${label} — response returned content`, body.slice(0, 200));
  } else {
    pass(`SSRF_BLOCKED_${label.replace(/\W+/g,'_').toUpperCase()}`, `→ ${r.status}`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

writeFileSync(`${OUT}/dast-results.json`, JSON.stringify({ target: BASE, findings, passed, totalChecks }, null, 2));

const bySeverity = {};
for (const f of findings) (bySeverity[f.severity] ??= []).push(f);

function findingTable(list) {
  if (!list.length) return '_None_\n';
  return ['| ID | Description | Detail |', '|---|---|---|',
    ...list.map(f => `| \`${f.id}\` | ${f.description} | ${(f.detail ?? '').slice(0, 100)} |`)
  ].join('\n') + '\n';
}

const now = new Date().toISOString();
const report = `# DAST Report — Dynamic Application Security Testing

**Scanned:** ${now}
**Target:** ${BASE}
**Auth:** ${TOKEN ? 'Bearer token provided' : 'No token — auth bypass checks limited'}
**Checks run:** ${totalChecks}
**Findings:** ${findings.length} | **Passed:** ${passed.length}

## Summary

| Severity | Count |
|---|---|
| 🔴 Critical | ${(bySeverity['CRITICAL'] ?? []).length} |
| 🟠 High     | ${(bySeverity['HIGH'] ?? []).length} |
| 🟡 Moderate | ${(bySeverity['MODERATE'] ?? []).length} |
| 🔵 Low      | ${(bySeverity['LOW'] ?? []).length} |
| **Total**   | **${findings.length}** |

---

## 🔴 Critical
${findingTable(bySeverity['CRITICAL'] ?? [])}
## 🟠 High
${findingTable(bySeverity['HIGH'] ?? [])}
## 🟡 Moderate
${findingTable(bySeverity['MODERATE'] ?? [])}
## 🔵 Low
${findingTable(bySeverity['LOW'] ?? [])}

---

## Checks Passed (${passed.length})

${passed.map(p => `- \`${p.id}\`${p.note ? ': ' + p.note : ''}`).join('\n') || '_None_'}

---

Raw data: \`${OUT}/dast-results.json\`
`;

writeFileSync(`${OUT}/dast-report.md`, report);
console.log(`\n[ DAST ] Report written to ${OUT}/dast-report.md`);

const critical = (bySeverity['CRITICAL'] ?? []).length;
const high     = (bySeverity['HIGH'] ?? []).length;
if (critical > 0 || high > 0) {
  console.error(`[ DAST ] FAIL — ${critical} critical, ${high} high severity findings`);
  process.exit(1);
}
console.log('[ DAST ] PASS — no critical or high severity findings');
