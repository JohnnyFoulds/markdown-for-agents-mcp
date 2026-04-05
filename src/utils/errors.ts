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
