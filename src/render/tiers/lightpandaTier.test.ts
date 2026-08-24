import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('playwright', () => ({
  chromium: { connectOverCDP: vi.fn() },
}));

import { chromium } from 'playwright';
import { LightpandaTier } from './lightpandaTier.js';

const ENABLED_CFG = { LIGHTPANDA_ENABLED: true,  LIGHTPANDA_CDP_URL: 'ws://lp:9222', LIGHTPANDA_MAX_FAILURE_RATE: 0.4 };
const DISABLED_CFG = { LIGHTPANDA_ENABLED: false, LIGHTPANDA_CDP_URL: 'ws://lp:9222', LIGHTPANDA_MAX_FAILURE_RATE: 0.4 };
const BASE_REQ = { url: 'https://example.com', timeoutMs: 5000 };
const GOOD_HTML = '<html><body><p>Hello</p></body></html>';

function makeMockBrowser(html = GOOD_HTML, title = 'Test') {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ html, title }),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('LightpandaTier.isAvailable', () => {
  it('returns false when LIGHTPANDA_ENABLED is false', async () => {
    expect(await new LightpandaTier(DISABLED_CFG).isAvailable()).toBe(false);
  });

  it('returns false when no config is provided (env not set)', async () => {
    expect(await new LightpandaTier().isAvailable()).toBe(false);
  });

  it('returns true when enabled and circuit is closed', async () => {
    expect(await new LightpandaTier(ENABLED_CFG).isAvailable()).toBe(true);
  });
});

describe('LightpandaTier.render', () => {
  it('connects via CDP and returns html + title', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    const result = await new LightpandaTier(ENABLED_CFG).render(BASE_REQ);

    expect(chromium.connectOverCDP).toHaveBeenCalledWith('ws://lp:9222', { timeout: 5000 });
    expect(result.tier).toBe('lightpanda');
    expect(result.html).toContain('Hello');
    expect(result.title).toBe('Test');
    expect(result.escalations).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('closes context and browser even when page.goto throws', async () => {
    const { browser, context, page } = makeMockBrowser();
    page.goto.mockRejectedValue(new Error('nav timeout'));
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await expect(new LightpandaTier(ENABLED_CFG).render(BASE_REQ)).rejects.toThrow('nav timeout');
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('closes browser even when context.close throws', async () => {
    const { browser, context } = makeMockBrowser();
    context.close.mockRejectedValue(new Error('close error'));
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    // Should not propagate the close error
    await expect(new LightpandaTier(ENABLED_CFG).render(BASE_REQ)).resolves.toBeDefined();
    expect(browser.close).toHaveBeenCalled();
  });
});

describe('LightpandaTier circuit breaker', () => {
  it('opens after failure rate exceeds threshold', async () => {
    const { browser, page } = makeMockBrowser();
    page.goto.mockRejectedValue(new Error('fail'));
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    const tier = new LightpandaTier(ENABLED_CFG);
    for (let i = 0; i < 25; i++) {
      await tier.render(BASE_REQ).catch(() => {});
    }

    expect(await tier.isAvailable()).toBe(false);
  });

  it('stays closed when all renders succeed', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    const tier = new LightpandaTier(ENABLED_CFG);
    for (let i = 0; i < 10; i++) {
      await tier.render(BASE_REQ);
    }

    expect(await tier.isAvailable()).toBe(true);
  });

  it('does not open on occasional failures below threshold', async () => {
    const { browser, page } = makeMockBrowser();
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    const tier = new LightpandaTier(ENABLED_CFG);

    // 10 successes then 3 failures → failure rate = 3/13 ≈ 0.23 < 0.4 threshold
    for (let i = 0; i < 10; i++) {
      await tier.render(BASE_REQ);
    }
    page.goto.mockRejectedValue(new Error('occasional'));
    for (let i = 0; i < 3; i++) {
      await tier.render(BASE_REQ).catch(() => {});
    }

    expect(await tier.isAvailable()).toBe(true);
  });
});
