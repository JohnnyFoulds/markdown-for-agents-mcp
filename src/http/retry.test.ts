import { describe, test, expect } from 'vitest';
import { shouldRetry, computeBackoff, parseRetryAfter } from './retry.js';
import { DomainBlockedError, RobotsDeniedError, RateLimitTimeoutError } from '../utils/errors.js';

describe('shouldRetry', () => {
  test('retries on 429', () => expect(shouldRetry(null, 429)).toBe(true));
  test('retries on 503', () => expect(shouldRetry(null, 503)).toBe(true));
  test('retries on 502', () => expect(shouldRetry(null, 502)).toBe(true));
  test('does not retry on 400', () => expect(shouldRetry(null, 400)).toBe(false));
  test('does not retry on 401', () => expect(shouldRetry(null, 401)).toBe(false));
  test('does not retry on 404', () => expect(shouldRetry(null, 404)).toBe(false));
  test('retries on ECONNRESET', () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(shouldRetry(err)).toBe(true);
  });
  test('retries on timeout message', () => expect(shouldRetry(new Error('request timed out'))).toBe(true));
  test('never retries DomainBlockedError', () => expect(shouldRetry(new DomainBlockedError('x.com'))).toBe(false));
  test('never retries RobotsDeniedError', () => expect(shouldRetry(new RobotsDeniedError('https://x.com/'))).toBe(false));
  test('never retries RateLimitTimeoutError', () => expect(shouldRetry(new RateLimitTimeoutError(1000))).toBe(false));
});

describe('computeBackoff', () => {
  test('honours Retry-After in ms', () => {
    expect(computeBackoff(1, 500, 3000)).toBe(3000);
  });
  test('returns 0 for zero Retry-After', () => {
    expect(computeBackoff(1, 500, 0)).toBe(0);
  });
  test('returns a value in [0, base * 2^(attempt-1)] for attempt 1', () => {
    const v = computeBackoff(1, 100);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
  test('caps at 30000ms', () => {
    const v = computeBackoff(20, 1000);
    expect(v).toBeLessThanOrEqual(30_000);
  });
});

describe('parseRetryAfter', () => {
  test('parses integer seconds', () => expect(parseRetryAfter('5')).toBe(5000));
  test('parses float seconds', () => expect(parseRetryAfter('1.5')).toBe(2000));
  test('returns undefined for undefined input', () => expect(parseRetryAfter(undefined)).toBeUndefined());
  test('returns undefined for invalid string', () => expect(parseRetryAfter('not-a-date')).toBeUndefined());
  test('parses HTTP date string', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_100);
  });
});
