/**
 * Privacy redaction primitives — unit tests.
 *
 * Phase 5 RED (before creating src/privacy/redact.ts and adding
 * _resetQuerySaltForTest to logger.ts):
 *   "Cannot find module './redact.js'"
 *   "_resetQuerySaltForTest is not exported from '../utils/logger.js'"
 *
 * Key invariants asserted here:
 * - redactUrl keeps scheme/host/path, scrubs query-param values and credentials
 * - redactHeaders scrubs authorization / cookie / set-cookie values
 * - redactQuery uses a per-process random salt (two resets → different hashes)
 * - redactQuery widens to 16 hex chars (was 8 — collision risk near 65 k values)
 * - Logger.log in JSON format scrubs sensitive keys from the data object
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import { redactUrl, redactHeaders } from './redact.js';
import { redactQuery, _resetQuerySaltForTest, Logger } from '../utils/logger.js';
import { initializeConfig } from '../config.js';

// ── redactUrl ─────────────────────────────────────────────────────────────────

describe('redactUrl', () => {
  it('preserves scheme, host, and path', () => {
    expect(redactUrl('https://example.com/search')).toBe('https://example.com/search');
  });

  it('redacts query-parameter values, keeps keys', () => {
    const r = redactUrl('https://example.com/q?msisdn=27821234567&q=johannesburg');
    expect(r).toContain('msisdn=');
    expect(r).not.toContain('27821234567');
    expect(r).toContain('q=');
    expect(r).not.toContain('johannesburg');
    expect(r).toContain('[redacted]');
  });

  it('scrubs embedded credentials', () => {
    const r = redactUrl('https://user:s3cr3t@example.com/path');
    expect(r).not.toContain('s3cr3t');
    expect(r).not.toContain('user:');
  });

  it('returns [url] for invalid input', () => {
    expect(redactUrl('not a url at all')).toBe('[url]');
  });

  it('is a no-op for clean URLs with no query string', () => {
    const plain = 'https://example.com/page/one';
    expect(redactUrl(plain)).toBe(plain);
  });
});

// ── redactHeaders ─────────────────────────────────────────────────────────────

describe('redactHeaders', () => {
  it('redacts Authorization value', () => {
    const r = redactHeaders({ Authorization: 'Bearer sk-secret', 'Content-Type': 'application/json' });
    expect(r['Authorization']).toBe('[redacted]');
    expect(r['Content-Type']).toBe('application/json');
  });

  it('redacts cookie value (lowercase)', () => {
    expect(redactHeaders({ cookie: 'session=abc123' })['cookie']).toBe('[redacted]');
  });

  it('redacts set-cookie value', () => {
    expect(redactHeaders({ 'set-cookie': 'session=abc; HttpOnly' })['set-cookie']).toBe('[redacted]');
  });

  it('is case-insensitive on header names', () => {
    expect(redactHeaders({ AUTHORIZATION: 'Bearer x' })['AUTHORIZATION']).toBe('[redacted]');
  });

  it('passes through non-sensitive headers unchanged', () => {
    const r = redactHeaders({ 'User-Agent': 'test/1', Accept: '*/*' });
    expect(r['User-Agent']).toBe('test/1');
    expect(r['Accept']).toBe('*/*');
  });
});

// ── redactQuery — per-process salt ────────────────────────────────────────────

describe('redactQuery — per-process random salt', () => {
  afterEach(() => {
    _resetQuerySaltForTest();
    initializeConfig({});
  });

  it('produces 16-character hex hash (widened from 8 for collision safety)', () => {
    initializeConfig({});
    const result = redactQuery('test query');
    expect(result).toMatch(/^\[redacted:[0-9a-f]{16}\]$/);
  });

  it('is deterministic within the same process (same salt)', () => {
    initializeConfig({});
    expect(redactQuery('same input')).toBe(redactQuery('same input'));
  });

  it('produces a different hash after salt reset — simulates a fresh process', () => {
    initializeConfig({});
    const h1 = redactQuery('test query');
    _resetQuerySaltForTest();
    // Force re-read of config with no explicit salt → new random salt
    initializeConfig({});
    const h2 = redactQuery('test query');
    // p(h1 === h2) ≈ 1/2^128; treat as impossible in practice
    expect(h1).not.toBe(h2);
  });

  it('is deterministic across resets when LOG_REDACT_SALT is set', () => {
    initializeConfig({ LOG_REDACT_SALT: 'deterministic-test-salt-abc' });
    const h1 = redactQuery('test query');
    _resetQuerySaltForTest();
    initializeConfig({ LOG_REDACT_SALT: 'deterministic-test-salt-abc' });
    const h2 = redactQuery('test query');
    expect(h1).toBe(h2);
  });

  it('returns query unchanged when LOG_REDACT_QUERIES=false', () => {
    initializeConfig({ LOG_REDACT_QUERIES: 'false' });
    expect(redactQuery('my sensitive query')).toBe('my sensitive query');
  });
});

// ── formatJsonEntry key scrubbing ─────────────────────────────────────────────

describe('Logger JSON format — sensitive key scrubbing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initializeConfig({});
  });

  it('scrubs authorization value from data object', () => {
    initializeConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'WARN' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Logger.warn('test message', { authorization: 'Bearer sk-very-secret' });
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.data.authorization).toBe('[redacted]');
  });

  it('scrubs cookie value from data object', () => {
    initializeConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'WARN' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Logger.warn('test message', { cookie: 'session=sensitive' });
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.data.cookie).toBe('[redacted]');
  });

  it('scrubs set-cookie value from data object (case-insensitive key)', () => {
    initializeConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'WARN' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Logger.warn('test message', { 'Set-Cookie': 'session=abc; HttpOnly' });
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.data['Set-Cookie']).toBe('[redacted]');
  });

  it('preserves non-sensitive data fields', () => {
    initializeConfig({ LOG_FORMAT: 'json', LOG_LEVEL: 'INFO' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Logger.info('test message', { hostname: 'example.com', statusCode: 200 });
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.data.hostname).toBe('example.com');
    expect(out.data.statusCode).toBe(200);
  });
});
