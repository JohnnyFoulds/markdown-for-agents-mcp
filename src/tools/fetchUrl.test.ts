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
      const mockHtml = '<h1>Test Article</h1><p>Content here</p>';
      const mockMarkdown = '# Test Article\n\nContent here\n\n---\n*Converted*';
      const url = 'https://example.com/article';

      vi.mocked(fetcher.fetch).mockResolvedValue(mockHtml);
      vi.mocked(converter.convertWithMetadata).mockReturnValue(mockMarkdown);

      const result = await fetchUrl({ url });

      expect(fetcher.fetch).toHaveBeenCalledWith(url, undefined);
      expect(converter.convertWithMetadata).toHaveBeenCalledWith(mockHtml, url);
      expect(result).toBe(mockMarkdown);
    });

    test('includes URL in metadata', async () => {
      const url = 'https://example.com/page';
      vi.mocked(fetcher.fetch).mockResolvedValue('<p>Content</p>');
      vi.mocked(converter.convertWithMetadata).mockReturnValue(
        '# https://example.com/page\n\nContent\n\n---'
      );

      const result = await fetchUrl({ url });

      expect(result).toContain(url);
    });
  });

  describe('error handling', () => {
    test('returns error message when fetch fails', async () => {
      const url = 'https://example.com';
      const fetchError = new Error('Network timeout');

      vi.mocked(fetcher.fetch).mockRejectedValue(fetchError);

      const result = await fetchUrl({ url });

      expect(result).toContain('# Error fetching');
      expect(result).toContain(url);
      expect(result).toContain('Network timeout');
    });

    test('handles non-Error exceptions', async () => {
      const url = 'https://example.com';

      vi.mocked(fetcher.fetch).mockRejectedValue('String error');

      const result = await fetchUrl({ url });

      expect(result).toContain('# Error fetching');
      expect(result).toContain('Unknown error');
    });

    test('handles null/undefined errors', async () => {
      const url = 'https://example.com';

      vi.mocked(fetcher.fetch).mockRejectedValue(null);

      const result = await fetchUrl({ url });

      expect(result).toContain('# Error fetching');
      expect(result).toContain('Unknown error');
    });
  });

  describe('edge cases', () => {
    test('handles URL with special characters', async () => {
      const url = 'https://example.com/path?query=value&other=123#section';
      vi.mocked(fetcher.fetch).mockResolvedValue('<h1>Page</h1>');
      vi.mocked(converter.convertWithMetadata).mockReturnValue(
        `# ${url}\n\nPage\n\n---`
      );

      const result = await fetchUrl({ url });

      expect(result).toContain(url);
    });

    test('handles very long URLs', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(1000);
      vi.mocked(fetcher.fetch).mockResolvedValue('<p>Content</p>');
      vi.mocked(converter.convertWithMetadata).mockReturnValue(`# ${longUrl}`);

      const result = await fetchUrl({ url: longUrl });

      expect(result).toContain(longUrl);
    });
  });
});
