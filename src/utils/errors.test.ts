/**
 * Custom error classes unit tests
 */

import { describe, it, expect } from 'vitest';
import {
  DomainBlockedError,
  ContentTooLargeError,
  FetchTimeoutError,
  RedirectBlockedError,
  RedirectLoopError,
} from './errors.js';

describe('Custom error classes', () => {
  it('DomainBlockedError has correct name and message', () => {
    const err = new DomainBlockedError('evil.com');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DomainBlockedError');
    expect(err.message).toContain('evil.com');
  });

  it('ContentTooLargeError has correct name and message', () => {
    const err = new ContentTooLargeError('https://example.com', 200000, 100000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContentTooLargeError');
    expect(err.message).toContain('https://example.com');
    expect(err.message).toContain('200000');
    expect(err.message).toContain('100000');
  });

  it('FetchTimeoutError has correct name and message', () => {
    const err = new FetchTimeoutError('https://example.com', 30000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FetchTimeoutError');
    expect(err.message).toContain('https://example.com');
    expect(err.message).toContain('30000');
  });

  it('RedirectBlockedError has correct name and message', () => {
    const err = new RedirectBlockedError('https://origin.com', 'https://evil.com');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RedirectBlockedError');
    expect(err.message).toContain('https://origin.com');
    expect(err.message).toContain('https://evil.com');
  });

  it('RedirectLoopError has correct name and message', () => {
    const err = new RedirectLoopError(10);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RedirectLoopError');
    expect(err.message).toContain('10');
  });

  it('all errors are catchable as Error instances', () => {
    const errors = [
      new DomainBlockedError('x.com'),
      new ContentTooLargeError('https://x.com', 1, 1),
      new FetchTimeoutError('https://x.com', 1),
      new RedirectBlockedError('https://a.com', 'https://b.com'),
      new RedirectLoopError(5),
    ];
    for (const err of errors) {
      expect(err instanceof Error).toBe(true);
    }
  });
});
