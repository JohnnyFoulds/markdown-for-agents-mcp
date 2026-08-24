/**
 * RFC 9111 shared-cache policy — pure, dependency-free.
 *
 * This module implements the subset of RFC 9111 relevant to a shared in-process
 * HTML cache (`urlCache` in fetcher.ts):
 *
 *   isStorable(req, res)    — §3, §3.5: decides whether a response may be stored
 *   freshnessMs(res, cap)   — §4.2: computes TTL for the stored entry, capped at
 *                             CACHE_TTL_MS so a max-age=31536000 cannot pin
 *                             personal information for a year (POPIA relevance)
 *   secondaryKey(req, res)  — §4.1 Vary: augments the primary URL key with
 *                             request-header values named by the Vary response header
 *
 * Conventions beyond the letter of RFC §3.5 (both widely adopted):
 *   • Request contains Cookie → not stored (Varnish default VCL behaviour).
 *     RFC §3.5 covers Authorization only; Cookie is convention.  This module
 *     comments that clearly so a future reader knows it is intentional.
 *   • Response sets Set-Cookie → not stored (nginx default behaviour).
 *     A session-cookie response is likely caller-scoped.
 *
 * Explicitly out of scope (not a confidentiality control):
 *   • §4.3 conditional revalidation (ETag / If-None-Match) — freshness optimisation
 *
 * The cache_not_stored_total metric (in obs/metrics.ts) is incremented at the
 * call site in fetcher.ts, not here, so this module stays dependency-free.
 */

/** Request-header names that, when present, make a response non-storable. */
export const CREDENTIAL_REQUEST_HEADERS = ['authorization', 'cookie'] as const;

export interface StorabilityResult {
  storable: boolean;
  /** Short causal reason, used as the metric label: no_store | private | authorization | cookie | set_cookie */
  reason: string;
}

/**
 * Decides whether a response may be stored in a shared cache.
 * Headers are matched case-insensitively.
 *
 * @param reqHeaders  Normalised lowercase request headers (or raw — we lower ourselves)
 * @param resHeaders  Normalised lowercase response headers (or raw — we lower ourselves)
 */
export function isStorable(
  reqHeaders: Record<string, string>,
  resHeaders: Record<string, string>,
): StorabilityResult {
  const req = lowerKeys(reqHeaders);
  const res = lowerKeys(resHeaders);

  const resCc = parseCacheControl(res['cache-control'] ?? '');
  const reqCc = parseCacheControl(req['cache-control'] ?? '');

  // §3 — no-store on either request or response
  if (reqCc.has('no-store') || resCc.has('no-store')) {
    return { storable: false, reason: 'no_store' };
  }

  // §3 — private directive on response (shared cache must not store)
  if (resCc.has('private')) {
    return { storable: false, reason: 'private' };
  }

  // convention (nginx) — response sets a cookie; likely caller-scoped
  if (res['set-cookie']) {
    return { storable: false, reason: 'set_cookie' };
  }

  // §3.5 — Authorization in request, unless response explicitly permits shared caching
  if (req['authorization']) {
    const allowedByResponse = resCc.has('public') || resCc.has('s-maxage') || resCc.has('must-revalidate');
    if (!allowedByResponse) {
      return { storable: false, reason: 'authorization' };
    }
  }

  // convention (Varnish) — Cookie in request; response is likely caller-scoped.
  // Note: RFC §3.5 covers Authorization only; Cookie is a widely-followed convention.
  if (req['cookie']) {
    return { storable: false, reason: 'cookie' };
  }

  return { storable: true, reason: '' };
}

/**
 * Computes the freshness lifetime in milliseconds, capped at capMs.
 * §4.2: s-maxage > max-age > Expires.
 *
 * @param resHeaders  Response headers (keys may be mixed-case)
 * @param capMs       Maximum TTL to enforce (CACHE_TTL_MS — the operator cap)
 */
export function freshnessMs(resHeaders: Record<string, string>, capMs: number): number {
  const res = lowerKeys(resHeaders);
  const cc = parseCacheControl(res['cache-control'] ?? '');

  // s-maxage takes precedence for shared caches
  if (cc.has('s-maxage')) {
    const v = Number(cc.get('s-maxage'));
    if (!isNaN(v)) return Math.min(v * 1000, capMs);
  }

  // max-age
  if (cc.has('max-age')) {
    const v = Number(cc.get('max-age'));
    if (!isNaN(v)) return Math.min(v * 1000, capMs);
  }

  // Expires (absolute date)
  if (res['expires']) {
    const exp = Date.parse(res['expires']);
    if (!isNaN(exp)) {
      const ttl = exp - Date.now();
      return Math.min(Math.max(ttl, 0), capMs);
    }
  }

  // No directive — use the operator cap
  return capMs;
}

/**
 * Computes the secondary cache key contribution from the Vary response header.
 * §4.1: the key is the primary URL plus a hash of the request-header values
 * named by Vary.  `Vary: *` always returns a unique value so it can never match.
 *
 * @param reqHeaders  Request headers (keys may be mixed-case)
 * @param resHeaders  Response headers (keys may be mixed-case)
 * @returns  A string to append to the URL as the full cache key.
 *           Empty string when Vary is absent (plain URL key).
 */
export function secondaryKey(
  reqHeaders: Record<string, string>,
  resHeaders: Record<string, string>,
): string {
  const res = lowerKeys(resHeaders);
  const vary = res['vary'];
  if (!vary) return '';

  // §4.1: Vary: * — response must never be reused
  if (vary.trim() === '*') {
    // Return a unique string so this key can never match any stored entry.
    return `vary-star:${Math.random().toString(36).slice(2)}:${Date.now()}`;
  }

  const req = lowerKeys(reqHeaders);
  const parts = vary
    .split(',')
    .map(h => h.trim().toLowerCase())
    .sort() // stable order regardless of Vary field ordering
    .map(h => `${h}=${req[h] ?? ''}`);

  return parts.join('&');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Parses a Cache-Control header value into a Map of directive → value.
 * e.g. "no-store, max-age=60" → Map { 'no-store' → '', 'max-age' → '60' }
 */
function parseCacheControl(value: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of value.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) map.set(k.trim().toLowerCase(), rest.join('=').trim());
  }
  return map;
}
