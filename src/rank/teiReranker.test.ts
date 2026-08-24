import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeConfig, resetConfig } from '../config.js';
import { TeiReranker } from './teiReranker.js';
import type { HttpClient, HttpResponse } from '../http/types.js';
import type { Chunk } from './types.js';

function mockClient(status: number, body: string): HttpClient {
  const res: HttpResponse = {
    url: 'http://tei:8080',
    status,
    headers: {},
    body: Buffer.from(body),
    charset: 'utf-8',
    redirectChain: [],
    attempts: 1,
    durationMs: 10,
    text: () => body,
  };
  return { request: vi.fn().mockResolvedValue(res) } as unknown as HttpClient;
}

const CHUNKS: Chunk[] = [
  { text: 'First passage', headingPath: '', sourceUrl: 'https://a.com', index: 0, tokenEstimate: 3 },
  { text: 'Second passage', headingPath: '', sourceUrl: 'https://a.com', index: 1, tokenEstimate: 3 },
  { text: 'Third passage', headingPath: '', sourceUrl: 'https://a.com', index: 2, tokenEstimate: 3 },
];

beforeEach(() => {
  resetConfig();
  initializeConfig({ RERANK_TEI_URL: 'http://tei:8080' });
});
afterEach(() => resetConfig());

describe('TeiReranker', () => {
  test('warmup() marks reranker as ready on successful health check', async () => {
    const client = mockClient(200, '{"status":"ok"}');
    const reranker = new TeiReranker(client);
    expect(reranker.isReady()).toBe(false);
    await reranker.warmup();
    expect(reranker.isReady()).toBe(true);
  });

  test('warmup() does not mark ready when health check fails', async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error('connection refused')) } as unknown as HttpClient;
    const reranker = new TeiReranker(client);
    await reranker.warmup();
    expect(reranker.isReady()).toBe(false);
  });

  test('warmup() is a no-op when RERANK_TEI_URL is not configured', async () => {
    resetConfig();
    initializeConfig({});
    const client = mockClient(200, 'ok');
    const reranker = new TeiReranker(client);
    await reranker.warmup();
    expect(reranker.isReady()).toBe(false);
  });

  test('rank() returns chunks sorted by score descending', async () => {
    // TEI returns index 0 score 0.1, index 1 score 0.9 — index 1 should win
    const rankResponse = JSON.stringify([{ index: 0, score: 0.1 }, { index: 1, score: 0.9 }, { index: 2, score: 0.5 }]);
    const healthClient = mockClient(200, '{"status":"ok"}');
    const rankClient = mockClient(200, rankResponse);
    // warmup uses health endpoint, rank uses rerank endpoint
    const reranker = new TeiReranker({
      request: vi.fn()
        .mockResolvedValueOnce({ ...healthClient.request, url: '', status: 200, headers: {}, body: Buffer.from('ok'), charset: 'utf-8', redirectChain: [], attempts: 1, durationMs: 5, text: () => 'ok' })
        .mockResolvedValueOnce({ url: '', status: 200, headers: {}, body: Buffer.from(rankResponse), charset: 'utf-8', redirectChain: [], attempts: 1, durationMs: 5, text: () => rankResponse }),
    } as unknown as HttpClient);
    await reranker.warmup();
    const scored = await reranker.rank('query', CHUNKS);
    expect(scored[0]!.score).toBe(0.9);
    expect(scored[0]!.text).toBe('Second passage');
    expect(scored[1]!.score).toBe(0.5);
    expect(scored[2]!.score).toBe(0.1);
  });

  test('rank() falls back to noop when not ready', async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error('down')) } as unknown as HttpClient;
    const reranker = new TeiReranker(client);
    // Not warmed up → falls back to noop (SERP order)
    const scored = await reranker.rank('query', CHUNKS);
    expect(scored).toHaveLength(3);
    // noop preserves SERP order with decreasing scores
    expect(scored[0]!.text).toBe('First passage');
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  test('close() marks reranker as not ready', async () => {
    const client = mockClient(200, 'ok');
    const reranker = new TeiReranker(client);
    await reranker.warmup();
    await reranker.close();
    expect(reranker.isReady()).toBe(false);
  });
});
