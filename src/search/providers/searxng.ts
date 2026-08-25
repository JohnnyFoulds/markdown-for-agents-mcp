import { getConfig } from '../../config.js';
import { httpClient as defaultHttpClient, internalHttpClient } from '../../http/client.js';
import { BotChallengeError } from '../../utils/errors.js';
import type { HttpClient } from '../../http/types.js';
import { domainOf } from '../filter.js';
import type { SearchProvider, SearchProviderQuery, ProviderResult } from '../types.js';

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
}

export function parseSearXNGResponse(raw: SearXNGResponse): ProviderResult[] {
  return (raw.results ?? []).map((r, i) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    domain: domainOf(r.url ?? ''),
    rank: i + 1,
    provider: 'searxng',
  })).filter(r => r.url);
}

export class SearXNGProvider implements SearchProvider {
  readonly name = 'searxng';
  readonly tier = 2 as const;

  constructor(private readonly client: HttpClient = defaultHttpClient) {}

  isConfigured(): boolean {
    try { return !!getConfig().SEARXNG_URL; } catch { return false; }
  }

  supports(_q: SearchProviderQuery): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }

  async search(q: SearchProviderQuery, opts: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]> {
    const config = getConfig();
    const params = new URLSearchParams({
      q: q.query,
      format: 'json',
      pageno: '1',
    });

    if (q.language) params.set('language', q.language);
    if (q.freshness) params.set('time_range', q.freshness);

    const res = await this.client.request({
      url: `${config.SEARXNG_URL}/search?${params}`,
      purpose: 'api',
      headers: { 'Accept': 'application/json' },
      timeoutMs: config.WEB_SEARCH_DEFAULT_TIMEOUT_MS,
      requestId: opts.requestId,
    });

    // Non-200 status or non-JSON body (HTML rate-limit page) → bot challenge
    if (res.status === 429 || res.status === 403) {
      throw new BotChallengeError(`${config.SEARXNG_URL}/search`);
    }

    const body = res.text();
    if (!body.trimStart().startsWith('{') && !body.trimStart().startsWith('[')) {
      throw new BotChallengeError(`${config.SEARXNG_URL}/search`);
    }

    const raw: SearXNGResponse = JSON.parse(body);
    return parseSearXNGResponse(raw).slice(0, q.maxResults);
  }
}

export const searXNGProvider = new SearXNGProvider(internalHttpClient);
