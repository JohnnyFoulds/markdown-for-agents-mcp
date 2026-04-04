/**
 * Logger unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Logger, LogLevel } from './logger.js';
import { initializeConfig, resetConfig } from '../config.js';

describe('Logger', () => {
  beforeEach(() => {
    resetConfig();
    initializeConfig({
      LOG_LEVEL: 'DEBUG',
      LOG_FORMAT: 'text',
    });
    Logger.clearMetrics();
  });

  afterEach(() => {
    resetConfig();
    Logger.clearMetrics();
  });

  describe('log levels', () => {
    it('should log at DEBUG level', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.debug('test debug message', { key: 'value' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test debug message'));
      consoleSpy.mockRestore();
    });

    it('should log at INFO level', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.info('test info message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test info message'));
      consoleSpy.mockRestore();
    });

    it('should log at WARN level', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.warn('test warn message', { warning: 'data' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test warn message'));
      consoleSpy.mockRestore();
    });

    it('should log at ERROR level', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.error('test error message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test error message'));
      consoleSpy.mockRestore();
    });
  });

  describe('log format', () => {
    it('should format logs as text by default', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      initializeConfig({ LOG_FORMAT: 'text' });
      Logger.info('test message');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/));
      consoleSpy.mockRestore();
    });

    it('should format logs as JSON when configured', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      initializeConfig({ LOG_FORMAT: 'json' });
      Logger.info('test message', { key: 'value' });
      expect(consoleSpy.mock.calls[0]?.[0]).toBeDefined();
      const call = consoleSpy.mock.calls[0]?.[0] as string;
      if (call) {
        const parsed = JSON.parse(call);
        expect(parsed.timestamp).toBeDefined();
        expect(parsed.level).toBe('INFO');
        expect(parsed.message).toBe('test message');
        expect(parsed.data).toEqual({ key: 'value' });
      }
      consoleSpy.mockRestore();
    });
  });

  describe('request IDs', () => {
    it('should include request ID when provided', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const requestId = Logger.generateRequestId();
      Logger.info('test message', undefined, requestId);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(requestId));
      consoleSpy.mockRestore();
    });

    it('generateRequestId should return valid UUID format', () => {
      const requestId = Logger.generateRequestId();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(requestId).toMatch(uuidRegex);
    });
  });

  describe('fetch metrics', () => {
    it('should log successful fetch', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const requestId = Logger.generateRequestId();
      Logger.logFetch({
        url: 'https://example.com',
        duration: 150,
        success: true,
        requestId,
      });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('success (150ms)'));
      consoleSpy.mockRestore();
    });

    it('should log failed fetch', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const requestId = Logger.generateRequestId();
      Logger.logFetch({
        url: 'https://example.com',
        duration: 200,
        success: false,
        error: 'Network error',
        requestId,
      });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed: Network error'));
      consoleSpy.mockRestore();
    });

    it('should track fetch metrics', () => {
      Logger.logFetch({
        url: 'https://example.com',
        duration: 100,
        success: true,
      });
      Logger.logFetch({
        url: 'https://example.org',
        duration: 200,
        success: false,
        error: 'Timeout',
      });

      const metrics = Logger.getMetrics();
      expect(metrics.length).toBe(2);
      expect(metrics[0]?.success).toBe(true);
      expect(metrics[1]?.success).toBe(false);
    });
  });

  describe('cache metrics', () => {
    it('should track cache hits', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.logCacheHit('example.com', 1024);
      const cacheMetrics = Logger.getCacheMetrics();
      expect(cacheMetrics.hits).toBe(1);
      consoleSpy.mockRestore();
    });

    it('should track cache misses', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Logger.logCacheMiss('example.com');
      const cacheMetrics = Logger.getCacheMetrics();
      expect(cacheMetrics.misses).toBe(1);
      consoleSpy.mockRestore();
    });

    it('should update cache stats', () => {
      Logger.updateCacheStats(10, 5000, 52428800);
      const cacheMetrics = Logger.getCacheMetrics();
      expect(cacheMetrics.currentSize).toBe(10);
      expect(cacheMetrics.totalBytes).toBe(5000);
      expect(cacheMetrics.maxBytes).toBe(52428800);
    });
  });

  describe('domain metrics', () => {
    it('should track domain metrics', () => {
      Logger.logFetch({
        url: 'https://example.com/page1',
        duration: 100,
        success: true,
      });
      Logger.logFetch({
        url: 'https://example.com/page2',
        duration: 150,
        success: true,
      });
      Logger.logFetch({
        url: 'https://example.org/page1',
        duration: 200,
        success: false,
        error: 'Error',
      });

      const domainMetrics = Logger.getDomainMetrics();
      const exampleCom = domainMetrics.get('example.com');
      const exampleOrg = domainMetrics.get('example.org');
      if (exampleCom) {
        expect(exampleCom.fetchCount).toBe(2);
        expect(exampleCom.successCount).toBe(2);
      }
      if (exampleOrg) {
        expect(exampleOrg.fetchCount).toBe(1);
        expect(exampleOrg.errorCount).toBe(1);
      }
    });
  });

  describe('summary', () => {
    it('should calculate summary correctly', () => {
      Logger.logFetch({ url: 'https://example.com/1', duration: 100, success: true });
      Logger.logFetch({ url: 'https://example.com/2', duration: 200, success: true });
      Logger.logFetch({ url: 'https://example.com/3', duration: 300, success: false, error: 'Error' });

      Logger.logCacheHit('example.com', 1000);
      Logger.logCacheMiss('example.org');

      const summary = Logger.getSummary();
      expect(summary.totalFetches).toBe(3);
      expect(summary.successCount).toBe(2);
      expect(summary.errorCount).toBe(1);
      expect(summary.avgDuration).toBe(200);
      expect(summary.cacheHits).toBe(1);
      expect(summary.cacheMisses).toBe(1);
      expect(summary.cacheUtilization).toBe(50);
    });
  });

  describe('health status', () => {
    it('should return healthy status when no errors', () => {
      Logger.logFetch({ url: 'https://example.com/1', duration: 100, success: true });
      Logger.logFetch({ url: 'https://example.com/2', duration: 200, success: true });

      const health = Logger.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.metrics.successCount).toBe(2);
    });

    it('should return unhealthy status when errors exist', () => {
      Logger.logFetch({ url: 'https://example.com/1', duration: 100, success: true });
      Logger.logFetch({ url: 'https://example.com/2', duration: 200, success: false, error: 'Error' });

      const health = Logger.getHealth();
      expect(health.status).toBe('unhealthy');
      expect(health.metrics.errorCount).toBe(1);
    });
  });

  describe('clear metrics', () => {
    it('should clear all metrics', () => {
      Logger.logFetch({ url: 'https://example.com', duration: 100, success: true });
      Logger.logCacheHit('example.com', 1000);
      Logger.updateCacheStats(5, 2000, 5000);

      Logger.clearMetrics();

      expect(Logger.getMetrics().length).toBe(0);
      expect(Logger.getCacheMetrics().hits).toBe(0);
      expect(Logger.getCacheMetrics().totalBytes).toBe(0);
    });
  });
});
