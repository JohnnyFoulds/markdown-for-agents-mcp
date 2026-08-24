export interface SearchProviderQuery {
  query: string;
  maxResults: number;
  freshness?: string;
  country?: string;
  language?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface ProviderResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  rank: number;
  provider: string;
}

export interface SearchProvider {
  readonly name: string;
  readonly tier: 1 | 2 | 3;
  isConfigured(): boolean;
  supports(q: SearchProviderQuery): { ok: true } | { ok: false; reason: string };
  search(q: SearchProviderQuery, opts: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]>;
}
