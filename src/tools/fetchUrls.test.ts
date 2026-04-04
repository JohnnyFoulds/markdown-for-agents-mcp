import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchUrls } from './fetchUrls.js';
import { fetcher } from '../fetcher.js';
import type { FetchResult } from '../fetcher.js';

vi.mock('../fetcher.js', () => ({
  fetcher: { fetchMultiple: vi.fn() },
}));

describe('fetchUrls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('successful fetches', () => {
    test('fetches multiple URLs and formats output', async () => {
      const mockResults = [
        {
          url: 'https://example.com/1',
          success: true,
          markdown: '# Article 1\n\nContent 1',
        },
        {
          url: 'https://example.com/2',
          success: true,
          markdown: '# Article 2\n\nContent 2',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const urls = ['https://example.com/1', 'https://example.com/2'];
      const result = await fetchUrls({ urls });

      expect(fetcher.fetchMultiple).toHaveBeenCalledWith(urls, undefined);
      expect(result).toContain('## URL: https://example.com/1');
      expect(result).toContain('# Article 1');
      expect(result).toContain('## URL: https://example.com/2');
      expect(result).toContain('# Article 2');
    });

    test('separates results with horizontal rules', async () => {
      const mockResults = [
        {
          url: 'https://example.com/1',
          success: true,
          markdown: 'Content 1',
        },
        {
          url: 'https://example.com/2',
          success: true,
          markdown: 'Content 2',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: ['https://example.com/1', 'https://example.com/2'] });

      expect(result).toContain('---');
    });

    test('handles single URL', async () => {
      const mockResults = [
        {
          url: 'https://example.com',
          success: true,
          markdown: '# Single URL',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: ['https://example.com'] });

      expect(result).toContain('## URL: https://example.com');
      expect(result).toContain('# Single URL');
    });
  });

  describe('error handling', () => {
    test('handles failed fetches', async () => {
      const mockResults: FetchResult[] = [
        {
          url: 'https://example.com/success',
          success: true,
          markdown: 'Success content',
        },
        {
          url: 'https://example.com/fail',
          success: false,
          markdown: '',
          error: 'Network error',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({
        urls: [
          'https://example.com/success',
          'https://example.com/fail',
        ],
      });

      expect(result).toContain('## URL: https://example.com/success');
      expect(result).toContain('Success content');
      expect(result).toContain('## URL: https://example.com/fail');
      expect(result).toContain('**Error:** Network error');
    });

    test('handles all failed fetches', async () => {
      const mockResults: FetchResult[] = [
        {
          url: 'https://example.com/1',
          success: false,
          markdown: '',
          error: 'Timeout',
        },
        {
          url: 'https://example.com/2',
          success: false,
          markdown: '',
          error: 'Connection refused',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({
        urls: [
          'https://example.com/1',
          'https://example.com/2',
        ],
      });

      expect(result).toContain('**Error:** Timeout');
      expect(result).toContain('**Error:** Connection refused');
    });
  });

  describe('edge cases', () => {
    test('handles empty array', async () => {
      vi.mocked(fetcher.fetchMultiple).mockResolvedValue([]);

      const result = await fetchUrls({ urls: [] });

      expect(fetcher.fetchMultiple).toHaveBeenCalledWith([], undefined);
      expect(result).toBe('');
    });

    test('handles URLs with special characters', async () => {
      const url = 'https://example.com/path?query=value#anchor';
      const mockResults = [
        {
          url,
          success: true,
          markdown: 'Content',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: [url] });

      expect(result).toContain(`## URL: ${url}`);
    });
  });

  describe('output format', () => {
    test('output structure matches expected format', async () => {
      const mockResults = [
        {
          url: 'https://example.com',
          success: true,
          markdown: '# Title',
        },
      ];

      vi.mocked(fetcher.fetchMultiple).mockResolvedValue(mockResults);

      const result = await fetchUrls({ urls: ['https://example.com'] });

      // Check structure
      expect(result).toMatch(/## URL: https:\/\/example\.com/);
      expect(result).toContain('# Title');
      expect(result).toContain('---');
    });
  });
});
