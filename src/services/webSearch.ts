import { createHash } from 'node:crypto';
import { fetcher } from '../fetcher.js';
import { extract } from '../extract/pipeline.js';
import { getConfig } from '../config.js';
import { Logger } from '../utils/logger.js';
import { fanout } from '../search/fanout.js';
import { braveProvider } from '../search/providers/brave.js';
import { serperProvider } from '../search/providers/serper.js';
import { searXNGProvider } from '../search/providers/searxng.js';
import { DuckDuckGoProvider, duckDuckGoProvider, parseDuckDuckGoHtml } from '../search/providers/duckduckgo.js';
import { passesAllowedList, passesBlockedList, domainOf } from '../search/filter.js';
import { chunkMarkdown, getReranker } from '../rank/index.js';
import { rerankDurationSeconds, searchCacheTotal } from '../obs/metrics.js';
import { getStores } from '../store/factory.js';
import type { SearchProvider } from '../search/types.js';
import type { HttpClient } from '../http/types.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  markdownResults?: { url: string; markdown: string }[];
  durationMs: number;
}

export type SearchDepth = 'fast' | 'basic' | 'advanced';

export interface SearchOptions {
  query: string;
  maxResults?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  fetchResults?: boolean;
  timeout?: number;
  searchDepth?: SearchDepth;
  chunksPerSource?: number;
}

const DEFAULT_PROVIDERS: SearchProvider[] = [
  braveProvider, serperProvider, searXNGProvider, duckDuckGoProvider,
];

function buildCacheKey(opts: SearchOptions & { profile: string }): string {
  const { query, maxResults = 10, allowedDomains, blockedDomains, searchDepth = 'fast', chunksPerSource = 1, profile } = opts;
  const digest = createHash('sha256').update(JSON.stringify({
    query, maxResults, allowedDomains, blockedDomains, searchDepth, chunksPerSource,
  })).digest('hex').slice(0, 16);
  return `search:${profile}:${digest}`;
}

async function getCachedResponse(key: string): Promise<SearchResponse | undefined> {
  try {
    const buf = await getStores().kv.get(key);
    if (!buf) return undefined;
    return JSON.parse(buf.toString('utf8')) as SearchResponse;
  } catch {
    return undefined;
  }
}

async function setCachedResponse(key: string, response: SearchResponse, ttlMs: number): Promise<void> {
  try {
    const buf = Buffer.from(JSON.stringify(response), 'utf8');
    await getStores().kv.set(key, buf, ttlMs);
  } catch {
    // stores not initialized or unavailable — silently skip caching
  }
}

// Exported for tests that import from this module
export function parseSearchResults(html: string): SearchResult[] {
  return parseDuckDuckGoHtml(html).map(({ title, url, snippet, domain }) => ({ title, url, snippet, domain }));
}

export function filterResults(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[],
): SearchResult[] {
  return results.filter(r => {
    const domain = r.domain ?? domainOf(r.url);
    return passesAllowedList(domain, allowedDomains) && passesBlockedList(domain, blockedDomains);
  });
}

