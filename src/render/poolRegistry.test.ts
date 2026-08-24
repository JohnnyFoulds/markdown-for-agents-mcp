import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BrowserPool so no real browsers launch
vi.mock('./browserPool.js', () => {
  class MockBrowserPool {
    private _proxyUrl: string | undefined;
    private _healthy = true;
    constructor(proxyUrl?: string) { this._proxyUrl = proxyUrl; }
    async warmup() {}
    async drain() {}
    stats() { return { browsers: 1, inUse: 0, queued: 0 }; }
    isHealthy() { return this._healthy; }
    proxyUrl() { return this._proxyUrl; }
  }
  const defaultPool = new MockBrowserPool();
  return { BrowserPool: MockBrowserPool, browserPool: defaultPool };
});

// Mock proxy module
vi.mock('../http/proxy.js', () => ({
  resolveProxyList: vi.fn(() => []),
  resolveProxy: vi.fn(() => undefined),
  resetProxyCache: vi.fn(),
}));

import { PoolRegistry } from './poolRegistry.js';
import { resolveProxyList } from '../http/proxy.js';

beforeEach(() => vi.clearAllMocks());

describe('PoolRegistry', () => {
  it('returns default pool when no proxies configured', () => {
    vi.mocked(resolveProxyList).mockReturnValue([]);
    const reg = new PoolRegistry();
    const p1 = reg.nextPool();
    const p2 = reg.nextPool();
    expect(p1).toBe(p2); // same default pool
  });

  it('round-robins across configured proxies', () => {
    vi.mocked(resolveProxyList).mockReturnValue(['http://p1:3128', 'http://p2:3128']);
    const reg = new PoolRegistry();
    const a = reg.nextPool();
    const b = reg.nextPool();
    const c = reg.nextPool(); // wraps back to first
    expect(a).not.toBe(b);
    expect(c).toBe(a);
  });

  it('creates one pool per proxy URL (reuses on second rotation)', () => {
    vi.mocked(resolveProxyList).mockReturnValue(['http://p1:3128', 'http://p2:3128']);
    const reg = new PoolRegistry();
    const pools = new Set([reg.nextPool(), reg.nextPool(), reg.nextPool(), reg.nextPool()]);
    expect(pools.size).toBe(2); // only 2 distinct pools
  });

  it('isHealthy returns true when any pool is healthy', () => {
    vi.mocked(resolveProxyList).mockReturnValue([]);
    const reg = new PoolRegistry();
    expect(reg.isHealthy()).toBe(true);
  });

  it('stats returns keyed by proxy or "direct"', () => {
    vi.mocked(resolveProxyList).mockReturnValue([]);
    const reg = new PoolRegistry();
    const s = reg.stats();
    expect(s['direct']).toBeDefined();
  });
});
