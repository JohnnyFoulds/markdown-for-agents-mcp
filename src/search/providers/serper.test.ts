import { describe, test, expect } from 'vitest';
import { parseSerperResponse } from './serper.js';

describe('parseSerperResponse', () => {
  test('extracts organic results', () => {
    const raw = {
      organic: [
        { title: 'One', link: 'https://one.com', snippet: 'First result', position: 1 },
        { title: 'Two', link: 'https://two.net/path', snippet: 'Second result', position: 2 },
      ],
    };
    const results = parseSerperResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'One',
      url: 'https://one.com',
      snippet: 'First result',
      domain: 'one.com',
      rank: 1,
      provider: 'serper',
    });
  });

  test('falls back to index for missing position', () => {
    const raw = { organic: [{ link: 'https://x.com', title: 'X' }] };
    const results = parseSerperResponse(raw);
    expect(results[0]!.rank).toBe(1);
  });

  test('returns empty array for missing organic', () => {
    expect(parseSerperResponse({})).toHaveLength(0);
  });

  test('filters out entries without a link', () => {
    const raw = { organic: [{ title: 'No link', snippet: 'desc' }] };
    expect(parseSerperResponse(raw)).toHaveLength(0);
  });
});
