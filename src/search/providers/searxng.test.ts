import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeConfig, resetConfig } from '../../config.js';
import { SearXNGProvider, parseSearXNGResponse } from './searxng.js';
import { BotChallengeError } from '../../utils/errors.js';
import type { HttpClient, HttpResponse } from '../../http/types.js';
import type { SearchProviderQuery } from '../types.js';

function mockClient(status: number, body: string): HttpClient {
  const res = {
    url: 'http://searxng:8080/search',
    status,
    headers: {},
    body: Buffer.from(body),
    charset: 'utf-8',
    redirectChain: [],
    attempts: 1,
    durationMs: 50,
    text: () => body,
  } satisfies HttpResponse;
  return { request: vi.fn().mockResolvedValue(res) } as unknown as HttpClient;
}

const Q: SearchProviderQuery = { query: 'test query', maxResults: 5 };
const OPTS = { signal: new AbortController().signal, requestId: 'r1' };

beforeEach(() => {
  resetConfig();
  initializeConfig({ SEARXNG_URL: 'http://searxng:8080' });
});
afterEach(() => resetConfig());

describe('parseSearXNGResponse', () => {
  test('maps results to ProviderResult', () => {
    const raw = {
      results: [
        { title: 'Alpha', url: 'https://alpha.com/', content: 'Alpha snippet' },
        { title: 'Beta', url: 'https://beta.io/page', content: 'Beta snippet' },
      ],
    };
    const results = parseSearXNGResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Alpha', url: 'https://alpha.com/', snippet: 'Alpha snippet', provider: 'searxng', rank: 1,
    });
    expect(results[1]!.rank).toBe(2);
  });

  test('filters out entries without a URL', () => {
    expect(parseSearXNGResponse({ results: [{ title: 'No URL' }] })).toHaveLength(0);
  });

  test('returns empty array for missing results', () => {
    expect(parseSearXNGResponse({})).toHaveLength(0);
  });
});

describe('SearXNGProvider — error handling', () => {
  // RED: currently throws SyntaxError — bare JSON.parse on HTML body
  test('HTML response body throws BotChallengeError', async () => {
    const provider = new SearXNGProvider(mockClient(200, '<html><body>Rate limited</body></html>'));
    await expect(provider.search(Q, OPTS)).rejects.toBeInstanceOf(BotChallengeError);
  });

  test('429 status throws BotChallengeError', async () => {
    const provider = new SearXNGProvider(mockClient(429, '<html>Too Many Requests</html>'));
    await expect(provider.search(Q, OPTS)).rejects.toBeInstanceOf(BotChallengeError);
  });

  test('403 status throws BotChallengeError', async () => {
    const provider = new SearXNGProvider(mockClient(403, '<html>Forbidden</html>'));
    await expect(provider.search(Q, OPTS)).rejects.toBeInstanceOf(BotChallengeError);
  });
});

describe('SearXNGProvider — query parameters', () => {
  test('sends language param when query includes language', async () => {
    const client = mockClient(200, JSON.stringify({ results: [] }));
    const provider = new SearXNGProvider(client);
    await provider.search({ ...Q, language: 'en' }, OPTS);
    const url = (client.request as ReturnType<typeof vi.fn>).mock.calls[0][0].url as string;
    // RED: currently only q, format, pageno are sent
    expect(url).toContain('language=en');
  });

  test('sends time_range param from freshness field', async () => {
    const client = mockClient(200, JSON.stringify({ results: [] }));
    const provider = new SearXNGProvider(client);
    await provider.search({ ...Q, freshness: 'week' }, OPTS);
    const url = (client.request as ReturnType<typeof vi.fn>).mock.calls[0][0].url as string;
    // RED: freshness is not mapped to time_range currently
    expect(url).toContain('time_range=week');
  });

  test('does not send time_range when freshness is absent', async () => {
    const client = mockClient(200, JSON.stringify({ results: [] }));
    const provider = new SearXNGProvider(client);
    await provider.search(Q, OPTS);
    const url = (client.request as ReturnType<typeof vi.fn>).mock.calls[0][0].url as string;
    expect(url).not.toContain('time_range');
  });

  test('successful JSON response returns parsed results', async () => {
    const body = JSON.stringify({
      results: [{ title: 'T', url: 'https://example.com', content: 'S' }],
    });
    const provider = new SearXNGProvider(mockClient(200, body));
    const results = await provider.search(Q, OPTS);
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.com');
  });
});
