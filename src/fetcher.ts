/**
 * URL Fetcher with Playwright
 * Handles JavaScript rendering and content extraction
 */

import { chromium, Page } from "playwright";

interface FetchResult {
  url: string;
  success: boolean;
  markdown: string;
  error?: string;
}

class Fetcher {
  private browser: unknown | null = null;
  private readonly timeout = 30000;

  async initialize(): Promise<void> {
    if (!this.browser) {
      const browser = await (chromium as any).launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });

      // Create a default context with user agent
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      // Store the context as well
      (browser as any).__defaultContext = context;
      this.browser = browser;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      const browser: any = this.browser;
      if (browser.__defaultContext) {
        await browser.__defaultContext.close();
      }
      await browser.close();
      this.browser = null;
    }
  }

  async fetch(url: string): Promise<string> {
    const browser: any = await (chromium as any).launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      const page = await context.newPage();

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
      await browser.close();
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

    await this.close();
    return results;
  }
}

export const fetcher = new Fetcher();
