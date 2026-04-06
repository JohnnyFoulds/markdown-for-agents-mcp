/**
 * LRUCache unit tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LRUCache } from './cache.js';

describe('LRUCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic set and get', () => {
    it('stores and retrieves a string value', () => {
      const cache = new LRUCache<string>();
      cache.set('key1', 'value1', 6);
      expect(cache.get('key1')).toBe('value1');
    });

    it('returns undefined for a missing key', () => {
      const cache = new LRUCache<string>();
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns undefined after a key is deleted', () => {
      const cache = new LRUCache<string>();
      cache.set('key1', 'hello', 5);
      cache.delete('key1');
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('TTL expiry', () => {
    it('returns the value before TTL has elapsed', () => {
      const cache = new LRUCache<string>({ ttl: 5000 });
      cache.set('key', 'value', 5);
      vi.advanceTimersByTime(4999);
      expect(cache.get('key')).toBe('value');
    });

    it('returns undefined after TTL has elapsed', () => {
      const cache = new LRUCache<string>({ ttl: 5000 });
      cache.set('key', 'value', 5);
      vi.advanceTimersByTime(5001);
      expect(cache.get('key')).toBeUndefined();
    });

    it('removes the entry from size tracking on TTL expiry', () => {
      const cache = new LRUCache<string>({ ttl: 1000 });
      cache.set('key', 'hello', 100);
      expect(cache.totalBytes).toBe(100);
      vi.advanceTimersByTime(1001);
      cache.get('key'); // triggers eviction
      expect(cache.totalBytes).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used entry when maxLength is exceeded', () => {
      const cache = new LRUCache<string>({ maxLength: 2, maxBytes: Infinity });
      cache.set('a', 'alpha', 5);
      cache.set('b', 'beta', 4);
      // Access 'a' to make it most-recently-used
      cache.get('a');
      // Adding 'c' should evict 'b' (least-recently-used)
      cache.set('c', 'gamma', 5);
      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe('gamma');
    });

    it('evicts entries when maxBytes is exceeded', () => {
      const cache = new LRUCache<string>({ maxLength: 100, maxBytes: 10 });
      cache.set('a', 'hello', 6);
      // Adding 'b' with 6 bytes would exceed 10-byte limit — 'a' gets evicted
      cache.set('b', 'world!', 6);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('world!');
    });

    it('does not evict when under all limits', () => {
      const cache = new LRUCache<string>({ maxLength: 5, maxBytes: 1000 });
      cache.set('a', 'alpha', 5);
      cache.set('b', 'beta', 4);
      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('b')).toBe('beta');
      expect(cache.size).toBe(2);
    });
  });

  describe('delete', () => {
    it('removes the entry and decrements totalBytes', () => {
      const cache = new LRUCache<string>();
      cache.set('key', 'data', 100);
      expect(cache.totalBytes).toBe(100);
      const removed = cache.delete('key');
      expect(removed).toBe(true);
      expect(cache.totalBytes).toBe(0);
      expect(cache.size).toBe(0);
    });

    it('returns false for a non-existent key', () => {
      const cache = new LRUCache<string>();
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    it('empties all entries and resets totalBytes', () => {
      const cache = new LRUCache<string>();
      cache.set('a', 'alpha', 10);
      cache.set('b', 'beta', 20);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.totalBytes).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns correct size, totalBytes, maxBytes, and utilization', () => {
      const cache = new LRUCache<string>({ maxBytes: 1000 });
      cache.set('a', 'hello', 100);
      cache.set('b', 'world', 200);
      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.totalBytes).toBe(300);
      expect(stats.maxBytes).toBe(1000);
      expect(stats.utilization).toBeCloseTo(0.3);
    });
  });

  describe('access order promotion', () => {
    it('promotes an accessed key to most-recently-used position', () => {
      const cache = new LRUCache<string>({ maxLength: 2, maxBytes: Infinity });
      cache.set('a', 'alpha', 5);
      cache.set('b', 'beta', 4);
      // Access 'a' — promotes it; 'b' becomes LRU
      cache.get('a');
      // Adding 'c' evicts LRU which is now 'b'
      cache.set('c', 'gamma', 5);
      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe('gamma');
    });
  });

  describe('re-setting an existing key', () => {
    it('replaces the value and recalculates bytes correctly', () => {
      const cache = new LRUCache<string>({ maxBytes: 1000 });
      cache.set('key', 'short', 5);
      expect(cache.totalBytes).toBe(5);
      cache.set('key', 'a much longer value', 19);
      expect(cache.get('key')).toBe('a much longer value');
      expect(cache.totalBytes).toBe(19);
      expect(cache.size).toBe(1);
    });
  });

  describe('byte estimation', () => {
    it('estimates bytes for string values via Buffer.byteLength', () => {
      const cache = new LRUCache<string>();
      // Set without explicit bytes — relies on estimateBytes
      cache.set('key', 'hello');
      expect(cache.totalBytes).toBeGreaterThan(0);
    });

    it('estimates bytes for non-string values via JSON serialization', () => {
      const cache = new LRUCache<object>();
      cache.set('key', { foo: 'bar' });
      expect(cache.totalBytes).toBeGreaterThan(0);
    });
  });
});
