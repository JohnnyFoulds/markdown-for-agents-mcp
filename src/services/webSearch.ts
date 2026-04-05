/**
 * Web Search Service
 * Performs DuckDuckGo searches and returns structured results
 */

import { fetcher } from "../fetcher.js";
import { converter } from "../converter.js";
import { getConfig } from "../config.js";
import http from 'http';
import https from 'https';

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
 * Fetch HTML using plain HTTP (no Playwright) to avoid bot detection
 * @param url - The URL to fetch
 * @param timeout - Request timeout in milliseconds
 * @param redirectCount - Internal redirect counter (default: 0, max: 10)
 * @returns Promise resolving to the HTML content
 * @throws {Error} If request times out or redirect limit exceeded
 */
export async function fetchHtml(
  url: string,
  timeout: number,
  redirectCount: number = 0
): Promise<string> {
  // Prevent infinite redirect loops
  if (redirectCount >= getConfig().MAX_REDIRECTS) {
    throw new Error(`Redirect limit exceeded (${getConfig().MAX_REDIRECTS} hops)`);
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    const chunks: Buffer[] = [];

    const req = client.request(options, (res: http.IncomingMessage) => {
      // Handle redirects with counter - recursively call fetchHtml for 3xx responses
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchHtml(res.headers.location, timeout, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', async () => {
        let data = Buffer.concat(chunks);

        // Decompress content based on encoding (gzip, brotli, deflate)
        try {
          const encoding = res.headers['content-encoding'];
          const zlib = await import('zlib');
          if (encoding === 'gzip') {
            data = zlib.gunzipSync(data);
          } else if (encoding === 'br') {
            data = zlib.brotliDecompressSync(data);
          } else if (encoding === 'deflate') {
            data = zlib.inflateSync(data);
          }
        } catch {
          // If decompression fails, return raw data
        }

        resolve(data.toString('utf8'));
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });

    req.end();
  });
}

/**
 * Perform DuckDuckGo search and return structured results
 * Uses /html endpoint which returns static HTML (no JS rendering required)
 * Uses plain HTTP to avoid Playwright bot detection
 */
export async function duckDuckGoSearch(
  options: SearchOptions,
  fetchHtmlImpl: (url: string, timeout: number) => Promise<string> = fetchHtml
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

  // Use DuckDuckGo HTML endpoint which returns static results
  const encodedQuery = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  try {
    // Fetch search results page using plain HTTP (injectable for testing)
    const html = await fetchHtmlImpl(searchUrl, searchTimeout);

    // Check for bot-challenge page (DDG anomaly modal)
    if (html.includes('anomaly-modal') || html.includes('DDoS protection') || html.length < 2000) {
      process.stderr.write(
        '[warn] Response looks like a bot-challenge page — results may be empty.\n'
      );
    }

    // Parse results from HTML
    let results = parseSearchResults(html);

    // Filter by domain lists
    results = filterResults(results, allowedDomains, blockedDomains);

    // Limit to maxResults
    results = results.slice(0, maxResults);

    let markdownResults: { url: string; markdown: string }[] | undefined;

    // Fetch and convert top results if requested (hybrid mode)
    // Use Promise.all for parallel fetching to avoid N+1 latency issues
    if (fetchResults && results.length > 0) {
      markdownResults = await Promise.all(
        results.map(async (result) => {
          try {
            const html = await fetcher.fetch(result.url, searchTimeout);
            const markdown = converter.convertWithMetadata(html, result.url);
            return { url: result.url, markdown };
          } catch (error) {
            return {
              url: result.url,
              markdown: `# Error fetching ${result.url}\n\n${getErrorMessage(error)}\n`,
            };
          }
        })
      );
    }

    const durationMs = Date.now() - startTime;

    return {
      query,
      results,
      markdownResults,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    return {
      query,
      results: [],
      durationMs,
      markdownResults: [
        {
          url: searchUrl,
          markdown: `# Search Error\n\nFailed to perform search: ${getErrorMessage(error)}\n`,
        },
      ],
    };
  }
}
