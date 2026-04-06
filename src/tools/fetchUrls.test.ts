import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchUrls } from './fetchUrls.js';
import { fetcher } from '../fetcher.js';
import type { FetchResult } from '../fetcher.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetchMultiple: vi.fn() },
}));

vi.mock('../converter.js', () => ({
  converter: { convertWithMetadata: vi.fn((html: string, url: string, title?: string) => {
    const heading = title ? `# ${title}\n\nSource: ${url}` : `# ${url}`;
    return `${heading}\n\n${html}\n\n---\n*Converted*`;
  }) },
}));

describe('fetchUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful fetches', () => {
    test('fetches multiple URLs and returns FetchUrlsResult', async () => {
      const mockResults: FetchResult[] = [
        { url: 'https://example.com/1', success: true, markdown: '<p>Content 1</p>', title: 'Article 1' },
        { url: 'https://example.com/2', success: true, markdown: '<p>Content 2</p>', title: 'Article 2' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const urls = ['https://example.com/1', 'https://example.com/2'];
      const result = await fetchUrls({ urls });

      expect(fetcher.fetchMultiple).toHaveBeenCalledWith(urls, undefined);
      expect(result.results).toHaveLength(2);
      expect(result.summary.total).toBe(2);
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(0);
    });

    test('result items contain url, title, markdown, fetchedAt, contentSize', async () => {
      const mockResults: FetchResult[] = [
        { url: 'https://example.com', success: true, markdown: '<p>Content</p>', title: 'My Page' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: ['https://example.com'] });
      const item = result.results[0];

      expect(item.url).toBe('https://example.com');
      expect(item.title).toBe('My Page');
      expect(typeof item.markdown).toBe('string');
      expect(typeof item.fetchedAt).toBe('string');
      expect(typeof item.contentSize).toBe('number');
      expect(item.contentSize).toBeGreaterThan(0);
      expect(item.success).toBe(true);
    });

    test('handles single URL', async () => {
      const mockResults: FetchResult[] = [
        { url: 'https://example.com', success: true, markdown: '# Single URL', title: '' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: ['https://example.com'] });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].url).toBe('https://example.com');
    });
  });

  describe('error handling', () => {
    test('handles failed fetches', async () => {
      const mockResults: FetchResult[] = [
        { url: 'https://example.com/success', success: true, markdown: '<p>Success</p>', title: 'OK' },
        { url: 'https://example.com/fail', success: false, markdown: '', title: '', error: 'Network error' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({
        urls: ['https://example.com/success', 'https://example.com/fail'],
      });

      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(1);

      const failItem = result.results.find(r => r.url === 'https://example.com/fail');
      expect(failItem?.success).toBe(false);
      expect(failItem?.error).toBe('Network error');
      expect(failItem?.markdown).toBe('');
      expect(failItem?.contentSize).toBe(0);
    });

    test('handles all failed fetches', async () => {
      const mockResults: FetchResult[] = [
        { url: 'https://example.com/1', success: false, markdown: '', title: '', error: 'Timeout' },
        { url: 'https://example.com/2', success: false, markdown: '', title: '', error: 'Connection refused' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({
        urls: ['https://example.com/1', 'https://example.com/2'],
      });

      expect(result.summary.succeeded).toBe(0);
      expect(result.summary.failed).toBe(2);
      expect(result.results[0].error).toBe('Timeout');
      expect(result.results[1].error).toBe('Connection refused');
    });
  });

  describe('edge cases', () => {
    test('handles empty array', async () => {
      vi.mocked(fetcher.fetchMultiple).mockResolvedValue([]);

      const result = await fetchUrls({ urls: [] });

      expect(fetcher.fetchMultiple).toHaveBeenCalledWith([], undefined);
      expect(result.results).toHaveLength(0);
      expect(result.summary.total).toBe(0);
    });

    test('handles URLs with special characters', async () => {
      const url = 'https://example.com/path?query=value#anchor';
      const mockResults: FetchResult[] = [
        { url, success: true, markdown: 'Content', title: '' },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: [url] });

      expect(result.results[0].url).toBe(url);
    });
  });
});
