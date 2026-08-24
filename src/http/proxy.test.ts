import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProxy, resolveProxyList, resetProxyCache } from './proxy.js';

beforeEach(() => {
  resetProxyCache();
  delete process.env['PROXY_PINS'];
  delete process.env['HTTP_PROXY_URL'];
  delete process.env['PLAYWRIGHT_PROXY'];
});
afterEach(() => {
  resetProxyCache();
  delete process.env['PROXY_PINS'];
  delete process.env['HTTP_PROXY_URL'];
  delete process.env['PLAYWRIGHT_PROXY'];
});

describe('resolveProxy — no proxy configured', () => {
  it('returns undefined when no proxy env vars set', () => {
    expect(resolveProxy()).toBeUndefined();
  });
});

describe('resolveProxy — single proxy', () => {
  it('returns HTTP_PROXY_URL when set', () => {
    process.env['HTTP_PROXY_URL'] = 'http://proxy:3128';
    resetProxyCache();
    expect(resolveProxy()?.url).toBe('http://proxy:3128');
  });
});

describe('resolveProxy — PROXY_PINS rotation', () => {
  it('round-robins across pins', () => {
    process.env['PROXY_PINS'] = '["http://p1:3128","http://p2:3128","http://p3:3128"]';
    resetProxyCache();
    expect(resolveProxy()?.url).toBe('http://p1:3128');
    expect(resolveProxy()?.url).toBe('http://p2:3128');
    expect(resolveProxy()?.url).toBe('http://p3:3128');
    // wraps around
    expect(resolveProxy()?.url).toBe('http://p1:3128');
  });

  it('ignores HTTP_PROXY_URL when PROXY_PINS is set', () => {
    process.env['PROXY_PINS'] = '["http://pin:3128"]';
    process.env['HTTP_PROXY_URL'] = 'http://single:3128';
    resetProxyCache();
    expect(resolveProxy()?.url).toBe('http://pin:3128');
  });

  it('returns undefined for invalid JSON', () => {
    process.env['PROXY_PINS'] = 'not-json';
    resetProxyCache();
    expect(resolveProxy()).toBeUndefined();
  });
});

describe('resolveProxyList', () => {
  it('returns empty array when no proxy configured', () => {
    expect(resolveProxyList()).toEqual([]);
  });

  it('returns single-entry list from HTTP_PROXY_URL', () => {
    process.env['HTTP_PROXY_URL'] = 'http://proxy:3128';
    resetProxyCache();
    expect(resolveProxyList()).toEqual(['http://proxy:3128']);
  });

  it('returns full pins list', () => {
    process.env['PROXY_PINS'] = '["http://p1:3128","http://p2:3128"]';
    resetProxyCache();
    expect(resolveProxyList()).toEqual(['http://p1:3128', 'http://p2:3128']);
  });
});
