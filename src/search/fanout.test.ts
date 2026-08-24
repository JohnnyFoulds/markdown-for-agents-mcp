import { describe, test, expect, beforeEach } from 'vitest';
import { fanout, resetBreakers } from './fanout.js';
import { AllProvidersFailedError, BotChallengeError } from '../utils/errors.js';
import { registry } from '../obs/metrics.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from './types.js';

async function getDegradedCount(reason: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find(m => m.name === 'search_degraded_total');
  if (!metric) return 0;
  const values = (metric as { values: Array<{ labels: Record<string, string>; value: number }> }).values;
  const v = values.find(x => x.labels.reason === reason);
  return v?.value ?? 0;
}

function fakeProvider(
  name: string,
  tier: 1 | 2 | 3,
  results: ProviderResult[] | Error,
  configured = true,
): SearchProvider {
  return {
    name,
    tier,
    isConfigured: () => configured,
    supports: () => ({ ok: true }),
    async search(_q, _opts) {
      if (results instanceof Error) throw results;
      return results;
    },
  };
}

function makeResult(provider: string, url: string, rank = 1): ProviderResult {
  return { title: 'T', url, snippet: '', domain: new URL(url).hostname, rank, provider };
}

const Q: SearchProviderQuery = { query: 'test', maxResults: 10 };
const OPTS = { signal: new AbortController().signal, requestId: 'r1', deadlineMs: 5000 };

