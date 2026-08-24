/**
 * RFC 9111 shared-cache conformance — cachePolicy unit tests.
 *
 * Phase 1 RED reason (before fix):
 *   The fetcher uses a process-global LRU keyed on the bare URL.
 *   `fetch_page(url, headers={Cookie:"s=A"})` then `fetch_page(url)` returns
 *   the first caller's authenticated HTML to an unauthenticated caller.
 *   None of the RFC 9111 directives (no-store, private, Authorization, Vary,
 *   Set-Cookie) are inspected.
 *
 * After fix:
 *   All clauses below hold, each named after the RFC section it tests.
 *   The cache_not_stored_total metric increments for each non-stored response.
 */

import { describe, it, expect } from 'vitest';
import {
  isStorable,
  freshnessMs,
  secondaryKey,
  CREDENTIAL_REQUEST_HEADERS,
} from './cachePolicy.js';

// ── §3 / §3.5 — storability ──────────────────────────────────────────────────

describe('cachePolicy.isStorable — RFC 9111 §3 / §3.5', () => {
  function req(headers: Record<string, string> = {}): Record<string, string> { return headers; }
  function res(headers: Record<string, string> = {}): Record<string, string> { return headers; }

  it('stores a plain cacheable response', () => {
    const r = isStorable(req(), res());
    expect(r.storable).toBe(true);
  });

  it('§3 — does not store when request has Cache-Control: no-store', () => {
    const r = isStorable(req({ 'cache-control': 'no-store' }), res());
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('no_store');
  });

  it('§3 — does not store when response has Cache-Control: no-store', () => {
    const r = isStorable(req(), res({ 'cache-control': 'no-store' }));
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('no_store');
  });

  it('§3 (shared cache) — does not store when response has Cache-Control: private', () => {
    // This is a shared cache; private responses must not be stored.
    const r = isStorable(req(), res({ 'cache-control': 'private' }));
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('private');
  });

  it('§3.5 — does not store when request has Authorization header', () => {
    // A shared cache MUST NOT reuse a response to an Authorization request
    // unless the response carries public / s-maxage / must-revalidate.
    const r = isStorable(req({ authorization: 'Bearer token' }), res());
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('authorization');
  });

  it('§3.5 override — stores when response has Cache-Control: public (overrides Authorization)', () => {
    const r = isStorable(req({ authorization: 'Bearer token' }), res({ 'cache-control': 'public' }));
    expect(r.storable).toBe(true);
  });

  it('§3.5 override — stores when response has Cache-Control: s-maxage (overrides Authorization)', () => {
    const r = isStorable(req({ authorization: 'Bearer token' }), res({ 'cache-control': 's-maxage=3600' }));
    expect(r.storable).toBe(true);
  });

  it('§3.5 override — stores when response has Cache-Control: must-revalidate (overrides Authorization)', () => {
    const r = isStorable(req({ authorization: 'Bearer token' }), res({ 'cache-control': 'must-revalidate' }));
    expect(r.storable).toBe(true);
  });

  it('convention (Varnish/nginx) — does not store when request has Cookie', () => {
    // RFC §3.5 covers Authorization only; Cookie is a widely-followed convention.
    // A session cookie makes the response personal to the caller.
    const r = isStorable(req({ cookie: 'session=A' }), res());
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('cookie');
  });

  it('convention (nginx) — does not store when response sets a cookie', () => {
    // A response that sets a cookie is likely session-scoped.
    const r = isStorable(req(), res({ 'set-cookie': 'session=B; Path=/' }));
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('set_cookie');
  });

  it('header matching is case-insensitive', () => {
    const r = isStorable(req({ 'Cache-Control': 'no-store' }), res());
    expect(r.storable).toBe(false);
    expect(r.reason).toBe('no_store');
  });
});

// ── §4.1 — Vary / secondary cache key ────────────────────────────────────────

