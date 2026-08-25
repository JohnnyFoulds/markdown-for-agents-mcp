import { getConfig } from '../../config.js';
import { httpClient as defaultHttpClient } from '../../http/client.js';
import type { HttpClient } from '../../http/types.js';
import { Logger, redactQuery } from '../../utils/logger.js';
import { BotChallengeError } from '../../utils/errors.js';
import { domainOf } from '../filter.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from '../types.js';

export function parseDuckDuckGoHtml(html: string): ProviderResult[] {
  const results: ProviderResult[] = [];
  const seen = new Set<string>();

  const snippetMap = new Map<string, string>();
  const snippetRe = /<a[^>]+class="result__snippet"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;

  while ((m = snippetRe.exec(html)) !== null) {
    snippetMap.set(m[1]!, m[2]!.replace(/<[^>]+>/g, '').trim());
  }

  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let rank = 1;

  while ((m = titleRe.exec(html)) !== null) {
    const rawHref = m[1]!;
    const title = m[2]!.replace(/<[^>]+>/g, '').trim();
    if (!rawHref) continue;

    let url: string;
    const uddgMatch = rawHref.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
      try {
        url = decodeURIComponent(uddgMatch[1].replace(/&amp;$/, ''));
      } catch {
        url = rawHref;
      }
    } else if (rawHref.startsWith('//')) {
      url = 'https:' + rawHref;
    } else {
      url = rawHref;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    results.push({
      title,
      url,
      snippet: snippetMap.get(rawHref) ?? '',
      domain: domainOf(url),
      rank: rank++,
      provider: 'duckduckgo',
    });
  }

  return results;
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'duckduckgo';
  readonly tier = 3 as const;

  constructor(private readonly client: HttpClient = defaultHttpClient) {}

  isConfigured(): boolean {
    try { return getConfig().SEARCH_ENABLE_DUCKDUCKGO; } catch { return true; }
  }

  supports(_q: SearchProviderQuery): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  async search(q: SearchProviderQuery, opts: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]> {
    const config = getConfig();
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q.query)}`;

    const res = await this.client.request({
      url: searchUrl,
      purpose: 'search',
      timeoutMs: config.WEB_SEARCH_DEFAULT_TIMEOUT_MS,
      requestId: opts.requestId,
    });

    const html = res.text();

    if (html.includes('anomaly-modal') || html.includes('DDoS protection') || html.length < 2000) {
      throw new BotChallengeError(searchUrl);
    }

    Logger.debug(`[DDG] ${html.length} chars for "${redactQuery(q.query)}"`);
    return parseDuckDuckGoHtml(html).slice(0, q.maxResults);
  }
}

export const duckDuckGoProvider = new DuckDuckGoProvider();
