/**
 * Domain blacklist for blocked sites
 * Uses a simple allowlist approach by default (block everything except common safe sites)
 * Can be configured via environment variables to use blacklist mode
 */

import { getConfig } from '../config.js';
import { Logger } from './logger.js';

/**
 * Cloud-provider instance metadata endpoints — blocked unconditionally.
 *
 * These hostnames serve credentials, environment variables, and IAM role keys to
 * any process that can reach them. They must not be reachable regardless of
 * allowlist / blocklist configuration.
 *
 * Note: this is a lexical denylist of *known* metadata hostnames. It is not
 * complete — an attacker-controlled domain with a private A record (e.g. pointing
 * to 169.254.169.254) is blocked at the IP layer, not here. The egress
 * NetworkPolicy is the authoritative control for the browser tiers (Lightpanda,
 * Playwright) which resolve DNS internally via Chromium.
 */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',     // GCP instance metadata
  'metadata.goog',                 // GCP short-form
  'metadata.google.com',           // GCP alternate
  'instance-data',                 // AWS EC2 instance-data (short name)
  'instance-data.ec2.internal',    // AWS EC2 instance-data FQDN
  'metadata.azure.com',            // Azure IMDS
  'metadata.oraclecloud.com',      // Oracle Cloud IMDS
]);

/**
 * SSRF protection: check if a hostname resolves to a private or loopback address.
 * Rejects localhost, loopback (127.x), link-local (169.254.x), RFC1918 ranges,
 * CGNAT (100.64.0.0/10, covers Oracle/Alibaba IMDS 100.100.100.200),
 * IPv6 loopback/ULA, IPv4-mapped IPv6 (::ffff:…), and decimal/octal IP
 * representations.
 */
function isPrivateOrLocalAddress(hostname: string): boolean {
  // Strip a single trailing dot (DNS FQDN suffix, e.g. "169.254.169.254.").
  // The IPv4 dotted-decimal regex is anchored and does not match the trailing dot form.
  const stripped = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const lower = stripped.toLowerCase();

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

  // IPv4-mapped IPv6 (::ffff:…) — two forms:
  //   dotted-decimal: ::ffff:169.254.169.254
  //   two-group hex:  ::ffff:a9fe:a9fe  (0xa9fe = [169, 254])
  // Recursively check the embedded IPv4 address.
  if (/^::ffff:/i.test(bare)) {
    const rest = bare.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) {
      return isPrivateOrLocalAddress(rest);
    }
    const hexMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateOrLocalAddress(ipv4);
    }
    return true; // unrecognised ::ffff: form — fail closed
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

  // Parse standard dotted-decimal IPv4 addresses.
  // Note: use `stripped` not `hostname` so the trailing-dot form still matches.
  const ipv4 = stripped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 10) return true;                           // 10.0.0.0/8 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16 RFC1918
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local / AWS metadata
    if (a === 0) return true;                            // 0.0.0.0/8
    // CGNAT 100.64.0.0/10 (covers Oracle/Alibaba IMDS at 100.100.100.200).
    // Note: some ISPs and CDNs legitimately use this range; blocking it is the
    // correct default for an SSRF guard but is a deliberate availability trade-off.
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
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
    // In allowlist mode read ALLOWLIST_DOMAINS; in blocklist mode read BLOCKLIST_DOMAINS.
    // The two vars have opposite semantics — reading the wrong one in each mode was the naming inversion.
    const domainSource = config.USE_ALLOWLIST_MODE ? config.ALLOWLIST_DOMAINS : config.BLOCKLIST_DOMAINS;
    const customDomains = domainSource
      ? domainSource.split(',').map(d => d.trim().toLowerCase())
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

    // Unconditional cloud-metadata hostname denylist — checked before allowlist /
    // blocklist resolution so no configuration can re-enable these endpoints.
    if (METADATA_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      return { valid: false, error: `SSRF protection: private or local addresses not allowed` };
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
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Exported alias used by the DNS guard (Phase 1) and Chromium pre-flight (Phase 2).
 * Checks lexically — caller must also do a post-DNS check to close the TOCTOU window.
 */
export function isPrivateIp(hostname: string): boolean {
  return isPrivateOrLocalAddress(hostname);
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
