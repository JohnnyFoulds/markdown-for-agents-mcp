import { createHmac, randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token',
  // Per-caller identity: hashed before any storage, but the raw value must not
  // reach log storage even through the Logger redactHeaders path.
  'x-mcp-caller-id',
]);

// ── Per-caller identity hashing ───────────────────────────────────────────────
// Separate salt from LOG_REDACT_SALT so query and identity hash spaces are
// independent — a hash from one cannot be correlated to the other.
//
// Per-process random default is privacy-safe (hashes are uncorrelatable across
// replicas/restarts).  Set MCP_CALLER_ID_SALT (in a Secret, not a ConfigMap)
// to enable fleet-wide incident attribution.

let _callerSalt: string | undefined;

/** Test-only export — resets the salt so a fresh random one is generated next call. */
export function _resetCallerSaltForTest(): void {
  _callerSalt = undefined;
}

function getCallerSalt(): string {
  if (!_callerSalt) {
    let explicit = '';
    try { explicit = getConfig().MCP_CALLER_ID_SALT ?? ''; } catch { /* not initialised */ }
    _callerSalt = explicit || randomBytes(32).toString('hex');
  }
  return _callerSalt;
}

/**
 * Validation reasons for hashCallerIdentity.
 * Also used as the `reason` label on the caller_identity_total metric.
 */
export type CallerIdReason = 'ok' | 'absent' | 'too_long' | 'bad_chars' | 'multi_value';

export interface CallerIdResult {
  hash: string | null;
  reason: CallerIdReason;
}

/**
 * Hash a raw x-mcp-caller-id header value for inclusion in audit events.
 *
 * Validation rules (all checked BEFORE the HMAC to avoid hashing attacker input):
 *  - undefined / empty / whitespace-only → absent
 *  - > 256 chars → too_long (rejected, not truncated — truncation collapses two callers)
 *  - contains ',' → multi_value (Node joins duplicate headers with ", ")
 *  - non-ASCII-printable after trim → bad_chars (latin1 decode issue for offline lookup)
 *  - otherwise: trim() + toLowerCase() then HMAC-SHA-256, 16 hex chars
 *
 * The raw value is never returned and must never be logged.
 */
export function hashCallerIdentity(raw: string | undefined): CallerIdResult {
  if (raw === undefined) return { hash: null, reason: 'absent' };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { hash: null, reason: 'absent' };
  if (trimmed.length > 256) return { hash: null, reason: 'too_long' };
  if (trimmed.includes(',')) return { hash: null, reason: 'multi_value' };
  // ASCII printable only: 0x21 (!) to 0x7E (~). Spaces (0x20) are rejected here
  // because trim() already handled leading/trailing spaces; an inner space is a
  // character-set violation.  Constraining to ASCII makes the offline-lookup recipe
  // unambiguous: HMAC(salt, toLowerCase(trimmedValue)) is reproducible externally.
  if (!/^[\x21-\x7E]+$/.test(trimmed)) return { hash: null, reason: 'bad_chars' };

  const normalized = trimmed.toLowerCase();
  const hash = createHmac('sha256', getCallerSalt()).update(normalized).digest('hex').slice(0, 16);
  return { hash, reason: 'ok' };
}

/**
 * Redact sensitive parts of a URL before logging.
 * - Removes embedded user:password credentials
 * - Replaces query-parameter values with [redacted], keeping keys
 * Preserves scheme, host, path — sufficient for request-path debugging.
 */
export function redactUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    url.username = '';
    url.password = '';
    if (url.search) {
      // Build manually so '[redacted]' is not percent-encoded in log output.
      const parts: string[] = [];
      for (const [key] of url.searchParams) {
        parts.push(`${encodeURIComponent(key)}=[redacted]`);
      }
      url.search = '?' + parts.join('&');
    }
    return url.toString();
  } catch {
    return '[url]';
  }
}

/**
 * Return a copy of a headers object with sensitive values replaced.
 * Always use this before passing headers to Logger calls.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}
