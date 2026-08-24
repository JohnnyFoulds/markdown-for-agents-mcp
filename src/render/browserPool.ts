import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { getConfig } from '../config.js';
import { generateBrowserUA, BROWSER_HEADERS } from '../http/fingerprint.js';
import { resolveProxy } from '../http/proxy.js';

export interface PageLease {
  readonly page: Page;
  readonly browserId: string;
  release(outcome: 'ok' | 'error' | 'crash'): Promise<void>;
}

interface BrowserSlot {
  id: string;
  browser: Browser;
  jobs: number;
  createdAt: number;
  replacing: boolean;
}

function cfg() {
  try { return getConfig(); } catch {
    return {
      BROWSER_POOL_SIZE: 1,
      RENDER_MAX_CONCURRENCY: 4,
      BROWSER_MAX_JOBS: 50,
      PLAYWRIGHT_PROXY: undefined as string | undefined,
      PLAYWRIGHT_PROXY_BYPASS: undefined as string | undefined,
      RENDER_SETTLE_MS: 2000,
      RENDER_BLOCK_RESOURCES: true,
    };
  }
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

export class BrowserPool {
  private slots: BrowserSlot[] = [];
  private inUse = 0;
  private readonly waitQueue: Array<() => void> = [];
  private readonly ua = generateBrowserUA();
  private initialized = false;

  private launchBrowser(): Promise<Browser> {
    const config = cfg();
    const proxyServer = resolveProxy(config.PLAYWRIGHT_PROXY, config.PLAYWRIGHT_PROXY_BYPASS);
    return chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      ...(proxyServer ? { proxy: { server: proxyServer.url, bypass: proxyServer.bypass } } : {}),
    });
  }

  async warmup(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const { BROWSER_POOL_SIZE } = cfg();
    for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
      const browser = await this.launchBrowser();
      this.slots.push({ id: `b${i}`, browser, jobs: 0, createdAt: Date.now(), replacing: false });
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.warmup();
  }

  private leastLoadedSlot(): BrowserSlot | undefined {
    return this.slots
      .filter(s => !s.replacing)
      .sort((a, b) => a.jobs - b.jobs)[0];
  }

  private async replaceSlot(slot: BrowserSlot): Promise<void> {
    slot.replacing = true;
    try { await slot.browser.close(); } catch { /* ignore */ }
    const browser = await this.launchBrowser();
    slot.browser = browser;
    slot.jobs = 0;
    slot.createdAt = Date.now();
    slot.replacing = false;
  }

  async acquire(signal?: AbortSignal): Promise<PageLease> {
    await this.ensureInitialized();
    const { RENDER_MAX_CONCURRENCY } = cfg();

    // Wait for a slot to free up if at capacity
    while (this.inUse >= RENDER_MAX_CONCURRENCY) {
      if (signal?.aborted) throw new Error('Render cancelled');
      await new Promise<void>(resolve => this.waitQueue.push(resolve));
    }
    if (signal?.aborted) throw new Error('Render cancelled');

    this.inUse++;
    const slot = this.leastLoadedSlot();
    if (!slot) throw new Error('BrowserPool: no slots available');

    slot.jobs++;
    const config = cfg();

    // Per-request context — fixes the cookie-leak bug
    const context: BrowserContext = await slot.browser.newContext({
      userAgent: this.ua,
      extraHTTPHeaders: BROWSER_HEADERS,
      viewport: { width: 1920, height: 1080 },
      javaScriptEnabled: true,
      bypassCSP: true,
      colorScheme: 'light',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    if (config.RENDER_BLOCK_RESOURCES) {
      await context.route('**/*', route => {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    const page = await context.newPage();

    const release = async (outcome: 'ok' | 'error' | 'crash') => {
      try { await context.close(); } catch { /* ignore */ }
      this.inUse = Math.max(0, this.inUse - 1);
      this.waitQueue.shift()?.();

      // Recycle browser if it's processed too many jobs
      if (outcome === 'crash' || slot.jobs >= config.BROWSER_MAX_JOBS) {
        // Launch replacement in the background — keep pool warm
        this.replaceSlot(slot).catch(() => {});
      }
    };

    return { page, browserId: slot.id, release };
  }

  async drain(graceMs = 5000): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.inUse > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    await Promise.all(this.slots.map(s => s.browser.close().catch(() => {})));
    this.slots = [];
    this.initialized = false;
  }

  stats() {
    return {
      browsers: this.slots.length,
      inUse: this.inUse,
      queued: this.waitQueue.length,
    };
  }

  isHealthy(): boolean {
    return this.slots.length > 0 && !this.slots.every(s => s.replacing);
  }
}

export const browserPool = new BrowserPool();
