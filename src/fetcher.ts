/**
 * URL Fetcher — thin public API over the 3-tier render ladder.
 * Caching and URL validation live here; rendering is delegated to renderLadder.
 */

import { Logger } from "./utils/logger.js";
import { LRUCache } from "./utils/cache.js";
import { validateUrl } from "./utils/domainBlacklist.js";
import {
  DomainBlockedError,
  FetchTimeoutError,
  RedirectBlockedError,
  RedirectLoopError,
} from "./utils/errors.js";
import { getConfig } from "./config.js";
import { renderLadder } from "./render/ladder.js";
import { isStorable, freshnessMs, secondaryKey } from "./http/cachePolicy.js";
import { cacheNotStoredTotal } from "./obs/metrics.js";

/**
 * Lazy wrapper: initialises the inner LRUCache from config on first use so
 * CACHE_MAX_BYTES and CACHE_TTL_MS are actually honoured. Tests call
 * clear() before each case — that nulls _inner, causing re-init from the
 * then-current config on the next access.
 */
class LazyLRUCache<T> {
  private _inner: LRUCache<T> | null = null;
  private readonly getOpts: () => { maxBytes: number; ttl: number };

  constructor(getOpts: () => { maxBytes: number; ttl: number }) {
    this.getOpts = getOpts;
  }

  private get inner(): LRUCache<T> {
    if (!this._inner) this._inner = new LRUCache<T>(this.getOpts());
    return this._inner;
  }

  get(key: string): T | undefined { return this.inner.get(key); }
  set(key: string, value: T, bytes?: number, ttlMs?: number): void { this.inner.set(key, value, bytes, ttlMs); }
  delete(key: string): boolean { return this.inner.delete(key); }
  clear(): void { this._inner?.clear(); this._inner = null; }
  getStats() { return this.inner.getStats(); }
  get size(): number { return this.inner.size; }
  get totalBytes(): number { return this.inner.totalBytes; }
  get maxBytes(): number { return this.inner.maxBytes; }
}

export const urlCache = new LazyLRUCache<string>(() => {
  const cfg = getFetcherConfig();
  return { maxBytes: cfg.CACHE_MAX_BYTES, ttl: cfg.CACHE_TTL_MS };
});

export const titleCache = new LazyLRUCache<string>(() => {
  const cfg = getFetcherConfig();
  // title strings are small; budget 1/50 of the HTML cache, floor 1 MB
  return { maxBytes: Math.max(1024 * 1024, Math.floor(cfg.CACHE_MAX_BYTES / 50)), ttl: cfg.CACHE_TTL_MS };
});

/**
 * Result of a single page fetch, including rendered HTML and extracted page title.
 */
export interface PageResult {
  html: string;
  title: string;
}

function getFetcherConfig() {
  try {
    return getConfig();
  } catch {
    return {
      FETCH_TIMEOUT_MS: 30000,
      MAX_CONCURRENT_FETCHES: 5,
      MAX_REDIRECTS: 10,
      MAX_CONTENT_LENGTH: 100000,
      CACHE_MAX_BYTES: 50 * 1024 * 1024,
      CACHE_TTL_MS: 15 * 60 * 1000,
    };
  }
}

export interface FetchResult {
  url: string;
  success: boolean;
  markdown: string;
  title: string;
  error?: string;
  requestId?: string;
}

export class Fetcher {
  private getConfig() {
    return getFetcherConfig();
  }

  async initialize(): Promise<void> {
    await renderLadder.warmup();
  }

  async close(): Promise<void> {
    await renderLadder.drain();
  }

