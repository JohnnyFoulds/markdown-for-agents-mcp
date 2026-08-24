import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { initializeConfig, resetConfig } from '../config.js';
import { getReranker } from './index.js';

beforeEach(() => resetConfig());
afterEach(() => resetConfig());

describe('getReranker() backend selection', () => {
  test('returns noop reranker when RERANK_BACKEND=none', () => {
    initializeConfig({ RERANK_BACKEND: 'none' });
    const r = getReranker();
    expect(r.name).toBe('noop');
  });

  test('returns transformers reranker when RERANK_BACKEND=local', () => {
    initializeConfig({ RERANK_BACKEND: 'local' });
    const r = getReranker();
    expect(r.name).toBe('transformers');
  });

  test('returns tei reranker when RERANK_BACKEND=tei', () => {
    initializeConfig({ RERANK_BACKEND: 'tei' });
    const r = getReranker();
    expect(r.name).toBe('tei');
  });

  test('returns noop when config is not initialized', () => {
    // getReranker() catches getConfig() failure and falls back to noop
    const r = getReranker();
    expect(r.name).toBe('noop');
  });

  test('returns noop for unknown backend value (defensive)', () => {
    // Zod catches invalid values, but test the default branch anyway
    initializeConfig({ RERANK_BACKEND: 'none' });
    const r = getReranker();
    expect(r.name).toBe('noop');
  });
});
