import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockChromium = {
  launch: vi.fn(),
};

vi.mock('playwright', () => ({
  chromium: mockChromium,
}));

describe('fetcher', () => {
  let fetcher: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import('./fetcher.js');
    fetcher = mod.fetcher;
  });

  describe('fetch', () => {
    test('fetches HTML from URL', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<h1>Test</h1>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const result = await fetcher.fetch('https://example.com');

      expect(result).toBe('<h1>Test</h1>');
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    });

    test('extracts main content from page', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<main><h1>Main Content</h1></main>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const result = await fetcher.fetch('https://example.com');

      expect(result).toContain('Main Content');
    });

    test('handles navigation errors', async () => {
      const mockPage = {
        goto: vi.fn().mockRejectedValue(new Error('Network error')),
        waitForTimeout: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      await expect(fetcher.fetch('https://invalid-url.example')).rejects.toThrow(
        'Network error'
      );
    });
  });

  describe('fetchMultiple', () => {
    test('fetches multiple URLs successfully', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<p>Content</p>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const urls = ['https://example.com/1', 'https://example.com/2'];
      const results = await fetcher.fetchMultiple(urls);

      expect(results).toHaveLength(2);
      expect(results[0].url).toBe('https://example.com/1');
      expect(results[0].success).toBe(true);
      expect(results[1].url).toBe('https://example.com/2');
      expect(results[1].success).toBe(true);
    });

    test('handles partial failures', async () => {
      const mockPage1 = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<p>Success</p>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockPage2 = {
        goto: vi.fn().mockRejectedValue(new Error('Failed')),
        waitForTimeout: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn()
          .mockResolvedValueOnce(mockPage1)
          .mockResolvedValueOnce(mockPage2),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const urls = ['https://example.com/success', 'https://example.com/fail'];
      const results = await fetcher.fetchMultiple(urls);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toContain('Failed');
    });

    test('includes markdown in successful results', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<article>Article content</article>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const results = await fetcher.fetchMultiple(['https://example.com']);

      expect(results[0].success).toBe(true);
      expect(results[0].markdown).toContain('Article content');
    });

    test('returns empty markdown for failed results', async () => {
      const mockPage = {
        goto: vi.fn().mockRejectedValue(new Error('Network error')),
        waitForTimeout: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };

      mockChromium.launch.mockResolvedValue(mockBrowser);

      const results = await fetcher.fetchMultiple(['https://example.com']);

      expect(results[0].success).toBe(false);
      expect(results[0].markdown).toBe('');
    });
  });
});
