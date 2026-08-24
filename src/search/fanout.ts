import { AllProvidersFailedError } from '../utils/errors.js';
import { Logger } from '../utils/logger.js';
import { deduplicateByCanonical } from './canonicalize.js';
import { passesAllowedList, passesBlockedList, passesSystemBlocklist } from './filter.js';
import { searchProviderRequestsTotal } from '../obs/metrics.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from './types.js';

export interface FanoutOptions {
  signal: AbortSignal;
  requestId: string;
  deadlineMs: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

// Reciprocal Rank Fusion — rewards agreement across providers without calibration
function rrfScore(results: ProviderResult[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const r of results) {
    const key = r.url;
    scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + r.rank));
  }
  return scores;
}

function applyRRF(candidates: ProviderResult[]): ProviderResult[] {
  const scores = rrfScore(candidates);
  const seen = new Map<string, ProviderResult>();

  for (const r of candidates) {
    if (!seen.has(r.url)) seen.set(r.url, r);
  }

  return [...seen.values()].sort((a, b) => (scores.get(b.url) ?? 0) - (scores.get(a.url) ?? 0));
}

async function runProvider(
  provider: SearchProvider,
  q: SearchProviderQuery,
  opts: { signal: AbortSignal; requestId: string; deadlineMs: number },
): Promise<{ provider: string; results: ProviderResult[] } | { provider: string; error: unknown }> {
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Provider ${provider.name} timeout`)), opts.deadlineMs),
  );
  try {
    const results = await Promise.race([
      provider.search(q, { signal: opts.signal, requestId: opts.requestId }),
      deadline,
    ]);
    searchProviderRequestsTotal.inc({ provider: provider.name, outcome: 'success' });
    return { provider: provider.name, results };
  } catch (err) {
    searchProviderRequestsTotal.inc({ provider: provider.name, outcome: 'error' });
    Logger.warn(`[fanout] ${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { provider: provider.name, error: err };
  }
}

export async function fanout(
  query: SearchProviderQuery,
  providers: SearchProvider[],
  opts: FanoutOptions,
): Promise<ProviderResult[]> {
  const { includeDomains, excludeDomains } = opts;

  const eligible = providers.filter(p => {
    if (!p.isConfigured()) return false;
    const s = p.supports(query);
    if (!s.ok) {
      Logger.debug(`[fanout] ${p.name} skipped: ${s.reason}`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    throw new AllProvidersFailedError({ _: 'No configured providers available' });
  }

  const tiers = [1, 2, 3] as const;
  const errors: Array<{ provider: string; error: unknown }> = [];

  for (const tier of tiers) {
    const tierProviders = eligible.filter(p => p.tier === tier);
    if (tierProviders.length === 0) continue;

    const outcomes = await Promise.all(
      tierProviders.map(p => runProvider(p, query, opts)),
    );

    const results: ProviderResult[] = [];
    for (const outcome of outcomes) {
      if ('error' in outcome) {
        errors.push(outcome);
      } else {
        results.push(...outcome.results);
      }
    }

    if (results.length === 0) continue;

    // Dedup, filter, RRF
    const deduped = deduplicateByCanonical(results);

    const filtered = deduped.filter(r => {
      if (!passesSystemBlocklist(r.domain)) return false;
      if (!passesAllowedList(r.domain, includeDomains)) return false;
      if (!passesBlockedList(r.domain, excludeDomains)) return false;
      return true;
    });

    const ranked = applyRRF(filtered);
    return ranked.slice(0, query.maxResults);
  }

  const causes = Object.fromEntries(
    errors.map(e => [e.provider, e.error instanceof Error ? e.error.message : String(e.error)]),
  );
  throw new AllProvidersFailedError(causes);
}
