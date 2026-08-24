import { getConfig } from '../config.js';
import { httpClient as defaultHttpClient } from '../http/client.js';
import type { HttpClient } from '../http/types.js';
import { Logger } from '../utils/logger.js';
import { NoopReranker } from './noopReranker.js';
import type { Chunk, ScoredChunk, Reranker } from './types.js';

interface TeiRankResponse {
  index: number;
  score: number;
}

export class TeiReranker implements Reranker {
  readonly name = 'tei';
  readonly maxSequenceTokens = 512;

  private healthy = false;
  private readonly fallback = new NoopReranker();

  constructor(private readonly client: HttpClient = defaultHttpClient) {}

  private cfg() {
    try { return getConfig(); } catch { return { RERANK_TEI_URL: undefined as string | undefined }; }
  }

  isConfigured(): boolean {
    return !!this.cfg().RERANK_TEI_URL;
  }

  async warmup(): Promise<void> {
    const url = this.cfg().RERANK_TEI_URL;
    if (!url) return;
    try {
      await this.client.request({ url: `${url}/health`, purpose: 'api', timeoutMs: 5000 });
      this.healthy = true;
    } catch {
      Logger.warn('[TeiReranker] Health check failed — falling back to noop');
    }
  }

  isReady(): boolean { return this.healthy; }

  async rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]> {
    const url = this.cfg().RERANK_TEI_URL;
    if (!url || !this.healthy) {
      return this.fallback.rank(query, chunks, opts);
    }

    try {
      const res = await this.client.request({
        url: `${url}/rerank`,
        method: 'POST',
        purpose: 'api',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          texts: chunks.map(c => c.text),
          truncate: true,
        }),
        timeoutMs: 30_000,
      });

      const raw: TeiRankResponse[] = JSON.parse(res.text());
      const scored: ScoredChunk[] = raw.map(r => ({ ...chunks[r.index]!, score: r.score }));
      return scored.sort((a, b) => b.score - a.score);
    } catch (err) {
      Logger.warn(`[TeiReranker] Request failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.fallback.rank(query, chunks, opts);
    }
  }

  async close(): Promise<void> {
    this.healthy = false;
  }
}

export const teiReranker = new TeiReranker();