describe('fanout', () => {
  beforeEach(() => resetBreakers());
  test('returns results from tier-1 provider', async () => {
    const p = fakeProvider('brave', 1, [makeResult('brave', 'https://a.com'), makeResult('brave', 'https://b.com', 2)]);
    const results = await fanout(Q, [p], OPTS);
    expect(results).toHaveLength(2);
    expect(results[0]!.url).toBe('https://a.com');
  });

  test('falls back to tier 2 when tier 1 fails', async () => {
    const t1 = fakeProvider('brave', 1, new Error('API down'));
    const t2 = fakeProvider('searxng', 2, [makeResult('searxng', 'https://c.com')]);
    const results = await fanout(Q, [t1, t2], OPTS);
    expect(results[0]!.url).toBe('https://c.com');
  });

  test('falls back to tier 3 when tier 1 and 2 both fail', async () => {
    const t1 = fakeProvider('brave', 1, new Error('down'));
    const t2 = fakeProvider('searxng', 2, new Error('down'));
    const t3 = fakeProvider('ddg', 3, [makeResult('ddg', 'https://d.com')]);
    const results = await fanout(Q, [t1, t2, t3], OPTS);
    expect(results[0]!.url).toBe('https://d.com');
  });

  test('throws AllProvidersFailedError when all fail', async () => {
    const t1 = fakeProvider('a', 1, new Error('a down'));
    const t2 = fakeProvider('b', 3, new Error('b down'));
    await expect(fanout(Q, [t1, t2], OPTS)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  test('throws AllProvidersFailedError when no configured providers', async () => {
    const p = fakeProvider('a', 1, [], false);
    await expect(fanout(Q, [p], OPTS)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  test('merges and deduplicates results from multiple tier-1 providers', async () => {
    const p1 = fakeProvider('brave', 1, [
      makeResult('brave', 'https://same.com', 1),
      makeResult('brave', 'https://only-brave.com', 2),
    ]);
    const p2 = fakeProvider('serper', 1, [
      makeResult('serper', 'https://same.com', 1),
      makeResult('serper', 'https://only-serper.com', 2),
    ]);
    const results = await fanout(Q, [p1, p2], OPTS);
    const urls = results.map(r => r.url);
    expect(new Set(urls).size).toBe(urls.length); // no duplicates
    expect(urls).toContain('https://same.com');
    // agreed-upon URL should rank first (higher RRF score)
    expect(results[0]!.url).toBe('https://same.com');
  });

  test('excludes domains in excludeDomains', async () => {
    const p = fakeProvider('brave', 1, [
      makeResult('brave', 'https://good.com'),
      makeResult('brave', 'https://bad.com', 2),
    ]);
    const results = await fanout(Q, [p], { ...OPTS, excludeDomains: ['bad.com'] });
    expect(results.every(r => r.domain !== 'bad.com')).toBe(true);
  });

  test('only includes domains in includeDomains when set', async () => {
    const p = fakeProvider('brave', 1, [
      makeResult('brave', 'https://allowed.com'),
      makeResult('brave', 'https://other.com', 2),
    ]);
    const results = await fanout(Q, [p], { ...OPTS, includeDomains: ['allowed.com'] });
    expect(results.every(r => r.domain === 'allowed.com')).toBe(true);
  });

  test('BotChallengeError from a provider is treated as provider failure', async () => {
    const t1 = fakeProvider('ddg', 3, new BotChallengeError('https://duckduckgo.com'));
    await expect(fanout(Q, [t1], OPTS)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  // RED (doc-fix): BotChallengeError must increment search_degraded_total{reason="bot_challenge"}
  // so runbook §3 Case B alert fires. Currently only searchProviderRequestsTotal is incremented.
  test('BotChallengeError increments search_degraded_total{reason="bot_challenge"}', async () => {
    const before = await getDegradedCount('bot_challenge');
    const t1 = fakeProvider('ddg', 3, new BotChallengeError('https://duckduckgo.com'));
    await fanout(Q, [t1], OPTS).catch(() => {});
    const after = await getDegradedCount('bot_challenge');
    expect(after).toBe(before + 1);
  });

  test('falls back when tier-1 returns empty results', async () => {
    const t1 = fakeProvider('brave', 1, []);
    const t3 = fakeProvider('ddg', 3, [makeResult('ddg', 'https://fallback.com')]);
    const results = await fanout(Q, [t1, t3], OPTS);
    expect(results[0]!.url).toBe('https://fallback.com');
  });

  // RED (Phase 4): dedup currently discards UTM variant before RRF sees it,
  // so the cross-provider agreement vote is lost and the agreed page ranks lower
  test('UTM variant from second provider contributes to RRF — canonical URL wins', async () => {
    // brave: winner.com/page at rank 3 (below also.com and other.com)
    // serper: winner.com/page?utm_source=serper at rank 1 → cross-provider agreement should boost it
    const brave = fakeProvider('brave', 1, [
      makeResult('brave', 'https://also.com', 1),
      makeResult('brave', 'https://other.com', 2),
      makeResult('brave', 'https://winner.com/page', 3),
    ]);
    const serper = fakeProvider('serper', 1, [
      makeResult('serper', 'https://winner.com/page?utm_source=serper', 1),
      makeResult('serper', 'https://other.com', 2),
    ]);
    const results = await fanout(Q, [brave, serper], OPTS);
    // After fix: both providers voted for winner.com → outranks also.com (single provider)
    expect(results[0]!.url).toBe('https://winner.com/page');
  });

  test('fetched URL is the original (non-canonical) form — canonicalisation is for ranking only', async () => {
    const p = fakeProvider('brave', 1, [
      makeResult('brave', 'https://example.com/page?utm_source=brave', 1),
    ]);
    const results = await fanout(Q, [p], OPTS);
    // The URL in the result should be the original, not the stripped canonical
    expect(results[0]!.url).toBe('https://example.com/page?utm_source=brave');
  });

  // RED: circuit breaker not wired into fanout yet — open breaker must skip the provider
  test('skips a provider whose circuit breaker is open', async () => {
    // searchCount tracks how many times the provider is called
    let searchCount = 0;
    const failing: SearchProvider = {
      name: 'flaky',
      tier: 1,
      isConfigured: () => true,
      supports: () => ({ ok: true }),
      async search() {
        searchCount++;
        throw new Error('upstream down');
      },
    };
    const fallback = fakeProvider('ddg', 3, [makeResult('ddg', 'https://ok.com')]);

    // Drive enough failures to open the breaker (6+ with ≥50% failure rate)
    for (let i = 0; i < 6; i++) {
      await fanout(Q, [failing, fallback], OPTS).catch(() => {});
    }
    const countBeforeOpen = searchCount;

    // After breaker opens, subsequent calls must NOT invoke the provider
    await fanout(Q, [failing, fallback], OPTS);
    // Provider must not have been called again after the breaker opened
    expect(searchCount).toBe(countBeforeOpen);
  });
});
