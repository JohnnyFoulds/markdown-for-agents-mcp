import { RateLimitTimeoutError } from '../utils/errors.js';

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

  async take(maxWaitMs: number): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rps) / 1000);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = Math.ceil(((1 - this.tokens) / this.rps) * 1000);
    if (waitMs > maxWaitMs) throw new RateLimitTimeoutError(maxWaitMs);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this.tokens = 0;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly maxWaitMs: number,
  ) {}

  async take(host: string): Promise<void> {
    if (this.rps <= 0) return;
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = new TokenBucket(this.rps, this.burst);
      this.buckets.set(host, bucket);
    }
    await bucket.take(this.maxWaitMs);
  }

  /** Feed crawl-delay from robots.txt into the limiter for a host. */
  setCrawlDelay(host: string, delaySeconds: number): void {
    const effectiveRps = delaySeconds > 0 ? 1 / delaySeconds : this.rps;
    this.buckets.set(host, new TokenBucket(Math.min(effectiveRps, this.rps), 1));
  }
}
