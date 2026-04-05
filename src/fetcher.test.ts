import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { chromium } from 'playwright';
import { fetcher } from './fetcher.js';

vi.mock('playwright', async () => {
  const actual = await vi.importActual('playwright');
  return {
    ...actual,
    chromium: {
      launch: vi.fn(),
    },
  };
});

describe('fetcher', () => {
  let fetcherInstance: any;
  const mockChromium = chromium as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    fetcherInstance = await import('./fetcher.js').then((m) => m.fetcher);
  });

  afterEach(async () => {
    // Clean up browser state between tests
    try {
      await fetcherInstance.close();
    } catch {
      // Ignore cleanup errors in tests
    }
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

      await fetcherInstance.initialize();
      const result = await fetcherInstance.fetch('https://example.com');

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

      await fetcherInstance.initialize();
      const result = await fetcherInstance.fetch('https://example.com');

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

      await fetcherInstance.initialize();

      await expect(fetcherInstance.fetch('https://invalid-url.example')).rejects.toThrow(
        'Network error'
      );
    });

    test('validates URL format', async () => {
      await expect(fetcherInstance.fetch('not-a-valid-url')).rejects.toThrow('Invalid URL');
    });

    test('validates URL protocol', async () => {
      await expect(fetcherInstance.fetch('ftp://example.com')).rejects.toThrow('Invalid URL');
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

      await fetcherInstance.initialize();
      const urls = ['https://example.com/1', 'https://example.com/2'];
      const results = await fetcherInstance.fetchMultiple(urls);

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

      await fetcherInstance.initialize();
      const urls = ['https://example.com/success', 'https://example.com/fail'];
      const results = await fetcherInstance.fetchMultiple(urls);

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

      await fetcherInstance.initialize();
      const results = await fetcherInstance.fetchMultiple(['https://example.com']);

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

      await fetcherInstance.initialize();
      const results = await fetcherInstance.fetchMultiple(['https://example.com']);

      expect(results[0].success).toBe(false);
      expect(results[0].markdown).toBe('');
    });
  });
});
