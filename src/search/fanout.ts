import { AllProvidersFailedError, BotChallengeError } from '../utils/errors.js';
import { Logger } from '../utils/logger.js';
import { canonicalizeUrl } from './canonicalize.js';
import { passesAllowedList, passesBlockedList, passesSystemBlocklist } from './filter.js';
import { searchProviderRequestsTotal, searchDegradedTotal } from '../obs/metrics.js';
import { CircuitBreaker } from './breaker.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from './types.js';

export interface FanoutOptions {
  signal: AbortSignal;
  requestId: string;
  deadlineMs: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

// Per-process per-provider circuit breakers.
// These are in-memory singletons; state resets on pod restart.
const breakers = new Map<string, CircuitBreaker>();

function getBreakerFor(providerName: string): CircuitBreaker {
  let b = breakers.get(providerName);
  if (!b) {
    b = new CircuitBreaker();
    breakers.set(providerName, b);
  }
  return b;
}

// Exported for tests only.
export function resetBreakers(): void {
  breakers.clear();
}

// Reciprocal Rank Fusion — canonicalise first so cross-provider agreement is
// detected even when URLs differ by tracking params (e.g. ?utm_source=).
// The original URL is preserved in the output so fetching uses the real link.
function applyRRF(candidates: ProviderResult[]): ProviderResult[] {
  // Group by canonical URL: accumulate RRF score from ALL provider ranks
  const rrfScores = new Map<string, number>();
  const firstSeen = new Map<string, ProviderResult>();

  for (const r of candidates) {
    const key = canonicalizeUrl(r.url);
    rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (60 + r.rank));
    if (!firstSeen.has(key)) firstSeen.set(key, r);
  }

  return [...firstSeen.values()].sort(
    (a, b) => (rrfScores.get(canonicalizeUrl(b.url)) ?? 0) - (rrfScores.get(canonicalizeUrl(a.url)) ?? 0),
  );
}

async function runProvider(
  provider: SearchProvider,
  q: SearchProviderQuery,
  opts: { signal: AbortSignal; requestId: string; deadlineMs: number },
): Promise<{ provider: string; results: ProviderResult[] } | { provider: string; error: unknown }> {
  const breaker = getBreakerFor(provider.name);

  if (breaker.isOpen()) {
    searchDegradedTotal.inc({ reason: 'breaker_open' });
    Logger.debug(`[fanout] ${provider.name} skipped — circuit breaker open`);
    return { provider: provider.name, error: new Error('circuit breaker open') };
  }

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Provider ${provider.name} timeout`)), opts.deadlineMs),
  );
  try {
    const results = await Promise.race([
      provider.search(q, { signal: opts.signal, requestId: opts.requestId }),
      deadline,
    ]);
    breaker.recordSuccess();
    searchProviderRequestsTotal.inc({ provider: provider.name, outcome: 'success' });
    return { provider: provider.name, results };
  } catch (err) {
    breaker.recordFailure();
    searchProviderRequestsTotal.inc({ provider: provider.name, outcome: 'error' });
    if (err instanceof BotChallengeError) {
      searchDegradedTotal.inc({ reason: 'bot_challenge' });
    }
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

    const filtered = results.filter(r => {
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
