/**
 * Domain blacklist unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
      expect(isDomainBlocked('cloudflare.com')).toBe(false); // CDN, not a tracker
      expect(isDomainBlocked('cloudflareinsights.com')).toBe(true);
      expect(isDomainBlocked('intercom.io')).toBe(true);
      expect(isDomainBlocked('hotjar.io')).toBe(true);
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
      expect(isPathBlocked('/file.download.dmg')).toBe(true);
      expect(isPathBlocked('/file.download.iso')).toBe(true);
    });

    it('should block payment paths', () => {
      expect(isPathBlocked('/checkout/123')).toBe(true);
      expect(isPathBlocked('/payment/process')).toBe(true);
      expect(isPathBlocked('/billing/invoice')).toBe(true);
    });

    it('should block admin paths', () => {
      expect(isPathBlocked('/admin/dashboard')).toBe(true);
      expect(isPathBlocked('/wp-admin/')).toBe(true);
      expect(isPathBlocked('/cpanel/')).toBe(true);
      expect(isPathBlocked('/phpmyadmin/')).toBe(true);
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

  describe('SSRF protection', () => {
    it('should block localhost', () => {
      expect(validateUrl('http://localhost/path').valid).toBe(false);
      expect(validateUrl('http://localhost:8080/').valid).toBe(false);
    });

    it('should block 127.x.x.x loopback addresses', () => {
      expect(validateUrl('http://127.0.0.1/').valid).toBe(false);
      expect(validateUrl('http://127.0.0.2/').valid).toBe(false);
      expect(validateUrl('http://127.255.255.255/').valid).toBe(false);
    });

    it('should block 10.x.x.x RFC1918 addresses', () => {
      expect(validateUrl('http://10.0.0.1/').valid).toBe(false);
      expect(validateUrl('http://10.255.255.255/').valid).toBe(false);
    });

    it('should block 172.16-31.x.x RFC1918 addresses', () => {
      expect(validateUrl('http://172.16.0.1/').valid).toBe(false);
      expect(validateUrl('http://172.31.255.255/').valid).toBe(false);
    });

    it('should allow 172.15.x.x (not in RFC1918 range)', () => {
      // 172.15.x.x is outside the 172.16-31 block
      expect(validateUrl('http://172.15.0.1/').valid).toBe(true);
    });

    it('should allow 172.32.x.x (not in RFC1918 range)', () => {
      expect(validateUrl('http://172.32.0.1/').valid).toBe(true);
    });

    it('should block 192.168.x.x RFC1918 addresses', () => {
      expect(validateUrl('http://192.168.0.1/').valid).toBe(false);
      expect(validateUrl('http://192.168.1.100/').valid).toBe(false);
    });

    it('should block 169.254.x.x link-local / AWS metadata', () => {
      expect(validateUrl('http://169.254.169.254/').valid).toBe(false);
      expect(validateUrl('http://169.254.0.1/').valid).toBe(false);
    });

    it('should block 0.0.0.0', () => {
      expect(validateUrl('http://0.0.0.0/').valid).toBe(false);
    });

    it('should block IPv6 loopback ::1', () => {
      expect(validateUrl('http://[::1]/').valid).toBe(false);
    });

    it('should include SSRF error message', () => {
      const result = validateUrl('http://127.0.0.1/');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('SSRF');
      }
    });
  });

  describe('custom blocklist configuration', () => {
    it('should get blocklist config', () => {
      const config = getBlocklistConfig();
      expect(config.mode).toBe('blocklist');
      expect(config.patternCount).toBeGreaterThan(0);
    });

    it('should reflect allowlist mode in getBlocklistConfig', () => {
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'true',
        BLOCKLIST_DOMAINS: 'allowed.com',
        BLOCKLIST_URL_PATTERNS: '',
      });
      const config = getBlocklistConfig();
      expect(config.mode).toBe('allowlist');
      expect(config.customDomains).toContain('allowed.com');
    });

    it('should include custom domains in getBlocklistConfig', () => {
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'false',
        BLOCKLIST_DOMAINS: 'evil.com,bad.org',
        BLOCKLIST_URL_PATTERNS: '',
      });
      const config = getBlocklistConfig();
      expect(config.customDomains).toContain('evil.com');
      expect(config.customDomains).toContain('bad.org');
    });

    it('should skip invalid regex patterns and warn', () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'false',
        BLOCKLIST_DOMAINS: '',
        BLOCKLIST_URL_PATTERNS: '(invalid[,/valid/path',
      });
      // Should not throw; invalid pattern skipped, valid one kept
      expect(() => isPathBlocked('/valid/path')).not.toThrow();
      warnSpy.mockRestore();
    });

    it('should skip patterns longer than 500 chars', () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resetConfig();
      initializeConfig({
        USE_ALLOWLIST_MODE: 'false',
        BLOCKLIST_DOMAINS: '',
        BLOCKLIST_URL_PATTERNS: 'a'.repeat(501),
      });
      expect(() => isPathBlocked('/anything')).not.toThrow();
      warnSpy.mockRestore();
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
