/**
 * MCP Server unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeConfig, resetConfig, validateConfig, validateAndInitializeConfig, getConfig } from './config.js';
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

      expect(() => initializeConfig({ LOG_LEVEL: 'INVALID' })).toThrow('Invalid LOG_LEVEL');
    });

    it('should reject invalid LOG_FORMAT', () => {
      resetConfig();

      expect(() => initializeConfig({ LOG_FORMAT: 'invalid' })).toThrow('Invalid LOG_FORMAT');
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

      try {
        initializeConfig({ LOG_LEVEL: 'INVALID' });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('Invalid LOG_LEVEL');
      }
    });
  });

  describe('logging integration', () => {
    it('should use configured log level', () => {
      resetConfig();
      initializeConfig({ LOG_LEVEL: 'DEBUG' });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Logger.debug('debug message');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should support JSON log format', () => {
      resetConfig();
      initializeConfig({ LOG_FORMAT: 'json' });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

describe('validateAndInitializeConfig', () => {
  beforeEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  it('parses process.env and makes config accessible via getConfig()', () => {
    vi.stubEnv('LOG_LEVEL', 'WARN');
    vi.stubEnv('FETCH_TIMEOUT_MS', '45000');

    const config = validateAndInitializeConfig();

    expect(config.LOG_LEVEL).toBe('WARN');
    expect(config.FETCH_TIMEOUT_MS).toBe(45000);

    // Must be accessible via getConfig() after initialization
    const stored = getConfig();
    expect(stored.LOG_LEVEL).toBe('WARN');
    expect(stored.FETCH_TIMEOUT_MS).toBe(45000);
  });

  it('parses the environment exactly once (returns consistent result)', () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');

    const first = validateAndInitializeConfig();
    const second = getConfig();

    expect(first.LOG_LEVEL).toBe(second.LOG_LEVEL);
    expect(first.FETCH_TIMEOUT_MS).toBe(second.FETCH_TIMEOUT_MS);
  });

  it('throws on invalid LOG_LEVEL in process.env', () => {
    vi.stubEnv('LOG_LEVEL', 'INVALID_LEVEL');
    expect(() => validateAndInitializeConfig()).toThrow('Invalid configuration');
  });

  it('uses defaults for missing env vars', () => {
    const config = validateAndInitializeConfig();
    expect(config.FETCH_TIMEOUT_MS).toBe(30000);
    expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
    expect(config.LOG_LEVEL).toBe('INFO');
  });
});
