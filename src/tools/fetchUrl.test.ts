import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockFetcher = { fetch: vi.fn() };
const mockConverter = { convertWithMetadata: vi.fn() };

vi.mock('../fetcher.js', () => ({ fetcher: mockFetcher }));
vi.mock('../converter.js', () => ({ converter: mockConverter }));

describe('fetchUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful fetch', () => {
    test('fetches URL and converts to markdown', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const mockHtml = '<h1>Test Article</h1><p>Content here</p>';
      const mockMarkdown = '# Test Article\n\nContent here\n\n---\n*Converted*';
      const url = 'https://example.com/article';

      mockFetcher.fetch.mockResolvedValue(mockHtml);
      mockConverter.convertWithMetadata.mockReturnValue(mockMarkdown);

      const result = await fetchUrl(url);

      expect(mockFetcher.fetch).toHaveBeenCalledWith(url);
      expect(mockConverter.convertWithMetadata).toHaveBeenCalledWith(
        mockHtml,
        url
      );
      expect(result).toBe(mockMarkdown);
    });

    test('includes URL in metadata', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const url = 'https://example.com/page';
      mockFetcher.fetch.mockResolvedValue('<p>Content</p>');
      mockConverter.convertWithMetadata.mockReturnValue(
        '# https://example.com/page\n\nContent\n\n---'
      );

      const result = await fetchUrl(url);

      expect(result).toContain(url);
    });
  });

  describe('error handling', () => {
    test('returns error message when fetch fails', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const url = 'https://example.com';
      const fetchError = new Error('Network timeout');

      mockFetcher.fetch.mockRejectedValue(fetchError);

      const result = await fetchUrl(url);

      expect(result).toContain('# Error fetching');
      expect(result).toContain(url);
      expect(result).toContain('Network timeout');
    });

    test('handles non-Error exceptions', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const url = 'https://example.com';

      mockFetcher.fetch.mockRejectedValue('String error');

      const result = await fetchUrl(url);

      expect(result).toContain('# Error fetching');
      expect(result).toContain('Unknown error');
    });

    test('handles null/undefined errors', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const url = 'https://example.com';

      mockFetcher.fetch.mockRejectedValue(null);

      const result = await fetchUrl(url);

      expect(result).toContain('# Error fetching');
      expect(result).toContain('Unknown error');
    });
  });

  describe('edge cases', () => {
    test('handles URL with special characters', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const url = 'https://example.com/path?query=value&other=123#section';
      mockFetcher.fetch.mockResolvedValue('<h1>Page</h1>');
      mockConverter.convertWithMetadata.mockReturnValue(
        `# ${url}\n\nPage\n\n---`
      );

      const result = await fetchUrl(url);

      expect(result).toContain(url);
    });

    test('handles very long URLs', async () => {
      const { fetchUrl } = await import('./fetchUrl.js');
      const longUrl = 'https://example.com/' + 'a'.repeat(1000);
      mockFetcher.fetch.mockResolvedValue('<p>Content</p>');
      mockConverter.convertWithMetadata.mockReturnValue(`# ${longUrl}`);

      const result = await fetchUrl(longUrl);

      expect(result).toContain(longUrl);
    });
  });
});
