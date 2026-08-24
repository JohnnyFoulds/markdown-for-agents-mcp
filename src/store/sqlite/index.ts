import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  KeyValueStore, RateLimitStore, JobQueue, JobSpec, QueueItem, LeasedItem,
  PageRecord, JobSummary, JobStatus, PageStatus, JobLease, Stores,
} from '../types.js';
import { storeOperationsTotal } from '../../obs/metrics.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  exp   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS rate_limit (
  host        TEXT PRIMARY KEY,
  tokens      REAL NOT NULL,
  last_refill INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id         TEXT PRIMARY KEY,
  spec       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  worker_id  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS crawl_queue (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  url              TEXT NOT NULL,
  depth            INTEGER NOT NULL DEFAULT 0,
  parent_url       TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  lease_id         TEXT,
  lease_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(job_id, url)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_queue_job_status ON crawl_queue(job_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_lease      ON crawl_queue(lease_expires_at) WHERE status='leased';

CREATE TABLE IF NOT EXISTS crawl_pages (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  url            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  title          TEXT,
  content        TEXT,
  content_format TEXT,
  content_size   INTEGER,
  depth          INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  crawled_at     INTEGER,
  UNIQUE(job_id, url)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pages_job ON crawl_pages(job_id, status);
`;

// ── KeyValueStore ─────────────────────────────────────────────────────────────

export class SqliteKvStore implements KeyValueStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async get(key: string): Promise<Buffer | undefined> {
    const now = Date.now();
    // Delete expired on read
    this.db.prepare('DELETE FROM kv WHERE key=? AND exp IS NOT NULL AND exp<=?').run(key, now);
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: Uint8Array } | undefined;
    storeOperationsTotal.inc({ backend: 'sqlite', op: 'get', result: row ? 'hit' : 'miss' });
    if (!row) return undefined;
    return Buffer.from(row.value);
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    const exp = ttlMs > 0 ? Date.now() + ttlMs : null;
    this.db.prepare('INSERT OR REPLACE INTO kv(key,value,exp) VALUES(?,?,?)').run(key, value, exp);
    storeOperationsTotal.inc({ backend: 'sqlite', op: 'set', result: 'ok' });
  }

  async del(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(key);
  }

  async setNx(key: string, value: Buffer, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Check (also clearing expired)
      this.db.prepare('DELETE FROM kv WHERE key=? AND exp IS NOT NULL AND exp<=?').run(key, now);
      const existing = this.db.prepare('SELECT key FROM kv WHERE key=?').get(key);
      if (existing) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const exp = ttlMs > 0 ? now + ttlMs : null;
      this.db.prepare('INSERT INTO kv(key,value,exp) VALUES(?,?,?)').run(key, value, exp);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async stats(): Promise<{ backend: string; entries: number; bytes: number }> {
    const now = Date.now();
    this.db.prepare('DELETE FROM kv WHERE exp IS NOT NULL AND exp<=?').run(now);
    const r = this.db.prepare('SELECT count(*) as c, sum(length(value)) as b FROM kv').get() as { c: number; b: number | null };
    return { backend: 'sqlite', entries: r.c, bytes: r.b ?? 0 };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ── RateLimitStore ────────────────────────────────────────────────────────────

export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async take(key: string, rps: number, burst: number, now: number): Promise<number> {
    if (rps <= 0) return 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT tokens, last_refill FROM rate_limit WHERE host=?').get(key) as
        { tokens: number; last_refill: number } | undefined;

      let tokens: number;
      let lastRefill: number;

      if (!row) {
        tokens = burst;
        lastRefill = now;
      } else {
        const elapsed = now - row.last_refill;
        tokens = Math.min(burst, row.tokens + (elapsed * rps) / 1000);
        lastRefill = now;
      }

      let waitMs = 0;
      if (tokens >= 1) {
        tokens -= 1;
      } else {
        waitMs = Math.ceil(((1 - tokens) / rps) * 1000);
        // Don't deduct tokens when returning a wait
      }

      this.db.prepare('INSERT OR REPLACE INTO rate_limit(host,tokens,last_refill) VALUES(?,?,?)').run(key, tokens, lastRefill);
      this.db.exec('COMMIT');
      return waitMs;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ── JobQueue ──────────────────────────────────────────────────────────────────

export class SqliteJobQueue implements JobQueue {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  async createJob(spec: JobSpec): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO crawl_jobs(id,spec,status,created_at,updated_at) VALUES(?,?,?,?,?)'
    ).run(id, JSON.stringify(spec), 'pending', now, now);
    return id;
  }

  async enqueue(jobId: string, items: QueueItem[]): Promise<number> {
    if (items.length === 0) return 0;

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO crawl_queue(id,job_id,url,depth,parent_url,status,attempts) VALUES(?,?,?,?,?,?,?)'
    );

    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const result = insert.run(randomUUID(), jobId, item.url, item.depth, item.parentUrl ?? null, 'pending', 0) as { changes: number };
        added += result.changes;
      }
      // Transition to running on first enqueue
      this.db.prepare(
        "UPDATE crawl_jobs SET status='running',updated_at=? WHERE id=? AND status='pending'"
      ).run(Date.now(), jobId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return added;
  }

  private reclaimExpired(jobId: string): void {
    const now = Date.now();
    this.db.prepare(
      "UPDATE crawl_queue SET status='pending',lease_id=NULL,lease_expires_at=NULL " +
      "WHERE job_id=? AND status='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at<?",
    ).run(jobId, now);
  }

  async lease(jobId: string, n: number, leaseMs: number): Promise<LeasedItem[]> {
    this.reclaimExpired(jobId);

    const leaseId = randomUUID();
    const leaseExpiresAt = Date.now() + leaseMs;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(
        "SELECT id,url,depth,parent_url FROM crawl_queue " +
        "WHERE job_id=? AND status='pending' ORDER BY depth ASC, rowid ASC LIMIT ?"
      ).all(jobId, n) as Array<{ id: string; url: string; depth: number; parent_url: string | null }>;

      if (rows.length === 0) {
        this.db.exec('ROLLBACK');
        return [];
      }

      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(
        `UPDATE crawl_queue SET status='leased',lease_id=?,lease_expires_at=? WHERE id IN (${placeholders})`
      ).run(leaseId, leaseExpiresAt, ...ids);

      this.db.exec('COMMIT');

      return rows.map(r => ({
        url: r.url, depth: r.depth, parentUrl: r.parent_url ?? undefined,
        jobId, leaseId, leaseExpiresAt,
      }));
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async heartbeat(items: LeasedItem[], leaseMs: number): Promise<void> {
    if (items.length === 0) return;
    const newExpiry = Date.now() + leaseMs;
    for (const item of items) {
      this.db.prepare(
        "UPDATE crawl_queue SET lease_expires_at=? WHERE job_id=? AND url=? AND lease_id=? AND status='leased'"
      ).run(newExpiry, item.jobId, item.url, item.leaseId);
    }
  }

  async complete(item: LeasedItem, record: PageRecord): Promise<void> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        "UPDATE crawl_queue SET status='completed' WHERE job_id=? AND url=? AND lease_id=?"
      ).run(item.jobId, item.url, item.leaseId);

      this.db.prepare(
        'INSERT OR REPLACE INTO crawl_pages(id,job_id,url,status,title,content,content_format,content_size,depth,error,crawled_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        randomUUID(), record.jobId, record.url, record.status,
        record.title ?? null, record.content ?? null, record.contentFormat ?? null,
        record.contentSize ?? null, record.depth, record.error ?? null, record.crawledAt ?? now,
      );

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    await this.maybeFinishJob(item.jobId);
  }

  async fail(item: LeasedItem, error: string, retryable: boolean): Promise<void> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT attempts FROM crawl_queue WHERE job_id=? AND url=?').get(item.jobId, item.url) as { attempts: number } | undefined;
      const attempts = (row?.attempts ?? 0) + 1;
      const newStatus = retryable && attempts < 3 ? 'pending' : 'failed';

      this.db.prepare(
        'UPDATE crawl_queue SET status=?,attempts=?,lease_id=NULL,lease_expires_at=NULL WHERE job_id=? AND url=?'
      ).run(newStatus, attempts, item.jobId, item.url);

      this.db.prepare(
        'INSERT OR REPLACE INTO crawl_pages(id,job_id,url,status,depth,error,crawled_at) VALUES(?,?,?,?,?,?,?)'
      ).run(randomUUID(), item.jobId, item.url, 'failed', item.depth, error, now);

      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    await this.maybeFinishJob(item.jobId);
  }

  private async maybeFinishJob(jobId: string): Promise<void> {
    const pending = this.db.prepare(
      "SELECT count(*) as c FROM crawl_queue WHERE job_id=? AND status IN ('pending','leased')"
    ).get(jobId) as { c: number };

    if (pending.c === 0) {
      this.db.prepare(
        "UPDATE crawl_jobs SET status='completed',updated_at=? WHERE id=? AND status='running'"
      ).run(Date.now(), jobId);
    }
  }

  async claimJob(workerId: string, _leaseMs: number): Promise<JobLease | undefined> {
    const row = this.db.prepare(
      "SELECT id FROM crawl_jobs WHERE status='running' AND worker_id IS NULL LIMIT 1"
    ).get() as { id: string } | undefined;

    if (!row) return undefined;

    this.db.prepare('UPDATE crawl_jobs SET worker_id=?,updated_at=? WHERE id=?').run(workerId, Date.now(), row.id);
    return { jobId: row.id, workerId };
  }

  async status(jobId: string): Promise<JobSummary | undefined> {
    const job = this.db.prepare('SELECT * FROM crawl_jobs WHERE id=?').get(jobId) as
      { id: string; spec: string; status: JobStatus; created_at: number; updated_at: number } | undefined;
    if (!job) return undefined;

    const spec = JSON.parse(job.spec) as JobSpec;
    const counts = this.db.prepare(
      "SELECT status, count(*) as c FROM crawl_queue WHERE job_id=? GROUP BY status"
    ).all(jobId) as Array<{ status: string; c: number }>;

    const byStatus = Object.fromEntries(counts.map(r => [r.status, r.c]));
    const completed = byStatus['completed'] ?? 0;
    const failed = byStatus['failed'] ?? 0;
    const pending = (byStatus['pending'] ?? 0) + (byStatus['leased'] ?? 0);

    return {
      id: job.id, rootUrl: spec.rootUrl, status: job.status,
      total: completed + failed + pending, completed, failed, pending,
      createdAt: job.created_at, updatedAt: job.updated_at,
    };
  }

  async results(jobId: string, offset: number, limit: number, filter: PageStatus | 'all' = 'all'): Promise<PageRecord[]> {
    const filterClause = filter === 'all' ? '' : `AND status='${filter}'`;
    const rows = this.db.prepare(
      `SELECT url,job_id,status,title,content,content_format,content_size,depth,error,crawled_at ` +
      `FROM crawl_pages WHERE job_id=? ${filterClause} ORDER BY crawled_at ASC LIMIT ? OFFSET ?`
    ).all(jobId, limit, offset) as Array<{
      url: string; job_id: string; status: PageStatus; title: string | null;
      content: string | null; content_format: string | null; content_size: number | null;
      depth: number; error: string | null; crawled_at: number | null;
    }>;

    return rows.map(r => ({
      url: r.url, jobId: r.job_id, status: r.status,
      title: r.title ?? undefined, content: r.content ?? undefined,
      contentFormat: r.content_format ?? undefined, contentSize: r.content_size ?? undefined,
      depth: r.depth, error: r.error ?? undefined, crawledAt: r.crawled_at ?? undefined,
    }));
  }

  async cancel(jobId: string): Promise<void> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE crawl_jobs SET status='cancelled',updated_at=? WHERE id=?").run(now, jobId);
      this.db.prepare(
        "UPDATE crawl_queue SET status='failed' WHERE job_id=? AND status IN ('pending','leased')"
      ).run(jobId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async list(): Promise<JobSummary[]> {
    const jobs = this.db.prepare(
      'SELECT id FROM crawl_jobs ORDER BY created_at DESC'
    ).all() as Array<{ id: string }>;

    const summaries: JobSummary[] = [];
    for (const { id } of jobs) {
      const s = await this.status(id);
      if (s) summaries.push(s);
    }
    return summaries;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createSqliteStores(path: string): Stores {
  return {
    kv: new SqliteKvStore(path),
    rateLimit: new SqliteRateLimitStore(path),
    queue: new SqliteJobQueue(path),
  };
}
