/**
 * URL Fetcher with Playwright
 * Handles JavaScript rendering and content extraction
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { Logger } from "./utils/logger.js";
import { LRUCache } from "./utils/cache.js";
import { validateUrl, isDomainBlocked } from "./utils/domainBlacklist.js";
import {
  DomainBlockedError,
  FetchTimeoutError,
  RedirectBlockedError,
  RedirectLoopError,
} from "./utils/errors.js";
import { getConfig } from "./config.js";

// URL cache: configured via config module (50MB max, 15min TTL)
// Exported for test visibility (cache-hit path testing)
export const urlCache = new LRUCache<string>({
  maxBytes: 50 * 1024 * 1024,
  ttl: 15 * 60 * 1000,
});

/**
 * Get fetcher configuration with fallback for initialization order
 * Used to handle cases where config is accessed before initialization
 */
function getFetcherConfig() {
  try {
    return getConfig();
  } catch {
    // Fallback if config not initialized yet
    return {
      FETCH_TIMEOUT_MS: 30000,
      MAX_CONCURRENT_FETCHES: 5,
      MAX_REDIRECTS: 10,
      MAX_CONTENT_LENGTH: 100000,
    };
  }
}

export interface FetchResult {
  url: string;
  success: boolean;
  markdown: string;
  error?: string;
  requestId?: string;
}

/**
 * Generates a generic user agent that blends in with regular browsers.
 * Randomizes the Chrome version to reduce fingerprinting consistency.
 */
