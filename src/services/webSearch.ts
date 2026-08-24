/**
 * Web Search Service
 * Performs DuckDuckGo searches and returns structured results
 */

import { fetcher } from "../fetcher.js";
import { extract } from "../extract/pipeline.js";
import { getConfig } from "../config.js";
import { Logger } from "../utils/logger.js";
import { BotChallengeError } from "../utils/errors.js";
import { httpClient as defaultHttpClient } from "../http/client.js";
import type { HttpClient } from "../http/types.js";

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

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Check if domain matches allowed list (if provided)
 */
function passesAllowedList(
  domain: string,
  allowedDomains?: string[]
): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return true;
  }
  return allowedDomains.some(
    (allowed) =>
      domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

/**
 * Check if domain matches blocked list (if provided)
 */
function passesBlockedList(
  domain: string,
  blockedDomains?: string[]
): boolean {
  if (!blockedDomains || blockedDomains.length === 0) {
    return true;
  }
  return !blockedDomains.some(
    (blocked) =>
      domain === blocked || domain.endsWith(`.${blocked}`)
  );
}

/**
 * Extract error message from error object with fallback
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Parse DuckDuckGo HTML search results into structured data
 * Uses the /html endpoint which returns static HTML
 */
export function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Build a map from href → snippet (snippets are separate anchors in DDG HTML)
  const snippetMap = new Map<string, string>();
  const snippetRe = /<a[^>]+class="result__snippet"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;

  while ((m = snippetRe.exec(html)) !== null) {
    const href = m[1]!;
    const snippet = m[2]!.replace(/<[^>]+>/g, '').trim();
    snippetMap.set(href, snippet);
  }

  // Match title anchors
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  while ((m = titleRe.exec(html)) !== null) {
    const rawHref = m[1]!;
    const title = m[2]!.replace(/<[^>]+>/g, '').trim();

    if (!rawHref) continue;

    // Decode the real URL from the DDG redirect wrapper (uddg param)
    let url: string;

    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+(?:amp;)?)/);
    if (uddgMatch && uddgMatch[1]) {
      try {
        // Remove &amp; suffix if present before decoding (DDG encodes ampersands as &amp;)
        let decoded = uddgMatch[1].replace(/&amp;$/, '&');
        url = decodeURIComponent(decoded);
      } catch {
        // If decoding fails, use raw URL
        url = rawHref;
      }
    } else if (rawHref.startsWith('//')) {
      url = 'https:' + rawHref;
    } else {
      url = rawHref;
    }

    // Skip duplicates
    if (seen.has(url)) continue;
    seen.add(url);

    const snippet = snippetMap.get(rawHref) || '';
    const domain = extractDomain(url);

    results.push({ title, url, snippet, domain });
  }

  return results;
}

/**
 * Filter results by domain allowlist and blocklist
 */
export function filterResults(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[]
): SearchResult[] {
  return results.filter((result) => {
    // Use domain from result if available, otherwise extract from URL
    const domain = result.domain || extractDomain(result.url);
    return (
      passesAllowedList(domain, allowedDomains) &&
      passesBlockedList(domain, blockedDomains)
    );
  });
}

/**
 * Perform DuckDuckGo search and return structured results.
 * Uses /html endpoint which returns static HTML (no JS rendering required).
 * The httpClient parameter is injectable for testing.
 */
export async function duckDuckGoSearch(
  options: SearchOptions,
  httpClient: HttpClient = defaultHttpClient,
): Promise<SearchResponse> {
  const startTime = Date.now();
  const {
    query,
    maxResults = 10,
    allowedDomains,
    blockedDomains,
    fetchResults = false,
    timeout,
  } = options;

  const searchTimeout = timeout ?? getConfig().WEB_SEARCH_DEFAULT_TIMEOUT_MS;
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  try {
    const res = await httpClient.request({
      url: searchUrl,
      purpose: 'search',
      timeoutMs: searchTimeout,
      requestId: Logger.generateRequestId(),
    });

    const html = res.text();

    if (html.includes('anomaly-modal') || html.includes('DDoS protection') || html.length < 2000) {
      throw new BotChallengeError(searchUrl);
    }

    let results = parseSearchResults(html);
    results = filterResults(results, allowedDomains, blockedDomains);
    results = results.slice(0, maxResults);

    let markdownResults: { url: string; markdown: string }[] | undefined;

    if (fetchResults && results.length > 0) {
      const urls = results.map((r) => r.url);
      const fetchedResults = await fetcher.fetchMultiple(urls, searchTimeout);
      markdownResults = fetchedResults.map((r) => {
        if (!r.success) {
          return { url: r.url, markdown: `# Error fetching ${r.url}\n\n${r.error ?? 'Unknown error'}\n` };
        }
        return { url: r.url, markdown: extract(r.markdown, { url: r.url, title: r.title ?? '' }).markdown };
      });
    }

    return { query, results, markdownResults, durationMs: Date.now() - startTime };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    return {
      query,
      results: [],
      durationMs,
      markdownResults: [{
        url: searchUrl,
        markdown: `# Search Error\n\nFailed to perform search: ${getErrorMessage(error)}\n`,
      }],
    };
  }
}
