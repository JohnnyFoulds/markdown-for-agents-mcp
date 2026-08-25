import { isPolicyBlockError } from '../utils/errors.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED',
  'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

export function shouldRetry(error: unknown, status?: number): boolean {
  if (status !== undefined) {
    if (status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status)) return false;
    return RETRYABLE_STATUS.has(status);
  }
  if (isPolicyBlockError(error)) return false;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (RETRYABLE_CODES.has(code)) return true;
    if (/timeout|timed out/i.test(error.message)) return true;
  }
  return false;
}

export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
  const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
  // full jitter: random in [0, exp]
  return Math.random() * exp;
}

export function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = parseFloat(header);
  if (!isNaN(seconds)) return Math.ceil(seconds) * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
