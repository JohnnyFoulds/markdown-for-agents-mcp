import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SsrfViolationError, DomainBlockedError } from '../utils/errors.js';

vi.mock('../obs/metrics.js', () => ({
  fetchRequestsTotal:   { inc: vi.fn() },
  fetchDurationSeconds: { observe: vi.fn() },
  fetchEscalationsTotal: { inc: vi.fn() },
}));

import { fetchRequestsTotal, fetchDurationSeconds, fetchEscalationsTotal } from '../obs/metrics.js';
import { RenderLadder } from './ladder.js';
import type { RenderTierImpl, RenderRequest, RenderResult } from './types.js';

// ── Fake tier factory ─────────────────────────────────────────────────────────

function fakeTier(
  name: 'http' | 'lightpanda' | 'playwright',
  html: string,
  opts: { available?: boolean; throws?: Error } = {},
): RenderTierImpl {
  return {
    tier: name,
    isAvailable: vi.fn().mockResolvedValue(opts.available ?? true),
    render: opts.throws
      ? vi.fn().mockRejectedValue(opts.throws)
      : vi.fn().mockResolvedValue({
          url: 'https://example.com',
          html,
          title: `${name} title`,
          status: 200,
          tier: name,
          escalations: [],
          durationMs: 10,
        } satisfies RenderResult),
  };
}

const STATIC_HTML = '<html><body><article><p>Static content with enough text here to satisfy the heuristic threshold for a real article page.</p><p>More text here.</p></article></body></html>';
const SPA_HTML    = '<html><body><div id="root"></div><script>window.__NEXT_DATA__={}</script><noscript>Please enable JavaScript</noscript></body></html>';
const CF_HTML     = '<html><body>Just a moment...<script>var cf=1</script></body></html>';

const BASE_REQ: RenderRequest = { url: 'https://example.com', timeoutMs: 5000 };

beforeEach(() => { vi.clearAllMocks(); });

describe('RenderLadder — tier selection', () => {
  it('returns HTTP result without escalation for static content', async () => {
    const http = fakeTier('http', STATIC_HTML);
    const lp   = fakeTier('lightpanda', '');
    const pw   = fakeTier('playwright', '');
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('http');
    expect(lp.render).not.toHaveBeenCalled();
    expect(pw.render).not.toHaveBeenCalled();
  });

  it('escalates to lightpanda for SPA content', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', '');
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('lightpanda');
    expect(pw.render).not.toHaveBeenCalled();
    expect(result.escalations.length).toBeGreaterThan(0);
    expect(result.escalations[0]!.from).toBe('http');
    expect(result.escalations[0]!.to).toBe('lightpanda');
  });

  it('escalates straight to playwright for Cloudflare challenge', async () => {
    const http = fakeTier('http', CF_HTML);
    const lp   = fakeTier('lightpanda', '');
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('playwright');
    // lp.render may or may not be called depending on target tier index,
    // but the result must be from playwright
    expect(result.escalations.some(e => e.to === 'playwright')).toBe(true);
  });

  it('skips lightpanda if unavailable, falls through to playwright', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', '', { available: false });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('playwright');
    expect(lp.render).not.toHaveBeenCalled();
  });

  it('falls through to playwright when lightpanda throws', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', '', { throws: new Error('CDP disconnect') });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('playwright');
    expect(result.escalations.some(e => e.from === 'lightpanda' && e.reason.includes('CDP disconnect'))).toBe(true);
  });

  it('throws when all tiers are exhausted', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', '', { throws: new Error('lp fail') });
    const pw   = fakeTier('playwright', '', { throws: new Error('pw fail') });
    const ladder = new RenderLadder([http, lp, pw]);

    await expect(ladder.render(BASE_REQ)).rejects.toThrow('pw fail');
  });
});

