/**
 * Domain blacklist for blocked sites
 * Uses a simple allowlist approach by default (block everything except common safe sites)
 * Can be configured via environment variables to use blacklist mode
 */

import { getConfig } from '../config.js';
import { Logger } from './logger.js';

/**
 * SSRF protection: check if a hostname resolves to a private or loopback address.
 * Rejects localhost, loopback (127.x), link-local (169.254.x), and RFC1918 ranges.
 */
function isPrivateOrLocalAddress(hostname: string): boolean {
  // Reject loopback names
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '::1' || lower === '0.0.0.0') {
    return true;
  }

  // Reject IPv6 loopback / link-local
  if (lower.startsWith('fe80:') || lower === '[::1]') {
    return true;
  }

  // Parse dotted-decimal IPv4 addresses
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    // 127.0.0.0/8 — loopback
    if (a === 127) return true;
    // 10.0.0.0/8 — RFC1918
    if (a === 10) return true;
    // 172.16.0.0/12 — RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 — RFC1918
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 — link-local / AWS instance metadata
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

  return false;
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

  // Check exact match first
  if (blocklist.has(normalized)) {
    return true;
  }

  // Check subdomain patterns (e.g., evil.doubleclick.net)
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
