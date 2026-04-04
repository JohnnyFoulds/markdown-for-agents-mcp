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

// URL cache: configured via config module
const urlCache = new LRUCache<string>({
  maxBytes: 50 * 1024 * 1024,
  ttl: 15 * 60 * 1000,
});

// Helper to get config with fallback for initialization order
function getFetcherConfig() {
  try {
    return getConfig();
  } catch {
    // Fallback if config not initialized yet
    return {
      FETCH_TIMEOUT_MS: 30000,
      MAX_CONCURRENT_FETCHES: 5,
      STABILIZATION_DELAY_MS: 2000,
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
 * Generates a generic user agent that blends in with regular browsers
 */
function generateUserAgent(): string {
  const versions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0'];
  const version = versions[Math.floor(Math.random() * versions.length)];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

class Fetcher {
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
        },
      });
    }
  }

  /**
   * Get or create a new page for fetching
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
   */
  private isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
    try {
      const original = new URL(originalUrl);
      const redirect = new URL(redirectUrl);

      // Block cross-origin redirects
      if (original.hostname !== redirect.hostname) {
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
   * Fetch a single URL and return HTML content
   */
  async fetch(url: string, timeout?: number, requestId?: string): Promise<string> {
    const requestTimeout = timeout ?? this.getConfig().FETCH_TIMEOUT_MS;
    const startTime = Date.now();

    // Validate URL format and check blocklist
    const validation = validateUrl(url);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Try cache first
    const cached = urlCache.get(url);
    if (cached) {
      const hostname = new URL(url).hostname;
      Logger.logCacheHit(hostname, Buffer.byteLength(cached, 'utf8'), requestId);
      const stats = urlCache.getStats();
      Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
      return cached;
    }

    const hostname = new URL(url).hostname;
    Logger.logCacheMiss(hostname, requestId);

    let currentUrl = url;
    let redirectCount = 0;
    let html = '';

    try {
      while (redirectCount < this.getConfig().MAX_REDIRECTS) {
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
            // Handle both function and property access for headers
            const headers = typeof pageResponse.headers === 'function'
              ? pageResponse.headers()
              : pageResponse.headers || {};
            locationHeader = (headers as Record<string, string>).location || '';
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

            // Check if redirect is permitted
            if (!this.isPermittedRedirect(currentUrl, redirectUrl)) {
              throw new RedirectBlockedError(currentUrl, redirectUrl);
            }

            redirectCount++;
            await page.close();
            currentUrl = redirectUrl;
            continue;
          }

          // Wait for content to stabilize
          await page.waitForTimeout(this.getConfig().STABILIZATION_DELAY_MS);

          // Extract main content using Readability library (if available)
          html = await page.evaluate(() => {
            // Try to use Readability if available
            const Readability = (globalThis as any).Readability ||
              (typeof require !== 'undefined' ? require('readability') : null);

            if (Readability && Readability.Readability) {
              const article = new Readability.Readability(document).parse();
              return article?.content || document.body.innerHTML;
            }

            // Fallback to original selector-based extraction
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

          redirectCount = 0; // Reset redirect counter on success
          await page.close();
          break;
        } catch (error) {
          await page.close();
          throw error;
        }
      }

      if (redirectCount >= this.getConfig().MAX_REDIRECTS) {
        throw new RedirectLoopError(this.getConfig().MAX_REDIRECTS);
      }

      // Truncate content if too large
      if (html.length > this.getConfig().MAX_CONTENT_LENGTH) {
        const truncatedSize = html.length;
        html = html.slice(0, this.getConfig().MAX_CONTENT_LENGTH);
        console.warn(`[Truncated] ${url}: ${truncatedSize} -> ${this.getConfig().MAX_CONTENT_LENGTH} chars`);
      }

      // Cache successful result
      try {
        urlCache.set(url, html, Buffer.byteLength(html, 'utf8'));
        const stats = urlCache.getStats();
        Logger.updateCacheStats(stats.size, stats.totalBytes, stats.maxBytes);
      } catch {
        // Cache full or error, continue without caching
      }

      const duration = Date.now() - startTime;
      Logger.logFetch({ url, duration, success: true, requestId });

      return html;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      Logger.logFetch({ url, duration, success: false, error: errorMessage, requestId });

      // Re-throw specific errors
      if (error instanceof DomainBlockedError ||
          error instanceof RedirectBlockedError ||
          error instanceof RedirectLoopError) {
        throw error;
      }

      // Wrap timeout errors
      if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        throw new FetchTimeoutError(url, requestTimeout);
      }

      throw error;
    }
  }

  /**
   * Fetch multiple URLs with concurrency limiting and return results
   */
  async fetchMultiple(urls: string[], timeout?: number): Promise<FetchResult[]> {
    const results: FetchResult[] = [];
    const batches: string[][] = [];

    // Split URLs into batches respecting MAX_CONCURRENT_FETCHES
    for (let i = 0; i < urls.length; i += this.getConfig().MAX_CONCURRENT_FETCHES) {
      batches.push(urls.slice(i, i + this.getConfig().MAX_CONCURRENT_FETCHES));
    }

    // Process batches sequentially, with concurrent fetches within each batch
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

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}

export const fetcher = new Fetcher();
