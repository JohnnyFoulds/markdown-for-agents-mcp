import { chromium } from 'playwright';
import { getConfig } from '../../config.js';
import type { RenderTierImpl, RenderRequest, RenderResult } from '../types.js';

// Lightpanda speaks CDP — connect the same way as Playwright's connectOverCDP.
// Ships disabled by default (LIGHTPANDA_ENABLED=false).
// AGPL-3.0: run as a separate process/sidecar, never import/vendor.

interface CircuitState {
  failures: number;
  total: number;
  openUntil: number;
}

interface LightpandaConfig {
  LIGHTPANDA_ENABLED: boolean;
  LIGHTPANDA_CDP_URL: string;
  LIGHTPANDA_MAX_FAILURE_RATE: number;
}

export class LightpandaTier implements RenderTierImpl {
  readonly tier = 'lightpanda' as const;
  private circuit: CircuitState = { failures: 0, total: 0, openUntil: 0 };
  private readonly injectedCfg: LightpandaConfig | undefined;

  constructor(cfg?: LightpandaConfig) {
    this.injectedCfg = cfg;
  }

  private cfg(): LightpandaConfig {
    if (this.injectedCfg) return this.injectedCfg;
    try {
      return getConfig();
    } catch {
      return {
        LIGHTPANDA_ENABLED: false,
        LIGHTPANDA_CDP_URL: 'ws://127.0.0.1:9222',
        LIGHTPANDA_MAX_FAILURE_RATE: 0.4,
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    const config = this.cfg();
    if (!config.LIGHTPANDA_ENABLED) return false;
    if (Date.now() < this.circuit.openUntil) return false;
    return true;
  }

  private recordResult(success: boolean): void {
    const config = this.cfg();
    this.circuit.total++;
    if (!success) this.circuit.failures++;

    // Rolling window of 50
    if (this.circuit.total > 50) {
      this.circuit.total = 25;
      this.circuit.failures = Math.floor(this.circuit.failures / 2);
    }

    const failureRate = this.circuit.total > 0 ? this.circuit.failures / this.circuit.total : 0;
    if (failureRate > config.LIGHTPANDA_MAX_FAILURE_RATE) {
      this.circuit.openUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const config = this.cfg();
    const start = Date.now();

    try {
      const browser = await chromium.connectOverCDP(config.LIGHTPANDA_CDP_URL, {
        timeout: req.timeoutMs,
      });

      try {
        const context = await browser.newContext({ javaScriptEnabled: true });
        const page = await context.newPage();
        try {
          await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: req.timeoutMs });
          const pageData = await page.evaluate((): { html: string; title: string } => ({
            html: document.documentElement.outerHTML,
            title: document.title || '',
          }));
          this.recordResult(true);
          return {
            url: req.url,
            html: pageData.html,
            title: pageData.title,
            status: 200,
            tier: 'lightpanda',
            escalations: [],
            durationMs: Date.now() - start,
          };
        } finally {
          await context.close().catch(() => {});
        }
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (err) {
      this.recordResult(false);
      throw err;
    }
  }
}
