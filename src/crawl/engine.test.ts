import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../render/ladder.js', () => ({
  renderLadder: {
    render: vi.fn(async ({ url }: { url: string }) => ({
      url,
      html: `<html><body><h1>Page</h1><p>Content of ${url}</p><a href="${url}page2">link</a></body></html>`,
      title: `Title of ${url}`,
      status: 200,
      tier: 'http',
      escalations: [],
      durationMs: 10,
    })),
    warmup: vi.fn(),
    drain: vi.fn(),
  },
}));

// Store factory: use in-memory stores for tests
vi.mock('../store/factory.js', async () => {
  const m = await import('../store/memory/index.js');
  const stores = m.createMemoryStores();
  return {
    getStores: () => stores,
    initStores: async () => stores,
    closeStores: async () => {},
    resetStores: () => {},
  };
});

import { crawlSync, startAsyncCrawl, processQueueItem } from './engine.js';

beforeEach(() => vi.clearAllMocks());

describe('crawlSync', () => {
  it('crawls root URL and returns pages', async () => {
    const result = await crawlSync({
      rootUrl: 'https://example.com/',
      maxPages: 3,
      maxDepth: 2,
    });

    expect(result.rootUrl).toBe('https://example.com/');
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages[0]!.success).toBe(true);
    expect(result.pages[0]!.url).toBe('https://example.com/');
    expect(result.summary.total).toBe(result.pages.length);
  });

  it('respects maxPages limit', async () => {
    const result = await crawlSync({
      rootUrl: 'https://example.com/',
      maxPages: 1,
      maxDepth: 5,
    });

    expect(result.pages.length).toBeLessThanOrEqual(1);
  });

  it('throws on invalid URL', async () => {
    await expect(crawlSync({
      rootUrl: 'not-a-url',
      maxPages: 10,
      maxDepth: 2,
    })).rejects.toThrow();
  });

  it('marks failed fetches in results', async () => {
    const { renderLadder } = await import('../render/ladder.js');
    vi.mocked(renderLadder.render).mockRejectedValueOnce(new Error('timeout'));

    const result = await crawlSync({
      rootUrl: 'https://example.com/',
      maxPages: 1,
      maxDepth: 1,
    });

    const failed = result.pages.filter(p => !p.success);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.error).toContain('timeout');
  });

  it('respects maxDepth — does not follow links beyond depth', async () => {
    const result = await crawlSync({
      rootUrl: 'https://example.com/',
      maxPages: 100,
      maxDepth: 0,
    });

    // With maxDepth=0, only the root URL is visited
    expect(result.pages.length).toBe(1);
  });
});

describe('processQueueItem', () => {
  it('returns completed record and discovered links', async () => {
    const item = {
      url: 'https://example.com/test',
      depth: 0,
      jobId: 'job1',
      leaseId: 'lease1',
      leaseExpiresAt: Date.now() + 30_000,
    };

    const { record, discoveredLinks } = await processQueueItem(item, {
      rootUrl: 'https://example.com',
      maxPages: 10,
      maxDepth: 2,
    });

    expect(record.status).toBe('completed');
    expect(record.url).toBe(item.url);
    expect(record.title).toContain('Title of');
    expect(Array.isArray(discoveredLinks)).toBe(true);
  });

  it('returns failed record on render error', async () => {
    const { renderLadder } = await import('../render/ladder.js');
    vi.mocked(renderLadder.render).mockRejectedValueOnce(new Error('connection refused'));

    const item = {
      url: 'https://example.com/fail',
      depth: 0,
      jobId: 'job1',
      leaseId: 'lease1',
      leaseExpiresAt: Date.now() + 30_000,
    };

    const { record } = await processQueueItem(item, {
      rootUrl: 'https://example.com',
      maxPages: 10,
      maxDepth: 2,
    });

    expect(record.status).toBe('failed');
    expect(record.error).toContain('connection refused');
  });

  it('does not discover links beyond maxDepth', async () => {
    const item = {
      url: 'https://example.com/page',
      depth: 3, // at maxDepth
      jobId: 'job1',
      leaseId: 'lease1',
      leaseExpiresAt: Date.now() + 30_000,
    };

    const { discoveredLinks } = await processQueueItem(item, {
      rootUrl: 'https://example.com',
      maxPages: 10,
      maxDepth: 3, // depth 3 == maxDepth, so no children
    });

    expect(discoveredLinks).toHaveLength(0);
  });
});

describe('startAsyncCrawl', () => {
  it('creates a job and seeds the queue', async () => {
    const { getStores } = await import('../store/factory.js');
    const stores = getStores();

    const jobId = await startAsyncCrawl({
      rootUrl: 'https://example.com/',
      maxPages: 50,
      maxDepth: 3,
    });

    expect(typeof jobId).toBe('string');
    const status = await stores.queue.status(jobId);
    expect(status).toBeDefined();
    expect(status?.rootUrl).toBe('https://example.com/');
    expect(status?.pending).toBeGreaterThanOrEqual(1);

    // Spec stored in KV
    const specBuf = await stores.kv.get(`job:${jobId}:spec`);
    expect(specBuf).toBeDefined();
    const spec = JSON.parse(specBuf!.toString());
    expect(spec.rootUrl).toBe('https://example.com/');
  });
});
