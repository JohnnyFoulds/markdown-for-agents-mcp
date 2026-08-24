export interface Chunk {
  text: string;
  headingPath: string;
  sourceUrl: string;
  index: number;
  tokenEstimate: number;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface Reranker {
  readonly name: string;
  readonly maxSequenceTokens: number;
  rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]>;
  warmup(): Promise<void>;
  isReady(): boolean;
  close(): Promise<void>;
}
