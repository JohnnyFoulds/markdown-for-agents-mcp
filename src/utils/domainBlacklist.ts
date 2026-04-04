/**
 * Domain blacklist for blocked sites
 * Uses a simple allowlist approach by default (block everything except common safe sites)
 * Can be configured via environment variables to use blacklist mode
 */

/**
 * Default blocklist of domains to never fetch
 * These are well-known problematic domains
 */
const DEFAULT_BLOCKLIST = new Set([
  // Common malicious/ad-heavy domains
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google.com',
  'analytics.google.com',
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

  // Known phishing/scam patterns
  'bit.ly',
  'tinyurl.com',
  'goo.gl',

  // Privacy-invasive trackers
  'cloudflare.com',
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

// Load custom blocklist from environment if provided
const CUSTOM_BLOCKLIST = process.env.BLOCKLIST_DOMAINS
  ? new Set(process.env.BLOCKLIST_DOMAINS.split(',').map(d => d.trim().toLowerCase() as string))
  : new Set();

const CUSTOM_URL_PATTERNS = process.env.BLOCKLIST_URL_PATTERNS
  ? process.env.BLOCKLIST_URL_PATTERNS.split(',').map(p => new RegExp(p.trim(), 'i')) as RegExp[]
  : [];

const USE_ALLOWLIST_MODE = process.env.USE_ALLOWLIST_MODE === 'true';

// Combine default and custom blocklists
const BLOCKLIST = new Set([...DEFAULT_BLOCKLIST, ...CUSTOM_BLOCKLIST]);

// Combine default and custom URL patterns
const URL_PATTERNS = [...DEFAULT_URL_PATTERNS, ...CUSTOM_URL_PATTERNS];

/**
 * Check if a domain should be blocked
 */
export function isDomainBlocked(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  // Check exact match first
  if (BLOCKLIST.has(normalized)) {
    return true;
  }

  // Check subdomain patterns (e.g., evil.doubleclick.net)
  for (const blocked of BLOCKLIST) {
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
  for (const pattern of URL_PATTERNS) {
    if (pattern.test(pathname)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate that a URL is safe to fetch
 */
export function validateUrl(url: string): { valid: true } | { valid: false; error: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Invalid URL: ${parsed.protocol} protocol not supported` };
    }

    // Check if domain is blocked
    if (isDomainBlocked(parsed.hostname)) {
      return { valid: false, error: `Domain blocked: ${parsed.hostname}` };
    }

    // Check if path matches block patterns
    if (isPathBlocked(parsed.pathname)) {
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
  return {
    mode: USE_ALLOWLIST_MODE ? 'allowlist' : 'blocklist',
    customDomains: Array.from(CUSTOM_BLOCKLIST) as string[],
    patternCount: URL_PATTERNS.length,
  };
}
