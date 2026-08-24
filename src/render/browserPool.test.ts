import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn() },
}));

vi.mock('../obs/metrics.js', () => ({
  browserPoolBrowsers:          { set: vi.fn() },
  browserPoolContexts:          { set: vi.fn() },
  browserPoolInUse:             { set: vi.fn() },
  browserPoolQueued:            { set: vi.fn() },
  browserRecyclesTotal:         { inc: vi.fn() },
  browserLaunchDurationSeconds: { observe: vi.fn() },
}));

import { chromium } from 'playwright';
import {
  browserPoolBrowsers,
  browserPoolInUse,
  browserPoolQueued,
  browserRecyclesTotal,
  browserLaunchDurationSeconds,
} from '../obs/metrics.js';
import { BrowserPool } from './browserPool.js';

// ── Mock browser factory ──────────────────────────────────────────────────────

function makeMockBrowser() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ html: '<html/>', title: 'test' }),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page };
}

beforeEach(() => { vi.clearAllMocks(); });

// ── warmup ────────────────────────────────────────────────────────────────────

describe('BrowserPool.warmup', () => {
  it('launches one browser by default and sets browser_pool_browsers', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    await pool.warmup();

    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(browserPoolBrowsers.set)).toHaveBeenCalledWith(1);
  });

  it('records browser_launch_duration_seconds after launch', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    await new BrowserPool().warmup();

    expect(vi.mocked(browserLaunchDurationSeconds.observe)).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it('is idempotent — does not launch twice', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    await pool.warmup();
    await pool.warmup();

    expect(chromium.launch).toHaveBeenCalledTimes(1);
  });
});

// ── acquire / release ─────────────────────────────────────────────────────────

describe('BrowserPool.acquire / release', () => {
  it('sets browser_pool_in_use=1 on acquire and back to 0 on release', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    const lease = await pool.acquire();

    expect(vi.mocked(browserPoolInUse.set)).toHaveBeenCalledWith(1);

    await lease.release('ok');

    expect(vi.mocked(browserPoolInUse.set)).toHaveBeenCalledWith(0);
  });

  it('sets browser_pool_queued=0 after a lease is acquired with no waiters', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    await pool.acquire();

    expect(vi.mocked(browserPoolQueued.set)).toHaveBeenCalledWith(0);
  });
});

// ── recycle ───────────────────────────────────────────────────────────────────

describe('BrowserPool recycle', () => {
  it('increments browser_recycles_total{reason=crash} on crash outcome', async () => {
    const { browser } = makeMockBrowser();
    // Second launch for the replacement
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    const lease = await pool.acquire();
    await lease.release('crash');

    // replaceSlot is async; give it a tick to run
    await new Promise(r => setTimeout(r, 0));

    expect(vi.mocked(browserRecyclesTotal.inc)).toHaveBeenCalledWith({ reason: 'crash' });
  });

  it('does not recycle on ok outcome below max_jobs', async () => {
    const { browser } = makeMockBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);

    const pool = new BrowserPool();
    const lease = await pool.acquire();
    await lease.release('ok');

    await new Promise(r => setTimeout(r, 0));

    expect(vi.mocked(browserRecyclesTotal.inc)).not.toHaveBeenCalled();
  });
});
