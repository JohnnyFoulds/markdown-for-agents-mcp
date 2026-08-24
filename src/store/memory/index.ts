import { randomUUID } from 'node:crypto';
import type {
  KeyValueStore, RateLimitStore, JobQueue, JobSpec, QueueItem, LeasedItem,
  PageRecord, JobSummary, JobStatus, PageStatus, JobLease, Stores,
} from '../types.js';

// ── KeyValueStore ─────────────────────────────────────────────────────────────

interface KvEntry { value: Buffer; expiresAt: number | null }

export class MemoryKvStore implements KeyValueStore {
  private readonly store = new Map<string, KvEntry>();

  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt !== null && v.expiresAt <= now) this.store.delete(k);
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    this.evict();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async setNx(key: string, value: Buffer, ttlMs: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== undefined) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async stats(): Promise<{ backend: string; entries: number; bytes: number }> {
    this.evict();
    let bytes = 0;
    for (const v of this.store.values()) bytes += v.value.length;
    return { backend: 'memory', entries: this.store.size, bytes };
  }

  async close(): Promise<void> { this.store.clear(); }
}

// ── RateLimitStore ────────────────────────────────────────────────────────────

interface BucketState { tokens: number; lastRefill: number }

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  async take(key: string, rps: number, burst: number, now: number): Promise<number> {
    if (rps <= 0) return 0;

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, lastRefill: now };
      this.buckets.set(key, b);
    }

    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(burst, b.tokens + (elapsed * rps) / 1000);
    b.lastRefill = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }

    return Math.ceil(((1 - b.tokens) / rps) * 1000);
  }

  async close(): Promise<void> { this.buckets.clear(); }
}

// ── JobQueue ──────────────────────────────────────────────────────────────────

interface JobEntry {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  workerId?: string;
  createdAt: number;
  updatedAt: number;
}

interface QueueEntry extends QueueItem {
  id: string;
  jobId: string;
  status: 'pending' | 'leased' | 'completed' | 'failed';
  leaseId?: string;
  leaseExpiresAt?: number;
  attempts: number;
}

