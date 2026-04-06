/**
 * Domain blacklist for blocked sites
 * Uses a simple allowlist approach by default (block everything except common safe sites)
 * Can be configured via environment variables to use blacklist mode
 */

import { getConfig } from '../config.js';
import { Logger } from './logger.js';

/**
 * SSRF protection: check if a hostname resolves to a private or loopback address.
 * Rejects localhost, loopback (127.x), link-local (169.254.x), RFC1918 ranges,
 * IPv6 loopback/ULA, and decimal/octal IP representations.
 */
function isPrivateOrLocalAddress(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Strip IPv6 brackets: [::1] → ::1
  const bare = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

  // Loopback / unspecified names
  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0' || bare === '::') {
    return true;
  }

  // IPv6 loopback and link-local (fe80::/10)
  if (bare.startsWith('fe80:') || bare === '::1') {
    return true;
  }

  // IPv6 ULA (fc00::/7 — covers fc00:: through fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) {
    return true;
  }

  // Reject non-standard IP representations that bypass dotted-decimal check:
  // decimal (http://2130706433/ = 127.0.0.1), octal (0177.0.0.1), hex (0x7f000001)
  // These are not valid hostnames in DNS but some HTTP clients resolve them.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(bare)) {
    return true; // pure integer / hex — likely an encoded IP
  }
  if (/^0[0-7]+(\.[0-9]+)*$/.test(bare)) {
    return true; // octal segment
  }

  // Parse standard dotted-decimal IPv4 addresses
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 10) return true;                           // 10.0.0.0/8 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 RFC1918
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local / AWS metadata
    if (a === 0) return true;                            // 0.0.0.0/8
  }

  return false;
}

/**
 * Detect catastrophic backtracking (ReDoS) in a regex pattern string.
 * Rejects patterns with nested quantifiers on groups containing quantifiers
 * or alternation inside repetition — the most common ReDoS shapes.
 */
function isSafePattern(pattern: string): boolean {
  // Reject patterns with nested quantifiers: (x+)+ / (x*)* / (x+)* etc.
  if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) return false;
  // Reject alternation inside unbounded repetition: (a|b)+ style catastrophic cases
  // that have multiple paths of different lengths
  if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) return false;
  return true;
}

/**
 * Default blocklist of domains to never fetch
 * These are well-known problematic domains
 */
const DEFAULT_BLOCKLIST = new Set([
  // Ad networks and tracking pixels
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google.com',
  'analytics.google.com',

  // Social platforms that aggressively block scrapers or serve login walls
  'facebook.com',
  'facebook.net',
  'twitter.com',
  't.co',
  'linkedin.com',
  'instagram.com',
  'snapchat.com',
  'pinterest.com',
  'tiktok.com',
  'reddit.com',
  'quora.com',

  // URL shorteners (opaque redirect chains)
  'bit.ly',
  'tinyurl.com',
  'goo.gl',

  // Analytics and session-recording trackers
  'cloudflareinsights.com',
  'intercom.io',
  'intercomassets.com',
  'hotjar.com',
  'hotjar.io',
  'mixpanel.com',
  'segment.com',
  'amplitude.com',
  'heap.io',
]);

/**
 * Default blocklist of URL patterns to reject
 */
const DEFAULT_URL_PATTERNS = [
  // OAuth/callback patterns
  /oauth\/callback/i,
  /auth\/callback/i,
  /login\/callback/i,
  /redirect\/callback/i,

  // Download patterns (avoid binary downloads)
  /download\.(exe|dll|msi|pkg|dmg|zip|rar|7z|tar|gz|iso|img)/i,
  /\/download\/.+$/i,

  // Payment patterns
  /checkout\/|payment\/|billing\/|invoice\//i,

  // Admin patterns
  /\/admin\/|\/wp-admin\/|\/cpanel\/|\/phpmyadmin/i,
];

