import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { getConfig } from '../config.js';
import { generateBrowserUA, BROWSER_HEADERS } from '../http/fingerprint.js';

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
      STEALTH_ENABLED: false,
    };
  }
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

/** Load playwright-extra + stealth plugin if available. Returns a chromium-compatible launcher. */
async function loadStealthChromium(): Promise<typeof chromium | null> {
  try {
    const { chromium: extraChromium } = await import('playwright-extra');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    extraChromium.use(StealthPlugin());
    return extraChromium as unknown as typeof chromium;
  } catch {
    return null;
  }
}

export class BrowserPool {
  private slots: BrowserSlot[] = [];
  private inUse = 0;
  private readonly waitQueue: Array<() => void> = [];
  private readonly ua = generateBrowserUA();
  private initialized = false;
  private stealthChromium: typeof chromium | null = null;
  private stealthLoaded = false;

  /**
   * @param proxyUrl Optional proxy URL for this pool. When provided, all browsers
   *   in this pool are launched with this proxy. When undefined, falls back to
   *   HTTP_PROXY_URL / PLAYWRIGHT_PROXY env vars (single-proxy mode).
   */
  constructor(private readonly proxyUrl?: string) {}

  private async getLauncher(): Promise<typeof chromium> {
    const config = cfg();
    if (config.STEALTH_ENABLED && !this.stealthLoaded) {
      this.stealthLoaded = true;
      this.stealthChromium = await loadStealthChromium();
      if (!this.stealthChromium) {
        // eslint-disable-next-line no-console
        console.error(
          '[BrowserPool] STEALTH_ENABLED=true but playwright-extra/puppeteer-extra-plugin-stealth ' +
          'are not installed. Falling back to plain chromium. ' +
          'Install with: npm install playwright-extra puppeteer-extra-plugin-stealth'
        );
      }
    }
    return this.stealthChromium ?? chromium;
  }

  private async launchBrowser(): Promise<Browser> {
    const config = cfg();
    const launcher = await this.getLauncher();

    // Resolve proxy: explicit pool proxy takes precedence; SOCKS5_UPSTREAM_URL
    // is used when set so all three tiers share the same egress path.
    const proxyUrl = this.proxyUrl
      ?? process.env['SOCKS5_UPSTREAM_URL']
      ?? process.env['HTTP_PROXY_URL']
      ?? process.env['PLAYWRIGHT_PROXY']
      ?? undefined;
    const proxyBypass = process.env['PLAYWRIGHT_PROXY_BYPASS'] ?? undefined;

    return launcher.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // --disable-dev-shm-usage: only when /dev/shm is not sized properly.
        // Set BROWSER_DISABLE_DEV_SHM=true as an escape hatch for restricted runtimes.
        ...(process.env['BROWSER_DISABLE_DEV_SHM'] === 'true' ? ['--disable-dev-shm-usage'] : []),
        '--disable-gpu',
      ],
      ...(proxyUrl ? { proxy: { server: proxyUrl, bypass: proxyBypass } } : {}),
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

      if (outcome === 'crash' || slot.jobs >= config.BROWSER_MAX_JOBS) {
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

// Default pool (no explicit proxy — uses env vars).
// The pool registry creates additional pools for rotation proxies.
export const browserPool = new BrowserPool();
