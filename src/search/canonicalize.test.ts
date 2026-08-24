import { describe, test, expect } from 'vitest';
import { canonicalizeUrl, deduplicateByCanonical } from './canonicalize.js';

describe('canonicalizeUrl', () => {
  test('strips UTM tracking params', () => {
    const url = 'https://example.com/page?utm_source=google&utm_medium=cpc&utm_campaign=test';
    expect(canonicalizeUrl(url)).toBe('https://example.com/page');
  });

  test('strips gclid and fbclid', () => {
    expect(canonicalizeUrl('https://example.com/?gclid=abc123')).toBe('https://example.com');
    expect(canonicalizeUrl('https://example.com/?fbclid=xyz789')).toBe('https://example.com');
  });

  test('strips URL fragment', () => {
    expect(canonicalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  test('strips leading www.', () => {
    expect(canonicalizeUrl('https://www.example.com/page')).toBe('https://example.com/page');
  });

  test('strips trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/page/')).toBe('https://example.com/page');
  });

  test('lowercases hostname', () => {
    expect(canonicalizeUrl('https://EXAMPLE.COM/page')).toBe('https://example.com/page');
  });

  test('sorts remaining query params for stability', () => {
    const a = canonicalizeUrl('https://example.com/?b=2&a=1');
    const b = canonicalizeUrl('https://example.com/?a=1&b=2');
    expect(a).toBe(b);
  });

  test('preserves non-tracking params', () => {
    const url = 'https://example.com/search?q=test&page=2';
    expect(canonicalizeUrl(url)).toContain('q=test');
    expect(canonicalizeUrl(url)).toContain('page=2');
  });

  test('unwraps DDG redirect (?uddg=<encoded>)', () => {
    const target = 'https://target.com/article';
    const redirect = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`;
    expect(canonicalizeUrl(redirect)).toBe(target);
  });

  test('unwraps Google /url?q= redirect', () => {
    const target = 'https://real.com/page';
    const redirect = `https://www.google.com/url?q=${encodeURIComponent(target)}&sa=U`;
    expect(canonicalizeUrl(redirect)).toBe(target);
  });

  test('returns raw URL unchanged for unparseable input', () => {
    expect(canonicalizeUrl('not-a-url')).toBe('not-a-url');
  });

  test('UTM variant and clean URL canonicalize to same value', () => {
    const clean = canonicalizeUrl('https://example.com/page');
    const tracked = canonicalizeUrl('https://example.com/page?utm_source=newsletter');
    expect(clean).toBe(tracked);
  });
});

describe('deduplicateByCanonical', () => {
  test('deduplicates byte-identical URLs', () => {
    const results = [
      { url: 'https://a.com', rank: 1 },
      { url: 'https://a.com', rank: 2 },
    ];
    expect(deduplicateByCanonical(results)).toHaveLength(1);
  });

  test('deduplicates UTM variants (keeps first)', () => {
    const results = [
      { url: 'https://example.com/page', rank: 1 },
      { url: 'https://example.com/page?utm_source=x', rank: 2 },
    ];
    const deduped = deduplicateByCanonical(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.url).toBe('https://example.com/page');
  });

  test('deduplicates www vs non-www', () => {
    const results = [
      { url: 'https://example.com/p', rank: 1 },
      { url: 'https://www.example.com/p', rank: 2 },
    ];
    expect(deduplicateByCanonical(results)).toHaveLength(1);
  });

  test('preserves genuinely different URLs', () => {
    const results = [
      { url: 'https://a.com', rank: 1 },
      { url: 'https://b.com', rank: 2 },
    ];
    expect(deduplicateByCanonical(results)).toHaveLength(2);
  });
});