  async fetch(url: string, timeout?: number, requestId?: string, headers?: Record<string, string>): Promise<PageResult> {
    const config = this.getConfig();
    const requestTimeout = timeout ?? config.FETCH_TIMEOUT_MS;
    const startTime = Date.now();

    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const hostname = new URL(url).hostname;

    // §4.1 Vary: the full cache key is the URL plus a secondary key derived from
    // request headers named by the origin's Vary response header.  For a plain
    // (non-Vary) response this appends nothing, so the key is identical to the URL.
    // We compute a provisional secondary key from the request headers before the
    // fetch; the definitive key is recomputed after the response arrives.
    const reqHeaders = headers ?? {};
    const provisionalKey = url + (secondaryKey(reqHeaders, {}) || '');

    const cached = urlCache.get(provisionalKey);
    if (cached) {
      Logger.logCacheHit(hostname, Buffer.byteLength(cached, 'utf8'), requestId);
      const stats = urlCache.getStats();
      Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
      return { html: cached, title: titleCache.get(provisionalKey) ?? '' };
    }

    Logger.logCacheMiss(hostname, requestId);

    try {
      const result = await renderLadder.render({ url, timeoutMs: requestTimeout, requestId, headers });

      let { html } = result;
      const pageTitle = result.title;
      const resHeaders = result.headers ?? {};

      if (html.length > config.MAX_CONTENT_LENGTH) {
        const truncatedSize = html.length;
        html = html.slice(0, config.MAX_CONTENT_LENGTH);
        Logger.warn(`[Truncated] ${url}: ${truncatedSize} -> ${config.MAX_CONTENT_LENGTH} chars`);
      }

      // RFC 9111 shared-cache policy: check storability before writing to cache.
      const storability = isStorable(reqHeaders, resHeaders);
      if (!storability.storable) {
        cacheNotStoredTotal.inc({ reason: storability.reason });
      } else {
        // §4.1 definitive secondary key using the actual Vary response header
        const sk = secondaryKey(reqHeaders, resHeaders);
        // sk includes 'vary-star:…' sentinel for Vary:* — which will never match cache
        const cacheKey = url + (sk || '');
        // §4.2 freshness capped at CACHE_TTL_MS
        const ttlMs = freshnessMs(resHeaders, config.CACHE_TTL_MS);
        try {
          urlCache.set(cacheKey, html, Buffer.byteLength(html, 'utf8'), ttlMs);
          titleCache.set(cacheKey, pageTitle, Buffer.byteLength(pageTitle, 'utf8'), ttlMs);
          const stats = urlCache.getStats();
          Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
        } catch {
          Logger.warn(`[Cache] Failed to cache ${url}`);
        }
      }

      const duration = Date.now() - startTime;
      Logger.logFetch({ url, duration, success: true, requestId });

      return { html, title: pageTitle };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      Logger.logFetch({ url, duration, success: false, error: errorMessage, requestId });

      if (
        error instanceof DomainBlockedError ||
        error instanceof RedirectBlockedError ||
        error instanceof RedirectLoopError
      ) {
        throw error;
      }

      if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        throw new FetchTimeoutError(url, requestTimeout);
      }

      throw error;
    }
  }

  async fetchMultiple(urls: string[], timeout?: number, headers?: Record<string, string>): Promise<FetchResult[]> {
    const config = this.getConfig();
    const results: FetchResult[] = [];
    const batches: string[][] = [];

    for (let i = 0; i < urls.length; i += config.MAX_CONCURRENT_FETCHES) {
      batches.push(urls.slice(i, i + config.MAX_CONCURRENT_FETCHES));
    }

    for (const batch of batches) {
      const batchPromises = batch.map(async (url) => {
        try {
          const requestId = Logger.generateRequestId();
          const pageResult = await this.fetch(url, timeout, requestId, headers);
          return {
            url,
            success: true,
            markdown: pageResult.html,
            title: pageResult.title,
            requestId,
          } as FetchResult;
        } catch (error) {
          return {
            url,
            success: false,
            markdown: "",
            title: "",
            error: error instanceof Error ? error.message : "Unknown error",
            requestId: Logger.generateRequestId(),
          } as FetchResult;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}

export const fetcher = new Fetcher();
