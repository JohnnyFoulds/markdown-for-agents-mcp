import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { MemoryJobQueue } from '../memory/index.js';
import { SqliteJobQueue } from '../sqlite/index.js';
import type { JobQueue, JobSpec } from '../types.js';

const REDIS_URL = process.env['REDIS_URL'];

const BASE_SPEC: JobSpec = {
  rootUrl: 'https://example.com',
  maxPages: 100,
  maxDepth: 3,
};

function runQueueContract(
  name: string,
  factory: () => JobQueue | Promise<JobQueue>,
) {
  describe(`JobQueue contract — ${name}`, () => {
    let queue: JobQueue;
    beforeEach(async () => { queue = await factory(); });
    afterEach(async () => { await queue.close(); });

    // ── createJob ────────────────────────────────────────────────────────────

    it('createJob returns a UUID string', async () => {
      const id = await queue.createJob(BASE_SPEC);
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('createJob leaves job in pending status', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const s = await queue.status(id);
      expect(s?.status).toBe('pending');
    });

    // ── enqueue ──────────────────────────────────────────────────────────────

    it('enqueue adds unique items and deduplicates in one call', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const added = await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 1 },
        { url: 'https://example.com/b', depth: 1 },
        { url: 'https://example.com/a', depth: 1 }, // duplicate
      ]);
      expect(added).toBe(2);
    });

    it('enqueue deduplicates across separate calls', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const first  = await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 1 }]);
      const second = await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 1 }]);
      expect(first).toBe(1);
      expect(second).toBe(0);
    });

    it('enqueue transitions job pending → running', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 1 }]);
      const s = await queue.status(id);
      expect(s?.status).toBe('running');
    });

    // ── lease ────────────────────────────────────────────────────────────────

    it('lease returns pending items in depth order (BFS)', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/deep', depth: 2 },
        { url: 'https://example.com/shallow', depth: 0 },
        { url: 'https://example.com/mid', depth: 1 },
      ]);
      const items = await queue.lease(id, 3, 30_000);
      expect(items.map(i => i.depth)).toEqual([0, 1, 2]);
    });

    it('lease marks items leased (not returned again until expiry)', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const first = await queue.lease(id, 1, 30_000);
      expect(first).toHaveLength(1);
      expect(first[0]!.leaseId).toBeTruthy();

      const second = await queue.lease(id, 1, 30_000);
      expect(second).toHaveLength(1);
      expect(second[0]!.url).not.toBe(first[0]!.url);
    });

    it('lease returns empty when all items are leased', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.lease(id, 1, 30_000);
      const second = await queue.lease(id, 1, 30_000);
      expect(second).toHaveLength(0);
    });

    it('expired leases are reclaimed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.lease(id, 1, 1); // 1ms lease
      await new Promise(r => setTimeout(r, 20));
      const reclaimed = await queue.lease(id, 1, 30_000);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.url).toBe('https://example.com/a');
    });

    // ── heartbeat ────────────────────────────────────────────────────────────

    it('heartbeat extends lease expiry', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 20); // 20ms lease
      // Heartbeat before it expires
      await queue.heartbeat([item!], 30_000);
      await new Promise(r => setTimeout(r, 30)); // original lease would have expired
      // Should still be leased (heartbeat extended it)
      const after = await queue.lease(id, 1, 30_000);
      expect(after).toHaveLength(0); // item still leased
    });

    it('heartbeat on empty list is a no-op', async () => {
      await expect(queue.heartbeat([], 30_000)).resolves.toBeUndefined();
    });

    // ── complete ─────────────────────────────────────────────────────────────

    it('complete stores page record', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed',
        title: 'Test', content: 'Hello', depth: 0, crawledAt: Date.now(),
      });
      const results = await queue.results(id, 0, 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Test');
      expect(results[0]!.status).toBe('completed');
    });

    it('job transitions to completed when last item is processed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now(),
      });
      const s = await queue.status(id);
      expect(s?.status).toBe('completed');
      expect(s?.completed).toBe(1);
      expect(s?.pending).toBe(0);
    });

    it('job stays running while items are still pending', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now(),
      });
      const s = await queue.status(id);
      expect(s?.status).toBe('running'); // one item still pending
    });

    // ── fail ─────────────────────────────────────────────────────────────────

    it('fail with retryable=false marks item as failed immediately', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.fail(item!, 'network error', false);

      const results = await queue.results(id, 0, 10, 'failed');
      expect(results).toHaveLength(1);
      expect(results[0]!.error).toBe('network error');
    });

    it('fail with retryable=true re-enqueues item (attempt 1)', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.fail(item!, 'timeout', true);

      // Item should be back as pending — leasable again
      const retried = await queue.lease(id, 1, 30_000);
      expect(retried).toHaveLength(1);
      expect(retried[0]!.url).toBe('https://example.com/a');
    });

    it('fail with retryable=true permanently fails after 3 attempts', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);

      // Attempt 1 → retry
      const [a1] = await queue.lease(id, 1, 30_000);
      await queue.fail(a1!, 'timeout', true);
      // Attempt 2 → retry
      const [a2] = await queue.lease(id, 1, 30_000);
      await queue.fail(a2!, 'timeout', true);
      // Attempt 3 → permanently failed
      const [a3] = await queue.lease(id, 1, 30_000);
      await queue.fail(a3!, 'timeout', true);

      // No more items to lease
      const noMore = await queue.lease(id, 1, 30_000);
      expect(noMore).toHaveLength(0);

      // Job should be completed (all URLs processed, even if failed)
      const s = await queue.status(id);
      expect(s?.status).toBe('completed');
      expect(s?.failed).toBeGreaterThanOrEqual(1);
    });

    it('fail updates failed_count in job status', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.fail(item!, 'err', false);
      const s = await queue.status(id);
      expect(s?.failed).toBe(1);
    });

    // ── claimJob ─────────────────────────────────────────────────────────────

    it('claimJob returns a running job', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const lease = await queue.claimJob('worker-1', 30_000);
      expect(lease).toBeDefined();
      expect(lease!.jobId).toBe(id);
      expect(lease!.workerId).toBe('worker-1');
    });

    it('claimJob returns undefined when no running jobs', async () => {
      const lease = await queue.claimJob('worker-1', 30_000);
      expect(lease).toBeUndefined();
    });

    it('claimJob is exclusive — second worker cannot claim same job', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const lease1 = await queue.claimJob('worker-1', 30_000);
      const lease2 = await queue.claimJob('worker-2', 30_000);
      // Only one of them should get the job (or both undefined if only 1 job)
      const claimed = [lease1, lease2].filter(Boolean);
      expect(claimed.length).toBeLessThanOrEqual(1);
      if (claimed.length === 1) {
        expect(claimed[0]!.jobId).toBe(id);
      }
    });

    // ── status ───────────────────────────────────────────────────────────────

    it('status returns undefined for unknown job', async () => {
      const s = await queue.status('00000000-0000-0000-0000-000000000000');
      expect(s).toBeUndefined();
    });

    it('status counts total = completed + failed + pending', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const [itemA, itemB] = await queue.lease(id, 2, 30_000);
      await queue.complete(itemA!, { url: itemA!.url, jobId: id, status: 'completed', depth: 0 });
      await queue.fail(itemB!, 'err', false);
      const s = await queue.status(id);
      expect(s!.total).toBe(s!.completed + s!.failed + s!.pending);
      expect(s!.completed).toBe(1);
      expect(s!.failed).toBe(1);
    });

    // ── results ──────────────────────────────────────────────────────────────

    it('results returns completed records', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed',
        title: 'Test', content: 'Hello', depth: 0, crawledAt: Date.now(),
      });
      const r = await queue.results(id, 0, 10);
      expect(r).toHaveLength(1);
      expect(r[0]!.title).toBe('Test');
    });

    it('results filters by status=completed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const [ok, fail] = await queue.lease(id, 2, 30_000);
      await queue.complete(ok!, { url: ok!.url, jobId: id, status: 'completed', depth: 0 });
      await queue.fail(fail!, 'err', false);
      const completed = await queue.results(id, 0, 10, 'completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]!.url).toBe(ok!.url);
    });

    it('results filters by status=failed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const [ok, fail] = await queue.lease(id, 2, 30_000);
      await queue.complete(ok!, { url: ok!.url, jobId: id, status: 'completed', depth: 0 });
      await queue.fail(fail!, 'err', false);
      const failed = await queue.results(id, 0, 10, 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.error).toBe('err');
    });

    it('results pagination works', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
      await queue.enqueue(id, urls.map(url => ({ url, depth: 0 })));
      for (let i = 0; i < 3; i++) {
        const [item] = await queue.lease(id, 1, 30_000);
        await queue.complete(item!, { url: item!.url, jobId: id, status: 'completed', depth: 0 });
      }
      const page1 = await queue.results(id, 0, 2);
      const page2 = await queue.results(id, 2, 2);
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      const allUrls = new Set([...page1, ...page2].map(r => r.url));
      expect(allUrls.size).toBe(3);
    });

    // ── cancel ───────────────────────────────────────────────────────────────

    it('cancel transitions job to cancelled', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.cancel(id);
      const s = await queue.status(id);
      expect(s?.status).toBe('cancelled');
    });

    it('cancel marks remaining pending items as failed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      // Lease one item — it should also be cancelled
      await queue.lease(id, 1, 30_000);
      await queue.cancel(id);
      // After cancel, no pending items should be leasable
      const s = await queue.status(id);
      expect(s?.pending).toBe(0);
    });

    // ── list ─────────────────────────────────────────────────────────────────

    it('list returns all created jobs', async () => {
      const id1 = await queue.createJob(BASE_SPEC);
      const id2 = await queue.createJob({ ...BASE_SPEC, rootUrl: 'https://other.com' });
      await queue.enqueue(id1, [{ url: 'https://example.com/', depth: 0 }]);
      await queue.enqueue(id2, [{ url: 'https://other.com/', depth: 0 }]);
      const jobs = await queue.list();
      const ids = new Set(jobs.map(j => j.id));
      expect(ids.has(id1)).toBe(true);
      expect(ids.has(id2)).toBe(true);
    });

    // ── POPIA Phase 2 — s14 retention ────────────────────────────────────────
    //
    // Phase 2 RED reason (before fix):
    //   cancel() accretes data rather than deleting it:
    //     - Redis cancel writes fake page records for every cancelled URL (hset/:pages + rpush/:pages:o)
    //     - Memory/SQLite cancel marks queue items 'failed' but leaves completed page records intact
    //   After cancel, results() returns content in all three backends.
    //   After cancel, list() returns the cancelled job in all three backends.
    //   purgeOlderThan() does not exist → compile error across all three backends.

    it('(POPIA Phase 2) cancel deletes page content — results() empty after partial crawl + cancel', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      // Complete one page before cancel — this would leave a page record without the fix
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed',
        title: 'T', content: 'Content', depth: 0, crawledAt: Date.now(),
      });
      await queue.cancel(id);
      const results = await queue.results(id, 0, 100);
      expect(results).toHaveLength(0);
    });

    it('(POPIA Phase 2) cancelled job is absent from list()', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.cancel(id);
      const jobs = await queue.list();
      expect(jobs.map(j => j.id)).not.toContain(id);
    });

    it('(POPIA Phase 2) status() still reports cancelled after cancel', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.cancel(id);
      const s = await queue.status(id);
      expect(s?.status).toBe('cancelled');
      expect(s?.pending).toBe(0);
    });

    it('(POPIA Phase 2) purgeOlderThan removes completed job older than cutoff', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, { url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now() });
      // Purge everything created before "now + 1s"
      const purged = await queue.purgeOlderThan(Date.now() + 1000, 100);
      expect(purged).toContain(id);
      const jobs = await queue.list();
      expect(jobs.map(j => j.id)).not.toContain(id);
    });

    it('(POPIA Phase 2) purgeOlderThan returns purged job ids', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, { url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now() });
      const purged = await queue.purgeOlderThan(Date.now() + 1000, 100);
      expect(Array.isArray(purged)).toBe(true);
      expect(purged).toContain(id);
    });

    it('(POPIA Phase 2) purgeOlderThan respects limit — returns at most limit ids', async () => {
      const ids = await Promise.all([
        queue.createJob(BASE_SPEC),
        queue.createJob(BASE_SPEC),
        queue.createJob(BASE_SPEC),
      ]);
      for (const id of ids) {
        await queue.enqueue(id, [{ url: `https://example.com/${id}`, depth: 0 }]);
        const [item] = await queue.lease(id, 1, 30_000);
        await queue.complete(item!, { url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now() });
      }
      const purged = await queue.purgeOlderThan(Date.now() + 1000, 2);
      expect(purged.length).toBeLessThanOrEqual(2);
    });

    it('(POPIA Phase 2) purgeOlderThan does not remove jobs newer than cutoff', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      // Cutoff in the past — this job was created after the cutoff
      const purged = await queue.purgeOlderThan(Date.now() - 60_000, 100);
      expect(purged).not.toContain(id);
      const jobs = await queue.list();
      expect(jobs.map(j => j.id)).toContain(id);
    });
  });
}

runQueueContract('memory', () => new MemoryJobQueue());
runQueueContract('sqlite', () => new SqliteJobQueue(':memory:'));

// ── Redis backend — requires REDIS_URL env var ────────────────────────────────
// Run with: REDIS_URL=redis://localhost:6379 npx vitest run

describe.skipIf(!REDIS_URL)('JobQueue contract — redis', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let redis: any;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Redis } = await import('ioredis' as any);
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 3, db: 3 }); // DB 3 — isolated from kv (1) and rateLimit (2)
    await redis.ping();
  });

  afterAll(async () => { await redis?.quit(); });
  beforeEach(async () => { await redis?.flushdb(); });

  // Run the entire shared suite against a fresh RedisJobQueue each test
  runQueueContract('redis (inner)', async () => {
    const { RedisJobQueue } = await import('../redis/index.js');
    return new RedisJobQueue(redis);
  });
});