function getBlocklistConfigFromConfig(): {
  useAllowlistMode: boolean;
  customDomains: string[];
  customPatterns: RegExp[];
} {
  try {
    const config = getConfig();
    const customDomains = config.BLOCKLIST_DOMAINS
      ? config.BLOCKLIST_DOMAINS.split(',').map(d => d.trim().toLowerCase())
      : [];
    const customPatterns: RegExp[] = config.BLOCKLIST_URL_PATTERNS
      ? config.BLOCKLIST_URL_PATTERNS.split(',').reduce<RegExp[]>((acc, raw) => {
          const trimmed = raw.trim();
          if (!trimmed || trimmed.length > 500) {
            if (trimmed.length > 500) {
              Logger.warn(`BLOCKLIST_URL_PATTERNS: skipping pattern longer than 500 chars`);
            }
            return acc;
          }
          if (!isSafePattern(trimmed)) {
            Logger.warn(`BLOCKLIST_URL_PATTERNS: skipping pattern with potentially unsafe backtracking: ${trimmed}`);
            return acc;
          }
          try {
            acc.push(new RegExp(trimmed, 'i'));
          } catch {
            Logger.warn(`BLOCKLIST_URL_PATTERNS: skipping invalid regex pattern: ${trimmed}`);
          }
          return acc;
        }, [])
      : [];

    return {
      useAllowlistMode: config.USE_ALLOWLIST_MODE,
      customDomains,
      customPatterns,
    };
  } catch {
    // Return defaults when config is not initialized (e.g., in tests)
    return {
      useAllowlistMode: false,
      customDomains: [],
      customPatterns: [],
    };
  }
}

/**
 * Check if a domain should be blocked
 */
export function isDomainBlocked(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const { useAllowlistMode, customDomains } = getBlocklistConfigFromConfig();

  if (useAllowlistMode) {
    // Allowlist mode: only allow domains explicitly listed in customDomains
    return !customDomains.some(
      (allowed) => normalized === allowed || normalized.endsWith('.' + allowed)
    );
  }

  // Blocklist mode (default): block domains in DEFAULT_BLOCKLIST + customDomains
  const blocklist = new Set([...DEFAULT_BLOCKLIST, ...customDomains]);

  if (blocklist.has(normalized)) {
    return true;
  }

  for (const blocked of blocklist) {
    if (normalized.endsWith('.' + blocked)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a URL path should be blocked based on patterns
 */
export function isPathBlocked(pathname: string): boolean {
  const { customPatterns } = getBlocklistConfigFromConfig();
  const patterns = [...DEFAULT_URL_PATTERNS, ...customPatterns];

  for (const pattern of patterns) {
    if (pattern.test(pathname)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate that a URL is safe to fetch
 */
export function validateUrl(
  url: string,
  options?: { skipPathPatterns?: boolean }
): { valid: true } | { valid: false; error: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Invalid URL: ${parsed.protocol} protocol not supported` };
    }

    // SSRF protection: block private/local addresses
    if (isPrivateOrLocalAddress(parsed.hostname)) {
      return { valid: false, error: `SSRF protection: private or local addresses not allowed` };
    }

    // Check if domain is blocked
    if (isDomainBlocked(parsed.hostname)) {
      return { valid: false, error: `Domain blocked: ${parsed.hostname}` };
    }

    // Check if path matches block patterns (can be skipped for binary downloads)
    if (!options?.skipPathPatterns && isPathBlocked(parsed.pathname)) {
      return { valid: false, error: `URL path blocked: ${parsed.pathname}` };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Get the current blocklist configuration for debugging
 */
export function getBlocklistConfig(): {
  mode: string;
  customDomains: string[];
  patternCount: number;
} {
  const { useAllowlistMode, customDomains, customPatterns } = getBlocklistConfigFromConfig();
  return {
    mode: useAllowlistMode ? 'allowlist' : 'blocklist',
    customDomains,
    patternCount: customPatterns.length + DEFAULT_URL_PATTERNS.length,
  };
}
