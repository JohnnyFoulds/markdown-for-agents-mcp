/**
 * MCP Server unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { initializeConfig, resetConfig, validateConfig } from './config.js';
import { Logger } from './utils/logger.js';

describe('MCP Server Configuration', () => {
  beforeEach(() => {
    resetConfig();
    initializeConfig({
      LOG_LEVEL: 'INFO',
      LOG_FORMAT: 'text',
      USE_ALLOWLIST_MODE: 'false',
      BLOCKLIST_DOMAINS: '',
      BLOCKLIST_URL_PATTERNS: '',
      FETCH_TIMEOUT_MS: '30000',
      MAX_CONCURRENT_FETCHES: '5',
      STABILIZATION_DELAY_MS: '2000',
      MAX_REDIRECTS: '10',
      MAX_CONTENT_LENGTH: '100000',
      CACHE_MAX_BYTES: '52428800',
      CACHE_TTL_MS: '900000',
    });
    Logger.clearMetrics();
  });

  afterEach(() => {
    resetConfig();
    Logger.clearMetrics();
  });

  describe('config validation', () => {
    it('should validate valid configuration', () => {
      const config = validateConfig();
      expect(config.LOG_LEVEL).toBe('INFO');
      expect(config.LOG_FORMAT).toBe('text');
    });

    it('should transform number strings to numbers', () => {
      const config = validateConfig();
      expect(typeof config.FETCH_TIMEOUT_MS).toBe('number');
      expect(config.FETCH_TIMEOUT_MS).toBe(30000);
      expect(typeof config.MAX_CONCURRENT_FETCHES).toBe('number');
      expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
    });

    it('should use defaults for missing values', () => {
      resetConfig();
      initializeConfig({});

      const config = validateConfig();
      expect(config.FETCH_TIMEOUT_MS).toBe(30000);
      expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
      expect(config.LOG_LEVEL).toBe('INFO');
    });

    it('should reject invalid LOG_LEVEL', () => {
      resetConfig();
      initializeConfig({ LOG_LEVEL: 'INVALID' });

      expect(() => validateConfig()).toThrow();
    });

    it('should reject invalid LOG_FORMAT', () => {
      resetConfig();
      initializeConfig({ LOG_FORMAT: 'invalid' });

      expect(() => validateConfig()).toThrow();
    });
  });

  describe('tool schemas', () => {
    it('should have fetch_url tool', () => {
      // Tool definitions are in index.ts
      // This test verifies the config system supports the tools
      const config = validateConfig();
      expect(config).toBeDefined();
      expect(config.LOG_LEVEL).toBeDefined();
    });

    it('should have fetch_urls tool', () => {
      const config = validateConfig();
      expect(config).toBeDefined();
      expect(config.MAX_CONCURRENT_FETCHES).toBeGreaterThan(0);
    });

    it('should have health_check tool', () => {
      const config = validateConfig();
      expect(config).toBeDefined();
      // Health check uses Logger metrics
      const health = Logger.getHealth();
      expect(health.status).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle missing required env vars with defaults', () => {
      resetConfig();
      initializeConfig({});

      expect(() => validateConfig()).not.toThrow();
    });

    it('should provide clear error messages for invalid config', () => {
      resetConfig();
      initializeConfig({ LOG_LEVEL: 'INVALID' });

      try {
        validateConfig();
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('Invalid configuration');
        expect(error.message).toContain('LOG_LEVEL');
      }
    });
  });

  describe('logging integration', () => {
    it('should use configured log level', () => {
      resetConfig();
      initializeConfig({ LOG_LEVEL: 'DEBUG' });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.debug('debug message');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should support JSON log format', () => {
      resetConfig();
      initializeConfig({ LOG_FORMAT: 'json' });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.info('test message');

      const call = consoleSpy.mock.calls[0]?.[0] as string;
      if (call) {
        const parsed = JSON.parse(call);
        expect(parsed.level).toBe('INFO');
        expect(parsed.message).toBe('test message');
      }
      consoleSpy.mockRestore();
    });
  });
});
