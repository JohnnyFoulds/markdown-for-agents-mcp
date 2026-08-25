/**
 * Tests for the DAST probe detector logic in scripts/dast/detectors.mjs.
 *
 * Three test classes:
 *   1. Meta-guards — structural invariants that make the whole false-positive bug class impossible.
 *   2. Regression corpus — the exact bodies from the 2026-08-24 false-positive run; must never
 *      produce 'exploited' on CRITICAL paths again.
 *   3. False-negative direction — synthesised exploitation bodies must produce 'exploited'.
 *
 * This file is excluded from tsconfig.json compilation but is picked up by Vitest
 * (vitest.config.ts include: src/**\/*.test.{ts,js}).
 *
 * The import path goes outside src/ — this is intentional: detectors.mjs is plain
 * ESM JavaScript so it can be imported by both the scanner (no build step) and
 * these tests (Vitest handles ESM natively). It must NOT be compiled into dist/.
 */

import { describe, it, expect } from 'vitest';
// This import goes RED if the module is absent — desired initial state.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs is excluded from tsc, Vitest resolves it directly
import {
  SSRF_TARGETS,
  INJECTION_PAYLOADS,
  PATH_TRAVERSAL_PAYLOADS,
  CRLF_PAYLOADS,
  BLOCK_SIGNATURES,
  SSRF_EXPLOITATION_TOKENS,
  redactEcho,
  evaluateProbe,
} from '../../scripts/dast/detectors.mjs';

import fpFixtures from './__fixtures__/dast-fp-2026-08.json';

// ── Meta-guard 1: no exploitation token is a substring of any probe payload / URL ──
//
// Invariant: if a token appears inside a probe URL or payload value, any response
// that echoes the probe input will trip the detector — regardless of whether the
// attack succeeded. This produced all four GCP SSRF CRITICAL findings in the
// 2026-08-24 run ('computeMetadata' ⊂ GCP probe URL).
//
// This test goes RED on the old 'computeMetadata' token and the old CRLF body
// token before the module is rewritten. It makes the same failure impossible for
// any future token addition.

describe('Meta-guard: detection tokens must not be substrings of probe inputs', () => {
  it('no SSRF exploitation token appears in any SSRF probe URL', () => {
    for (const target of SSRF_TARGETS) {
      for (const { token } of SSRF_EXPLOITATION_TOKENS) {
        const urlLower = target.url.toLowerCase();
        const tokenLower = token.toLowerCase();
        expect(
          urlLower.includes(tokenLower),
          `Exploitation token "${token}" is a substring of SSRF probe URL "${target.url}". ` +
          `Any response that echoes this URL will trip the detector, producing a false positive.`
        ).toBe(false);
      }
    }
  });

  it('no SSRF exploitation token appears in any injection payload', () => {
    const allPayloadValues = [
      ...INJECTION_PAYLOADS.map((p: { value: string }) => p.value),
      ...PATH_TRAVERSAL_PAYLOADS.map((p: { value: string }) => p.value),
    ];
    for (const payload of allPayloadValues) {
      for (const { token } of SSRF_EXPLOITATION_TOKENS) {
        const payloadLower = payload.toLowerCase();
        const tokenLower = token.toLowerCase();
        expect(
          payloadLower.includes(tokenLower),
          `Exploitation token "${token}" appears inside injection payload "${payload.slice(0, 60)}". ` +
          `Echoing this payload in a response would produce a false SSRF finding.`
        ).toBe(false);
      }
    }
  });

  it('no BLOCK_SIGNATURE is a substring of any probe payload or URL', () => {
    const allInputs = [
      ...SSRF_TARGETS.map((t: { url: string }) => t.url),
      ...INJECTION_PAYLOADS.map((p: { value: string }) => p.value),
      ...PATH_TRAVERSAL_PAYLOADS.map((p: { value: string }) => p.value),
      ...CRLF_PAYLOADS.map((p: { value: string }) => p.value),
    ];
    for (const input of allInputs) {
      for (const sig of BLOCK_SIGNATURES) {
        const inputLower = input.toLowerCase();
        const sigLower = sig.toLowerCase();
        expect(
          inputLower.includes(sigLower),
          `Block signature "${sig}" is a substring of probe input "${input.slice(0, 60)}". ` +
          `Echoing this input would produce a false "blocked" verdict.`
        ).toBe(false);
      }
    }
  });
});

