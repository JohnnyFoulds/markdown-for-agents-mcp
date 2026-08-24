/**
 * Phase 5.1 — Paid-tier config swap proof.
 *
 * These tests are an artifact, not just assertions. They prove that "adding budget
 * is a config change" — the same code, purely by toggling BRAVE_API_KEY or
 * SERPER_API_KEY, switches between the free path (SearXNG → DDG) and the paid
 * path (Brave/Serper → SearXNG → DDG) with no source diff required.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeConfig, resetConfig } from '../config.js';
import { BraveProvider } from './providers/brave.js';
import { SerperProvider } from './providers/serper.js';
import { SearXNGProvider } from './providers/searxng.js';
import { DuckDuckGoProvider } from './providers/duckduckgo.js';
import { fanout, resetBreakers } from './fanout.js';
import type { SearchProvider, ProviderResult } from './types.js';

function makeResult(provider: string, url: string, rank = 1): ProviderResult {
  return { title: 'T', url, snippet: '', domain: new URL(url).hostname, rank, provider };
}

function fakeConfigured(name: string, tier: 1 | 2 | 3, results: ProviderResult[]): SearchProvider & { calls: number } {
  let calls = 0;
  return {
    name, tier,
    isConfigured: () => true,
    supports: () => ({ ok: true }),
    async search() { calls++; return results; },
    get calls() { return calls; },
  };
}

function fakeUnconfigured(name: string, tier: 1 | 2 | 3): SearchProvider & { calls: number } {
  let calls = 0;
  return {
    name, tier,
    isConfigured: () => false,
    supports: () => ({ ok: true }),
    async search() { calls++; return []; },
    get calls() { return calls; },
  };
}

const Q = { query: 'test query', maxResults: 10 };
const OPTS = { signal: new AbortController().signal, requestId: 'r1', deadlineMs: 5000 };

beforeEach(() => {
  resetConfig();
  resetBreakers();
});
afterEach(() => resetConfig());

describe('provider isConfigured() — gated by env vars alone', () => {
  test('BraveProvider.isConfigured() = true when BRAVE_API_KEY is set', () => {
    initializeConfig({ BRAVE_API_KEY: 'sk-brave-test' });
    expect(new BraveProvider().isConfigured()).toBe(true);
  });

  test('BraveProvider.isConfigured() = false when BRAVE_API_KEY is absent', () => {
    initializeConfig({});
    expect(new BraveProvider().isConfigured()).toBe(false);
  });

  test('SerperProvider.isConfigured() = true when SERPER_API_KEY is set', () => {
    initializeConfig({ SERPER_API_KEY: 'sk-serper-test' });
    expect(new SerperProvider().isConfigured()).toBe(true);
  });

  test('SerperProvider.isConfigured() = false when SERPER_API_KEY is absent', () => {
    initializeConfig({});
    expect(new SerperProvider().isConfigured()).toBe(false);
  });

  test('SearXNGProvider.isConfigured() = true when SEARXNG_URL is set', () => {
    initializeConfig({ SEARXNG_URL: 'http://searxng:8080' });
    expect(new SearXNGProvider().isConfigured()).toBe(true);
  });

  test('SearXNGProvider.isConfigured() = false when SEARXNG_URL is absent', () => {
    initializeConfig({});
    expect(new SearXNGProvider().isConfigured()).toBe(false);
  });
});

describe('paid-tier config swap — tier preemption', () => {
  test('tier-1 paid provider preempts tier-2/3 — lower tiers never called', async () => {
    const paid = fakeConfigured('brave', 1, [makeResult('brave', 'https://paid.com', 1)]);
    const searxng = fakeConfigured('searxng', 2, [makeResult('searxng', 'https://free.com', 1)]);
    const ddg = fakeConfigured('ddg', 3, [makeResult('ddg', 'https://fallback.com', 1)]);

    const results = await fanout(Q, [paid, searxng, ddg], OPTS);

    expect(results[0]!.url).toBe('https://paid.com');
    expect(searxng.calls).toBe(0);
    expect(ddg.calls).toBe(0);
  });

  test('free path used when no paid keys — SearXNG tier-2 satisfies query', async () => {
    const unpaidBrave = fakeUnconfigured('brave', 1);
    const unpaidSerper = fakeUnconfigured('serper', 1);
    const searxng = fakeConfigured('searxng', 2, [makeResult('searxng', 'https://free.com', 1)]);

    const results = await fanout(Q, [unpaidBrave, unpaidSerper, searxng], OPTS);

    expect(results[0]!.url).toBe('https://free.com');
    expect(unpaidBrave.calls).toBe(0);
    expect(unpaidSerper.calls).toBe(0);
  });

  test('free path falls through to DDG tier-3 when SearXNG also absent', async () => {
    const unpaidBrave = fakeUnconfigured('brave', 1);
    const unpaidSearxng = fakeUnconfigured('searxng', 2);
    const ddg = fakeConfigured('ddg', 3, [makeResult('ddg', 'https://ddg.com', 1)]);

    const results = await fanout(Q, [unpaidBrave, unpaidSearxng, ddg], OPTS);

    expect(results[0]!.url).toBe('https://ddg.com');
  });

  test('both tier-1 providers run concurrently when both keys set', async () => {
    const brave = fakeConfigured('brave', 1, [
      makeResult('brave', 'https://brave.com', 1),
      makeResult('brave', 'https://shared.com', 2),
    ]);
    const serper = fakeConfigured('serper', 1, [
      makeResult('serper', 'https://serper.com', 1),
      makeResult('serper', 'https://shared.com', 2),
    ]);
    const ddg = fakeConfigured('ddg', 3, [makeResult('ddg', 'https://ddg.com', 1)]);

    const results = await fanout(Q, [brave, serper, ddg], OPTS);

    // Both paid providers ran — cross-provider agreement boosts shared.com
    expect(brave.calls).toBe(1);
    expect(serper.calls).toBe(1);
    expect(ddg.calls).toBe(0); // tier-3 never called
    expect(results.map(r => r.url)).toContain('https://shared.com');
    // shared.com appears in both — RRF boosts it above single-provider results
    expect(results[0]!.url).toBe('https://shared.com');
  });
});

describe('config-only swap — no code diff between free and paid run', () => {
  test('active providers change purely by adding BRAVE_API_KEY to config', () => {
    // Free config: no paid keys
    initializeConfig({});
    const freeSet = [new BraveProvider(), new SerperProvider(), new SearXNGProvider(), new DuckDuckGoProvider()]
      .filter(p => p.isConfigured())
      .map(p => p.name);

    expect(freeSet).not.toContain('brave');
    expect(freeSet).not.toContain('serper');

    // Paid config: BRAVE_API_KEY added — same code, different config
    resetConfig();
    initializeConfig({ BRAVE_API_KEY: 'sk-brave', SEARXNG_URL: 'http://searxng:8080' });
    const paidSet = [new BraveProvider(), new SerperProvider(), new SearXNGProvider(), new DuckDuckGoProvider()]
      .filter(p => p.isConfigured())
      .map(p => p.name);

    expect(paidSet).toContain('brave');
    expect(paidSet).toContain('searxng');
    expect(paidSet).not.toContain('serper'); // only brave key set, not serper
  });

  test('removing BRAVE_API_KEY reverts cleanly to free path — no code diff', () => {
    initializeConfig({ BRAVE_API_KEY: 'sk-brave' });
    expect(new BraveProvider().isConfigured()).toBe(true);

    resetConfig();
    initializeConfig({});
    expect(new BraveProvider().isConfigured()).toBe(false);
  });

  test('paid tier has higher priority in fanout — tier-1 preempts free tiers by design', async () => {
    // Simulate the DEFAULT_PROVIDERS array behaviour: same providers, config controls activation
    const allProviders = [
      fakeConfigured('brave', 1, [makeResult('brave', 'https://paid-result.com', 1)]),
      fakeUnconfigured('serper', 1),
      fakeConfigured('searxng', 2, [makeResult('searxng', 'https://free-result.com', 1)]),
      fakeConfigured('ddg', 3, [makeResult('ddg', 'https://ddg-result.com', 1)]),
    ];

    const results = await fanout(Q, allProviders, OPTS);
    // Tier-1 (brave) wins — paid result appears first
    expect(results[0]!.url).toBe('https://paid-result.com');
  });
});
