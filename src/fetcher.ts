/**
 * URL Fetcher with Playwright
 * Handles JavaScript rendering and content extraction
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import { Logger, FetchMetrics } from "./utils/logger.js";

// Import Readability lazily to avoid issues in test environments
function getReadability() {
  try {
    return require("readability");
  } catch {
    return null;
  }
}

export interface FetchResult {
  url: string;
  success: boolean;
  markdown: string;
  error?: string;
}

/**
 * Validates that a URL is safe to fetch
 * Prevents SSRF attacks by restricting to http/https protocols
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

class Fetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly timeout = 30000;
  private readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
   * Fetch a single URL and return HTML content
   */
  async fetch(url: string, timeout?: number): Promise<string> {
    // Validate URL before fetching
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }

    const page = await this.getPage();
    const requestTimeout = timeout ?? this.timeout;
    const startTime = Date.now();

    try {
      // Navigate to URL with configurable timeout
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: requestTimeout,
      });

      // Wait for content to stabilize
      await page.waitForTimeout(2000);

      // Extract main content using Readability library (if available)
      const content = await page.evaluate(() => {
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

        elementsToRemove.forEach((selector) => {
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

      const duration = Date.now() - startTime;
      Logger.logFetch({ url, duration, success: true });

      return content;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      Logger.logFetch({ url, duration, success: false, error: errorMessage });
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * Fetch multiple URLs and return results
   */
  async fetchMultiple(urls: string[], timeout?: number): Promise<FetchResult[]> {
    const results: FetchResult[] = [];

    for (const url of urls) {
      try {
        const html = await this.fetch(url, timeout);
        results.push({
          url,
          success: true,
          markdown: html,
        });
      } catch (error) {
        results.push({
          url,
          success: false,
          markdown: "",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return results;
  }
}

export const fetcher = new Fetcher();
