import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { MemoryKvStore } from '../memory/index.js';
import { SqliteKvStore } from '../sqlite/index.js';
import type { KeyValueStore } from '../types.js';

const REDIS_URL = process.env['REDIS_URL'];

function runKvContract(
  name: string,
  factory: () => KeyValueStore | Promise<KeyValueStore>,
  opts: { supportsEntryCount?: boolean } = {},
) {
  describe(`KeyValueStore contract — ${name}`, () => {
    let store: KeyValueStore;
    beforeEach(async () => { store = await factory(); });
    afterEach(async () => { await store.close(); });

    it('get returns undefined for missing key', async () => {
      expect(await store.get('missing')).toBeUndefined();
    });

    it('set and get round-trips a buffer', async () => {
      const val = Buffer.from('hello');
      await store.set('k', val, 0);
      const result = await store.get('k');
      expect(result).toBeDefined();
      expect(result!.toString()).toBe('hello');
    });

    it('overwrites existing key', async () => {
      await store.set('k', Buffer.from('v1'), 0);
      await store.set('k', Buffer.from('v2'), 0);
      expect((await store.get('k'))!.toString()).toBe('v2');
    });

    it('del removes a key', async () => {
      await store.set('k', Buffer.from('v'), 0);
      await store.del('k');
      expect(await store.get('k')).toBeUndefined();
    });

    it('del is a no-op on missing key', async () => {
      await expect(store.del('nonexistent')).resolves.toBeUndefined();
    });

    it('TTL expires entries', async () => {
      await store.set('k', Buffer.from('v'), 1); // 1ms TTL
      await new Promise(r => setTimeout(r, 20));
      expect(await store.get('k')).toBeUndefined();
    });

    it('zero TTL means no expiry', async () => {
      await store.set('k', Buffer.from('v'), 0);
      await new Promise(r => setTimeout(r, 10));
      expect((await store.get('k'))!.toString()).toBe('v');
    });

    it('setNx succeeds when key absent', async () => {
      const set = await store.setNx('k', Buffer.from('v'), 0);
      expect(set).toBe(true);
      expect((await store.get('k'))!.toString()).toBe('v');
    });

    it('setNx fails when key exists', async () => {
      await store.set('k', Buffer.from('v1'), 0);
      const set = await store.setNx('k', Buffer.from('v2'), 0);
      expect(set).toBe(false);
      expect((await store.get('k'))!.toString()).toBe('v1');
    });

    it('setNx with TTL expires the entry', async () => {
      const set = await store.setNx('k', Buffer.from('v'), 1);
      expect(set).toBe(true);
      await new Promise(r => setTimeout(r, 20));
      expect(await store.get('k')).toBeUndefined();
    });

    it('stats returns backend name', async () => {
      const stats = await store.stats();
      expect(stats.backend).toBeTruthy();
      expect(typeof stats.backend).toBe('string');
    });

    if (opts.supportsEntryCount !== false) {
      it('stats returns entry count', async () => {
        await store.set('a', Buffer.from('1'), 0);
        await store.set('b', Buffer.from('2'), 0);
        const stats = await store.stats();
        expect(stats.entries).toBe(2);
      });
    }
  });
}

runKvContract('memory', () => new MemoryKvStore(), { supportsEntryCount: true });
runKvContract('sqlite', () => new SqliteKvStore(':memory:'), { supportsEntryCount: true });

// ── Redis backend — requires REDIS_URL env var ────────────────────────────────
// Run with: REDIS_URL=redis://localhost:6379 npx vitest run

describe.skipIf(!REDIS_URL)('KeyValueStore contract — redis', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;
  let store: KeyValueStore;

  beforeAll(async () => {
    const { RedisKvStore } = await import('../redis/index.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Redis } = await import('ioredis' as any);
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 3, db: 1 }); // DB 1 — isolated from queue (3) and rateLimit (2)
    await redis.ping();
    store = new RedisKvStore(redis);
  });

  afterAll(async () => { await redis?.quit(); });
  beforeEach(async () => { await redis?.flushdb(); });

  it('get returns undefined for missing key', async () => {
    expect(await store.get('missing')).toBeUndefined();
  });

  it('set and get round-trips a buffer', async () => {
    await store.set('k', Buffer.from('hello'), 0);
    const r = await store.get('k');
    expect(r!.toString()).toBe('hello');
  });

  it('overwrites existing key', async () => {
    await store.set('k', Buffer.from('v1'), 0);
    await store.set('k', Buffer.from('v2'), 0);
    expect((await store.get('k'))!.toString()).toBe('v2');
  });

  it('del removes a key', async () => {
    await store.set('k', Buffer.from('v'), 0);
    await store.del('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('TTL expires entries', async () => {
    await store.set('k', Buffer.from('v'), 50);
    await new Promise(r => setTimeout(r, 80));
    expect(await store.get('k')).toBeUndefined();
  });

  it('setNx succeeds when key absent', async () => {
    const set = await store.setNx('k', Buffer.from('v'), 0);
    expect(set).toBe(true);
    expect((await store.get('k'))!.toString()).toBe('v');
  });

  it('setNx fails when key present', async () => {
    await store.set('k', Buffer.from('v1'), 0);
    expect(await store.setNx('k', Buffer.from('v2'), 0)).toBe(false);
    expect((await store.get('k'))!.toString()).toBe('v1');
  });

  it('stats returns backend=redis', async () => {
    const s = await store.stats();
    expect(s.backend).toBe('redis');
  });
});
