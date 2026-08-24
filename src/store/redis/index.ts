import type { KeyValueStore, RateLimitStore, JobQueue, Stores } from '../types.js';

// Redis backend — requires `ioredis` optional dependency.
// All three stores share one Redis connection.
// If ioredis is not installed, the constructor throws at startup.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadIoredis(): Promise<any> {
  try {
    // @ts-expect-error optional dependency not in devDependencies
    const m = await import('ioredis');
    return m.default ?? m;
  } catch {
    throw new Error(
      'STORE_BACKEND=redis requires the ioredis package. Install it with: npm install ioredis'
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

export class RedisKvStore implements KeyValueStore {
  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<Buffer | undefined> {
    const val: Buffer | null = await this.redis.getBuffer(key);
    return val ?? undefined;
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    if (ttlMs > 0) {
      await this.redis.set(key, value, 'PX', ttlMs);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async setNx(key: string, value: Buffer, ttlMs: number): Promise<boolean> {
    const result: string | null = ttlMs > 0
      ? await this.redis.set(key, value, 'PX', ttlMs, 'NX')
      : await this.redis.set(key, value, 'NX');
    return result === 'OK';
  }

  async stats(): Promise<{ backend: string; entries?: number; bytes?: number }> {
    return { backend: 'redis' };
  }

  async close(): Promise<void> { /* shared connection — closed by factory */ }
}

export class RedisRateLimitStore implements RateLimitStore {
  // Lua script for atomic token-bucket take
  private static readonly TAKE_SCRIPT = `
local key = KEYS[1]
local rps = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1]) or burst
local last_refill = tonumber(data[2]) or now

local elapsed = now - last_refill
tokens = math.min(burst, tokens + (elapsed * rps / 1000))

local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait_ms = math.ceil((1 - tokens) / rps * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('EXPIRE', key, 300)
return wait_ms
`;

  constructor(private readonly redis: RedisClient) {}

  async take(key: string, rps: number, burst: number, now: number): Promise<number> {
    if (rps <= 0) return 0;
    const result = await this.redis.eval(RedisRateLimitStore.TAKE_SCRIPT, 1, key, rps, burst, now);
    return typeof result === 'number' ? result : 0;
  }

  async close(): Promise<void> { /* shared connection */ }
}

// Redis JobQueue is complex (needs Lua for atomic lease) — stub for now
// Full implementation would use ZSET for pending items sorted by depth + HSCAN for metadata
export class RedisJobQueue implements JobQueue {
  constructor(_redis: RedisClient) {}

  private notImpl(): never { throw new Error('Redis JobQueue: not yet implemented'); }

  async createJob(): Promise<string> { return this.notImpl(); }
  async enqueue(): Promise<number> { return this.notImpl(); }
  async lease(): Promise<never[]> { return this.notImpl(); }
  async heartbeat(): Promise<void> { return this.notImpl(); }
  async complete(): Promise<void> { return this.notImpl(); }
  async fail(): Promise<void> { return this.notImpl(); }
  async claimJob(): Promise<undefined> { return this.notImpl(); }
  async status(): Promise<undefined> { return this.notImpl(); }
  async results(): Promise<never[]> { return this.notImpl(); }
  async cancel(): Promise<void> { return this.notImpl(); }
  async list(): Promise<never[]> { return this.notImpl(); }
  async close(): Promise<void> { /* no-op */ }
}

export async function createRedisStores(redisUrl: string): Promise<Stores> {
  const Redis = await loadIoredis();
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  await redis.ping();

  return {
    kv: new RedisKvStore(redis),
    rateLimit: new RedisRateLimitStore(redis),
    queue: new RedisJobQueue(redis),
  };
}
