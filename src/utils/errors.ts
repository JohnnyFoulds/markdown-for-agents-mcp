/**
 * Custom error classes for URL fetching
 */

export class DomainBlockedError extends Error {
  constructor(hostname: string) {
    super(`Blocked domain: ${hostname}`);
    this.name = 'DomainBlockedError';
  }
}

export class ContentTooLargeError extends Error {
  constructor(url: string, size: number, limit: number) {
    super(`Content too large for ${url}: ${size} bytes exceeds ${limit} byte limit`);
    this.name = 'ContentTooLargeError';
  }
}

export class FetchTimeoutError extends Error {
  constructor(url: string, timeout: number) {
    super(`Fetch timeout for ${url} after ${timeout}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export class RedirectBlockedError extends Error {
  constructor(originalUrl: string, redirectUrl: string) {
    super(`Redirect blocked: ${originalUrl} -> ${redirectUrl}`);
    this.name = 'RedirectBlockedError';
  }
}

export class RedirectLoopError extends Error {
  constructor(maxRedirects: number) {
    super(`Too many redirects (exceeded ${maxRedirects})`);
    this.name = 'RedirectLoopError';
  }
}

export class SsrfViolationError extends Error {
  constructor(hostname: string, resolvedIp: string) {
    super(`SSRF violation: ${hostname} resolved to private address ${resolvedIp}`);
    this.name = 'SsrfViolationError';
  }
}

export class RobotsDeniedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows: ${url}`);
    this.name = 'RobotsDeniedError';
  }
}

export class RateLimitTimeoutError extends Error {
  constructor(maxWaitMs: number) {
    super(`Rate limit wait exceeded ${maxWaitMs}ms`);
    this.name = 'RateLimitTimeoutError';
  }
}

export class SearchProviderError extends Error {
  constructor(provider: string, cause: string) {
    super(`${provider}: ${cause}`);
    this.name = 'SearchProviderError';
  }
}

export class BotChallengeError extends Error {
  constructor(url: string) {
    super(`Bot challenge detected at ${url}`);
    this.name = 'BotChallengeError';
  }
}

export class AllProvidersFailedError extends Error {
  readonly causes: Record<string, string>;
  constructor(causes: Record<string, string>) {
    super(`All search providers failed: ${JSON.stringify(causes)}`);
    this.name = 'AllProvidersFailedError';
    this.causes = causes;
  }
}

/**
 * Returns true when `err` is a security-policy block — a decision made
 * by a guard that must not be retried or escalated to a weaker tier.
 *
 * Escalating past a policy-block converts a correctly-firing guard into a
 * bypass: tier-0 blocks the request, then tier-1 (Chromium/Lightpanda)
 * resolves DNS internally and fetches it unchecked. Using this predicate
 * in both `shouldRetry` (retry.ts) and the render ladder (ladder.ts)
 * ensures the two call sites stay in sync without duplicating the class list.
 */
export function isPolicyBlockError(err: unknown): boolean {
  return (
    err instanceof SsrfViolationError ||
    err instanceof DomainBlockedError ||
    err instanceof RedirectBlockedError ||
    err instanceof RedirectLoopError ||
    err instanceof RobotsDeniedError ||
    err instanceof RateLimitTimeoutError
  );
}