describe('RenderLadder — minTier / maxTier', () => {
  it('minTier=lightpanda skips http entirely', async () => {
    const http = fakeTier('http', STATIC_HTML);
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', '');
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render({ ...BASE_REQ, minTier: 'lightpanda' });
    expect(result.tier).toBe('lightpanda');
    expect(http.render).not.toHaveBeenCalled();
  });

  it('maxTier=http never reaches lightpanda or playwright', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', '');
    const ladder = new RenderLadder([http, lp, pw]);

    // SPA html would normally escalate but maxTier=http prevents it
    const result = await ladder.render({ ...BASE_REQ, maxTier: 'http' });
    expect(result.tier).toBe('http');
    expect(lp.render).not.toHaveBeenCalled();
  });
});

describe('RenderLadder — tier memo', () => {
  it('memoises the successful tier and uses it on the next call', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', '');
    // decay=0 means memo is always used (never randomly re-probed)
    const ladder = new RenderLadder([http, lp, pw], 0);

    await ladder.render(BASE_REQ);          // first call: http → lightpanda
    vi.mocked(http.render).mockClear();
    vi.mocked(lp.render).mockClear();

    await ladder.render(BASE_REQ);          // second call: should start at lightpanda
    expect(http.render).not.toHaveBeenCalled();
    expect(lp.render).toHaveBeenCalled();
  });
});

// ── Phase 1: headers pass-through ─────────────────────────────────────────────
//
// RED before fix: ladder.ts:68 passes {} as headers to needsEscalation(),
// so header-based bot-challenge detection (cf-mitigated, x-datadome-request,
// x-incapsula-error) can never fire even when the response carries these headers.
//
// These tests assert the DESIRED behaviour and MUST be RED until ladder.ts is fixed.

function fakeTierWithHeaders(
  name: 'http' | 'lightpanda' | 'playwright',
  html: string,
  responseHeaders: Record<string, string>,
  status = 200,
): RenderTierImpl {
  return {
    tier: name,
    isAvailable: vi.fn().mockResolvedValue(true),
    render: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      html,
      title: `${name} title`,
      status,
      tier: name,
      escalations: [],
      durationMs: 10,
      headers: responseHeaders,
    } satisfies RenderResult),
  };
}

describe('RenderLadder — header-based escalation (Phase 1 fix)', () => {
  it('escalates to playwright when tier-1 returns cf-mitigated header (status 200)', async () => {
    // Static HTML body that would NOT trigger content-based escalation on its own.
    const http = fakeTierWithHeaders('http', STATIC_HTML, { 'cf-mitigated': 'challenge' });
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    const result = await ladder.render(BASE_REQ);
    // Without the fix, result.tier === 'http' (headers ignored).
    // With the fix, result.tier === 'playwright' (cf-mitigated → bot-challenge → playwright).
    expect(result.tier).toBe('playwright');
    expect(result.escalations.some(e => e.to === 'playwright')).toBe(true);
  });

  it('does NOT escalate for a 200 OK with no bot-challenge headers', async () => {
    const http = fakeTierWithHeaders('http', STATIC_HTML, { 'content-type': 'text/html' });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('http');
    expect(pw.render).not.toHaveBeenCalled();
  });

  it('escalates when content-type header signals non-HTML (avoids escalating a PDF)', async () => {
    // content-type: application/pdf — needsEscalation should return escalate:false
    // (the non-HTML guard returns early with escalate:false), so the result stays at http.
    const http = fakeTierWithHeaders('http', '<html></html>', { 'content-type': 'application/pdf' });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);

    const result = await ladder.render(BASE_REQ);
    // With the fix: content-type is passed → heuristic returns escalate:false for non-HTML
    expect(pw.render).not.toHaveBeenCalled();
  });
});

