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
