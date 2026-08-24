import { BrowserPool, browserPool } from './browserPool.js';
import { resolveProxyList } from '../http/proxy.js';

/**
 * Maps proxy URL (or '' for direct) to a BrowserPool.
 *
 * Playwright's proxy option is launch-time, so rotation requires one pool per
 * proxy. The registry creates pools lazily and the PlaywrightTier picks the
 * next pool via round-robin across the configured proxy list.
 */
export class PoolRegistry {
  private readonly pools = new Map<string, BrowserPool>();
  private rotationIndex = 0;

  constructor() {
    // Register the default (no explicit proxy) pool
    this.pools.set('', browserPool);
  }

  private getOrCreate(proxyUrl: string): BrowserPool {
    if (!this.pools.has(proxyUrl)) {
      this.pools.set(proxyUrl, new BrowserPool(proxyUrl));
    }
    return this.pools.get(proxyUrl)!;
  }

  /**
   * Return the next pool in the rotation list.
   * - If PROXY_PINS is set, cycles through one pool per pin.
   * - If HTTP_PROXY_URL / PLAYWRIGHT_PROXY is set (single proxy), always returns that pool.
   * - Otherwise returns the default (direct) pool.
   */
  nextPool(): BrowserPool {
    const pins = resolveProxyList();
    if (pins.length === 0) return browserPool;
    const url = pins[this.rotationIndex % pins.length]!;
    this.rotationIndex = (this.rotationIndex + 1) % pins.length;
    return this.getOrCreate(url);
  }

  /** Warm up all pools that have been created. */
  async warmupAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map(p => p.warmup()));
  }

  /** Pre-create pools for all configured proxies and warm them up. */
  async warmupProxies(): Promise<void> {
    const pins = resolveProxyList();
    for (const url of pins) { this.getOrCreate(url); }
    await this.warmupAll();
  }

  async drain(graceMs = 5000): Promise<void> {
    await Promise.all([...this.pools.values()].map(p => p.drain(graceMs)));
  }

  stats(): Record<string, ReturnType<BrowserPool['stats']>> {
    const out: Record<string, ReturnType<BrowserPool['stats']>> = {};
    for (const [k, p] of this.pools) {
      out[k || 'direct'] = p.stats();
    }
    return out;
  }

  isHealthy(): boolean {
    return [...this.pools.values()].some(p => p.isHealthy());
  }
}

export const poolRegistry = new PoolRegistry();