// ── Meta-guard 2: echo-only response bodies must never produce 'exploited' ────
//
// For every probe spec, synthesise a JSON-RPC response whose entire text content
// is just the probe input value echoed back. This simulates a server that echoes
// whatever it receives verbatim. No detection should fire on a pure echo.

describe('Meta-guard: echo-only responses must not produce exploited verdict', () => {
  function makeEchoBody(paramValue: unknown): string {
    const valueStr = typeof paramValue === 'string' ? paramValue : JSON.stringify(paramValue);
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: `# Error\n\n${valueStr}` }],
        isError: true,
      },
    });
  }

  it('SSRF targets — echoed URL in isError body must not be exploited', () => {
    for (const target of SSRF_TARGETS) {
      const spec = {
        toolName: 'fetch_url',
        paramName: 'url',
        payloadClass: 'ssrf',
        label: `fetch_url.url/${target.label}`,
        args: { url: target.url },
      };
      const body = makeEchoBody(target.url);
      const verdict = evaluateProbe(spec, {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(
        verdict.outcome,
        `SSRF target ${target.label}: echoed URL produced verdict '${verdict.outcome}' (expected: not 'exploited' at CRITICAL). ` +
        `id=${verdict.id}`
      ).not.toBe('exploited');
    }
  });

  it('injection payloads — echoed XSS payload in JSON must not be exploited', () => {
    const xssPayload = INJECTION_PAYLOADS.find((p: { label: string }) => p.label === 'XSS');
    expect(xssPayload).toBeDefined();
    const spec = {
      toolName: 'crawl_status',
      paramName: 'jobId',
      payloadClass: 'injection',
      label: 'crawl_status.jobId/XSS',
      args: { jobId: xssPayload.value },
    };
    const body = makeEchoBody(xssPayload.value);
    const verdict = evaluateProbe(spec, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(
      verdict.outcome,
      `XSS payload echoed in application/json must not produce 'exploited' — no HTML sink. Got: ${verdict.outcome}`
    ).not.toBe('exploited');
    // Should be 'info' — echoing is normal and correct for error messages
    expect(verdict.outcome).toBe('info');
  });
});

// ── Regression corpus ─────────────────────────────────────────────────────────
//
// The verbatim bodies from the 2026-08-24 run that triggered false CRITICAL/HIGH
// findings. Each must produce the expected outcome after the detector rewrite.

describe('Regression corpus — 2026-08-24 false positives', () => {
  it('fetch_urls GCP DNS failure → inconclusive (not exploited)', () => {
    const f = fpFixtures.ssrf_fetch_urls_gcp;
    const verdict = evaluateProbe(f.spec, f.response);
    expect(verdict.outcome).toBe('inconclusive');
    expect((verdict as { inconclusiveReason?: string }).inconclusiveReason).toBe('dns_unresolvable');
  });

  it('crawl_start GCP accepted URL → SSRF_URL_ACCEPTED HIGH (not old false CRITICAL)', () => {
    const f = fpFixtures.ssrf_crawl_start_gcp;
    const verdict = evaluateProbe(f.spec, f.response);
    // The crawl_start accepting a metadata URL IS a real finding — but HIGH, not CRITICAL,
    // and with the id SSRF_URL_ACCEPTED_* rather than the old SSRF_* CRITICAL.
    expect(verdict.outcome).toBe('exploited');
    expect(verdict.severity).toBe('HIGH');
    expect(verdict.id).toMatch(/SSRF_URL_ACCEPTED/);
    // Must NOT be the old 'computeMetadata' false positive (CRITICAL from echo-matching)
    expect(verdict.severity).not.toBe('CRITICAL');
  });

  it('crawl_status XSS echo in JSON → info (not exploited)', () => {
    const f = fpFixtures.xss_crawl_status;
    const verdict = evaluateProbe(f.spec, f.response);
    expect(verdict.outcome).toBe('info');
  });

  it('crawl_results XSS echo in JSON → info (not exploited)', () => {
    const f = fpFixtures.xss_crawl_results;
    const verdict = evaluateProbe(f.spec, f.response);
    expect(verdict.outcome).toBe('info');
  });

  it('crawl_cancel XSS echo in JSON → info (not exploited)', () => {
    const f = fpFixtures.xss_crawl_cancel;
    const verdict = evaluateProbe(f.spec, f.response);
    expect(verdict.outcome).toBe('info');
  });
});

// ── False-negative direction ──────────────────────────────────────────────────
//
// Synthesised bodies that genuinely contain exploitation evidence must produce
// 'exploited'. This direction was completely blind with the old detector when an
// internal admin page returned none of the five token strings.

describe('False-negative direction — genuine exploitation bodies must be detected', () => {
  it('AWS IMDSv1 ami-launch-index in response → exploited CRITICAL', () => {
    const spec = {
      toolName: 'fetch_url',
      paramName: 'url',
      payloadClass: 'ssrf',
      label: 'fetch_url.url/AWS_METADATA',
      args: { url: 'http://169.254.169.254/latest/meta-data/' },
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'ami-launch-index\nami-id\nhostname\niam/security-credentials\n' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).toBe('exploited');
    expect(verdict.severity).toBe('CRITICAL');
  });

  it('/etc/passwd content (two-token) → exploited CRITICAL', () => {
    const spec = {
      toolName: 'fetch_url',
      paramName: 'url',
      payloadClass: 'ssrf',
      label: 'fetch_url.url/FILE_PROTO',
      args: { url: 'file:///etc/passwd' },
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).toBe('exploited');
    expect(verdict.severity).toBe('CRITICAL');
  });

  it('only one /etc/passwd token present (single) → not exploited (requires both)', () => {
    const spec = {
      toolName: 'fetch_url',
      paramName: 'url',
      payloadClass: 'ssrf',
      label: 'fetch_url.url/FILE_PROTO',
      args: { url: 'file:///etc/passwd' },
    };
    // Only root:x:0:0: without the daemon:x:1:1: pair
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'root:x:0:0:root:/root:/bin/bash\n' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).not.toBe('exploited');
  });

  it('admin page with no token strings → inconclusive (old detector blind spot)', () => {
    // This is the failure mode the old detector was blind in: a real SSRF returning
    // an internal admin page with no keyword matches was silently recorded as "SSRF blocked".
    const spec = {
      toolName: 'fetch_url',
      paramName: 'url',
      payloadClass: 'ssrf',
      label: 'fetch_url.url/RFC1918_10X',
      args: { url: 'http://10.0.0.1/' },
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: '<h1>Internal Admin Dashboard</h1><p>Logged in as admin</p>' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    // The new detector correctly admits it cannot prove or disprove; the old one would have said "SSRF blocked"
    expect(verdict.outcome).toBe('inconclusive');
  });

  it('SSTI: product 981999769 in body without expression → exploited', () => {
    const sstiPayload = INJECTION_PAYLOADS.find((p: { label: string }) => p.label === 'SSTI');
    expect(sstiPayload).toBeDefined();
    const spec = {
      toolName: 'crawl_status',
      paramName: 'jobId',
      payloadClass: 'injection',
      label: 'crawl_status.jobId/SSTI',
      args: { jobId: sstiPayload.value },
    };
    // Body contains evaluated result but not the original expression
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'Rendered: 981999769' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).toBe('exploited');
    expect(verdict.severity).toBe('HIGH');
  });

  it('SSTI: UUID with 49 in it (old false-positive scenario) → not exploited', () => {
    // Old payload was {{7*7}} → detect 49. A UUID like "0ae5f4e8-ec93-4bd3-85be-ab11b772028e"
    // contains no 49 but demonstrates the old '49' token was too loose.
    // New payload {{31337*31337}} → 981999769, which never appears in UUIDs.
    const sstiPayload = INJECTION_PAYLOADS.find((p: { label: string }) => p.label === 'SSTI');
    expect(sstiPayload).toBeDefined();
    const spec = {
      toolName: 'crawl_status',
      paramName: 'jobId',
      payloadClass: 'injection',
      label: 'crawl_status.jobId/SSTI',
      args: { jobId: sstiPayload.value },
    };
    // Body contains a UUID and a timestamp — no template evaluation
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'job-id: 0ae5f4e8-ec93-4bd3-85be-ab11b772028e, ts: 1724491249000' }] },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).not.toBe('exploited');
  });

  it('XSS in text/html response → exploited HIGH', () => {
    const xssPayload = INJECTION_PAYLOADS.find((p: { label: string }) => p.label === 'XSS');
    expect(xssPayload).toBeDefined();
    const spec = {
      toolName: 'crawl_status',
      paramName: 'jobId',
      payloadClass: 'injection',
      label: 'crawl_status.jobId/XSS',
      args: { jobId: xssPayload.value },
    };
    // HTML response with raw payload — this is a real XSS
    const body = `<html><body>Error: job ${xssPayload.value} not found</body></html>`;
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
    expect(verdict.outcome).toBe('exploited');
    expect(verdict.severity).toBe('HIGH');
  });
});

