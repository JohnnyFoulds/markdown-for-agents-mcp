import { describe, test, expect } from 'vitest';
import { NoopReranker } from './noopReranker.js';
import type { Chunk } from './types.js';

function makeChunk(text: string, index: number): Chunk {
  return { text, headingPath: '', sourceUrl: 'https://x.com', index, tokenEstimate: 10 };
}

describe('NoopReranker', () => {
  const reranker = new NoopReranker();

  test('returns same number of chunks with score annotations', async () => {
    const chunks = [makeChunk('A', 0), makeChunk('B', 1), makeChunk('C', 2)];
    const scored = await reranker.rank('query', chunks);
    expect(scored).toHaveLength(3);
    expect(scored.every(c => typeof c.score === 'number')).toBe(true);
  });

  test('preserves original order (first chunk gets highest score)', async () => {
    const chunks = [makeChunk('First', 0), makeChunk('Second', 1)];
    const scored = await reranker.rank('q', chunks);
    expect(scored[0]!.score).toBeGreaterThanOrEqual(scored[1]!.score);
  });

  test('isReady returns true', () => {
    expect(reranker.isReady()).toBe(true);
  });

  test('warmup and close resolve without error', async () => {
    await expect(reranker.warmup()).resolves.toBeUndefined();
    await expect(reranker.close()).resolves.toBeUndefined();
  });
});