describe('cachePolicy.secondaryKey — RFC 9111 §4.1', () => {
  it('returns empty string for a plain response (no Vary)', () => {
    expect(secondaryKey({}, {})).toBe('');
  });

  it('returns empty string when Vary header is absent', () => {
    expect(secondaryKey({}, { 'content-type': 'text/html' })).toBe('');
  });

  it('Vary: * — returns sentinel that never matches any real key', () => {
    // §4.1: a stored response with Vary: * MUST NOT be reused.
    // We return a unique-per-call sentinel so it can never match a cached key.
    const k1 = secondaryKey({}, { vary: '*' });
    const k2 = secondaryKey({}, { vary: '*' });
    expect(k1).not.toBe('');
    expect(k1).not.toBe(k2); // unique — never matches cache
  });

  it('Vary: Cookie — different cookie values produce different keys', () => {
    const k1 = secondaryKey({ cookie: 'session=A' }, { vary: 'Cookie' });
    const k2 = secondaryKey({ cookie: 'session=B' }, { vary: 'Cookie' });
    expect(k1).not.toBe(k2);
  });

  it('Vary: Cookie — same cookie values produce the same key', () => {
    const k1 = secondaryKey({ cookie: 'session=A' }, { vary: 'Cookie' });
    const k2 = secondaryKey({ cookie: 'session=A' }, { vary: 'Cookie' });
    expect(k1).toBe(k2);
  });

  it('Vary: Accept-Encoding — header lookup is case-insensitive', () => {
    const k1 = secondaryKey({ 'accept-encoding': 'gzip' }, { vary: 'Accept-Encoding' });
    const k2 = secondaryKey({ 'Accept-Encoding': 'gzip' }, { vary: 'Accept-Encoding' });
    expect(k1).toBe(k2);
  });

  it('missing Vary header in request contributes empty string to key', () => {
    // A request without a Cookie header should not match a cookie-keyed entry.
    const k1 = secondaryKey({}, { vary: 'Cookie' });
    const k2 = secondaryKey({ cookie: 'session=A' }, { vary: 'Cookie' });
    expect(k1).not.toBe(k2);
  });
});

// ── §4.2 — freshness calculation, capped at CACHE_TTL_MS ─────────────────────

describe('cachePolicy.freshnessMs — RFC 9111 §4.2', () => {
  it('returns capMs when response has no freshness directive', () => {
    expect(freshnessMs({}, 900_000)).toBe(900_000);
  });

  it('returns min(origin-max-age, cap) when max-age < cap', () => {
    expect(freshnessMs({ 'cache-control': 'max-age=60' }, 900_000)).toBe(60_000);
  });

  it('caps a very large max-age at capMs (POPIA: no year-long personal-info retention)', () => {
    // max-age=31536000 (1 year) must not pin personal information for a year.
    expect(freshnessMs({ 'cache-control': 'max-age=31536000' }, 900_000)).toBe(900_000);
  });

  it('s-maxage takes precedence over max-age for shared caches', () => {
    expect(freshnessMs({ 'cache-control': 's-maxage=120, max-age=3600' }, 900_000)).toBe(120_000);
  });

  it('s-maxage is also capped', () => {
    expect(freshnessMs({ 'cache-control': 's-maxage=31536000' }, 900_000)).toBe(900_000);
  });

  it('Expires header is honoured when max-age absent (capped)', () => {
    // Expires value is an absolute date in the future (+10 minutes).
    const future = new Date(Date.now() + 600_000).toUTCString();
    const ms = freshnessMs({ expires: future }, 900_000);
    expect(ms).toBeGreaterThan(590_000);
    expect(ms).toBeLessThanOrEqual(600_000);
  });

  it('past Expires returns 0 (already stale)', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(freshnessMs({ expires: past }, 900_000)).toBe(0);
  });
});

// ── CREDENTIAL_REQUEST_HEADERS exported constant ──────────────────────────────

describe('cachePolicy exports', () => {
  it('CREDENTIAL_REQUEST_HEADERS includes authorization and cookie', () => {
    expect(CREDENTIAL_REQUEST_HEADERS).toContain('authorization');
    expect(CREDENTIAL_REQUEST_HEADERS).toContain('cookie');
  });
});
