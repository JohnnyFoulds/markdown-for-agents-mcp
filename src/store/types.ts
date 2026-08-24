export interface KeyValueStore {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic set-if-not-exists. Returns true if the key was set (i.e. did not exist). */
  setNx(key: string, value: Buffer, ttlMs: number): Promise<boolean>;
  stats(): Promise<{ backend: string; entries?: number; bytes?: number }>;
  close(): Promise<void>;
}

export interface RateLimitStore {
  /**
   * Atomic token-bucket take for the given key at the given rps/burst.
   * Returns the number of milliseconds the caller should wait before proceeding (0 = proceed now).
   */
  take(key: string, rps: number, burst: number, now: number): Promise<number>;
  close(): Promise<void>;
}

// ── Job queue types ───────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
export type PageStatus = 'pending' | 'completed' | 'failed';

export interface JobSpec {
  rootUrl: string;
  maxPages: number;
  maxDepth: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  includeSelector?: string;
  excludeSelectors?: string[];
  outputFormat?: 'markdown' | 'html' | 'text';
  query?: string;
  relevanceThreshold?: number;
  timeout?: number;
}

export interface QueueItem {
  url: string;
  depth: number;
  parentUrl?: string;
}

export interface LeasedItem extends QueueItem {
  jobId: string;
  leaseId: string;
  leaseExpiresAt: number;
}

export interface PageRecord {
  url: string;
  jobId: string;
  status: PageStatus;
  title?: string;
  content?: string;
  contentFormat?: string;
  contentSize?: number;
  depth: number;
  error?: string;
  crawledAt?: number;
}

export interface JobSummary {
  id: string;
  rootUrl: string;
  status: JobStatus;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobLease {
  jobId: string;
  workerId: string;
}

export interface JobQueue {
  createJob(spec: JobSpec): Promise<string>;
  enqueue(jobId: string, items: QueueItem[]): Promise<number>;
  lease(jobId: string, n: number, leaseMs: number): Promise<LeasedItem[]>;
  heartbeat(items: LeasedItem[], leaseMs: number): Promise<void>;
  complete(item: LeasedItem, record: PageRecord): Promise<void>;
  fail(item: LeasedItem, error: string, retryable: boolean): Promise<void>;
  claimJob(workerId: string, leaseMs: number): Promise<JobLease | undefined>;
  status(jobId: string): Promise<JobSummary | undefined>;
  results(jobId: string, offset: number, limit: number, filter?: PageStatus | 'all'): Promise<PageRecord[]>;
  cancel(jobId: string): Promise<void>;
  list(): Promise<JobSummary[]>;
  close(): Promise<void>;
}

export interface Stores {
  kv: KeyValueStore;
  rateLimit: RateLimitStore;
  queue: JobQueue;
}