export class MemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly queue = new Map<string, QueueEntry>();
  private readonly pages = new Map<string, PageRecord>();
  private readonly visited = new Map<string, Set<string>>();

  async createJob(spec: JobSpec): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    this.jobs.set(id, { id, spec, status: 'pending', createdAt: now, updatedAt: now });
    this.visited.set(id, new Set());
    return id;
  }

  async enqueue(jobId: string, items: QueueItem[]): Promise<number> {
    const visited = this.visited.get(jobId);
    if (!visited) throw new Error(`Job not found: ${jobId}`);

    let added = 0;
    for (const item of items) {
      if (visited.has(item.url)) continue;
      visited.add(item.url);

      const id = randomUUID();
      this.queue.set(id, { ...item, id, jobId, status: 'pending', attempts: 0 });
      added++;
    }

    const job = this.jobs.get(jobId);
    if (job && job.status === 'pending') {
      job.status = 'running';
      job.updatedAt = Date.now();
    }

    return added;
  }

  private reclaimExpired(jobId: string): void {
    const now = Date.now();
    for (const entry of this.queue.values()) {
      if (entry.jobId === jobId && entry.status === 'leased' &&
          entry.leaseExpiresAt !== undefined && entry.leaseExpiresAt < now) {
        entry.status = 'pending';
        entry.leaseId = undefined;
        entry.leaseExpiresAt = undefined;
      }
    }
  }

  async lease(jobId: string, n: number, leaseMs: number): Promise<LeasedItem[]> {
    this.reclaimExpired(jobId);
    const leaseId = randomUUID();
    const leaseExpiresAt = Date.now() + leaseMs;
    const result: LeasedItem[] = [];

    for (const entry of this.queue.values()) {
      if (result.length >= n) break;
      if (entry.jobId !== jobId || entry.status !== 'pending') continue;

      entry.status = 'leased';
      entry.leaseId = leaseId;
      entry.leaseExpiresAt = leaseExpiresAt;
      result.push({
        url: entry.url, depth: entry.depth, parentUrl: entry.parentUrl,
        jobId, leaseId, leaseExpiresAt,
      });
    }

    return result;
  }

  async heartbeat(items: LeasedItem[], leaseMs: number): Promise<void> {
    const newExpiry = Date.now() + leaseMs;
    for (const item of items) {
      for (const entry of this.queue.values()) {
        if (entry.jobId === item.jobId && entry.url === item.url && entry.leaseId === item.leaseId) {
          entry.leaseExpiresAt = newExpiry;
        }
      }
    }
  }

  async complete(item: LeasedItem, record: PageRecord): Promise<void> {
    for (const entry of this.queue.values()) {
      if (entry.jobId === item.jobId && entry.url === item.url && entry.leaseId === item.leaseId) {
        entry.status = 'completed';
        break;
      }
    }
    this.pages.set(`${item.jobId}:${item.url}`, record);
    await this.maybeFinishJob(item.jobId);
  }

  async fail(item: LeasedItem, error: string, retryable: boolean): Promise<void> {
    for (const entry of this.queue.values()) {
      if (entry.jobId === item.jobId && entry.url === item.url && entry.leaseId === item.leaseId) {
        entry.attempts++;
        entry.status = retryable && entry.attempts < 3 ? 'pending' : 'failed';
        entry.leaseId = undefined;
        entry.leaseExpiresAt = undefined;
        break;
      }
    }
    const record: PageRecord = { ...item, status: 'failed', error, crawledAt: Date.now() };
    this.pages.set(`${item.jobId}:${item.url}`, record);
    await this.maybeFinishJob(item.jobId);
  }

  private async maybeFinishJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    let hasPending = false;
    for (const entry of this.queue.values()) {
      if (entry.jobId === jobId && (entry.status === 'pending' || entry.status === 'leased')) {
        hasPending = true;
        break;
      }
    }

    if (!hasPending) {
      job.status = 'completed';
      job.updatedAt = Date.now();
    }
  }

  async claimJob(workerId: string, _leaseMs: number): Promise<JobLease | undefined> {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && !job.workerId) {
        job.workerId = workerId;
        job.updatedAt = Date.now();
        return { jobId: job.id, workerId };
      }
    }
    return undefined;
  }

  async status(jobId: string): Promise<JobSummary | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    let total = 0, completed = 0, failed = 0, pending = 0;
    for (const entry of this.queue.values()) {
      if (entry.jobId !== jobId) continue;
      total++;
      if (entry.status === 'completed') completed++;
      else if (entry.status === 'failed') failed++;
      else pending++;
    }

    return {
      id: job.id, rootUrl: job.spec.rootUrl, status: job.status,
      total, completed, failed, pending,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
    };
  }

  async results(jobId: string, offset: number, limit: number, filter: PageStatus | 'all' = 'all'): Promise<PageRecord[]> {
    const records: PageRecord[] = [];
    for (const [key, rec] of this.pages) {
      if (!key.startsWith(`${jobId}:`)) continue;
      if (filter !== 'all' && rec.status !== filter) continue;
      records.push(rec);
    }
    records.sort((a, b) => (a.crawledAt ?? 0) - (b.crawledAt ?? 0));
    return records.slice(offset, offset + limit);
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    job.status = 'cancelled';
    job.updatedAt = Date.now();

    for (const entry of this.queue.values()) {
      if (entry.jobId === jobId && (entry.status === 'pending' || entry.status === 'leased')) {
        entry.status = 'failed';
      }
    }
  }

  async list(): Promise<JobSummary[]> {
    const summaries: JobSummary[] = [];
    for (const job of this.jobs.values()) {
      const s = await this.status(job.id);
      if (s) summaries.push(s);
    }
    summaries.sort((a, b) => b.createdAt - a.createdAt);
    return summaries;
  }

  async close(): Promise<void> {
    this.jobs.clear();
    this.queue.clear();
    this.pages.clear();
    this.visited.clear();
  }
}

export function createMemoryStores(): Stores {
  return {
    kv: new MemoryKvStore(),
    rateLimit: new MemoryRateLimitStore(),
    queue: new MemoryJobQueue(),
  };
}
