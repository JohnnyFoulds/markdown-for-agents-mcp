/**
 * Domain blacklist for blocked sites
 * Uses a simple allowlist approach by default (block everything except common safe sites)
 * Can be configured via environment variables to use blacklist mode
 */

import { getConfig } from '../config.js';

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
    const customPatterns = config.BLOCKLIST_URL_PATTERNS
      ? config.BLOCKLIST_URL_PATTERNS.split(',').map(p => new RegExp(p.trim(), 'i'))
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
  const { useAllowlistMode, customDomains, customPatterns } = getBlocklistConfigFromConfig();
  return {
    mode: useAllowlistMode ? 'allowlist' : 'blocklist',
    customDomains,
    patternCount: customPatterns.length + DEFAULT_URL_PATTERNS.length,
  };
}