function generateUserAgent(): string {
  const versions = ['132.0.0.0', '133.0.0.0', '134.0.0.0', '135.0.0.0'];
  const version = versions[Math.floor(Math.random() * versions.length)];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export class Fetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly userAgent = generateUserAgent();

  private getConfig() {
    return getFetcherConfig();
  }

  /**
   * Initialize browser and context once for reuse across fetches
   */
  async initialize(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      this.context = await this.browser.newContext({
        userAgent: this.userAgent,
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
        },
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        javaScriptEnabled: true,
        bypassCSP: true,
        colorScheme: 'light',
        reducedMotion: 'no-preference',
      });

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });

        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
        });
      });
    }
  }

  /**
   * Get or create a new page for fetching
   * Creates a fresh page for each fetch to isolate state
   */
  private async getPage(): Promise<Page> {
    await this.initialize();

    if (!this.context) {
      throw new Error("Browser context not initialized");
    }

    return await this.context.newPage();
  }

  /**
   * Close browser and context
   */
  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Check if redirect is allowed (same host only)
   * Blocks cross-origin redirects and blocked domains
   */
  private isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
    try {
      const original = new URL(originalUrl);
      const redirect = new URL(redirectUrl);

      // Block cross-origin redirects (hostname mismatch)
      if (original.hostname !== redirect.hostname) {
        return false;
      }

      // Block redirects that change port (e.g. example.com → example.com:8080)
      if (original.port !== redirect.port) {
        return false;
      }

      // Block if redirect domain is on blocklist
      if (isDomainBlocked(redirect.hostname)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch a single URL and return HTML content.
   * Checks the LRU cache first; on a miss, renders the page with Playwright,
   * handles same-origin redirects, truncates oversized content, and caches the result.
   * @param url - The URL to fetch
   * @param timeout - Optional request timeout in milliseconds (overrides config)
   * @param requestId - Optional request ID for correlated logging
   * @returns Resolved HTML string
   */
  async fetch(url: string, timeout?: number, requestId?: string): Promise<string> {
    const config = this.getConfig();
    const requestTimeout = timeout ?? config.FETCH_TIMEOUT_MS;
    const startTime = Date.now();

    // Validate URL format and check blocklist
    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Extract hostname once for logging and caching
    const hostname = new URL(url).hostname;

    // Try cache first (avoids redundant network requests)
    const cached = urlCache.get(url);
    if (cached) {
      Logger.logCacheHit(hostname, Buffer.byteLength(cached, 'utf8'), requestId);
      const stats = urlCache.getStats();
      Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
      return cached;
    }

    Logger.logCacheMiss(hostname, requestId);

    let currentUrl = url;
    let redirectCount = 0;
    let html = '';

    try {
      while (redirectCount < config.MAX_REDIRECTS) {
        const page = await this.getPage();

        try {
          // Navigate to URL with configurable timeout
          const pageResponse = await page.goto(currentUrl, {
            waitUntil: "networkidle",
            timeout: requestTimeout,
          });

          // Get response status and location header
          let status = 200;
          let locationHeader = '';

          if (pageResponse) {
            status = pageResponse.status();
            // headers() is always a function in Playwright's Response API
            const headers = pageResponse.headers();
            locationHeader = headers['location'] || '';
          }

          // Handle 3xx redirects manually
          if (status >= 300 && status < 400 && locationHeader) {
            // Resolve relative redirect URLs
            let redirectUrl: string;
            try {
              redirectUrl = new URL(locationHeader, currentUrl).href;
            } catch {
              throw new RedirectBlockedError(currentUrl, locationHeader);
            }

            // Check if redirect is permitted (same origin, same port, not blocked)
            if (!this.isPermittedRedirect(currentUrl, redirectUrl)) {
              throw new RedirectBlockedError(currentUrl, redirectUrl);
            }

            redirectCount++;
            await page.close();
            currentUrl = redirectUrl;
            continue;
          }

          html = await page.evaluate(() => {
            const elementsToRemove = [
              "nav", "footer", "header", "[role='navigation']",
              ".nav", ".navbar", ".sidebar", ".ads", ".advertisement",
              "iframe", "script", "style", "link", "meta"
            ];

            elementsToRemove.forEach((selector: string) => {
              document.querySelectorAll(selector).forEach((el: Element) => el.remove());
            });

            const mainContent =
              document.querySelector("main") ||
              document.querySelector("article") ||
              document.querySelector("#content") ||
              document.querySelector(".content") ||
              document.querySelector("body");

            return mainContent?.innerHTML || document.body.innerHTML;
          });

          await page.close();
          break;
        } catch (error) {
          await page.close();
          throw error;
        }
      }

      if (redirectCount >= config.MAX_REDIRECTS) {
        throw new RedirectLoopError(config.MAX_REDIRECTS);
      }

      if (html.length > config.MAX_CONTENT_LENGTH) {
        const truncatedSize = html.length;
        html = html.slice(0, config.MAX_CONTENT_LENGTH);
        Logger.warn(`[Truncated] ${url}: ${truncatedSize} -> ${config.MAX_CONTENT_LENGTH} chars`);
      }

      try {
        urlCache.set(url, html, Buffer.byteLength(html, 'utf8'));
        const stats = urlCache.getStats();
        Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
      } catch {
        // Cache write failed (e.g. eviction race), continue without caching
        Logger.warn(`[Cache] Failed to cache ${url}`);
      }

      const duration = Date.now() - startTime;
      Logger.logFetch({ url, duration, success: true, requestId });

      return html;
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

  /**
   * Fetch multiple URLs in parallel batches.
   * Splits URLs into batches of MAX_CONCURRENT_FETCHES and processes each batch concurrently.
   * @param urls - Array of URLs to fetch
   * @param timeout - Optional per-request timeout in milliseconds
   * @returns Array of FetchResult objects, one per input URL
   */
  async fetchMultiple(urls: string[], timeout?: number): Promise<FetchResult[]> {
    const config = this.getConfig();
    const results: FetchResult[] = [];
    const batches: string[][] = [];

    // Split URLs into batches for parallel processing
    for (let i = 0; i < urls.length; i += config.MAX_CONCURRENT_FETCHES) {
      batches.push(urls.slice(i, i + config.MAX_CONCURRENT_FETCHES));
    }

    // Process each batch concurrently
    for (const batch of batches) {
      const batchPromises = batch.map(async (url) => {
        try {
          const requestId = Logger.generateRequestId();
          const html = await this.fetch(url, timeout, requestId);
          return {
            url,
            success: true,
            markdown: html,
            requestId,
          } as FetchResult;
        } catch (error) {
          return {
            url,
            success: false,
            markdown: "",
            error: error instanceof Error ? error.message : "Unknown error",
            requestId: Logger.generateRequestId(),
          } as FetchResult;
        }
      });

      // Process all URLs in batch concurrently
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}

export const fetcher = new Fetcher();
