import { getConfig } from '../config.js';
import { noopReranker } from './noopReranker.js';
import { teiReranker } from './teiReranker.js';
import { transformersReranker } from './transformersReranker.js';
import type { Reranker } from './types.js';

export function getReranker(): Reranker {
  try {
    const config = getConfig();
    switch (config.RERANK_BACKEND) {
      case 'tei': return teiReranker;
      case 'local': return transformersReranker;
      case 'none': return noopReranker;
      default: return noopReranker;
    }
  } catch {
    return noopReranker;
  }
}

export { chunkMarkdown } from './chunker.js';
export type { Chunk, ScoredChunk, Reranker } from './types.js';
