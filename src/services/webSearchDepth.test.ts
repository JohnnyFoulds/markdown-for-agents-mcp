import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';

vi.mock('../search/fanout.js', () => ({
  fanout: vi.fn(),
}));

vi.mock('../fetcher.js', () => ({
  fetcher: { fetchMultiple: vi.fn(), fetch: vi.fn() },
}));

vi.mock('../rank/index.js', () => ({
  getReranker: vi.fn(),
  chunkMarkdown: vi.fn().mockReturnValue([]),
}));

vi.mock('../obs/metrics.js', () => ({
  rerankDurationSeconds: { startTimer: vi.fn(() => vi.fn()) },
}));

vi.mock('../extract/pipeline.js', () => ({
  extract: vi.fn().mockReturnValue({
    markdown: '# content',
    title: 'title',
    contentSize: 100,
  }),
}));

import { webSearch } from './webSearch.js';
import { fanout } from '../search/fanout.js';
import { fetcher } from '../fetcher.js';
import { getReranker } from '../rank/index.js';
import { initializeConfig } from '../config.js';

const FAKE_RESULTS = [
  { title: 'R1', url: 'https://a.com', snippet: 'S1', domain: 'a.com' },
  { title: 'R2', url: 'https://b.com', snippet: 'S2', domain: 'b.com' },
];

const noopReranker = { isReady: () => false, rank: vi.fn(), warmup: vi.fn(), close: vi.fn(), name: 'noop' };

beforeAll(() => {
  initializeConfig({
    FETCH_TIMEOUT_MS: '30000',
    MAX_CONCURRENT_FETCHES: '5',
    MAX_REDIRECTS: '10',
    MAX_CONTENT_LENGTH: '100000',
    LOG_LEVEL: 'INFO',
    LOG_FORMAT: 'text',
    CACHE_MAX_BYTES: '52428800',
    CACHE_TTL_MS: '900000',
    USE_ALLOWLIST_MODE: 'false',
    WEB_SEARCH_DEFAULT_TIMEOUT_MS: '30000',
    SEARCH_FANOUT_RESULTS: '20',
    RERANK_BACKEND: 'none',
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fanout).mockResolvedValue(FAKE_RESULTS);
  vi.mocked(getReranker).mockReturnValue(noopReranker);
  vi.mocked(fetcher.fetchMultiple).mockResolvedValue([]);
});

describe('webSearch fetch-depth behavior (Phase 2 fix)', () => {
  // RED today: default searchDepth is 'basic', which sets shouldFetch=true and calls fetchMultiple
  it('default (no searchDepth arg) performs zero fetches', async () => {
    await webSearch({ query: 'test' });
    expect(fetcher.fetchMultiple).not.toHaveBeenCalled();
  });

  // RED today: shouldFetch = fetchResults || searchDepth==='basic' — fetchResults:false is ignored
  it('fetchResults: false at basic depth suppresses fetching', async () => {
    await webSearch({ query: 'test', searchDepth: 'basic', fetchResults: false });
    expect(fetcher.fetchMultiple).not.toHaveBeenCalled();
  });

  // GREEN today (passes even before fix): explicit fast never fetches
  it('explicit searchDepth: fast performs zero fetches', async () => {
    await webSearch({ query: 'test', searchDepth: 'fast' });
    expect(fetcher.fetchMultiple).not.toHaveBeenCalled();
  });

  // GREEN today: explicit basic fetches (desired behaviour)
  it('searchDepth: basic fetches results', async () => {
    await webSearch({ query: 'test', searchDepth: 'basic' });
    expect(fetcher.fetchMultiple).toHaveBeenCalled();
  });

  // GREEN today: fetchResults:true forces fetching even at fast
  it('fetchResults: true at fast depth forces fetching', async () => {
    await webSearch({ query: 'test', searchDepth: 'fast', fetchResults: true });
    expect(fetcher.fetchMultiple).toHaveBeenCalled();
  });
});
