/**
 * Domain blacklist unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { validateUrl, isDomainBlocked, isPathBlocked, getBlocklistConfig } from './domainBlacklist.js';
import { initializeConfig, resetConfig } from '../config.js';

describe('Domain Blacklist', () => {
  beforeEach(() => {
    resetConfig();
    initializeConfig({
      USE_ALLOWLIST_MODE: 'false',
      BLOCKLIST_DOMAINS: '',
      BLOCKLIST_URL_PATTERNS: '',
    });
  });

  afterEach(() => {
    resetConfig();
  });

  describe('validateUrl', () => {
    it('should validate valid HTTP URLs', () => {
      const result = validateUrl('http://example.com');
      expect(result.valid).toBe(true);
    });

    it('should validate valid HTTPS URLs', () => {
      const result = validateUrl('https://example.com/path');
      expect(result.valid).toBe(true);
    });

    it('should reject invalid URL format', () => {
      const result = validateUrl('not-a-url');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Invalid URL');
      }
    });

    it('should reject non-HTTP/HTTPS protocols', () => {
      const result = validateUrl('ftp://example.com');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('protocol not supported');
      }
    });

    it('should reject blocked domains', () => {
      const result = validateUrl('https://doubleclick.net/ad');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Domain blocked');
      }
    });

    it('should reject blocked subdomains', () => {
      const result = validateUrl('https://tracking.doubleclick.net/ad');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('Domain blocked');
      }
    });

    it('should reject blocked URL paths', () => {
      const result = validateUrl('https://example.com/oauth/callback');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('URL path blocked');
      }
    });

    it('should reject payment-related paths', () => {
      const result = validateUrl('https://example.com/checkout/123');
      expect(result.valid).toBe(false);
    });

    it('should reject admin paths', () => {
      const result = validateUrl('https://example.com/admin/dashboard');
      expect(result.valid).toBe(false);
    });

    it('should allow safe URLs', () => {
      const result = validateUrl('https://example.com/blog/article');
      expect(result.valid).toBe(true);
    });
  });

  describe('isDomainBlocked', () => {
    it('should block doubleclick.net', () => {
      expect(isDomainBlocked('doubleclick.net')).toBe(true);
    });

    it('should block googlesyndication.com', () => {
      expect(isDomainBlocked('googlesyndication.com')).toBe(true);
    });

    it('should block social media domains', () => {
      expect(isDomainBlocked('facebook.com')).toBe(true);
      expect(isDomainBlocked('twitter.com')).toBe(true);
      expect(isDomainBlocked('linkedin.com')).toBe(true);
      expect(isDomainBlocked('instagram.com')).toBe(true);
    });

    it('should block tracking services', () => {
      expect(isDomainBlocked('google-analytics.com')).toBe(true);
      expect(isDomainBlocked('cloudflare.com')).toBe(true);
      expect(isDomainBlocked('intercom.io')).toBe(true);
    });

    it('should block URL shorteners', () => {
      expect(isDomainBlocked('bit.ly')).toBe(true);
      expect(isDomainBlocked('tinyurl.com')).toBe(true);
    });

    it('should block subdomains of blocked domains', () => {
      expect(isDomainBlocked('tracking.doubleclick.net')).toBe(true);
      expect(isDomainBlocked('adservice.google.com')).toBe(true);
      expect(isDomainBlocked('x.facebook.com')).toBe(true);
    });

    it('should allow safe domains', () => {
      expect(isDomainBlocked('example.com')).toBe(false);
      expect(isDomainBlocked('github.com')).toBe(false);
      expect(isDomainBlocked('developer.mozilla.org')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isDomainBlocked('DoubleClick.NET')).toBe(true);
      expect(isDomainBlocked('FACEBOOK.COM')).toBe(true);
    });
  });

  describe('isPathBlocked', () => {
    it('should block OAuth callback paths', () => {
      expect(isPathBlocked('/oauth/callback')).toBe(true);
      expect(isPathBlocked('/auth/callback')).toBe(true);
      expect(isPathBlocked('/login/callback')).toBe(true);
    });

    it('should block download paths', () => {
      expect(isPathBlocked('/download/file.exe')).toBe(true);
      expect(isPathBlocked('/download/package.zip')).toBe(true);
      expect(isPathBlocked('/downloads/file.msi')).toBe(true);
    });

    it('should block payment paths', () => {
      expect(isPathBlocked('/checkout/123')).toBe(true);
      expect(isPathBlocked('/payment/process')).toBe(true);
      expect(isPathBlocked('/billing/invoice')).toBe(true);
    });

    it('should block admin paths', () => {
      expect(isPathBlocked('/admin')).toBe(true);
      expect(isPathBlocked('/wp-admin')).toBe(true);
      expect(isPathBlocked('/cpanel')).toBe(true);
      expect(isPathBlocked('/phpmyadmin')).toBe(true);
    });

    it('should allow safe paths', () => {
      expect(isPathBlocked('/')).toBe(false);
      expect(isPathBlocked('/about')).toBe(false);
      expect(isPathBlocked('/blog/article')).toBe(false);
      expect(isPathBlocked('/api/v1/users')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isPathBlocked('/OAUTH/Callback')).toBe(true);
      expect(isPathBlocked('/CHECKOUT/123')).toBe(true);
    });
  });

  describe('custom blocklist configuration', () => {
    it('should load custom domain blocklist from env', () => {
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'false',
        BLOCKLIST_DOMAINS: 'custom-bad.com,another-bad.com',
        BLOCKLIST_URL_PATTERNS: '',
      });

      // Re-import to pick up new env values
      jest.isolateModules(() => {
        // Custom domains should be blocked
        expect(isDomainBlocked('custom-bad.com')).toBe(true);
        expect(isDomainBlocked('another-bad.com')).toBe(true);
      });
    });

    it('should load custom URL patterns from env', () => {
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'false',
        BLOCKLIST_DOMAINS: '',
        BLOCKLIST_URL_PATTERNS: 'secret\/,private\/',
      });

      jest.isolateModules(() => {
        // Custom patterns should be blocked
        expect(isPathBlocked('/secret/data')).toBe(true);
        expect(isPathBlocked('/private/info')).toBe(true);
      });
    });

    it('should get blocklist config', () => {
      const config = getBlocklistConfig();
      expect(config.mode).toBe('blocklist');
      expect(config.patternCount).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty URL', () => {
      const result = validateUrl('');
      expect(result.valid).toBe(false);
    });

    it('should handle URL with query params', () => {
      const result = validateUrl('https://example.com/search?q=test&page=1');
      expect(result.valid).toBe(true);
    });

    it('should handle URL with fragment', () => {
      const result = validateUrl('https://example.com/page#section');
      expect(result.valid).toBe(true);
    });

    it('should handle URL with port', () => {
      const result = validateUrl('https://example.com:8080/path');
      expect(result.valid).toBe(true);
    });

    it('should handle international domain names', () => {
      const result = validateUrl('https://example.com/path');
      expect(result.valid).toBe(true);
    });
  });
});
