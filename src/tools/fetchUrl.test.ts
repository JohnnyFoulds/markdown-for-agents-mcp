import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchUrl } from './fetchUrl.js';
import { fetcher } from '../fetcher.js';
import type { ExtractResult } from '../extract/pipeline.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetch: vi.fn() },
}));

vi.mock('../extract/pipeline.js', () => ({
  extract: vi.fn(),
}));

import { extract } from '../extract/pipeline.js';

describe('fetchUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful fetch', () => {
    test('fetches URL and converts to markdown', async () => {
      const mockPageResult = { html: '<h1>Test Article</h1><p>Content here</p>', title: 'Test Article' };
      const mockExtractResult: ExtractResult = {
        markdown: '# Test Article\n\nSource: https://example.com/article\n\nContent here\n\n---\n*Converted*',
        title: 'Test Article',
        contentSize: 80,
      };
      const url = 'https://example.com/article';

      vi.mocked(fetcher.fetch).mockResolvedValue(mockPageResult);
      vi.mocked(extract).mockReturnValue(mockExtractResult);

      const result = await fetchUrl({ url });

      expect(fetcher.fetch).toHaveBeenCalledWith(url, undefined, undefined, undefined);
      expect(extract).toHaveBeenCalledWith(mockPageResult.html, { url, title: mockPageResult.title });
      expect(result.markdown).toBe(mockExtractResult.markdown);
    });

    test('returns FetchUrlResult with all fields', async () => {
      const url = 'https://example.com/page';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: 'Page Title' });
      vi.mocked(extract).mockReturnValue({
        markdown: '# Page Title\n\nSource: https://example.com/page\n\nContent\n\n---',
        title: 'Page Title',
        contentSize: 60,
      });

      const result = await fetchUrl({ url });

      expect(result.url).toBe(url);
      expect(result.title).toBe('Page Title');
      expect(typeof result.markdown).toBe('string');
      expect(typeof result.fetchedAt).toBe('string');
      expect(typeof result.contentSize).toBe('number');
      expect(result.contentSize).toBeGreaterThan(0);
    });

    test('fetchedAt is a valid ISO 8601 timestamp', async () => {
      const url = 'https://example.com';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>ok</p>', title: '' });
      vi.mocked(extract).mockReturnValue({ markdown: 'content', title: '', contentSize: 7 });

      const result = await fetchUrl({ url });

      expect(() => new Date(result.fetchedAt)).not.toThrow();
      expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
    });

    test('contentSize comes from ExtractResult', async () => {
      const url = 'https://example.com';
      const expectedSize = 42;
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>ok</p>', title: '' });
      vi.mocked(extract).mockReturnValue({ markdown: 'content', title: '', contentSize: expectedSize });

      const result = await fetchUrl({ url });

      expect(result.contentSize).toBe(expectedSize);
    });

    test('includes page title from fetcher result', async () => {
      const url = 'https://example.com/page';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: 'Fetched Title' });
      vi.mocked(extract).mockReturnValue({
        markdown: '# Fetched Title\n\nSource: https://example.com/page\n\nContent\n\n---',
        title: 'Fetched Title',
        contentSize: 70,
      });

      const result = await fetchUrl({ url });

      expect(result.title).toBe('Fetched Title');
    });
  });

  describe('error handling', () => {
    test('throws when fetch fails', async () => {
      const url = 'https://example.com';
      vi.mocked(fetcher.fetch).mockRejectedValue(new Error('Network timeout'));
      await expect(fetchUrl({ url })).rejects.toThrow('Network timeout');
    });

    test('throws non-Error exceptions', async () => {
      const url = 'https://example.com';
      vi.mocked(fetcher.fetch).mockRejectedValue('String error');
      await expect(fetchUrl({ url })).rejects.toBe('String error');
    });

    test('throws null errors', async () => {
      const url = 'https://example.com';
      vi.mocked(fetcher.fetch).mockRejectedValue(null);
      await expect(fetchUrl({ url })).rejects.toBeNull();
    });
  });

  describe('edge cases', () => {
    test('handles URL with special characters', async () => {
      const url = 'https://example.com/path?query=value&other=123#section';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<h1>Page</h1>', title: '' });
      vi.mocked(extract).mockReturnValue({ markdown: `# ${url}\n\nPage\n\n---`, title: '', contentSize: url.length + 20 });

      const result = await fetchUrl({ url });

      expect(result.url).toBe(url);
    });

    test('handles very long URLs', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(1000);
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: '' });
      vi.mocked(extract).mockReturnValue({ markdown: `# ${longUrl}`, title: '', contentSize: longUrl.length + 2 });

      const result = await fetchUrl({ url: longUrl });

      expect(result.url).toBe(longUrl);
    });
  });
});