export async function webSearch(options: SearchOptions): Promise<SearchResponse> {
  const startTime = Date.now();
  const {
    query,
    maxResults = 10,
    allowedDomains,
    blockedDomains,
    fetchResults,
    timeout,
    searchDepth = 'fast',
    chunksPerSource = 1,
  } = options;

  const config = getConfig();
  const profile = config.SEARXNG_ENGINE_PROFILE;

  // Cache lookup — skip for fetched/reranked results since those are large and
  // per-request freshness matters more than latency.
  const cacheKey = buildCacheKey({ ...options, profile });
  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    searchCacheTotal.inc({ result: 'hit' });
    return { ...cached, durationMs: Date.now() - startTime };
  }
  searchCacheTotal.inc({ result: 'miss' });
  const searchTimeout = timeout ?? config.WEB_SEARCH_DEFAULT_TIMEOUT_MS;
  const requestId = Logger.generateRequestId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), searchTimeout);

  try {
    const fanoutMax = searchDepth === 'advanced'
      ? Math.max(maxResults * 2, config.SEARCH_FANOUT_RESULTS)
      : Math.max(maxResults, 10);

    const providerResults = await fanout(
      { query, maxResults: fanoutMax, includeDomains: allowedDomains, excludeDomains: blockedDomains },
      DEFAULT_PROVIDERS,
      { signal: controller.signal, requestId, deadlineMs: searchTimeout, includeDomains: allowedDomains, excludeDomains: blockedDomains },
    );

    const results: SearchResult[] = providerResults.slice(0, maxResults).map(r => ({
      title: r.title, url: r.url, snippet: r.snippet, domain: r.domain,
    }));

    let markdownResults: { url: string; markdown: string }[] | undefined;
    // fetchResults: true → always fetch; false → never; undefined → derive from depth
    const shouldFetch = fetchResults === true || (fetchResults !== false && searchDepth !== 'fast');

    if (shouldFetch && results.length > 0) {
      const titleMap = new Map(results.map(r => [r.url, r.title]));
      const fetched = await fetcher.fetchMultiple(results.map(r => r.url), searchTimeout);

      const reranker = getReranker();
      const ranked: { url: string; markdown: string }[] = [];

      for (const r of fetched) {
        if (!r.success) {
          ranked.push({ url: r.url, markdown: `# Error fetching ${r.url}\n\n${r.error ?? 'Unknown error'}\n` });
          continue;
        }
        const extracted = extract(r.markdown, { url: r.url, title: r.title ?? titleMap.get(r.url) ?? '' });

        if (searchDepth === 'advanced' && reranker.isReady()) {
          const chunks = chunkMarkdown(extracted.markdown, r.url);
          if (chunks.length > 0) {
            const rerankTimer = rerankDurationSeconds.startTimer({ backend: reranker.name });
            const scored = await reranker.rank(query, chunks, { signal: controller.signal });
            rerankTimer();
            ranked.push({ url: r.url, markdown: scored.slice(0, chunksPerSource).map(c => c.text).join('\n\n---\n\n') });
            continue;
          }
        }

        ranked.push({ url: r.url, markdown: extracted.markdown });
      }
      markdownResults = ranked;
    }

    const response: SearchResponse = { query, results, markdownResults, durationMs: Date.now() - startTime };
    // Store in cache (fire-and-forget — never block the response on cache write)
    void setCachedResponse(cacheKey, response, config.SEARCH_CACHE_TTL_MS);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// Backward-compat entry point: when an httpClient is injected (tests), run only
// the DDG provider directly so existing tests don't need rewriting.
export async function duckDuckGoSearch(
  options: SearchOptions,
  httpClient?: HttpClient,
): Promise<SearchResponse> {
  if (!httpClient) return webSearch(options);

  const startTime = Date.now();
  const { query, maxResults = 10, allowedDomains, blockedDomains, fetchResults = false, timeout } = options;
  const config = getConfig();
  const searchTimeout = timeout ?? config.WEB_SEARCH_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), searchTimeout);

  try {
    const provider = new DuckDuckGoProvider(httpClient);
    let results = await provider.search({ query, maxResults }, { signal: controller.signal, requestId: Logger.generateRequestId() });
    results = results.filter(r => passesAllowedList(r.domain, allowedDomains) && passesBlockedList(r.domain, blockedDomains));

    const searchResults: SearchResult[] = results.slice(0, maxResults).map(r => ({
      title: r.title, url: r.url, snippet: r.snippet, domain: r.domain,
    }));

    let markdownResults: { url: string; markdown: string }[] | undefined;

    if (fetchResults && searchResults.length > 0) {
      const fetched = await fetcher.fetchMultiple(searchResults.map(r => r.url), searchTimeout);
      markdownResults = fetched.map(r => {
        if (!r.success) {
          return { url: r.url, markdown: `# Error fetching ${r.url}\n\n${r.error ?? 'Unknown error'}\n` };
        }
        return { url: r.url, markdown: extract(r.markdown, { url: r.url, title: r.title ?? '' }).markdown };
      });
    }

    return { query, results: searchResults, markdownResults, durationMs: Date.now() - startTime };
  } catch (error) {
    return {
      query,
      results: [],
      durationMs: Date.now() - startTime,
      markdownResults: [{ url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, markdown: `# Search Error\n\nFailed to perform search: ${error instanceof Error ? error.message : 'Unknown error'}\n` }],
    };
  } finally {
    clearTimeout(timer);
  }
}
