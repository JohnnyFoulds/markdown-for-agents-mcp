import { getConfig } from '../config.js';
import { Logger } from '../utils/logger.js';
import { isPolicyBlockError } from '../utils/errors.js';
import { needsEscalation } from './heuristic.js';
import { HttpTier } from './tiers/httpTier.js';
import { LightpandaTier } from './tiers/lightpandaTier.js';
import { PlaywrightTier } from './tiers/playwrightTier.js';
import type { RenderTier, RenderTierImpl, RenderRequest, RenderResult, EscalationRecord } from './types.js';
import { TIER_ORDER } from './types.js';
import { fetchRequestsTotal, fetchDurationSeconds, fetchEscalationsTotal } from '../obs/metrics.js';

const TIER_INDEX: Record<RenderTier, number> = { http: 0, lightpanda: 1, playwright: 2 };

function normalizePath(pathname: string): string {
  return pathname.replace(/\b[0-9a-f]{8,}\b/gi, ':hex').replace(/\b\d+\b/g, ':id');
}

function memoKey(url: string): string {
  const { hostname, pathname } = new URL(url);
  return `tier:${hostname}:${normalizePath(pathname)}`;
}

export class RenderLadder {
  private readonly tiers: RenderTierImpl[];
  private readonly tierMemo = new Map<string, RenderTier>();
  private readonly tierMemoDecayProb: number;

  constructor(
    tiers?: RenderTierImpl[],
    tierMemoDecayProb = 0.05,
  ) {
    this.tiers = tiers ?? [new HttpTier(), new LightpandaTier(), new PlaywrightTier()];
    this.tierMemoDecayProb = tierMemoDecayProb;
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const key = memoKey(req.url);

    // Tier memo: start at the memoised tier to amortise the wasted Tier-1 fetch
    let memoedTier: RenderTier | undefined;
    if (Math.random() > this.tierMemoDecayProb) {
      memoedTier = this.tierMemo.get(key);
    }

    const minTierIdx = Math.max(
      req.minTier ? TIER_INDEX[req.minTier] : 0,
      memoedTier ? TIER_INDEX[memoedTier] : 0,
    );
    const configMaxTierIdx = (() => {
      try { return TIER_INDEX[getConfig().RENDER_MAX_TIER]; } catch { return TIER_ORDER.length - 1; }
    })();
    const maxTierIdx = Math.min(
      req.maxTier ? TIER_INDEX[req.maxTier] : TIER_ORDER.length - 1,
      configMaxTierIdx,
    );

    const escalations: EscalationRecord[] = [];
    let currentTierIdx = minTierIdx;

    while (currentTierIdx <= maxTierIdx) {
      const impl = this.tiers[currentTierIdx]!;
      const tier = impl.tier;

      if (!(await impl.isAvailable())) {
        currentTierIdx++;
        continue;
      }

      const tierStart = Date.now();
      try {
        const result = await impl.render(req);
        const elapsed = (Date.now() - tierStart) / 1000;
        fetchDurationSeconds.observe({ tier }, elapsed);

        // Check if the result needs escalation, passing response headers so that
        // header-based bot-challenge detection (cf-mitigated, x-datadome-request,
        // x-incapsula-error) and the non-HTML content-type guard can fire.
        const { escalate, targetTier } = needsEscalation(result.html, result.status, result.headers ?? {});

        if (escalate) {
          const targetIdx = TIER_INDEX[targetTier];
          if (targetIdx > currentTierIdx && targetIdx <= maxTierIdx) {
            const record: EscalationRecord = { from: tier, to: targetTier, reason: 'heuristic' };
            escalations.push(record);
            fetchEscalationsTotal.inc({ from_tier: tier, to_tier: targetTier, reason: 'heuristic' });
            Logger.debug(`[Ladder] Escalating ${req.url}: ${tier} → ${targetTier}`);
            currentTierIdx = targetIdx;
            continue;
          }
        }

        // Success — update memo and return
        fetchRequestsTotal.inc({ tier, outcome: 'success' });
        this.tierMemo.set(key, tier);
        return { ...result, escalations: [...escalations, ...result.escalations] };

      } catch (err) {
        const elapsed = (Date.now() - tierStart) / 1000;
        fetchDurationSeconds.observe({ tier }, elapsed);
        fetchRequestsTotal.inc({ tier, outcome: 'error' });

        // Policy-block errors (SSRF, domain blocked, robots, …) must never
        // escalate to a higher tier. The guard fired correctly — escalating
        // would convert a block into a bypass via an unguarded browser path.
        if (isPolicyBlockError(err)) {
          throw err;
        }

        const nextTierIdx = currentTierIdx + 1;
        if (nextTierIdx <= maxTierIdx) {
          const nextTier = this.tiers[nextTierIdx]!.tier;
          const reason = `error:${err instanceof Error ? err.message.slice(0, 60) : String(err)}`;
          escalations.push({ from: tier, to: nextTier, reason });
          fetchEscalationsTotal.inc({ from_tier: tier, to_tier: nextTier, reason: 'error' });
          currentTierIdx = nextTierIdx;
        } else {
          throw err;
        }
      }
    }

    throw new Error(`All render tiers exhausted for ${req.url}`);
  }

  async warmup(): Promise<void> {
    for (const tier of this.tiers) {
      await tier.warmup?.();
    }
  }

  async drain(): Promise<void> {
    for (const tier of this.tiers) {
      await tier.drain?.();
    }
  }
}

export const renderLadder = new RenderLadder();
