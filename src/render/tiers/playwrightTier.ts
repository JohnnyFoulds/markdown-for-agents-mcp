import { getConfig } from '../../config.js';
import { browserPool } from '../browserPool.js';
import type { BrowserPool } from '../browserPool.js';
import type { RenderTierImpl, RenderRequest, RenderResult } from '../types.js';

function cfg() {
  try {
    return getConfig();
  } catch {
    return { FETCH_TIMEOUT_MS: 30_000, RENDER_SETTLE_MS: 2000 };
  }
}

export class PlaywrightTier implements RenderTierImpl {
  readonly tier = 'playwright' as const;

  constructor(private readonly pool: BrowserPool = browserPool) {}

  async isAvailable(): Promise<boolean> { return true; }

  async warmup(): Promise<void> { await this.pool.warmup(); }
  async drain(): Promise<void> { await this.pool.drain(); }

  async render(req: RenderRequest): Promise<RenderResult> {
    const config = cfg();
    const start = Date.now();
    const lease = await this.pool.acquire();

    try {
      const { page } = lease;

      // domcontentloaded + bounded settle — avoids networkidle hanging on long-poll/analytics
      const response = await page.goto(req.url, {
        waitUntil: 'domcontentloaded',
        timeout: req.timeoutMs,
      });

      // Bounded settle: wait for networkidle but don't block longer than RENDER_SETTLE_MS
      await Promise.race([
        page.waitForLoadState('networkidle').catch(() => {}),
        new Promise(r => setTimeout(r, config.RENDER_SETTLE_MS)),
      ]);

      const status = response?.status() ?? 200;

      const pageData = await page.evaluate((): { html: string; title: string } => ({
        html: document.documentElement.outerHTML,
        title: document.title || '',
      }));

      await lease.release('ok');
      return {
        url: req.url,
        html: pageData.html,
        title: pageData.title,
        status,
        tier: 'playwright',
        escalations: [],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      await lease.release('error');
      throw err;
    }
  }
}
