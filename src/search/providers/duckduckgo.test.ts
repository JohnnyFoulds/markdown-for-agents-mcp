import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseDuckDuckGoHtml, DuckDuckGoProvider } from './duckduckgo.js';
import { FakeHttpClient } from '../../http/testing.js';
import { BotChallengeError } from '../../utils/errors.js';
import { initializeConfig } from '../../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

initializeConfig({ WEB_SEARCH_DEFAULT_TIMEOUT_MS: '30000' });

const fixture = readFileSync(join(__dirname, '../__fixtures__/ddg-results.html'), 'utf8');

describe('parseDuckDuckGoHtml', () => {
  test('parses 3 results from fixture', () => {
    const results = parseDuckDuckGoHtml(fixture);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      title: 'Example Page One',
      url: 'https://example.com/page1',
      snippet: 'First result snippet text about the topic',
      domain: 'example.com',
      rank: 1,
      provider: 'duckduckgo',
    });
  });

  test('assigns ascending ranks', () => {
    const results = parseDuckDuckGoHtml(fixture);
    expect(results.map(r => r.rank)).toEqual([1, 2, 3]);
  });

  test('deduplicates repeated URLs', () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdupe.com">T1</a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdupe.com">T2</a>
      ${'x'.repeat(2200)}
    `;
    const results = parseDuckDuckGoHtml(html);
    expect(results.filter(r => r.url === 'https://dupe.com')).toHaveLength(1);
  });

  test('returns empty array for empty HTML', () => {
    expect(parseDuckDuckGoHtml('<html><body>No results</body></html>')).toHaveLength(0);
  });
});

describe('DuckDuckGoProvider', () => {
  test('returns parsed results for successful response', async () => {
    const client = new FakeHttpClient().onDefault({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: fixture,
    });

    const provider = new DuckDuckGoProvider(client);
    const results = await provider.search(
      { query: 'test', maxResults: 10 },
      { signal: new AbortController().signal, requestId: 'r1' },
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.provider).toBe('duckduckgo');
  });

  test('throws BotChallengeError for short HTML', async () => {
    const client = new FakeHttpClient().onDefault({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html><body>Short</body></html>',
    });

    const provider = new DuckDuckGoProvider(client);
    await expect(
      provider.search({ query: 'test', maxResults: 10 }, { signal: new AbortController().signal, requestId: 'r1' }),
    ).rejects.toBeInstanceOf(BotChallengeError);
  });

  test('throws BotChallengeError for anomaly-modal HTML', async () => {
    const body = '<html><body>' + 'x'.repeat(3000) + '<div class="anomaly-modal">blocked</div></body></html>';
    const client = new FakeHttpClient().onDefault({ status: 200, headers: {}, body });

    const provider = new DuckDuckGoProvider(client);
    await expect(
      provider.search({ query: 'test', maxResults: 10 }, { signal: new AbortController().signal, requestId: 'r1' }),
    ).rejects.toBeInstanceOf(BotChallengeError);
  });

  test('respects maxResults', async () => {
    const client = new FakeHttpClient().onDefault({ status: 200, headers: {}, body: fixture });
    const provider = new DuckDuckGoProvider(client);
    const results = await provider.search(
      { query: 'test', maxResults: 2 },
      { signal: new AbortController().signal, requestId: 'r1' },
    );
    expect(results).toHaveLength(2);
  });
});
