import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchResult } from '../fetcher.js';

vi.mock('../fetcher.js', () => {
  const makeFetch = (url: string, html: string, title = 'Test'): FetchResult => ({
    url,
    success: true,
    markdown: html,
    title,
  });
  const makeError = (url: string, error: string): FetchResult => ({
    url,
    success: false,
    markdown: '',
    title: '',
    error,
  });
  return {
    fetcher: {
      fetchMultiple: vi.fn(async (urls: string[]) =>
        urls.map(url => {
          if (url.includes('fail')) return makeError(url, 'Connection refused');
          return makeFetch(url, `<html><body><h1>Page</h1><p>${url}</p></body></html>`);
        })
      ),
    },
  };
});

import { extractUrls } from './extractUrls.js';

beforeEach(() => vi.clearAllMocks());

describe('extractUrls', () => {
  it('returns extracted content for each URL', async () => {
    const result = await extractUrls({ urls: ['https://example.com/a', 'https://example.com/b'] });
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.success)).toBe(true);
    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(0);
  });

  it('marks failed fetches as unsuccessful', async () => {
    const result = await extractUrls({ urls: ['https://fail.example.com'] });
    const [r] = result.results;
    expect(r!.success).toBe(false);
    expect(r!.error).toBe('Connection refused');
    expect(result.summary.failed).toBe(1);
  });

  it('uses specified outputFormat', async () => {
    const result = await extractUrls({ urls: ['https://example.com/'], outputFormat: 'text' });
    const [r] = result.results;
    expect(r!.format).toBe('text');
    expect(r!.content).not.toContain('<');
  });

  it('returns html format unchanged', async () => {
    const result = await extractUrls({ urls: ['https://example.com/'], outputFormat: 'html' });
    const [r] = result.results;
    expect(r!.format).toBe('html');
    expect(r!.content).toContain('<h1>');
  });

  it('applies maxChars pagination', async () => {
    const result = await extractUrls({ urls: ['https://example.com/'], maxChars: 10 });
    const [r] = result.results;
    expect(r!.content.length).toBeLessThanOrEqual(20); // some tolerance
    expect(r!.truncated).toBe(true);
    expect(r!.totalLength).toBeGreaterThan(r!.content.length);
  });

  it('mixed success/failure summary', async () => {
    const result = await extractUrls({
      urls: ['https://example.com/ok', 'https://fail.example.com/x'],
    });
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(1);
  });

  it('includes fetchedAt timestamp', async () => {
    const result = await extractUrls({ urls: ['https://example.com/'] });
    const [r] = result.results;
    expect(r!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
