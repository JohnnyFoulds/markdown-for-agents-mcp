// Tests the RERANK_BACKEND=local fail-loudly contract WITHOUT mocking
// @huggingface/transformers — the package is genuinely absent from package.json,
// so the import probe in warmup() fails with 'not installed'.
//
// RED today: TransformersReranker.warmup() silently catches that error and resolves
//            (sets failed=true, falls back to noop), even when RERANK_BACKEND=local
//            was explicitly set — meaning a broken deployment is invisible.
// GREEN after fix: warmup() re-throws when RERANK_BACKEND=local and the probe fails.

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { initializeConfig, resetConfig } from '../config.js';

vi.mock('worker_threads', () => ({
  Worker: vi.fn(),
  workerData: {},
  parentPort: null,
  isMainThread: false,
}));

// Do NOT mock @huggingface/transformers — it is not installed, so the probe fails naturally

import { TransformersReranker } from './transformersReranker.js';

describe('TransformersReranker — fail loudly when RERANK_BACKEND=local (Phase 2 fix)', () => {
  beforeEach(() => {
    resetConfig();
  });

  // RED today: warmup() resolves (noops) when RERANK_BACKEND=local and dep is absent
  it('warmup() rejects when RERANK_BACKEND=local and @huggingface/transformers is absent', async () => {
    initializeConfig({
      RERANK_BACKEND: 'local',
      RERANK_MODEL: 'Xenova/bge-reranker-base',
      RERANK_DTYPE: 'q8',
      RERANK_DEVICE: 'cpu',
    });
    const r = new TransformersReranker();
    await expect(r.warmup()).rejects.toThrow();
  });

  // GREEN today: warmup() silently resolves when RERANK_BACKEND=none (the default)
  it('warmup() resolves silently when RERANK_BACKEND=none and dep is absent', async () => {
    initializeConfig({
      RERANK_BACKEND: 'none',
      RERANK_MODEL: 'Xenova/bge-reranker-base',
      RERANK_DTYPE: 'q8',
      RERANK_DEVICE: 'cpu',
    });
    const r = new TransformersReranker();
    await expect(r.warmup()).resolves.toBeUndefined();
    expect(r.isReady()).toBe(false);
  });
});
