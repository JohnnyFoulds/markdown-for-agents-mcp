import { describe, test, expect } from 'vitest';
import { parseBraveResponse } from './brave.js';

describe('parseBraveResponse', () => {
  test('extracts results from web.results array', () => {
    const raw = {
      web: {
        results: [
          { title: 'Alpha', url: 'https://alpha.com/', description: 'Alpha snippet' },
          { title: 'Beta', url: 'https://beta.io/page', description: 'Beta snippet' },
        ],
      },
    };
    const results = parseBraveResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Alpha',
      url: 'https://alpha.com/',
      snippet: 'Alpha snippet',
      domain: 'alpha.com',
      rank: 1,
      provider: 'brave',
    });
    expect(results[1]!.rank).toBe(2);
  });

  test('returns empty array for missing web.results', () => {
    expect(parseBraveResponse({})).toHaveLength(0);
    expect(parseBraveResponse({ web: {} })).toHaveLength(0);
  });

  test('filters out entries without a URL', () => {
    const raw = { web: { results: [{ title: 'No URL', description: 'desc' }] } };
    expect(parseBraveResponse(raw)).toHaveLength(0);
  });
});
