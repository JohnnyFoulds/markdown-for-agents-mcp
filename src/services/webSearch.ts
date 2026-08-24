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

export interface SearchOptions {
  query: string;
  maxResults?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  fetchResults?: boolean;
  timeout?: number;
}

const DEFAULT_PROVIDERS: SearchProvider[] = [
  braveProvider, serperProvider, searXNGProvider, duckDuckGoProvider,
];

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
    fetchResults = false,
    timeout,
  } = options;

  const config = getConfig();
  const searchTimeout = timeout ?? config.WEB_SEARCH_DEFAULT_TIMEOUT_MS;
  const requestId = Logger.generateRequestId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), searchTimeout);

  try {
    const providerResults = await fanout(
      { query, maxResults: Math.max(maxResults, config.SEARCH_FANOUT_RESULTS), includeDomains: allowedDomains, excludeDomains: blockedDomains },
      DEFAULT_PROVIDERS,
      { signal: controller.signal, requestId, deadlineMs: searchTimeout, includeDomains: allowedDomains, excludeDomains: blockedDomains },
    );

    const results: SearchResult[] = providerResults.slice(0, maxResults).map(r => ({
      title: r.title, url: r.url, snippet: r.snippet, domain: r.domain,
    }));

    let markdownResults: { url: string; markdown: string }[] | undefined;

    if (fetchResults && results.length > 0) {
      const titleMap = new Map(results.map(r => [r.url, r.title]));
      const fetched = await fetcher.fetchMultiple(results.map(r => r.url), searchTimeout);
      markdownResults = fetched.map(r => {
        if (!r.success) {
          return { url: r.url, markdown: `# Error fetching ${r.url}\n\n${r.error ?? 'Unknown error'}\n` };
        }
        return { url: r.url, markdown: extract(r.markdown, { url: r.url, title: r.title ?? titleMap.get(r.url) ?? '' }).markdown };
      });
    }

    return { query, results, markdownResults, durationMs: Date.now() - startTime };
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
