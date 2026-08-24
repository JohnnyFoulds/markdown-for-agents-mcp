import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getConfig } from '../config.js';
import { Logger } from '../utils/logger.js';
import { NoopReranker } from './noopReranker.js';
import type { Chunk, ScoredChunk, Reranker } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PendingRequest {
  resolve: (scores: number[]) => void;
  reject: (err: Error) => void;
}

export class TransformersReranker implements Reranker {
  readonly name = 'transformers';
  readonly maxSequenceTokens = 512;

  private worker: Worker | null = null;
  private ready = false;
  private failed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly fallback = new NoopReranker();

  private cfg() {
    try { return getConfig(); } catch {
      return { RERANK_MODEL: 'Xenova/bge-reranker-base', RERANK_DTYPE: 'q8', RERANK_DEVICE: 'cpu' };
    }
  }

  async warmup(): Promise<void> {
    if (this.worker || this.failed) return;
    const config = this.cfg();

    try {
      // Probe the optional dep before launching a worker
      // @ts-expect-error optional dependency — not declared in devDependencies
      await import('@huggingface/transformers').catch(() => { throw new Error('not installed'); });

      this.worker = new Worker(
        join(__dirname, 'rerankWorker.js'),
        {
          workerData: {
            modelName: config.RERANK_MODEL,
            dtype: config.RERANK_DTYPE,
            device: config.RERANK_DEVICE,
          },
        },
      );

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker warmup timeout')), 120_000);

        this.worker!.on('message', (msg: { type?: string; id?: number; scores?: number[]; error?: string }) => {
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            this.ready = true;
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error));
          } else if (msg.id !== undefined) {
            const req = this.pending.get(msg.id);
            if (!req) return;
            this.pending.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(msg.error));
            } else {
              req.resolve(msg.scores ?? []);
            }
          }
        });

        this.worker!.on('error', err => {
          clearTimeout(timeout);
          this.ready = false;
          this.failed = true;
          const e = err instanceof Error ? err : new Error(String(err));
          for (const p of this.pending.values()) p.reject(e);
          this.pending.clear();
          reject(e);
        });

        this.worker!.on('exit', () => {
          this.ready = false;
          for (const p of this.pending.values()) p.reject(new Error('Worker exited'));
          this.pending.clear();
        });
      });
    } catch (err) {
      Logger.warn(`[TransformersReranker] Falling back to noop: ${err instanceof Error ? err.message : String(err)}`);
      this.worker = null;
      this.failed = true;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]> {
    if (!this.ready || this.failed) {
      return this.fallback.rank(query, chunks, opts);
    }

    const id = this.nextId++;
    const passages = chunks.map(c => c.text);

    const scores = await new Promise<number[]>((resolve, reject) => {
      if (opts?.signal?.aborted) return reject(new Error('Aborted'));

      const abortHandler = () => {
        this.pending.delete(id);
        reject(new Error('Aborted'));
      };

      opts?.signal?.addEventListener('abort', abortHandler, { once: true });

      this.pending.set(id, {
        resolve: (s) => {
          opts?.signal?.removeEventListener('abort', abortHandler);
          resolve(s);
        },
        reject: (e) => {
          opts?.signal?.removeEventListener('abort', abortHandler);
          reject(e);
        },
      });

      this.worker!.postMessage({ id, query, passages });
    });

    const scored: ScoredChunk[] = chunks.map((c, i) => ({
      ...c,
      score: scores[i] ?? 0,
    }));

    return scored.sort((a, b) => b.score - a.score);
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}

export const transformersReranker = new TransformersReranker();
