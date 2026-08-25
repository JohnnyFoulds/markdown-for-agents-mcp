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
import { redactUrl, redactHeaders, hashCallerIdentity, _resetCallerSaltForTest } from './redact.js';
import { redactQuery, _resetQuerySaltForTest, Logger } from '../utils/logger.js';
import { initializeConfig, resetConfig } from '../config.js';

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

// ── hashCallerIdentity ────────────────────────────────────────────────────────
// N6: x-mcp-caller-id is treated as sensitive by redactHeaders
describe('redactHeaders — x-mcp-caller-id is sensitive', () => {
  it('redacts X-Mcp-Caller-Id value (PascalCase key)', () => {
    const r = redactHeaders({ 'X-Mcp-Caller-Id': 'alice@corp.co.za' });
    expect(r['X-Mcp-Caller-Id']).toBe('[redacted]');
  });

  it('redacts x-mcp-caller-id value (lowercase key)', () => {
    const r = redactHeaders({ 'x-mcp-caller-id': 'alice@corp.co.za' });
    expect(r['x-mcp-caller-id']).toBe('[redacted]');
  });
});

// N7/N8: hashCallerIdentity shape, determinism, salt isolation
describe('hashCallerIdentity — per-process salt', () => {
  afterEach(() => {
    _resetCallerSaltForTest();
    resetConfig();
    initializeConfig({});
  });

  it('produces 16-character hex hash for a valid identity', () => {
    initializeConfig({});
    const result = hashCallerIdentity('alice@corp.co.za');
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.reason).toBe('ok');
  });

  it('is deterministic within the same process (same salt)', () => {
    initializeConfig({});
    expect(hashCallerIdentity('alice@corp').hash).toBe(hashCallerIdentity('alice@corp').hash);
  });

  it('produces a different hash after salt reset — simulates a fresh process', () => {
    initializeConfig({});
    const h1 = hashCallerIdentity('alice@corp').hash;
    _resetCallerSaltForTest();
    resetConfig();
    initializeConfig({});
    const h2 = hashCallerIdentity('alice@corp').hash;
    // p(h1 === h2) ≈ 1/2^128; treat as impossible
    expect(h1).not.toBe(h2);
  });

  it('is deterministic across resets when MCP_CALLER_ID_SALT is set', () => {
    initializeConfig({ MCP_CALLER_ID_SALT: 'explicit-test-salt-xyz' });
    const h1 = hashCallerIdentity('alice@corp').hash;
    _resetCallerSaltForTest();
    initializeConfig({ MCP_CALLER_ID_SALT: 'explicit-test-salt-xyz' });
    const h2 = hashCallerIdentity('alice@corp').hash;
    expect(h1).toBe(h2);
  });

  // N8: WRITE THIS FIRST — the invariant that proves separate salts landed
  it('N8 — identity hash differs from redactQuery hash for the same input (separate salt spaces)', () => {
    initializeConfig({});
    const identityResult = hashCallerIdentity('test-subject');
    const queryHash = redactQuery('test-subject');
    // If the same salt were used, HMAC('salt', 'x').slice(0,16) would be equal
    expect(identityResult.hash).not.toBe(queryHash.replace(/^\[redacted:([0-9a-f]{16})\]$/, '$1'));
  });

  it('normalises case — Alice@Corp and alice@corp produce the same hash', () => {
    initializeConfig({});
    expect(hashCallerIdentity('Alice@Corp').hash).toBe(hashCallerIdentity('alice@corp').hash);
  });

  it('normalises leading/trailing whitespace before hashing', () => {
    initializeConfig({});
    expect(hashCallerIdentity('  alice@corp  ').hash).toBe(hashCallerIdentity('alice@corp').hash);
  });
});

// N19: validation table — every rejection/absent case
describe('hashCallerIdentity — validation', () => {
  afterEach(() => {
    _resetCallerSaltForTest();
    resetConfig();
    initializeConfig({});
  });

  it('treats empty string as absent', () => {
    initializeConfig({});
    const r = hashCallerIdentity('');
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('absent');
  });

  it('treats whitespace-only as absent', () => {
    initializeConfig({});
    const r = hashCallerIdentity('   ');
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('absent');
  });

  it('rejects a 257-character value as too_long (not truncated)', () => {
    initializeConfig({});
    const long = 'a'.repeat(257);
    const r = hashCallerIdentity(long);
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('too_long');
  });

  it('accepts a 256-character value', () => {
    initializeConfig({});
    const r = hashCallerIdentity('a'.repeat(256));
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.reason).toBe('ok');
  });

  it('rejects a multi-value (comma-joined duplicate header) as multi_value', () => {
    initializeConfig({});
    const r = hashCallerIdentity('alice@corp, attacker@evil.com');
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('multi_value');
  });

  it('rejects non-ASCII characters as bad_chars', () => {
    initializeConfig({});
    // latin1-encoded UTF-8: café arrives as cafÃ©
    const r = hashCallerIdentity('caf\xc3\xa9');
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('bad_chars');
  });

  it('rejects a value with a space (non-printable-outside-trim) as bad_chars', () => {
    initializeConfig({});
    // Space is 0x20, which is below the 0x21–0x7E printable range.
    // But trim() runs first, so only inner spaces trigger bad_chars.
    const r = hashCallerIdentity('alice corp');  // inner space
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('bad_chars');
  });

  it('undefined input is treated as absent', () => {
    initializeConfig({});
    const r = hashCallerIdentity(undefined);
    expect(r.hash).toBeNull();
    expect(r.reason).toBe('absent');
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
