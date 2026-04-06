import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { chromium } from 'playwright';
import { fetcher, Fetcher, urlCache } from './fetcher.js';
import { initializeConfig, resetConfig } from './config.js';

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
    resetConfig();
    initializeConfig({
      FETCH_TIMEOUT_MS: '30000',
      MAX_CONCURRENT_FETCHES: '5',
      MAX_REDIRECTS: '3',
      MAX_CONTENT_LENGTH: '100000',
    });
    urlCache.clear();
    fetcherInstance = fetcher;
  });

  afterEach(async () => {
    urlCache.clear();
    resetConfig();
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
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<h1>Test</h1>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<main><h1>Main Content</h1></main>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<p>Content</p>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
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
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue('<article>Article content</article>'),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
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
        addInitScript: vi.fn().mockResolvedValue(undefined),
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

  describe('cache hit path', () => {
    test('returns cached content without calling Playwright', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue('<p>Live content</p>'),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      // Pre-populate the cache
      const cachedContent = '<p>Cached content</p>';
      urlCache.set('https://example.com', cachedContent, Buffer.byteLength(cachedContent, 'utf8'));

      const result = await fetcherInstance.fetch('https://example.com');

      expect(result).toBe(cachedContent);
      // Playwright should NOT have been invoked
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    test('calls Playwright on a cache miss and stores the result', async () => {
      const liveContent = '<h1>Fresh content</h1>';
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue(liveContent),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      const result = await fetcherInstance.fetch('https://example.com');

      expect(result).toBe(liveContent);
      expect(mockPage.goto).toHaveBeenCalledOnce();
      // Should now be cached
      expect(urlCache.get('https://example.com')).toBe(liveContent);
    });
  });

  describe('redirect handling', () => {
    test('blocks a cross-origin redirect with RedirectBlockedError', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({
          status: () => 302,
          headers: vi.fn().mockReturnValue({ location: 'https://evil.com/page' }),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      await expect(fetcherInstance.fetch('https://example.com')).rejects.toThrow('Redirect blocked');
    });

    test('blocks a redirect to a different port with RedirectBlockedError', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({
          status: () => 302,
          headers: vi.fn().mockReturnValue({ location: 'https://example.com:8080/page' }),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      await expect(fetcherInstance.fetch('https://example.com')).rejects.toThrow('Redirect blocked');
    });

    test('throws RedirectLoopError when MAX_REDIRECTS is reached', async () => {
      // Always return a same-origin redirect to trigger the loop
      const mockPage = {
        goto: vi.fn().mockResolvedValue({
          status: () => 302,
          headers: vi.fn().mockReturnValue({ location: 'https://example.com/loop' }),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      // MAX_REDIRECTS is configured to 3 in beforeEach
      await expect(fetcherInstance.fetch('https://example.com')).rejects.toThrow('Too many redirects');
    });
  });

  describe('content truncation', () => {
    test('truncates content that exceeds MAX_CONTENT_LENGTH', async () => {
      // Set a very small content limit
      resetConfig();
      initializeConfig({
        FETCH_TIMEOUT_MS: '30000',
        MAX_CONCURRENT_FETCHES: '5',
        MAX_REDIRECTS: '10',
        MAX_CONTENT_LENGTH: '20',
      });

      const largeContent = 'A'.repeat(100);
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue(largeContent),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      const result = await fetcherInstance.fetch('https://example.com/big');

      expect(result.length).toBe(20);
      expect(result).toBe('A'.repeat(20));
    });

    test('does not truncate content within MAX_CONTENT_LENGTH', async () => {
      const content = '<p>Short content</p>';
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue(content),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContext = {
        newPage: vi.fn().mockResolvedValue(mockPage),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      const result = await fetcherInstance.fetch('https://example.com/short');

      expect(result).toBe(content);
    });
  });
});
