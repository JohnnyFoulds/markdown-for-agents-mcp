import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryJobQueue } from '../memory/index.js';
import { SqliteJobQueue } from '../sqlite/index.js';
import type { JobQueue, JobSpec } from '../types.js';

const BASE_SPEC: JobSpec = {
  rootUrl: 'https://example.com',
  maxPages: 100,
  maxDepth: 3,
};

function runQueueContract(name: string, factory: () => JobQueue) {
  describe(`JobQueue contract — ${name}`, () => {
    let queue: JobQueue;
    beforeEach(() => { queue = factory(); });
    afterEach(async () => { await queue.close(); });

    it('createJob returns a job id', async () => {
      const id = await queue.createJob(BASE_SPEC);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('enqueue adds unique items and deduplicates', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const added = await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 1 },
        { url: 'https://example.com/b', depth: 1 },
        { url: 'https://example.com/a', depth: 1 }, // duplicate
      ]);
      expect(added).toBe(2);
    });

    it('enqueue transitions job to running', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 1 }]);
      const status = await queue.status(id);
      expect(status?.status).toBe('running');
    });

    it('lease returns pending items and marks them leased', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [
        { url: 'https://example.com/a', depth: 0 },
        { url: 'https://example.com/b', depth: 0 },
      ]);
      const items = await queue.lease(id, 1, 30_000);
      expect(items).toHaveLength(1);
      expect(items[0]!.url).toBe('https://example.com/a');
      expect(items[0]!.leaseId).toBeTruthy();

      // Can lease the second item
      const items2 = await queue.lease(id, 1, 30_000);
      expect(items2).toHaveLength(1);
      expect(items2[0]!.url).toBe('https://example.com/b');
    });

    it('lease returns empty when all items leased', async () => {
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
      await new Promise(r => setTimeout(r, 10));
      // expired lease should be reclaimable
      const items = await queue.lease(id, 1, 30_000);
      expect(items).toHaveLength(1);
    });

    it('complete marks item done and stores page record', async () => {
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
    });

    it('fail marks item failed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.fail(item!, 'timeout', false);

      const results = await queue.results(id, 0, 10, 'failed');
      expect(results).toHaveLength(1);
      expect(results[0]!.error).toBe('timeout');
    });

    it('job completes when all items processed', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      const [item] = await queue.lease(id, 1, 30_000);
      await queue.complete(item!, {
        url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now(),
      });

      const status = await queue.status(id);
      expect(status?.status).toBe('completed');
      expect(status?.completed).toBe(1);
      expect(status?.pending).toBe(0);
    });

    it('cancel transitions job to cancelled', async () => {
      const id = await queue.createJob(BASE_SPEC);
      await queue.enqueue(id, [{ url: 'https://example.com/a', depth: 0 }]);
      await queue.cancel(id);
      const status = await queue.status(id);
      expect(status?.status).toBe('cancelled');
    });

    it('list returns all jobs', async () => {
      const id1 = await queue.createJob(BASE_SPEC);
      const id2 = await queue.createJob({ ...BASE_SPEC, rootUrl: 'https://other.com' });
      await queue.enqueue(id1, [{ url: 'https://example.com/', depth: 0 }]);
      await queue.enqueue(id2, [{ url: 'https://other.com/', depth: 0 }]);
      const jobs = await queue.list();
      const ids = new Set(jobs.map(j => j.id));
      expect(ids.has(id1)).toBe(true);
      expect(ids.has(id2)).toBe(true);
    });

    it('results pagination works', async () => {
      const id = await queue.createJob(BASE_SPEC);
      const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
      await queue.enqueue(id, urls.map(url => ({ url, depth: 0 })));

      for (let i = 0; i < 3; i++) {
        const [item] = await queue.lease(id, 1, 30_000);
        await queue.complete(item!, {
          url: item!.url, jobId: id, status: 'completed', depth: 0, crawledAt: Date.now() + i,
        });
      }

      const page1 = await queue.results(id, 0, 2);
      const page2 = await queue.results(id, 2, 2);
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(new Set([...page1, ...page2].map(r => r.url)).size).toBe(3);
    });
  });
}

runQueueContract('memory', () => new MemoryJobQueue());
runQueueContract('sqlite', () => new SqliteJobQueue(':memory:'));
