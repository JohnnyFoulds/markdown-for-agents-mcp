import { describe, test, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { duckDuckGoSearch, parseSearchResults, filterResults, SearchResult } from './webSearch.js';
import { FakeHttpClient } from '../http/testing.js';
import { fetcher } from '../fetcher.js';
import { initializeConfig } from '../config.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetch: vi.fn(), fetchMultiple: vi.fn() },
}));

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
  });
});

const createMockDDGResponse = (urls: Array<{ title: string; url: string; snippet: string }>): string => {
  const results = urls.map((item) => `
    <div class="result__body">
      <p class="result__snippet">
        <a class="result__snippet" href="/l/?uddg=${encodeURIComponent(item.url)}">${item.snippet}</a>
      </p>
      <ul class="result__links">
        <li>
          <a class="result__a" href="/l/?uddg=${encodeURIComponent(item.url)}">${item.title}</a>
        </li>
      </ul>
    </div>
  `).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>test</title></head><body><div id="web">${results}</div></body></html>`;
};

function htmlClient(html: string): FakeHttpClient {
  const padded = html.length >= 2100 ? html : html.replace('</body>', `<!-- ${'x'.repeat(2100)} --></body>`);
  return new FakeHttpClient().onDefault({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: padded,
  });
}

describe('parseSearchResults - Real DDG HTML Structure', () => {
  test('parses valid DuckDuckGo HTML with uddg redirect links', () => {
    const html = createMockDDGResponse([
      { title: 'Example Title', url: 'https://example.com', snippet: 'Example snippet text here' },
      { title: 'Other Result', url: 'https://other.com/path?query=1', snippet: 'Another snippet' },
    ]);
    const results = parseSearchResults(html);
    expect(results.length).toBe(2);
    expect(results[0]).toEqual({ title: 'Example Title', url: 'https://example.com', snippet: 'Example snippet text here', domain: 'example.com' });
    expect(results[1]?.url).toBe('https://other.com/path?query=1');
  });

  test('handles ampersand encoding in uddg URLs', () => {
    const html = createMockDDGResponse([{ title: 'Test', url: 'https://example.com/path?a=1&b=2&c=3', snippet: 'Snippet' }]);
    const results = parseSearchResults(html);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.url).toContain('a=1');
    expect(results[0]?.url).toContain('b=2');
  });

  test('handles results without snippets', () => {
    const html = createMockDDGResponse([{ title: 'Title Only', url: 'https://example.com', snippet: '' }]);
    const results = parseSearchResults(html);
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe('Title Only');
  });

  test('handles empty results', () => {
    const html = `<!DOCTYPE html><html><body><div class="web--no-results"><h2>No results found.</h2></div></body></html>`;
    expect(parseSearchResults(html).length).toBe(0);
  });

  test('handles malformed HTML gracefully', () => {
    const html = '<div><ul class="result__links"><li><a class="result__a" href="/l/?uddg=invalid';
    expect(parseSearchResults(html).length).toBe(0);
  });

  test('handles ampersand in URL correctly', () => {
    const html = createMockDDGResponse([{ title: 'Query Test', url: 'https://example.com/search?q=hello+world&type=foo', snippet: 'Test snippet' }]);
    const results = parseSearchResults(html);
    expect(results.length).toBe(1);
    expect(results[0]?.url).toBe('https://example.com/search?q=hello+world&type=foo');
  });
});

describe('filterResults', () => {
  const mockResults: SearchResult[] = [
    { title: 'A', url: 'https://example.com', snippet: '', domain: 'example.com' },
    { title: 'B', url: 'https://other.com', snippet: '', domain: 'other.com' },
    { title: 'C', url: 'https://sub.example.com', snippet: '', domain: 'sub.example.com' },
    { title: 'D', url: 'https://blocked.com', snippet: '', domain: 'blocked.com' },
  ];

  test('returns all results when no filters provided', () => {
    expect(filterResults(mockResults, undefined, undefined).length).toBe(4);
  });

  test('filters by allowedDomains (exact match)', () => {
    const results = filterResults(mockResults, ['example.com'], undefined);
    expect(results.length).toBe(2);
    expect(results.every(r => r.domain === 'example.com' || r.domain === 'sub.example.com')).toBe(true);
  });

  test('filters by blockedDomains', () => {
    const results = filterResults(mockResults, undefined, ['blocked.com']);
    expect(results.length).toBe(3);
    expect(results.some(r => r.domain === 'blocked.com')).toBe(false);
  });
});

describe('duckDuckGoSearch Integration', () => {
  const stderrWrite = process.stderr.write;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(fetcher.fetchMultiple).mockResolvedValue([
      { url: 'https://example.com', success: true, markdown: '<html><body>content</body></html>', requestId: 'r1' },
    ]);
  });
  afterEach(() => {
    process.stderr.write = stderrWrite;
    vi.restoreAllMocks();
  });

  const mockDDGHtml = createMockDDGResponse([
    { title: 'Test Result', url: 'https://example.com', snippet: 'Test snippet' },
  ]);

  test('handles fetch errors gracefully', async () => {
    const client = new FakeHttpClient().onDefault({ status: 0, error: new Error('Network timeout') });
    const result = await duckDuckGoSearch({ query: 'test', maxResults: 0 }, client);
    expect(result.results.length).toBe(0);
    expect(result.markdownResults?.[0]?.markdown).toContain('Network timeout');
  });

  test('fetchResults mode works with mocked fetcher', async () => {
    const result = await duckDuckGoSearch(
      { query: 'test', maxResults: 1, fetchResults: true },
      htmlClient(mockDDGHtml),
    );
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.title).toBe('Test Result');
    expect(fetcher.fetchMultiple).toHaveBeenCalledWith(['https://example.com'], expect.any(Number));
    expect(result.markdownResults?.length).toBe(1);
  });

  test('respects maxResults limit', async () => {
    const html = createMockDDGResponse([
      { title: '1', url: 'https://example.com/1', snippet: '' },
      { title: '2', url: 'https://example.com/2', snippet: '' },
      { title: '3', url: 'https://example.com/3', snippet: '' },
      { title: '4', url: 'https://example.com/4', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', maxResults: 2 }, htmlClient(html));
    expect(result.results.length).toBe(2);
  });

  test('filters by allowedDomains', async () => {
    const html = createMockDDGResponse([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', allowedDomains: ['allowed.com'], maxResults: 2 }, htmlClient(html));
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });

  test('filters by blockedDomains', async () => {
    const html = createMockDDGResponse([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', blockedDomains: ['blocked.com'], maxResults: 2 }, htmlClient(html));
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });
});
