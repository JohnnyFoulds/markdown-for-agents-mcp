import { randomUUID } from 'node:crypto';
import type {
  KeyValueStore, RateLimitStore, JobQueue, JobSpec, QueueItem, LeasedItem,
  PageRecord, JobSummary, JobStatus, PageStatus, JobLease, Stores,
} from '../types.js';
import { storeOperationsTotal } from '../../obs/metrics.js';

// Redis backend — requires `ioredis` optional dependency.
// All three stores share one Redis connection.
// If ioredis is not installed, the constructor throws at startup.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadIoredis(): Promise<any> {
  try {
    const m = await import('ioredis' as string) as { default?: unknown } & Record<string, unknown>;
    return (m.default ?? m) as unknown;
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
    storeOperationsTotal.inc({ backend: 'redis', op: 'get', result: val !== null ? 'hit' : 'miss' });
    return val ?? undefined;
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    if (ttlMs > 0) {
      await this.redis.set(key, value, 'PX', ttlMs);
    } else {
      await this.redis.set(key, value);
    }
    storeOperationsTotal.inc({ backend: 'redis', op: 'set', result: 'ok' });
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

// ── Redis JobQueue ─────────────────────────────────────────────────────────────
//
// Key schema (prefix = mcp:):
//   mcp:job:{id}          HASH  spec, status, worker_id, created_at, updated_at,
//                               completed_count, failed_count
//   mcp:job:{id}:pending  ZSET  member=url, score=depth
//   mcp:job:{id}:leased   ZSET  member=url, score=lease_expires_at
//   mcp:job:{id}:visited  SET   member=url  (dedup guard in enqueue)
//   mcp:job:{id}:items    HASH  field=url, value=JSON{depth,parentUrl,attempts,leaseId}
//   mcp:job:{id}:pages    HASH  field=url, value=JSON page record
//   mcp:job:{id}:pages:o  LIST  urls in completion order (for results pagination)
//   mcp:jobs              ZSET  member=jobId, score=created_at
//   mcp:jobs:running      SET   member=jobId (running jobs not yet worker-claimed)

const PFX = 'mcp';

export class RedisJobQueue implements JobQueue {
  constructor(private readonly redis: RedisClient) {}

  private jk  = (id: string) => `${PFX}:job:${id}`;
  private pk  = (id: string) => `${PFX}:job:${id}:pending`;
  private lk  = (id: string) => `${PFX}:job:${id}:leased`;
  private vk  = (id: string) => `${PFX}:job:${id}:visited`;
  private ik  = (id: string) => `${PFX}:job:${id}:items`;
  private pgk = (id: string) => `${PFX}:job:${id}:pages`;
  private pok = (id: string) => `${PFX}:job:${id}:pages:o`;
  private jlk = ()           => `${PFX}:jobs`;
  private rnk = ()           => `${PFX}:jobs:running`;

  // Atomically reclaim expired leases, then lease up to n items (lowest depth first).
  // KEYS[1]=pending KEYS[2]=leased KEYS[3]=items
  // ARGV[1]=n ARGV[2]=leaseMs ARGV[3]=leaseId ARGV[4]=now
  private static LEASE_SCRIPT = `
local pending = KEYS[1]
local leased  = KEYS[2]
local items   = KEYS[3]
local n       = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local leaseId = ARGV[3]
local now     = tonumber(ARGV[4])
local exp     = now + leaseMs

-- Reclaim leases expired before now
local dead = redis.call('ZRANGEBYSCORE', leased, '-inf', now)
for _, url in ipairs(dead) do
  redis.call('ZREM', leased, url)
  local raw = redis.call('HGET', items, url)
  if raw then
    local it = cjson.decode(raw)
    redis.call('ZADD', pending, it.depth or 0, url)
    it.leaseId = nil
    redis.call('HSET', items, url, cjson.encode(it))
  end
end

-- Pop n pending items (lowest depth = BFS order)
local pairs = redis.call('ZPOPMIN', pending, n)
local result = {}
for i = 1, #pairs, 2 do
  local url = pairs[i]
  local raw = redis.call('HGET', items, url)
  local it  = raw and cjson.decode(raw) or {depth=0, attempts=0}
  it.leaseId = leaseId
  redis.call('ZADD', leased, exp, url)
  redis.call('HSET', items, url, cjson.encode(it))
  -- Encode result; parentUrl may be nil (JSON null)
  local entry = {url=url, depth=it.depth or 0, leaseId=leaseId, leaseExpiresAt=exp}
  if it.parentUrl then entry.parentUrl = it.parentUrl end
  table.insert(result, cjson.encode(entry))
end
return result
`;

  // Atomically fail an item: retry if retryable+attempts<3, else mark failed.
  // Also increments failed_count and checks job completion.
  // KEYS[1]=leased KEYS[2]=pending KEYS[3]=items KEYS[4]=pages KEYS[5]=pagesOrd KEYS[6]=job
  // ARGV[1]=url ARGV[2]=leaseId ARGV[3]=errMsg ARGV[4]=retryable(0/1) ARGV[5]=now ARGV[6]=depth
  private static FAIL_SCRIPT = `
local leased   = KEYS[1]
local pending  = KEYS[2]
local items    = KEYS[3]
local pages    = KEYS[4]
local pagesOrd = KEYS[5]
local jobKey   = KEYS[6]
local url      = ARGV[1]
local leaseId  = ARGV[2]
local errMsg   = ARGV[3]
local retryable = tonumber(ARGV[4])
local now      = tonumber(ARGV[5])
local depth    = tonumber(ARGV[6])

local raw = redis.call('HGET', items, url)
if not raw then return 0 end
local it = cjson.decode(raw)

local attempts = (it.attempts or 0) + 1
redis.call('ZREM', leased, url)

if retryable == 1 and attempts < 3 then
  it.attempts = attempts
  it.leaseId  = nil
  redis.call('HSET', items, url, cjson.encode(it))
  redis.call('ZADD', pending, it.depth or 0, url)
else
  it.attempts = attempts
  it.leaseId  = nil
  redis.call('HSET', items, url, cjson.encode(it))
  local page = {status='failed', depth=depth, error=errMsg, crawled_at=now}
  redis.call('HSET', pages, url, cjson.encode(page))
  redis.call('RPUSH', pagesOrd, url)
  redis.call('HINCRBY', jobKey, 'failed_count', 1)
  -- Check job completion
  local pc = redis.call('ZCARD', pending)
  local lc = redis.call('ZCARD', leased)
  if pc == 0 and lc == 0 then
    redis.call('HSET', jobKey, 'status', 'completed', 'updated_at', now)
  end
end
return 1
`;

  async createJob(spec: JobSpec): Promise<string> {
    const id  = randomUUID();
    const now = Date.now();
    const p   = this.redis.pipeline();
    p.hset(this.jk(id),
      'spec', JSON.stringify(spec),
      'status', 'pending',
      'created_at', String(now),
      'updated_at', String(now),
      'completed_count', '0',
      'failed_count', '0',
    );
    p.zadd(this.jlk(), now, id);
    await p.exec();
    return id;
  }

  async enqueue(jobId: string, items: QueueItem[]): Promise<number> {
    if (items.length === 0) return 0;

    // Individual SADD per URL — returns 1 if new, 0 if already visited.
    // Two round-trips (check + add) but correct without Lua.
    const checkPipeline = this.redis.pipeline();
    for (const item of items) {
      checkPipeline.sadd(this.vk(jobId), item.url);
    }
    const checkResults = await checkPipeline.exec() as Array<[Error | null, number]>;
    const newItems = items.filter((_, i) => checkResults[i]![1] === 1);
    if (newItems.length === 0) return 0;

    const now = Date.now();
    const p = this.redis.pipeline();
    for (const item of newItems) {
      p.zadd(this.pk(jobId), item.depth, item.url);
      p.hset(this.ik(jobId), item.url, JSON.stringify({
        depth: item.depth,
        parentUrl: item.parentUrl ?? null,
        attempts: 0,
        leaseId: null,
      }));
    }
    // Transition job to running (idempotent — HSET overwrites same value on second call)
    p.hset(this.jk(jobId), 'status', 'running', 'updated_at', String(now));
    p.sadd(this.rnk(), jobId);
    await p.exec();
    return newItems.length;
  }

  async lease(jobId: string, n: number, leaseMs: number): Promise<LeasedItem[]> {
    const leaseId = randomUUID();
    const now     = Date.now();
    const raw = await this.redis.eval(
      RedisJobQueue.LEASE_SCRIPT,
      3,
      this.pk(jobId), this.lk(jobId), this.ik(jobId),
      n, leaseMs, leaseId, now,
    ) as string[];

    return (raw ?? []).map(r => {
      const parsed = JSON.parse(r) as {
        url: string; depth: number; parentUrl?: string;
        leaseId: string; leaseExpiresAt: number;
      };
      return {
        url: parsed.url, depth: parsed.depth,
        parentUrl: parsed.parentUrl,
        jobId, leaseId: parsed.leaseId, leaseExpiresAt: parsed.leaseExpiresAt,
      };
    });
  }

  async heartbeat(items: LeasedItem[], leaseMs: number): Promise<void> {
    if (items.length === 0) return;
    const newExpiry = Date.now() + leaseMs;
    const p = this.redis.pipeline();
    for (const item of items) {
      p.zadd(this.lk(item.jobId), newExpiry, item.url);
    }
    await p.exec();
  }

  async complete(item: LeasedItem, record: PageRecord): Promise<void> {
    const now  = Date.now();
    const page = {
      status:         record.status,
      title:          record.title          ?? null,
      content:        record.content        ?? null,
      content_format: record.contentFormat  ?? null,
      content_size:   record.contentSize    ?? null,
      depth:          record.depth,
      error:          record.error          ?? null,
      crawled_at:     record.crawledAt      ?? now,
    };

    const p = this.redis.pipeline();
    p.zrem(this.lk(item.jobId), item.url);
    p.hset(this.pgk(item.jobId), item.url, JSON.stringify(page));
    p.rpush(this.pok(item.jobId), item.url);
    p.hincrby(this.jk(item.jobId), 'completed_count', 1);
    p.hset(this.jk(item.jobId), 'updated_at', String(now));
    await p.exec();

    await this.maybeFinishJob(item.jobId);
  }

  private async maybeFinishJob(jobId: string): Promise<void> {
    const p = this.redis.pipeline();
    p.zcard(this.pk(jobId));
    p.zcard(this.lk(jobId));
    const res = await p.exec() as Array<[Error | null, number]>;
    if (res[0]![1] === 0 && res[1]![1] === 0) {
      const now = Date.now();
      await this.redis.hset(this.jk(jobId),
        'status', 'completed', 'updated_at', String(now));
      await this.redis.srem(this.rnk(), jobId);
    }
  }

  async fail(item: LeasedItem, error: string, retryable: boolean): Promise<void> {
    const now = Date.now();
    await this.redis.eval(
      RedisJobQueue.FAIL_SCRIPT,
      6,
      this.lk(item.jobId), this.pk(item.jobId), this.ik(item.jobId),
      this.pgk(item.jobId), this.pok(item.jobId), this.jk(item.jobId),
      item.url, item.leaseId, error,
      retryable ? 1 : 0,
      now, item.depth,
    );
    // maybeFinishJob handled inside Lua for the permanently-failed path;
    // call it here too in case we just retried (pending count may have changed).
    await this.maybeFinishJob(item.jobId);
  }

  async claimJob(workerId: string, _leaseMs: number): Promise<JobLease | undefined> {
    // HSETNX worker_id — atomic claim; avoids two workers taking the same job.
    const jobIds = await this.redis.smembers(this.rnk()) as string[];
    for (const jobId of jobIds) {
      const status = await this.redis.hget(this.jk(jobId), 'status') as string | null;
      if (status !== 'running') {
        await this.redis.srem(this.rnk(), jobId);
        continue;
      }
      const claimed: number = await this.redis.hsetnx(this.jk(jobId), 'worker_id', workerId);
      if (claimed === 1) {
        await this.redis.hset(this.jk(jobId), 'updated_at', String(Date.now()));
        return { jobId, workerId };
      }
    }
    return undefined;
  }

  async status(jobId: string): Promise<JobSummary | undefined> {
    const data = await this.redis.hgetall(this.jk(jobId)) as Record<string, string> | null;
    if (!data?.spec) return undefined;

    const spec = JSON.parse(data.spec) as JobSpec;
    const p = this.redis.pipeline();
    p.zcard(this.pk(jobId));
    p.zcard(this.lk(jobId));
    const res = await p.exec() as Array<[Error | null, number]>;

    const completed = Number(data.completed_count ?? 0);
    const failed    = Number(data.failed_count    ?? 0);
    const pending   = res[0]![1] + res[1]![1];

    return {
      id: jobId, rootUrl: spec.rootUrl,
      status: data.status as JobStatus,
      total: completed + failed + pending,
      completed, failed, pending,
      createdAt: Number(data.created_at),
      updatedAt: Number(data.updated_at),
    };
  }

  async results(
    jobId: string,
    offset: number,
    limit: number,
    filter: PageStatus | 'all' = 'all',
  ): Promise<PageRecord[]> {
    if (filter === 'all') {
      const urls = await this.redis.lrange(this.pok(jobId), offset, offset + limit - 1) as string[];
      if (urls.length === 0) return [];
      const p = this.redis.pipeline();
      for (const url of urls) p.hget(this.pgk(jobId), url);
      const res = await p.exec() as Array<[Error | null, string | null]>;
      return urls.flatMap((url, i) => {
        const raw = res[i]![1];
        if (!raw) return [];
        return [this.parsePageRecord(url, jobId, raw)];
      });
    }

    // Filtered: scan ordered list in batches
    const records: PageRecord[] = [];
    const BATCH = Math.max(limit * 3, 50);
    let idx = 0, skipped = 0;
    while (records.length < limit) {
      const urls = await this.redis.lrange(this.pok(jobId), idx, idx + BATCH - 1) as string[];
      if (urls.length === 0) break;
      const p = this.redis.pipeline();
      for (const url of urls) p.hget(this.pgk(jobId), url);
      const res = await p.exec() as Array<[Error | null, string | null]>;
      for (let i = 0; i < urls.length && records.length < limit; i++) {
        const raw = res[i]![1];
        if (!raw) continue;
        const rec = this.parsePageRecord(urls[i]!, jobId, raw);
        if (rec.status !== filter) continue;
        if (skipped < offset) { skipped++; continue; }
        records.push(rec);
      }
      idx += BATCH;
    }
    return records;
  }

  private parsePageRecord(url: string, jobId: string, raw: string): PageRecord {
    const p = JSON.parse(raw) as {
      status: PageStatus; title: string | null; content: string | null;
      content_format: string | null; content_size: number | null;
      depth: number; error: string | null; crawled_at: number | null;
    };
    return {
      url, jobId, status: p.status,
      title:         p.title          ?? undefined,
      content:       p.content        ?? undefined,
      contentFormat: p.content_format ?? undefined,
      contentSize:   p.content_size   ?? undefined,
      depth:         p.depth,
      error:         p.error          ?? undefined,
      crawledAt:     p.crawled_at     ?? undefined,
    };
  }

  async cancel(jobId: string): Promise<void> {
    const now = Date.now();
    const [pendingUrls, leasedUrls] = await Promise.all([
      this.redis.zrange(this.pk(jobId), 0, -1) as Promise<string[]>,
      this.redis.zrange(this.lk(jobId), 0, -1) as Promise<string[]>,
    ]);
    const allUrls = [...new Set([...pendingUrls, ...leasedUrls])];

    // Fetch item metadata (depth) before clearing the ZSET/HASH data
    let depthMap: Record<string, number> = {};
    if (allUrls.length > 0) {
      const p = this.redis.pipeline();
      for (const url of allUrls) p.hget(this.ik(jobId), url);
      const res = await p.exec() as Array<[Error | null, string | null]>;
      depthMap = Object.fromEntries(allUrls.map((url, i) => {
        const raw = res[i]![1];
        const depth = raw ? (JSON.parse(raw) as { depth: number }).depth : 0;
        return [url, depth];
      }));
    }

    const p = this.redis.pipeline();
    p.hset(this.jk(jobId), 'status', 'cancelled', 'updated_at', String(now));
    p.srem(this.rnk(), jobId);
    p.del(this.pk(jobId));
    p.del(this.lk(jobId));
    for (const url of allUrls) {
      const depth = depthMap[url] ?? 0;
      p.hset(this.pgk(jobId), url, JSON.stringify({
        status: 'failed', depth, error: 'cancelled', crawled_at: now,
      }));
      p.rpush(this.pok(jobId), url);
    }
    if (allUrls.length > 0) {
      p.hincrby(this.jk(jobId), 'failed_count', allUrls.length);
    }
    await p.exec();
  }

  async list(): Promise<JobSummary[]> {
    const jobIds = await this.redis.zrevrange(this.jlk(), 0, -1) as string[];
    const summaries: JobSummary[] = [];
    for (const id of jobIds) {
      const s = await this.status(id);
      if (s) summaries.push(s);
    }
    return summaries;
  }

  async close(): Promise<void> { /* shared connection — closed by factory */ }
}

export async function createRedisStores(redisUrl: string): Promise<Stores> {
  const Redis = await loadIoredis();
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  await redis.ping();

  return {
    kv:        new RedisKvStore(redis),
    rateLimit: new RedisRateLimitStore(redis),
    queue:     new RedisJobQueue(redis),
  };
}
