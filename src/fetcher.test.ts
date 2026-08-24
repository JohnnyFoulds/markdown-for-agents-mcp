import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { fetcher, Fetcher, urlCache, titleCache } from './fetcher.js';
import { initializeConfig, resetConfig } from './config.js';
import { DomainBlockedError, RedirectBlockedError } from './utils/errors.js';

vi.mock('./render/ladder.js', () => ({
  renderLadder: {
    render: vi.fn(),
    warmup: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  },
}));

import { renderLadder } from './render/ladder.js';
const mockLadder = renderLadder as any;

function makeResult(html: string, title = '') {
  return { url: 'https://example.com', html, title, status: 200, tier: 'http', escalations: [], durationMs: 10 };
}

describe('fetcher', () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    urlCache.clear();
    titleCache.clear();
    resetConfig();
  });

  describe('fetch', () => {
    test('fetches HTML and title via render ladder', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<h1>Test</h1>', 'Test Page'));

      const result = await fetcher.fetch('https://example.com');

      expect(result.html).toBe('<h1>Test</h1>');
      expect(result.title).toBe('Test Page');
      expect(mockLadder.render).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com', timeoutMs: 30000 }),
      );
    });

    test('passes custom timeout to render ladder', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<p>ok</p>'));

      await fetcher.fetch('https://example.com', 5000);

      expect(mockLadder.render).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 5000 }),
      );
    });

    test('validates URL format before calling ladder', async () => {
      await expect(fetcher.fetch('not-a-valid-url')).rejects.toThrow('Invalid URL');
      expect(mockLadder.render).not.toHaveBeenCalled();
    });

    test('validates URL protocol before calling ladder', async () => {
      await expect(fetcher.fetch('ftp://example.com')).rejects.toThrow('Invalid URL');
      expect(mockLadder.render).not.toHaveBeenCalled();
    });

    test('returns empty title when ladder returns empty title', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<p>Content</p>', ''));
      const result = await fetcher.fetch('https://example.com');
      expect(result.title).toBe('');
    });
  });

  describe('cache', () => {
    test('returns cached content without calling ladder', async () => {
      const cachedContent = '<p>Cached</p>';
      urlCache.set('https://example.com', cachedContent, Buffer.byteLength(cachedContent, 'utf8'));
      titleCache.set('https://example.com', 'Cached Title', 12);

      const result = await fetcher.fetch('https://example.com');

      expect(result.html).toBe(cachedContent);
      expect(result.title).toBe('Cached Title');
      expect(mockLadder.render).not.toHaveBeenCalled();
    });

    test('populates cache on cache miss', async () => {
      const liveContent = '<h1>Fresh</h1>';
      mockLadder.render.mockResolvedValue(makeResult(liveContent, 'Fresh'));

      await fetcher.fetch('https://example.com/new');

      expect(urlCache.get('https://example.com/new')).toBe(liveContent);
      expect(titleCache.get('https://example.com/new')).toBe('Fresh');
    });

    test('second fetch returns cached content without re-rendering', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<p>Live</p>'));

      await fetcher.fetch('https://example.com');
      await fetcher.fetch('https://example.com');

      expect(mockLadder.render).toHaveBeenCalledOnce();
    });

    test('continues normally when cache.set throws', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<p>content</p>'));
      vi.spyOn(urlCache, 'set').mockImplementationOnce(() => { throw new Error('cache full'); });

      const result = await fetcher.fetch('https://example.com/nocache');
      expect(result.html).toBe('<p>content</p>');
    });

    test('urlCache.maxBytes reflects CACHE_MAX_BYTES', () => {
      resetConfig();
      initializeConfig({ CACHE_MAX_BYTES: '1048576', CACHE_TTL_MS: '60000' });
      urlCache.clear();
      expect(urlCache.maxBytes).toBe(1048576);
    });
  });

  describe('content truncation', () => {
    test('truncates content that exceeds MAX_CONTENT_LENGTH', async () => {
      resetConfig();
      initializeConfig({
        FETCH_TIMEOUT_MS: '30000',
        MAX_CONCURRENT_FETCHES: '5',
        MAX_REDIRECTS: '10',
        MAX_CONTENT_LENGTH: '20',
      });

      const largeContent = 'A'.repeat(100);
      mockLadder.render.mockResolvedValue(makeResult(largeContent));

      const result = await fetcher.fetch('https://example.com/big');

      expect(result.html.length).toBe(20);
      expect(result.html).toBe('A'.repeat(20));
    });

    test('does not truncate content within MAX_CONTENT_LENGTH', async () => {
      const content = '<p>Short content</p>';
      mockLadder.render.mockResolvedValue(makeResult(content));

      const result = await fetcher.fetch('https://example.com/short');
      expect(result.html).toBe(content);
    });
  });

  describe('error handling', () => {
    test('throws on a blocked domain without calling ladder', async () => {
      await expect(fetcher.fetch('https://doubleclick.net/page')).rejects.toThrow('Domain blocked');
      expect(mockLadder.render).not.toHaveBeenCalled();
    });

    test('re-throws DomainBlockedError from ladder', async () => {
      mockLadder.render.mockRejectedValue(new DomainBlockedError('example.com'));
      await expect(fetcher.fetch('https://example.com')).rejects.toBeInstanceOf(DomainBlockedError);
    });

    test('re-throws RedirectBlockedError from ladder', async () => {
      mockLadder.render.mockRejectedValue(new RedirectBlockedError('https://example.com', 'https://evil.com'));
      await expect(fetcher.fetch('https://example.com')).rejects.toBeInstanceOf(RedirectBlockedError);
    });

    test('wraps timeout messages in FetchTimeoutError', async () => {
      mockLadder.render.mockRejectedValue(new Error('page.goto: Timeout 30000ms exceeded'));
      await expect(fetcher.fetch('https://example.com')).rejects.toThrow('Fetch timeout for https://example.com');
    });

    test('re-throws other errors from ladder', async () => {
      mockLadder.render.mockRejectedValue(new Error('Network error'));
      await expect(fetcher.fetch('https://example.com')).rejects.toThrow('Network error');
    });
  });

  describe('initialize and close', () => {
    test('initialize delegates to renderLadder.warmup', async () => {
      await fetcher.initialize();
      expect(mockLadder.warmup).toHaveBeenCalledOnce();
    });

    test('close delegates to renderLadder.drain', async () => {
      await fetcher.close();
      expect(mockLadder.drain).toHaveBeenCalledOnce();
    });
  });

  describe('fetchMultiple', () => {
    test('fetches multiple URLs and returns results', async () => {
      mockLadder.render
        .mockResolvedValueOnce({ ...makeResult('<p>One</p>'), url: 'https://example.com/1' })
        .mockResolvedValueOnce({ ...makeResult('<p>Two</p>'), url: 'https://example.com/2' });

      const results = await fetcher.fetchMultiple(['https://example.com/1', 'https://example.com/2']);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].url).toBe('https://example.com/1');
      expect(results[1].success).toBe(true);
      expect(results[1].url).toBe('https://example.com/2');
    });

    test('handles partial failures', async () => {
      mockLadder.render
        .mockResolvedValueOnce({ ...makeResult('<p>Success</p>'), url: 'https://example.com/success' })
        .mockRejectedValueOnce(new Error('Failed'));

      const results = await fetcher.fetchMultiple([
        'https://example.com/success',
        'https://example.com/fail',
      ]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toContain('Failed');
    });

    test('includes html in markdown field of successful results', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<article>Article content</article>'));

      const results = await fetcher.fetchMultiple(['https://example.com']);

      expect(results[0].success).toBe(true);
      expect(results[0].markdown).toContain('Article content');
    });

    test('returns empty markdown for failed results', async () => {
      mockLadder.render.mockRejectedValue(new Error('Network error'));

      const results = await fetcher.fetchMultiple(['https://example.com']);

      expect(results[0].success).toBe(false);
      expect(results[0].markdown).toBe('');
      expect(results[0].title).toBe('');
    });

    test('propagates title from successful fetch', async () => {
      mockLadder.render.mockResolvedValue(makeResult('<p>ok</p>', 'Page Title'));

      const results = await fetcher.fetchMultiple(['https://example.com']);
      expect(results[0].title).toBe('Page Title');
    });
  });

  // ── RFC 9111 shared-cache disclosure fix (POPIA Phase 1) ─────────────────────
  //
  // Phase 1 RED reason (before fix):
  //   urlCache keyed on bare URL; Cookie/Authorization ignored.
  //   fetch(url, Cookie=A) then fetch(url, no headers) → second caller receives A's
  //   authenticated content without ever supplying credentials.
  //
  describe('RFC 9111 shared-cache policy — cross-caller disclosure prevention', () => {
    const URL = 'https://example.com/protected';
    const AUTHED_HTML = '<p>authenticated content</p>';
    const ANON_HTML = '<p>public content</p>';

    test('(headline) Cookie-bearing response is NOT served to unauthenticated caller', async () => {
      // Caller A: authenticated fetch
      mockLadder.render.mockResolvedValueOnce(makeResult(AUTHED_HTML, 'Protected'));
      await fetcher.fetch(URL, undefined, undefined, { cookie: 'session=A' });

      // Caller B: unauthenticated fetch — must NOT get A's content
      mockLadder.render.mockResolvedValueOnce(makeResult(ANON_HTML, 'Public'));
      const result = await fetcher.fetch(URL);

      expect(result.html).toBe(ANON_HTML);
      expect(result.html).not.toBe(AUTHED_HTML);
      expect(mockLadder.render).toHaveBeenCalledTimes(2);
    });

    test('Authorization-bearing response is NOT cached and NOT served to next caller', async () => {
      mockLadder.render.mockResolvedValueOnce(makeResult(AUTHED_HTML));
      await fetcher.fetch(URL, undefined, undefined, { authorization: 'Bearer token' });

      mockLadder.render.mockResolvedValueOnce(makeResult(ANON_HTML));
      const result = await fetcher.fetch(URL);

      expect(result.html).toBe(ANON_HTML);
      expect(mockLadder.render).toHaveBeenCalledTimes(2);
    });

    test('Cache-Control: private response is NOT stored', async () => {
      const r = { ...makeResult(AUTHED_HTML), headers: { 'cache-control': 'private' } };
      mockLadder.render.mockResolvedValueOnce(r);
      await fetcher.fetch(URL);

      // Next call must hit the ladder again, not the cache
      mockLadder.render.mockResolvedValueOnce(makeResult(ANON_HTML));
      const result = await fetcher.fetch(URL);

      expect(result.html).toBe(ANON_HTML);
      expect(mockLadder.render).toHaveBeenCalledTimes(2);
    });

    test('Cache-Control: no-store response is NOT stored', async () => {
      const r = { ...makeResult(AUTHED_HTML), headers: { 'cache-control': 'no-store' } };
      mockLadder.render.mockResolvedValueOnce(r);
      await fetcher.fetch(URL);

      mockLadder.render.mockResolvedValueOnce(makeResult(ANON_HTML));
      const result = await fetcher.fetch(URL);

      expect(result.html).toBe(ANON_HTML);
      expect(mockLadder.render).toHaveBeenCalledTimes(2);
    });

    test('plain cacheable response IS reused (caching still works)', async () => {
      mockLadder.render.mockResolvedValueOnce(makeResult(ANON_HTML, 'Public'));
      await fetcher.fetch(URL);
      // Second call: should be a cache hit, ladder NOT called again
      const result = await fetcher.fetch(URL);

      expect(result.html).toBe(ANON_HTML);
      expect(mockLadder.render).toHaveBeenCalledOnce();
    });

    test('Vary: Cookie — different cookies produce separate cache entries', async () => {
      const htmlA = '<p>user A</p>';
      const htmlB = '<p>user B</p>';
      const varyRes = { headers: { vary: 'Cookie' } };

      mockLadder.render.mockResolvedValueOnce({ ...makeResult(htmlA), ...varyRes });
      await fetcher.fetch(URL, undefined, undefined, { cookie: 'session=A' });

      mockLadder.render.mockResolvedValueOnce({ ...makeResult(htmlB), ...varyRes });
      await fetcher.fetch(URL, undefined, undefined, { cookie: 'session=B' });

      // Both should have called the ladder (different secondary keys)
      expect(mockLadder.render).toHaveBeenCalledTimes(2);
    });
  });
});
