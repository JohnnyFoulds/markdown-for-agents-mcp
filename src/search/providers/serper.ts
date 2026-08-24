import { getConfig } from '../../config.js';
import { httpClient as defaultHttpClient } from '../../http/client.js';
import type { HttpClient } from '../../http/types.js';
import { domainOf } from '../filter.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from '../types.js';

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperOrganic[];
}

export function parseSerperResponse(raw: SerperResponse): ProviderResult[] {
  return (raw.organic ?? []).map((r, i) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
    domain: domainOf(r.link ?? ''),
    rank: r.position ?? i + 1,
    provider: 'serper',
  })).filter(r => r.url);
}

export class SerperProvider implements SearchProvider {
  readonly name = 'serper';
  readonly tier = 1 as const;

  constructor(private readonly client: HttpClient = defaultHttpClient) {}

  isConfigured(): boolean {
    try { return !!getConfig().SERPER_API_KEY; } catch { return false; }
  }

  supports(_q: SearchProviderQuery): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  async search(q: SearchProviderQuery, opts: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]> {
    const config = getConfig();

    const body = JSON.stringify({
      q: q.query,
      num: q.maxResults,
      ...(q.country ? { gl: q.country } : {}),
      ...(q.language ? { hl: q.language } : {}),
    });

    const res = await this.client.request({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      purpose: 'api',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.SERPER_API_KEY!,
      },
      body,
      timeoutMs: config.WEB_SEARCH_DEFAULT_TIMEOUT_MS,
      requestId: opts.requestId,
    });

    const raw: SerperResponse = JSON.parse(res.text());
    return parseSerperResponse(raw).slice(0, q.maxResults);
  }
}

export const serperProvider = new SerperProvider();
