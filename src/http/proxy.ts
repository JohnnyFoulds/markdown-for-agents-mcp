export interface ProxyConfig {
  url: string;
  bypass?: string;
  isSocks5?: boolean;
}

let rotationIndex = 0;
let pinCache: string[] | undefined;

function loadPins(): string[] {
  if (pinCache) return pinCache;
  const raw = process.env['PROXY_PINS'];
  if (!raw) { pinCache = []; return pinCache; }
  try {
    const parsed = JSON.parse(raw);
    pinCache = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    pinCache = [];
  }
  return pinCache;
}

/**
 * Resolve a single proxy config for a one-off request (e.g. HttpClient).
 *
 * Priority:
 *   1. SOCKS5_UPSTREAM_URL (with optional SOCKS5_UPSTREAM_USER/PASS embedded)
 *   2. PROXY_PINS round-robin
 *   3. HTTP_PROXY_URL / PLAYWRIGHT_PROXY env vars
 */
export function resolveProxy(envProxy?: string, envBypass?: string): ProxyConfig | undefined {
  const socks5Upstream = process.env['SOCKS5_UPSTREAM_URL'];
  if (socks5Upstream) {
    const u = process.env['SOCKS5_UPSTREAM_USER'];
    const p = process.env['SOCKS5_UPSTREAM_PASS'];
    if (u && p) {
      // Embed credentials in the URL so undici's Socks5ProxyAgent can use them
      const parsed = new URL(socks5Upstream);
      parsed.username = u;
      parsed.password = p;
      return { url: parsed.toString(), isSocks5: true };
    }
    return { url: socks5Upstream, isSocks5: socks5Upstream.startsWith('socks5') };
  }

  const pins = loadPins();
  if (pins.length > 0) {
    const url = pins[rotationIndex % pins.length]!;
    rotationIndex = (rotationIndex + 1) % pins.length;
    return { url };
  }
  const raw = process.env['HTTP_PROXY_URL'] ?? envProxy ?? process.env['PLAYWRIGHT_PROXY'] ?? undefined;
  if (!raw) return undefined;
  return { url: raw, bypass: envBypass ?? process.env['PLAYWRIGHT_PROXY_BYPASS'] };
}

/**
 * Return the full rotation list (PROXY_PINS), or a single-entry list from
 * HTTP_PROXY_URL / PLAYWRIGHT_PROXY, or an empty list when no proxy is configured.
 * Used by the pool registry to create one BrowserPool per proxy.
 */
export function resolveProxyList(): string[] {
  const pins = loadPins();
  if (pins.length > 0) return pins;
  const single = process.env['HTTP_PROXY_URL'] ?? process.env['PLAYWRIGHT_PROXY'] ?? undefined;
  return single ? [single] : [];
}

/** Reset pin cache — for tests only. */
export function resetProxyCache(): void {
  pinCache = undefined;
  rotationIndex = 0;
}