describe('RenderLadder — metrics', () => {
  it('increments fetch_requests_total{outcome=success} on a clean render', async () => {
    const ladder = new RenderLadder([fakeTier('http', STATIC_HTML)]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchRequestsTotal.inc)).toHaveBeenCalledWith({ tier: 'http', outcome: 'success' });
  });

  it('observes fetch_duration_seconds on a clean render', async () => {
    const ladder = new RenderLadder([fakeTier('http', STATIC_HTML)]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchDurationSeconds.observe)).toHaveBeenCalledWith(
      { tier: 'http' },
      expect.any(Number),
    );
  });

  it('increments fetch_requests_total{outcome=error} when a tier throws', async () => {
    const http = fakeTier('http', '', { throws: new Error('timeout') });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchRequestsTotal.inc)).toHaveBeenCalledWith({ tier: 'http', outcome: 'error' });
    expect(vi.mocked(fetchRequestsTotal.inc)).toHaveBeenCalledWith({ tier: 'playwright', outcome: 'success' });
  });

  it('increments fetch_escalations_total{reason=heuristic} on heuristic escalation', async () => {
    const http = fakeTier('http', SPA_HTML);
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const ladder = new RenderLadder([http, lp]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchEscalationsTotal.inc)).toHaveBeenCalledWith({
      from_tier: 'http',
      to_tier: 'lightpanda',
      reason: 'heuristic',
    });
  });

  it('increments fetch_escalations_total{reason=error} on tier error fall-through', async () => {
    const http = fakeTier('http', '', { throws: new Error('conn reset') });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchEscalationsTotal.inc)).toHaveBeenCalledWith({
      from_tier: 'http',
      to_tier: 'playwright',
      reason: 'error',
    });
  });

  it('does not increment fetch_escalations_total on a clean single-tier render', async () => {
    const ladder = new RenderLadder([fakeTier('http', STATIC_HTML)]);
    await ladder.render(BASE_REQ);
    expect(vi.mocked(fetchEscalationsTotal.inc)).not.toHaveBeenCalled();
  });
});

// ── Phase 2: fail closed on policy-block errors ───────────────────────────────
//
// A security-block error (SsrfViolationError, DomainBlockedError, …) must NOT
// cause the ladder to escalate to a weaker tier. Escalating a security decision
// converts a guard that fired correctly into a bypass — the exact mechanism that
// makes the render ladder an SSRF escalation path.
//
// RED before fix: ladder.ts catch block escalates on ANY error, including
// SsrfViolationError. The tests below assert that after the fix, browser tiers
// are never invoked when tier-0 throws a policy-block error.

describe('RenderLadder — fail closed on policy-block errors (Phase 2)', () => {
  it('does NOT escalate when http tier throws SsrfViolationError — error propagates', async () => {
    const ssrfErr = new SsrfViolationError('metadata.google.internal', '169.254.169.254');
    const http = fakeTier('http', '', { throws: ssrfErr });
    const lp   = fakeTier('lightpanda', STATIC_HTML);
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    // Must reject with the original SsrfViolationError — not silently succeed via playwright
    await expect(ladder.render(BASE_REQ)).rejects.toThrow(SsrfViolationError);
    // The browser tiers must never have been invoked
    expect(lp.render).not.toHaveBeenCalled();
    expect(pw.render).not.toHaveBeenCalled();
  });

  it('does NOT escalate when http tier throws DomainBlockedError', async () => {
    const blockedErr = new DomainBlockedError('internal.corp');
    const http = fakeTier('http', '', { throws: blockedErr });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);

    await expect(ladder.render(BASE_REQ)).rejects.toThrow(DomainBlockedError);
    expect(pw.render).not.toHaveBeenCalled();
  });

  it('DOES still escalate on a generic transient error (conn reset)', async () => {
    // Regression guard: non-security errors must still escalate as before
    const http = fakeTier('http', '', { throws: new Error('ECONNRESET') });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, pw]);

    const result = await ladder.render(BASE_REQ);
    expect(result.tier).toBe('playwright');
  });

  it('SsrfViolationError at lightpanda tier also does not escalate to playwright', async () => {
    // The guard can fire at any tier; escalation must not happen regardless of which tier blocks
    const http = fakeTier('http', SPA_HTML);  // succeeds but triggers heuristic escalation
    const lp   = fakeTier('lightpanda', '', { throws: new SsrfViolationError('evil.test', '10.0.0.1') });
    const pw   = fakeTier('playwright', STATIC_HTML);
    const ladder = new RenderLadder([http, lp, pw]);

    // http → heuristic escalation to lightpanda → SsrfViolationError → must NOT reach playwright
    await expect(ladder.render(BASE_REQ)).rejects.toThrow(SsrfViolationError);
    expect(pw.render).not.toHaveBeenCalled();
  });
});
