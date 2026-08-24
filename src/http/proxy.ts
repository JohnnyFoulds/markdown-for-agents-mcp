export interface ProxyConfig {
  url: string;
  bypass?: string;
}

export function resolveProxy(envProxy?: string, envBypass?: string): ProxyConfig | undefined {
  // Canonical var: HTTP_PROXY_URL; PLAYWRIGHT_PROXY kept as legacy alias
  const raw = process.env['HTTP_PROXY_URL'] ?? envProxy ?? process.env['PLAYWRIGHT_PROXY'] ?? undefined;
  if (!raw) return undefined;
  return { url: raw, bypass: envBypass ?? process.env['PLAYWRIGHT_PROXY_BYPASS'] };
}
