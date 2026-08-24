import { httpClient } from '../http/client.js';
import { validateUrl } from '../utils/domainBlacklist.js';
import { Logger } from '../utils/logger.js';

export interface MapSiteOptions {
  url: string;
  maxUrls?: number;
  followLinks?: boolean;
  timeout?: number;
}

export interface MapSiteResult {
  rootUrl: string;
  urls: string[];
  total: number;
  fromSitemap: boolean;
  fromCrawl: boolean;
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const resolved = new URL(href, base).toString();
    // Strip fragment
    const u = new URL(resolved);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && ua.port === ub.port && ua.protocol === ub.protocol;
  } catch {
    return false;
  }
}

function extractSitemapUrls(xml: string): string[] {
  const urls: string[] = [];
  const locRe = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    urls.push(m[1]!.trim());
  }
  return urls;
}

function extractSitemapIndexUrls(xml: string): string[] {
  const urls: string[] = [];
  const locRe = /<sitemap>\s*<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    urls.push(m[1]!.trim());
  }
  return urls;
}

function extractHtmlLinks(html: string, base: string, rootUrl: string): string[] {
  const links: string[] = [];
  const hrefRe = /<a\s[^>]*href=["']([^"'#][^"']*?)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const normalized = normalizeUrl(m[1]!, base);
    if (normalized && isSameOrigin(normalized, rootUrl)) {
      links.push(normalized);
    }
  }
  return links;
}

async function fetchSitemapUrls(rootUrl: string, timeout: number): Promise<string[]> {
  const sitemapUrl = new URL('/sitemap.xml', rootUrl).toString();
  try {
    const res = await httpClient.request({ url: sitemapUrl, purpose: 'page', timeoutMs: timeout });
    if (res.status !== 200) return [];
    const xml = res.text();
    // Check if it's a sitemap index
    if (xml.includes('<sitemapindex')) {
      const indexUrls = extractSitemapIndexUrls(xml);
      const allUrls: string[] = [];
      for (const indexUrl of indexUrls.slice(0, 5)) {
        try {
          const subRes = await httpClient.request({ url: indexUrl, purpose: 'page', timeoutMs: timeout });
          if (subRes.status === 200) {
            allUrls.push(...extractSitemapUrls(subRes.text()));
          }
        } catch { /* ignore sub-sitemap errors */ }
      }
      return allUrls;
    }
    return extractSitemapUrls(xml);
  } catch {
    return [];
  }
}

async function crawlLinks(rootUrl: string, maxUrls: number, timeout: number): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [rootUrl];
  const found: string[] = [];

  while (queue.length > 0 && found.length < maxUrls) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    if (!validateUrl(url).valid) continue;

    try {
      const res = await httpClient.request({ url, purpose: 'page', timeoutMs: timeout });
      if (res.status !== 200) continue;

      const ct = res.headers['content-type'] ?? '';
      if (!ct.includes('text/html')) continue;

      found.push(url);

      const links = extractHtmlLinks(res.text(), url, rootUrl);
      for (const link of links) {
        if (!visited.has(link) && found.length + queue.length < maxUrls * 3) {
          queue.push(link);
        }
      }
    } catch (err) {
      Logger.debug(`[mapSite] Failed to crawl ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return found;
}

export async function mapSite(options: MapSiteOptions): Promise<MapSiteResult> {
  const { url, maxUrls = 100, followLinks = true, timeout = 30_000 } = options;

  const validation = validateUrl(url);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const rootUrl = new URL(url).origin;
  const allUrls = new Set<string>();
  let fromSitemap = false;
  let fromCrawl = false;

  // Step 1: Try sitemap.xml
  const sitemapUrls = await fetchSitemapUrls(rootUrl, timeout);
  if (sitemapUrls.length > 0) {
    fromSitemap = true;
    for (const u of sitemapUrls) {
      if (isSameOrigin(u, rootUrl)) allUrls.add(u);
    }
  }

  // Step 2: Crawl HTML links if requested and sitemap was sparse
  if (followLinks && allUrls.size < maxUrls) {
    const crawledUrls = await crawlLinks(url, maxUrls - allUrls.size, timeout);
    if (crawledUrls.length > 0) {
      fromCrawl = true;
      for (const u of crawledUrls) allUrls.add(u);
    }
  }

  const urls = [...allUrls].slice(0, maxUrls);

  return {
    rootUrl,
    urls,
    total: urls.length,
    fromSitemap,
    fromCrawl,
  };
}
