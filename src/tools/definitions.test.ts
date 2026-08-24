import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./webSearch.js', () => ({
  webSearch: vi.fn().mockResolvedValue({ query: '', results: [], durationMs: 0 }),
}));

vi.mock('../crawl/engine.js', () => ({
  crawlSync: vi.fn(),
  startAsyncCrawl: vi.fn(),
}));

vi.mock('../services/mapSite.js', () => ({
  mapSite: vi.fn(),
}));

import { TOOLS } from './definitions.js';
import { webSearch } from './webSearch.js';

const wst = TOOLS.find(t => t.name === 'web_search')!;

describe('web_search tool — Phase 2 schema activation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // RED today: key absent from inputSchema
  it('inputSchema has searchDepth key', () => {
    expect(wst.inputSchema).toHaveProperty('searchDepth');
  });

  // RED today: key absent from inputSchema
  it('inputSchema has chunksPerSource key', () => {
    expect(wst.inputSchema).toHaveProperty('chunksPerSource');
  });

  // RED today: handler drops searchDepth before calling webSearch
  it('handler passes searchDepth to webSearch', async () => {
    await (wst.handler as (a: Record<string, unknown>) => Promise<unknown>)({
      query: 'test query',
      searchDepth: 'advanced',
    });
    expect(webSearch).toHaveBeenCalledWith(
      expect.objectContaining({ searchDepth: 'advanced' }),
    );
  });

  // RED today: handler drops chunksPerSource before calling webSearch
  it('handler passes chunksPerSource to webSearch', async () => {
    await (wst.handler as (a: Record<string, unknown>) => Promise<unknown>)({
      query: 'test query',
      chunksPerSource: 3,
    });
    expect(webSearch).toHaveBeenCalledWith(
      expect.objectContaining({ chunksPerSource: 3 }),
    );
  });

  // RED today: description still says "DuckDuckGo" — single provider claim
  it('description does not claim a single provider', () => {
    expect(wst.description).not.toContain('using DuckDuckGo');
  });
});