// ── BLOCK_SIGNATURES detection ────────────────────────────────────────────────

describe('Block signature detection', () => {
  it('SSRF protection message in response → blocked (positive guard evidence)', () => {
    const spec = {
      toolName: 'fetch_url',
      paramName: 'url',
      payloadClass: 'ssrf',
      label: 'fetch_url.url/AWS_METADATA',
      args: { url: 'http://169.254.169.254/latest/meta-data/' },
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'SSRF protection: private or local addresses not allowed' },
    });
    const verdict = evaluateProbe(spec, { status: 200, headers: { 'content-type': 'application/json' }, body });
    expect(verdict.outcome).toBe('blocked');
  });
});

// ── redactEcho unit tests ─────────────────────────────────────────────────────

describe('redactEcho', () => {
  it('removes a URL from the body', () => {
    const body = 'Error: getaddrinfo ENOTFOUND metadata.google.internal for http://metadata.google.internal/computeMetadata/v1/';
    const result = redactEcho(body, { url: 'http://metadata.google.internal/computeMetadata/v1/' });
    expect(result).not.toContain('metadata.google.internal');
    expect(result).not.toContain('computeMetadata');
  });

  it('removes a URL from an array-typed arg', () => {
    const body = 'Fetched: http://metadata.google.internal/computeMetadata/v1/';
    const result = redactEcho(body, { urls: ['http://metadata.google.internal/computeMetadata/v1/'] });
    expect(result).not.toContain('computeMetadata');
  });

  it('preserves DNS error code (not part of the probe input)', () => {
    const body = 'ENOTFOUND metadata.google.internal';
    const result = redactEcho(body, { url: 'http://metadata.google.internal/computeMetadata/v1/' });
    // ENOTFOUND is a system error code, not something we injected — must survive redaction
    expect(result).toContain('ENOTFOUND');
    expect(result).not.toContain('metadata.google.internal');
  });

  it('strips longest match first to avoid partial clobbering', () => {
    // Full URL must be stripped before its hostname substring can corrupt it
    const body = 'http://metadata.google.internal/computeMetadata/v1/ ENOTFOUND';
    const result = redactEcho(body, { url: 'http://metadata.google.internal/computeMetadata/v1/' });
    // Must not leave fragments like "http://[REDACTED]/computeMetadata/v1/"
    expect(result).not.toContain('computeMetadata');
    expect(result).not.toContain('metadata.google.internal');
  });
});
