import { describe, test, expect, beforeEach, vi } from 'vitest';
import { duckDuckGoSearch, parseSearchResults, filterResults, SearchResult } from './webSearch.js';
import { fetcher } from '../fetcher.js';
import { initializeConfig } from '../config.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetch: vi.fn() },
}));

// Initialize config before tests
beforeAll(() => {
  initializeConfig({
    FETCH_TIMEOUT_MS: '30000',
    MAX_CONCURRENT_FETCHES: '5',
    STABILIZATION_DELAY_MS: '2000',
    MAX_REDIRECTS: '10',
    MAX_CONTENT_LENGTH: '100000',
    LOG_LEVEL: 'INFO',
    LOG_FORMAT: 'text',
    CACHE_MAX_BYTES: '52428800',
    CACHE_TTL_MS: '900000',
    USE_ALLOWLIST_MODE: 'false',
    WEB_SEARCH_MAX_RESULTS: '10',
    WEB_SEARCH_DEFAULT_TIMEOUT_MS: '30000',
  });
});

describe('parseSearchResults', () => {
  // Helper to create mock DDG HTML with proper uddg redirect format
  const createMockDDGHtml = (results: Array<{ title: string; url: string; snippet: string }>) => {
    const html = results.map(
      (r) => `
      <div class="result__body">
        <p class="result__snippet">
          <a class="result__snippet" href="/l/?uddg=${encodeURIComponent(r.url)}">${r.snippet}</a>
        </p>
        <ul class="result__links">
          <li>
            <a class="result__a" href="/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>
          </li>
        </ul>
      </div>
    `
    ).join('\n');
    return `<!DOCTYPE html><html><head><title>Results</title></head><body><div id="web">${html}</div></body></html>`;
  };

  test('parses valid DuckDuckGo search results', () => {
    const html = createMockDDGHtml([
      { title: 'Example Title', url: 'https://example.com', snippet: 'Example snippet text' },
      { title: 'Other Title', url: 'https://other.com/other', snippet: 'Other snippet text' },
    ]);

    const results = parseSearchResults(html);

    expect(results.length).toBe(2);
    expect(results[0]).toEqual({
      title: 'Example Title',
      url: 'https://example.com',
      snippet: 'Example snippet text',
      domain: 'example.com',
    });
    expect(results[1]).toEqual({
      title: 'Other Title',
      url: 'https://other.com/other',
      snippet: 'Other snippet text',
      domain: 'other.com',
    });
  });

  test('handles results without snippets', () => {
    const html = createMockDDGHtml([
      { title: 'Title without snippet', url: 'https://example.com', snippet: '' },
    ]);

    const results = parseSearchResults(html);

    expect(results.length).toBe(1);
    expect(results[0]).toEqual({
      title: 'Title without snippet',
      url: 'https://example.com',
      snippet: '',
      domain: 'example.com',
    });
  });

  test('handles empty results', () => {
    const html = '<div>No results found</div>';
    const results = parseSearchResults(html);
    expect(results.length).toBe(0);
  });

  test('handles malformed HTML', () => {
    const html = '<div><a class="result__a">Unclosed tag</div>';
    const results = parseSearchResults(html);
    expect(results.length).toBe(0);
  });

  test('handles ampersand encoding in URLs', () => {
    const html = createMockDDGHtml([
      { title: 'Title', url: 'https://example.com/path?a=1&b=2', snippet: 'Snippet' },
    ]);

    const results = parseSearchResults(html);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.url).toBe('https://example.com/path?a=1&b=2');
  });
});

describe('filterResults', () => {
  const mockResults = [
    { title: 'A', url: 'https://example.com', snippet: '', domain: 'example.com' },
    { title: 'B', url: 'https://other.com', snippet: '', domain: 'other.com' },
    { title: 'C', url: 'https://sub.example.com', snippet: '', domain: 'sub.example.com' },
    { title: 'D', url: 'https://blocked.com', snippet: '', domain: 'blocked.com' },
  ];

  test('returns all results when no filters provided', () => {
    const results = filterResults(mockResults, undefined, undefined);
    expect(results.length).toBe(4);
  });

  test('filters by allowedDomains (exact match)', () => {
    const results = filterResults(mockResults, ['example.com'], undefined);
    // Includes example.com and sub.example.com (subdomain match)
    expect(results.length).toBe(2);
    expect(results.every((r: SearchResult) => r.domain === 'example.com' || r.domain === 'sub.example.com')).toBe(true);
  });

  test('filters by allowedDomains (subdomain match)', () => {
    const results = filterResults(mockResults, ['example.com'], undefined);
    expect(results.length).toBe(2); // example.com and sub.example.com
  });

  test('filters by blockedDomains', () => {
    const results = filterResults(mockResults, undefined, ['blocked.com']);
    expect(results.length).toBe(3);
    expect(results.some((r: SearchResult) => r.domain === 'blocked.com')).toBe(false);
  });

  test('filters by blockedDomains (subdomain match)', () => {
    const results = filterResults(mockResults, undefined, ['example.com']);
    expect(results.length).toBe(2); // other.com and blocked.com
    expect(results.some((r: SearchResult) => r.domain === 'example.com')).toBe(false);
    expect(results.some((r: SearchResult) => r.domain === 'sub.example.com')).toBe(false);
  });

  test('applies both allowed and blocked filters', () => {
    const results = filterResults(
      mockResults,
      ['example.com', 'blocked.com'],
      ['blocked.com']
    );
    expect(results.length).toBe(2); // example.com and sub.example.com
    expect(results.some((r: SearchResult) => r.domain === 'blocked.com')).toBe(false);
  });
});

