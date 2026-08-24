import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { chromium } from 'playwright';
import { fetcher, Fetcher, urlCache, titleCache } from './fetcher.js';
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
    titleCache.clear();
    fetcherInstance = fetcher;
  });

  afterEach(async () => {
    urlCache.clear();
    titleCache.clear();
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
        evaluate: vi.fn().mockResolvedValue({ html: '<h1>Test</h1>', title: 'Test Page' }),
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

      expect(result.html).toBe('<h1>Test</h1>');
      expect(result.title).toBe('Test Page');
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    });

    test('extracts main content from page', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({ html: '<main><h1>Main Content</h1></main>', title: '' }),
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

      expect(result.html).toContain('Main Content');
    });

    test('extracts document.title from page', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Content</p>', title: 'My Awesome Page' }),
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

      expect(result.title).toBe('My Awesome Page');
    });

    test('returns empty title when document.title is empty', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Content</p>', title: '' }),
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

      expect(result.title).toBe('');
    });

    test('populates titleCache on cache miss', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Content</p>', title: 'Cached Title' }),
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
      await fetcherInstance.fetch('https://example.com/title-test');

      expect(titleCache.get('https://example.com/title-test')).toBe('Cached Title');
    });

    test('returns title from titleCache on cache hit', async () => {
      // Pre-populate both caches
      const cachedContent = '<p>Cached content</p>';
      const cachedTitle = 'Cached Title';
      urlCache.set('https://example.com', cachedContent, Buffer.byteLength(cachedContent, 'utf8'));
      titleCache.set('https://example.com', cachedTitle, Buffer.byteLength(cachedTitle, 'utf8'));

      const result = await fetcherInstance.fetch('https://example.com');

      expect(result.html).toBe(cachedContent);
      expect(result.title).toBe(cachedTitle);
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
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Content</p>', title: 'Test' }),
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
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Success</p>', title: 'OK' }),
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
        evaluate: vi.fn().mockResolvedValue({ html: '<article>Article content</article>', title: '' }),
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
      expect(results[0].title).toBe('');
    });

    test('propagates title from successful fetch', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>ok</p>', title: 'Page Title' }),
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

      expect(results[0].title).toBe('Page Title');
    });
  });

  describe('cache hit path', () => {
    test('returns cached content without calling Playwright', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>Live content</p>', title: 'Live' }),
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

      expect(result.html).toBe(cachedContent);
      // Playwright should NOT have been invoked
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    test('calls Playwright on a cache miss and stores the result', async () => {
      const liveContent = '<h1>Fresh content</h1>';
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: liveContent, title: 'Fresh' }),
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

      expect(result.html).toBe(liveContent);
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

  describe('timeout handling', () => {
    test('wraps timeout errors in FetchTimeoutError', async () => {
      const mockPage = {
        goto: vi.fn().mockRejectedValue(new Error('page.goto: Timeout 30000ms exceeded')),
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
      await expect(fetcherInstance.fetch('https://example.com')).rejects.toThrow('Fetch timeout for https://example.com');
    });

    test('passes custom timeout to page.goto', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>ok</p>', title: '' }),
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
      await fetcherInstance.fetch('https://example.com', 5000);

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle',
        timeout: 5000,
      });
    });
  });

  describe('redirect — edge cases', () => {
    test('blocks a redirect to a domain on the blocklist', async () => {
      // doubleclick.net is in the default blocklist
      const mockPage = {
        goto: vi.fn().mockResolvedValue({
          status: () => 302,
          headers: vi.fn().mockReturnValue({ location: 'https://doubleclick.net/page' }),
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

    test('blocks a redirect with a malformed Location header', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue({
          status: () => 302,
          headers: vi.fn().mockReturnValue({ location: 'http://:80/' }),
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

    test('null pageResponse defaults to status 200 and continues', async () => {
      const mockPage = {
        goto: vi.fn().mockResolvedValue(null),
        evaluate: vi.fn().mockResolvedValue({ html: '<p>null response ok</p>', title: '' }),
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
      expect(result.html).toBe('<p>null response ok</p>');
    });
  });

  describe('initialize', () => {
    test('does not re-create browser on second call', async () => {
      const mockContext = {
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
          evaluate: vi.fn().mockResolvedValue({ html: '<p>ok</p>', title: '' }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      await fetcherInstance.initialize();
      await fetcherInstance.initialize(); // second call

      expect(mockChromium.launch).toHaveBeenCalledOnce();
    });

    test('passes proxy config to chromium.launch when PLAYWRIGHT_PROXY is set', async () => {
      resetConfig();
      initializeConfig({
        FETCH_TIMEOUT_MS: '30000',
        MAX_CONCURRENT_FETCHES: '5',
        MAX_REDIRECTS: '3',
        MAX_CONTENT_LENGTH: '100000',
        PLAYWRIGHT_PROXY: 'http://proxy.example.com:8080',
      });

      const mockContext = {
        newPage: vi.fn(),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      // Use a fresh instance so it re-initializes with new config
      const freshFetcher = new Fetcher();
      await freshFetcher.initialize();

      expect(mockChromium.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: { server: 'http://proxy.example.com:8080', bypass: undefined },
        })
      );

      await freshFetcher.close();
    });

    test('does not pass proxy config when PLAYWRIGHT_PROXY is absent', async () => {
      const mockContext = {
        newPage: vi.fn(),
        addInitScript: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue(mockContext),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockChromium.launch.mockResolvedValue(mockBrowser);

      const freshFetcher = new Fetcher();
      await freshFetcher.initialize();

      const launchCall = mockChromium.launch.mock.calls[0][0];
      expect(launchCall.proxy).toBeUndefined();

      await freshFetcher.close();
    });
  });

  describe('cache write failure', () => {
    test('continues normally when cache.set throws', async () => {
      const liveContent = '<p>content</p>';
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: liveContent, title: '' }),
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

      // Force cache.set to throw
      vi.spyOn(urlCache, 'set').mockImplementationOnce(() => { throw new Error('cache full'); });

      await fetcherInstance.initialize();
      // Should still return the content despite the cache write failure
      const result = await fetcherInstance.fetch('https://example.com/nocache');
      expect(result.html).toBe(liveContent);
    });
  });

  describe('domain blocking', () => {
    test('throws on a blocked domain without touching Playwright', async () => {
      // doubleclick.net is in the built-in blocklist
      await expect(fetcherInstance.fetch('https://doubleclick.net/page')).rejects.toThrow('Domain blocked');
      expect(mockChromium.launch).not.toHaveBeenCalled();
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
        evaluate: vi.fn().mockResolvedValue({ html: largeContent, title: '' }),
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

      expect(result.html.length).toBe(20);
      expect(result.html).toBe('A'.repeat(20));
    });

    test('does not truncate content within MAX_CONTENT_LENGTH', async () => {
      const content = '<p>Short content</p>';
      const mockPage = {
        goto: vi.fn().mockResolvedValue({ status: () => 200, headers: vi.fn().mockReturnValue({}) }),
        evaluate: vi.fn().mockResolvedValue({ html: content, title: '' }),
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

      expect(result.html).toBe(content);
    });
  });
});
