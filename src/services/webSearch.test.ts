import { describe, test, expect, beforeEach, vi, afterEach, beforeAll } from 'vitest';
import { duckDuckGoSearch, parseSearchResults, filterResults, SearchResult } from './webSearch.js';
import { FakeHttpClient } from '../http/testing.js';
import { fetcher } from '../fetcher.js';
import { initializeConfig, resetConfig } from '../config.js';

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

const createMockDDGHtml = (results: Array<{ title: string; url: string; snippet: string }>) => {
  const body = results.map(
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
  return `<!DOCTYPE html><html><head><title>Results</title></head><body><div id="web">${body}</div></body></html>`;
};

function htmlClient(html: string): FakeHttpClient {
  // Pad HTML to exceed the 2000-char bot-challenge length threshold
  const padded = html.length >= 2100 ? html : html.replace('</body>', `<!-- ${'x'.repeat(2100)} --></body>`);
  return new FakeHttpClient().onDefault({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: padded,
  });
}

describe('parseSearchResults', () => {
  test('parses valid DuckDuckGo search results', () => {
    const html = createMockDDGHtml([
      { title: 'Example Title', url: 'https://example.com', snippet: 'Example snippet text' },
      { title: 'Other Title', url: 'https://other.com/other', snippet: 'Other snippet text' },
    ]);
    const results = parseSearchResults(html);
    expect(results.length).toBe(2);
    expect(results[0]).toEqual({ title: 'Example Title', url: 'https://example.com', snippet: 'Example snippet text', domain: 'example.com' });
  });

  test('handles results without snippets', () => {
    const html = createMockDDGHtml([{ title: 'Title without snippet', url: 'https://example.com', snippet: '' }]);
    const results = parseSearchResults(html);
    expect(results.length).toBe(1);
    expect(results[0]?.snippet).toBe('');
  });

  test('handles empty results', () => {
    expect(parseSearchResults('<div>No results found</div>').length).toBe(0);
  });

  test('handles malformed HTML', () => {
    expect(parseSearchResults('<div><a class="result__a">Unclosed tag</div>').length).toBe(0);
  });

  test('handles ampersand encoding in URLs', () => {
    const html = createMockDDGHtml([{ title: 'Title', url: 'https://example.com/path?a=1&b=2', snippet: 'Snippet' }]);
    const results = parseSearchResults(html);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.url).toBe('https://example.com/path?a=1&b=2');
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

  test('filters by allowedDomains (includes subdomain match)', () => {
    const results = filterResults(mockResults, ['example.com'], undefined);
    expect(results.length).toBe(2);
    expect(results.some(r => r.domain === 'blocked.com')).toBe(false);
  });

  test('filters by blockedDomains', () => {
    const results = filterResults(mockResults, undefined, ['blocked.com']);
    expect(results.length).toBe(3);
    expect(results.some(r => r.domain === 'blocked.com')).toBe(false);
  });

  test('applies both allow and block lists', () => {
    const results = filterResults(mockResults, ['example.com', 'blocked.com'], ['blocked.com']);
    expect(results.length).toBe(2);
    expect(results.some(r => r.domain === 'blocked.com')).toBe(false);
  });
});

describe('duckDuckGoSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  test('performs search and returns results', async () => {
    const html = createMockDDGHtml([{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }]);
    const result = await duckDuckGoSearch({ query: 'test query', maxResults: 10 }, htmlClient(html));
    expect(result.query).toBe('test query');
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.title).toBe('Example');
    expect(result.results[0]?.url).toBe('https://example.com');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('respects maxResults limit', async () => {
    const html = createMockDDGHtml([
      { title: 'R1', url: 'https://example.com/1', snippet: '' },
      { title: 'R2', url: 'https://example.com/2', snippet: '' },
      { title: 'R3', url: 'https://example.com/3', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', maxResults: 2 }, htmlClient(html));
    expect(result.results.length).toBe(2);
  });

  test('filters by allowedDomains', async () => {
    const html = createMockDDGHtml([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', allowedDomains: ['allowed.com'] }, htmlClient(html));
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });

  test('filters by blockedDomains', async () => {
    const html = createMockDDGHtml([
      { title: 'Allowed', url: 'https://allowed.com', snippet: '' },
      { title: 'Blocked', url: 'https://blocked.com', snippet: '' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', blockedDomains: ['blocked.com'] }, htmlClient(html));
    expect(result.results.length).toBe(1);
    expect(result.results[0]?.domain).toBe('allowed.com');
  });

  test('handles fetch errors gracefully', async () => {
    const client = new FakeHttpClient().onDefault({ status: 0, error: new Error('Network error') });
    const result = await duckDuckGoSearch({ query: 'test' }, client);
    expect(result.query).toBe('test');
    expect(result.results.length).toBe(0);
    expect(result.markdownResults?.[0]?.markdown).toContain('Network error');
  });

  test('fetches markdown results when fetchResults is true', async () => {
    const html = createMockDDGHtml([{ title: 'Example', url: 'https://example.com', snippet: 'Snippet' }]);
    vi.mocked(fetcher.fetchMultiple).mockResolvedValue([
      { url: 'https://example.com', success: true, markdown: '<h1>Page Content</h1>', requestId: 'r1' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', fetchResults: true, maxResults: 1 }, htmlClient(html));
    expect(result.markdownResults?.length).toBe(1);
    expect(result.markdownResults?.[0]?.markdown).toContain('Page Content');
  });

  test('continues with other results if one fetch fails', async () => {
    const html = createMockDDGHtml([
      { title: 'R1', url: 'https://example.com/1', snippet: '' },
      { title: 'R2', url: 'https://example.com/2', snippet: '' },
    ]);
    vi.mocked(fetcher.fetchMultiple).mockResolvedValue([
      { url: 'https://example.com/1', success: true, markdown: '<h1>Content</h1>', requestId: 'r1' },
      { url: 'https://example.com/2', success: false, markdown: '', error: 'Network error', requestId: 'r2' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', fetchResults: true, maxResults: 2 }, htmlClient(html));
    expect(result.markdownResults?.length).toBe(2);
    expect(result.markdownResults?.[1]?.markdown).toContain('Error fetching');
  });

  test('includes fetched content in response', async () => {
    const html = createMockDDGHtml([{ title: 'R', url: 'https://example.com', snippet: '' }]);
    vi.mocked(fetcher.fetchMultiple).mockResolvedValue([
      { url: 'https://example.com', success: true, markdown: '<h1>Test Content</h1>', requestId: 'r1' },
    ]);
    const result = await duckDuckGoSearch({ query: 'test', fetchResults: true, maxResults: 1 }, htmlClient(html));
    expect(result.markdownResults?.[0]?.markdown).toContain('Test Content');
  });

  test('bot-challenge page results in error response (short HTML)', async () => {
    // Inject a short HTML response directly (bypass htmlClient padding)
    const shortHtml = '<html><body>Short</body></html>';
    const client = new FakeHttpClient().onDefault({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: shortHtml,
    });
    const result = await duckDuckGoSearch({ query: 'test' }, client);
    expect(result.results.length).toBe(0);
    expect(result.markdownResults?.[0]?.markdown).toContain('Search Error');
  });

  test('bot-challenge page results in error response (anomaly-modal)', async () => {
    const challengeHtml = '<html><body>' + 'x'.repeat(3000) + '<div class="anomaly-modal">challenge</div></body></html>';
    const client = new FakeHttpClient().onDefault({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: challengeHtml,
    });
    const result = await duckDuckGoSearch({ query: 'test' }, client);
    expect(result.results.length).toBe(0);
    expect(result.markdownResults?.[0]?.markdown).toContain('Search Error');
  });
});
