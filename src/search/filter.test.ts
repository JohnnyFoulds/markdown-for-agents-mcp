import { describe, test, expect } from 'vitest';
import { passesAllowedList, passesBlockedList, passesSystemBlocklist, domainOf } from './filter.js';

describe('passesAllowedList', () => {
  test('passes when no allowedDomains specified', () => {
    expect(passesAllowedList('any.com')).toBe(true);
    expect(passesAllowedList('any.com', [])).toBe(true);
  });

  test('passes when domain matches exactly', () => {
    expect(passesAllowedList('example.com', ['example.com'])).toBe(true);
  });

  test('passes when domain is a subdomain of an allowed domain', () => {
    expect(passesAllowedList('sub.example.com', ['example.com'])).toBe(true);
  });

  test('blocks when domain is not in allowed list', () => {
    expect(passesAllowedList('other.com', ['example.com'])).toBe(false);
  });

  test('does not allow subdomain of subdomain that is not in list', () => {
    // 'foo.example.com' should not match allowed domain 'com'
    expect(passesAllowedList('foo.example.com', ['bar.com'])).toBe(false);
  });
});

describe('passesBlockedList', () => {
  test('passes when no blockedDomains specified', () => {
    expect(passesBlockedList('any.com')).toBe(true);
    expect(passesBlockedList('any.com', [])).toBe(true);
  });

  test('blocks exact domain match', () => {
    expect(passesBlockedList('blocked.com', ['blocked.com'])).toBe(false);
  });

  test('blocks subdomain of blocked domain', () => {
    expect(passesBlockedList('sub.blocked.com', ['blocked.com'])).toBe(false);
  });

  test('passes domain not in blocked list', () => {
    expect(passesBlockedList('ok.com', ['blocked.com'])).toBe(true);
  });
});

describe('passesSystemBlocklist', () => {
  test('returns boolean for any domain', () => {
    expect(typeof passesSystemBlocklist('anything.com')).toBe('boolean');
  });

  test('blocks domains that are in the system blocklist', () => {
    // These should be blocked by the built-in list
    expect(passesSystemBlocklist('doubleclick.net')).toBe(false);
  });

  test('passes normal content domains', () => {
    expect(passesSystemBlocklist('example.com')).toBe(true);
    expect(passesSystemBlocklist('wikipedia.org')).toBe(true);
  });
});

describe('domainOf', () => {
  test('extracts hostname from URL', () => {
    expect(domainOf('https://example.com/path')).toBe('example.com');
    expect(domainOf('https://sub.example.com/page?q=1')).toBe('sub.example.com');
  });

  test('returns raw input when not a valid URL', () => {
    expect(domainOf('not-a-url')).toBe('not-a-url');
  });
});