describe('duckDuckGoSearch', () => {
  // Suppress stderr warnings during tests
  const stderrWrite = process.stderr.write;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    process.stderr.write = stderrWrite;
    vi.restoreAllMocks();
  });

  // Helper to create mock DDG HTML with proper uddg redirect format
  const createMockDDGHtml = (results: Array<{ title: string; url: string; snippet: string }>) => {
    const html = results.map(
      (r) => `
      <div class="result__body">
        <p class="result__snippet">
          <a class="result__snippet" href="/l/?uddg=${encodeURIComponent(r.url)}">${r.snippet}</a>
        </p>
        <ul class="result__links">
          <li>
            <a class="result__a" href="/l/?uddg=${encodeURIComponent(r.url)}">${r.title}</a>
          </li>
        </ul>
      </div>
    `
    ).join('\n');
    return `<!DOCTYPE html><html><head><title>Results</title></head><body><div id="web">${html}</div></body></html>`;
  };

  test('performs search and returns results', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Example', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    const mockPageHtml = '<html><body>Page content</body></html>';

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);
    vi.mocked(fetcher.fetch).mockResolvedValue(mockPageHtml);

    const result = await duckDuckGoSearch({ query: 'test query', maxResults: 10 }, mockFetchHtml);

    expect(result.query).toBe('test query');
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.title).toBe('Example');
    expect(result.results[0]?.url).toBe('https://example.com');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('respects maxResults limit', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
      { title: 'Result 3', url: 'https://example.com/3', snippet: 'Snippet 3' },
    ]);

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);

    const result = await duckDuckGoSearch({ query: 'test', maxResults: 2 }, mockFetchHtml);

    expect(result.results.length).toBe(2);
  });

  test('filters by allowedDomains', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);

    const result = await duckDuckGoSearch(
      { query: 'test', allowedDomains: ['allowed.com'] },
      mockFetchHtml
    );

    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });

  test('filters by blockedDomains', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);

    const result = await duckDuckGoSearch(
      { query: 'test', blockedDomains: ['blocked.com'] },
      mockFetchHtml
    );

    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });

  test('handles fetch errors gracefully', async () => {
    const mockFetchHtml = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await duckDuckGoSearch({ query: 'test' }, mockFetchHtml);

    expect(result.query).toBe('test');
    expect(result.results.length).toBe(0);
    expect(result.markdownResults).toBeDefined();
    expect(result.markdownResults?.[0]?.markdown).toContain('Network error');
  });

  test('fetches markdown results when fetchResults is true', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Example', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    const mockPageHtml = '<h1>Page Content</h1><p>More content</p>';

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);
    vi.mocked(fetcher.fetch).mockResolvedValue(mockPageHtml);

    const result = await duckDuckGoSearch(
      { query: 'test', fetchResults: true, maxResults: 1 },
      mockFetchHtml
    );

    expect(result.markdownResults).toBeDefined();
    expect(result.markdownResults?.length).toBe(1);
    expect(result.markdownResults?.[0]?.markdown).toContain('Page Content');
  });

  test('continues with other results if one fetch fails', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Result 1', url: 'https://example.com/1', snippet: '' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: '' },
    ]);
    const mockPageHtml = '<h1>Page Content</h1>';

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);
    vi.mocked(fetcher.fetch)
      .mockResolvedValueOnce(mockPageHtml)
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await duckDuckGoSearch(
      { query: 'test', fetchResults: true, maxResults: 2 },
      mockFetchHtml
    );

    expect(result.markdownResults).toBeDefined();
    expect(result.markdownResults?.length).toBe(2);
    expect(result.markdownResults?.[1]?.markdown).toContain('Error fetching');
  });

  test('includes fetched content in response', async () => {
    const mockSearchHtml = createMockDDGHtml([
      { title: 'Result', url: 'https://example.com', snippet: '' },
    ]);
    const mockPageHtml = '<h1>Test Content</h1>';

    const mockFetchHtml = vi.fn().mockResolvedValue(mockSearchHtml);
    vi.mocked(fetcher.fetch).mockResolvedValue(mockPageHtml);

    const result = await duckDuckGoSearch(
      { query: 'test', fetchResults: true, maxResults: 1 },
      mockFetchHtml
    );

    expect(result.markdownResults?.[0]?.markdown).toContain('Test Content');
  });
});
