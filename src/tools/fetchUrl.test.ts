import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchUrl } from './fetchUrl.js';
import { fetcher } from '../fetcher.js';
import { converter } from '../converter.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetch: vi.fn() },
}));

vi.mock('../converter.js', () => ({
  converter: { convertWithMetadata: vi.fn() },
}));

describe('fetchUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful fetch', () => {
    test('fetches URL and converts to markdown', async () => {
      const mockPageResult = { html: '<h1>Test Article</h1><p>Content here</p>', title: 'Test Article' };
      const mockMarkdown = '# Test Article\n\nSource: https://example.com/article\n\nContent here\n\n---\n*Converted*';
      const url = 'https://example.com/article';

      vi.mocked(fetcher.fetch).mockResolvedValue(mockPageResult);
      vi.mocked(converter.convertWithMetadata).mockReturnValue(mockMarkdown);

      const result = await fetchUrl({ url });

      expect(fetcher.fetch).toHaveBeenCalledWith(url, undefined);
      expect(converter.convertWithMetadata).toHaveBeenCalledWith(mockPageResult.html, url, mockPageResult.title);
      expect(result.markdown).toBe(mockMarkdown);
    });

    test('returns FetchUrlResult with all fields', async () => {
      const url = 'https://example.com/page';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: 'Page Title' });
      vi.mocked(converter.convertWithMetadata).mockReturnValue('# Page Title\n\nSource: https://example.com/page\n\nContent\n\n---');

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
      vi.mocked(converter.convertWithMetadata).mockReturnValue('content');

      const result = await fetchUrl({ url });

      expect(() => new Date(result.fetchedAt)).not.toThrow();
      expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
    });

    test('contentSize matches byte length of markdown', async () => {
      const url = 'https://example.com';
      const markdown = '# Title\n\nSome content with unicode: 😀';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>ok</p>', title: '' });
      vi.mocked(converter.convertWithMetadata).mockReturnValue(markdown);

      const result = await fetchUrl({ url });

      expect(result.contentSize).toBe(Buffer.byteLength(markdown, 'utf8'));
    });

    test('includes page title from fetcher result', async () => {
      const url = 'https://example.com/page';
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: 'Fetched Title' });
      vi.mocked(converter.convertWithMetadata).mockReturnValue('# Fetched Title\n\nSource: https://example.com/page\n\nContent\n\n---');

      const result = await fetchUrl({ url });

      expect(result.title).toBe('Fetched Title');
    });
  });

  describe('error handling', () => {
    test('throws when fetch fails', async () => {
      const url = 'https://example.com';
      const fetchError = new Error('Network timeout');

      vi.mocked(fetcher.fetch).mockRejectedValue(fetchError);

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
      vi.mocked(converter.convertWithMetadata).mockReturnValue(
        `# ${url}\n\nPage\n\n---`
      );

      const result = await fetchUrl({ url });

      expect(result.url).toBe(url);
    });

    test('handles very long URLs', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(1000);
      vi.mocked(fetcher.fetch).mockResolvedValue({ html: '<p>Content</p>', title: '' });
      vi.mocked(converter.convertWithMetadata).mockReturnValue(`# ${longUrl}`);

      const result = await fetchUrl({ url: longUrl });

      expect(result.url).toBe(longUrl);
    });
  });
});
