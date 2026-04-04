/**
 * URL Fetcher with Playwright
 * Handles JavaScript rendering and content extraction
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";

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
  async fetch(url: string): Promise<string> {
    // Validate URL before fetching
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL: ${url}`);
    }

    const page = await this.getPage();

    try {
      // Navigate to URL with timeout
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: this.timeout,
      });

      // Wait for content to stabilize
      await page.waitForTimeout(2000);

      // Extract main content using Readability-style approach
      const content = await page.evaluate(() => {
        // Remove unnecessary elements
        const elementsToRemove = [
          "nav",
          "footer",
          "header",
          "[role='navigation']",
          ".nav",
          ".navbar",
          ".sidebar",
          ".ads",
          ".advertisement",
          "iframe",
          "script",
          "style",
          "link",
          "meta",
        ];

        elementsToRemove.forEach((selector) => {
          document.querySelectorAll(selector).forEach((el: Element) => el.remove());
        });

        // Find main content
        const mainContent =
          document.querySelector("main") ||
          document.querySelector("article") ||
          document.querySelector("#content") ||
          document.querySelector(".content") ||
          document.querySelector("body");

        if (!mainContent) {
          return document.body.innerHTML;
        }

        return mainContent.innerHTML;
      });

      return content;
    } finally {
      await page.close();
    }
  }

  /**
   * Fetch multiple URLs and return results
   */
  async fetchMultiple(urls: string[]): Promise<FetchResult[]> {
    const results: FetchResult[] = [];

    for (const url of urls) {
      try {
        const html = await this.fetch(url);
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
