const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'set-cookie',
  'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token',
]);

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
