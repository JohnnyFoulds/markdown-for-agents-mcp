export interface ProxyConfig {
  url: string;
  bypass?: string;
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
 * Returns the next entry from PROXY_PINS (round-robin), falling back to
 * HTTP_PROXY_URL / PLAYWRIGHT_PROXY env vars.
 */
export function resolveProxy(envProxy?: string, envBypass?: string): ProxyConfig | undefined {
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
