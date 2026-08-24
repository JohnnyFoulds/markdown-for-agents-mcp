import { describe, it, expect, vi } from 'vitest';
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

    await ladder.render(BASE_REQ);           // first call: http → lightpanda
    vi.mocked(http.render).mockClear();
    vi.mocked(lp.render).mockClear();

    await ladder.render(BASE_REQ);           // second call: should start at lightpanda
    expect(http.render).not.toHaveBeenCalled();
    expect(lp.render).toHaveBeenCalled();
  });
});
