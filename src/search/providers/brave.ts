import { getConfig } from '../../config.js';
import { httpClient as defaultHttpClient } from '../../http/client.js';
import type { HttpClient } from '../../http/types.js';
import { domainOf } from '../filter.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from '../types.js';

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

export function parseBraveResponse(raw: BraveResponse): ProviderResult[] {
  return (raw.web?.results ?? []).map((r, i) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
    domain: domainOf(r.url ?? ''),
    rank: i + 1,
    provider: 'brave',
  })).filter(r => r.url);
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  readonly tier = 1 as const;

  constructor(private readonly client: HttpClient = defaultHttpClient) {}

  isConfigured(): boolean {
    try { return !!getConfig().BRAVE_API_KEY; } catch { return false; }
  }

  supports(_q: SearchProviderQuery): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  async search(q: SearchProviderQuery, opts: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]> {
    const config = getConfig();
    const params = new URLSearchParams({
      q: q.query,
      count: String(q.maxResults),
      ...(q.country ? { country: q.country } : {}),
      ...(q.language ? { search_lang: q.language } : {}),
      ...(q.freshness ? { freshness: q.freshness } : {}),
    });

    const res = await this.client.request({
      url: `https://api.search.brave.com/res/v1/web/search?${params}`,
      purpose: 'api',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': config.BRAVE_API_KEY!,
      },
      timeoutMs: config.WEB_SEARCH_DEFAULT_TIMEOUT_MS,
      requestId: opts.requestId,
    });

    const raw: BraveResponse = JSON.parse(res.text());
    return parseBraveResponse(raw).slice(0, q.maxResults);
  }
}

export const braveProvider = new BraveProvider();
