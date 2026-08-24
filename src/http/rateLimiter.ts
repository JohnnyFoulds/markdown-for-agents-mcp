import { RateLimitTimeoutError } from '../utils/errors.js';
import type { RateLimitStore } from '../store/types.js';
import { rateLimitWaitsSeconds } from '../obs/metrics.js';

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly rps: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  async take(maxWaitMs: number): Promise<number> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rps) / 1000);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }

    const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
    if (waitMs > maxWaitMs) throw new RateLimitTimeoutError(maxWaitMs);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.tokens = 0;
    return waitMs;
  }
}

export class RateLimiter {
  private readonly localBuckets = new Map<string, TokenBucket>();
  private store?: RateLimitStore;

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly maxWaitMs: number,
  ) {}

  /** Wire to a shared RateLimitStore so limits apply across replicas. */
  setStore(store: RateLimitStore): void {
    this.store = store;
  }

  async take(host: string): Promise<void> {
    if (this.rps <= 0) return;

    if (this.store) {
      const waitMs = await this.store.take(host, this.rps, this.burst, Date.now());
      if (waitMs > this.maxWaitMs) throw new RateLimitTimeoutError(this.maxWaitMs);
      if (waitMs > 0) {
        rateLimitWaitsSeconds.observe(waitMs / 1000);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      return;
    }

    let bucket = this.localBuckets.get(host);
    if (!bucket) {
      bucket = new TokenBucket(this.rps, this.burst);
      this.localBuckets.set(host, bucket);
    }
    const waitMs = await bucket.take(this.maxWaitMs);
    if (waitMs > 0) rateLimitWaitsSeconds.observe(waitMs / 1000);
  }

  /** Feed crawl-delay from robots.txt into the local limiter for a host. */
  setCrawlDelay(host: string, delaySeconds: number): void {
    if (this.store) return; // shared store manages its own state
    const effectiveRps = delaySeconds > 0 ? 1 / delaySeconds : this.rps;
    this.localBuckets.set(host, new TokenBucket(Math.min(effectiveRps, this.rps), 1));
  }
}
