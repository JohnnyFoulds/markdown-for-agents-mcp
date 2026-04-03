/**
 * URL Fetcher with Playwright
 * Handles JavaScript rendering and content extraction
 */

import { chromium, Browser, Page } from "playwright";

interface FetchResult {
  url: string;
  success: boolean;
  markdown: string;
  error?: string;
}

class Fetcher {
  private browser: Browser | null = null;
  private readonly timeout = 30000;

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
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetch(url: string): Promise<string> {
    await this.initialize();

    const browser = this.browser;
    if (!browser) {
      throw new Error("Browser not initialized");
    }

    const page = await browser.newPage();

    try {
      // Set realistic user agent
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

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
          document.querySelectorAll(selector).forEach((el) => el.remove());
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
