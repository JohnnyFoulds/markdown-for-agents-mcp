import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { MemoryRateLimitStore } from '../memory/index.js';
import { SqliteRateLimitStore } from '../sqlite/index.js';
import type { RateLimitStore } from '../types.js';

const REDIS_URL = process.env['REDIS_URL'];

function runRateLimitContract(
  name: string,
  factory: () => RateLimitStore | Promise<RateLimitStore>,
) {
  describe(`RateLimitStore contract — ${name}`, () => {
    let store: RateLimitStore;
    beforeEach(async () => { store = await factory(); });
    afterEach(async () => { await store.close(); });

    it('returns 0 when tokens are available (burst)', async () => {
      const wait = await store.take('host.example', 2, 4, Date.now());
      expect(wait).toBe(0);
    });

    it('consumes tokens sequentially up to burst', async () => {
      const now = Date.now();
      // burst = 2 → first 2 calls return 0
      const w1 = await store.take('host.example', 2, 2, now);
      const w2 = await store.take('host.example', 2, 2, now);
      expect(w1).toBe(0);
      expect(w2).toBe(0);
    });

    it('returns wait > 0 when bucket is exhausted', async () => {
      const now = Date.now();
      // Consume all burst tokens
      await store.take('host.example', 2, 2, now);
      await store.take('host.example', 2, 2, now);
      // Third call: no tokens left → must wait
      const wait = await store.take('host.example', 2, 2, now);
      expect(wait).toBeGreaterThan(0);
    });

    it('wait is approximately 1/rps when bucket empty', async () => {
      const rps = 2;
      const now = Date.now();
      await store.take('host.example', rps, 1, now); // consume the single burst token
      const wait = await store.take('host.example', rps, 1, now);
      // For rps=2: 1 token refill takes 500ms
      expect(wait).toBeGreaterThanOrEqual(400);
      expect(wait).toBeLessThanOrEqual(600);
    });

    it('different keys have independent buckets', async () => {
      const now = Date.now();
      await store.take('host.a', 2, 1, now);
      // host.a is exhausted; host.b still has tokens
      const waitA = await store.take('host.a', 2, 1, now);
      const waitB = await store.take('host.b', 2, 1, now);
      expect(waitA).toBeGreaterThan(0);
      expect(waitB).toBe(0);
    });

    it('refills tokens over elapsed time', async () => {
      const rps = 2;
      const burst = 2;
      const t0 = Date.now();
      // Consume entire burst
      await store.take('host.example', rps, burst, t0);
      await store.take('host.example', rps, burst, t0);

      // Advance time by 1 second → 2 tokens refilled (back to full burst)
      const t1 = t0 + 1000;
      const w1 = await store.take('host.example', rps, burst, t1);
      const w2 = await store.take('host.example', rps, burst, t1);
      expect(w1).toBe(0);
      expect(w2).toBe(0);
      // One more should now need to wait again
      const w3 = await store.take('host.example', rps, burst, t1);
      expect(w3).toBeGreaterThan(0);
    });

    it('rps=0 always returns 0 (rate limiting disabled)', async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        const w = await store.take('host.example', 0, 10, now);
        expect(w).toBe(0);
      }
    });
  });
}

runRateLimitContract('memory', () => new MemoryRateLimitStore());
runRateLimitContract('sqlite', () => new SqliteRateLimitStore(':memory:'));

// ── Redis backend — requires REDIS_URL env var ────────────────────────────────

describe.skipIf(!REDIS_URL)('RateLimitStore contract — redis', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  let store: RateLimitStore;

  beforeAll(async () => {
    const { RedisRateLimitStore } = await import('../redis/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Redis } = await import('ioredis' as any);
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 3, db: 2 }); // DB 2 — isolated from kv (1) and queue (3)
    await redis.ping();
    store = new RedisRateLimitStore(redis);
  });

  afterAll(async () => { await redis?.quit(); });
  beforeEach(async () => { await redis?.flushdb(); });

  it('returns 0 when tokens available', async () => {
    expect(await store.take('h', 2, 4, Date.now())).toBe(0);
  });

  it('returns wait > 0 when bucket exhausted', async () => {
    const now = Date.now();
    await store.take('h', 2, 2, now);
    await store.take('h', 2, 2, now);
    const wait = await store.take('h', 2, 2, now);
    expect(wait).toBeGreaterThan(0);
  });

  it('wait is ~500ms for rps=2, burst=1 when empty', async () => {
    const now = Date.now();
    await store.take('h', 2, 1, now);
    const wait = await store.take('h', 2, 1, now);
    expect(wait).toBeGreaterThanOrEqual(400);
    expect(wait).toBeLessThanOrEqual(600);
  });

  it('different keys are independent', async () => {
    const now = Date.now();
    await store.take('a', 2, 1, now);
    const wA = await store.take('a', 2, 1, now);
    const wB = await store.take('b', 2, 1, now);
    expect(wA).toBeGreaterThan(0);
    expect(wB).toBe(0);
  });

  it('bucket refills over elapsed time', async () => {
    const t0 = Date.now();
    await store.take('h', 2, 2, t0);
    await store.take('h', 2, 2, t0);
    // +1000ms → 2 new tokens
    const t1 = t0 + 1000;
    expect(await store.take('h', 2, 2, t1)).toBe(0);
    expect(await store.take('h', 2, 2, t1)).toBe(0);
    expect(await store.take('h', 2, 2, t1)).toBeGreaterThan(0);
  });

  it('rps=0 always returns 0', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(await store.take('h', 0, 10, now)).toBe(0);
    }
  });
});
