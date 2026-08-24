import type { Chunk, ScoredChunk, Reranker } from './types.js';

export class NoopReranker implements Reranker {
  readonly name = 'noop';
  readonly maxSequenceTokens = 512;

  rank(_query: string, chunks: Chunk[], _opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]> {
    return Promise.resolve(
      chunks.map((c, i) => ({ ...c, score: 1 - i * 0.001 })),
    );
  }

  warmup(): Promise<void> { return Promise.resolve(); }
  isReady(): boolean { return true; }
  close(): Promise<void> { return Promise.resolve(); }
}

export const noopReranker = new NoopReranker();
