import { isDomainBlocked } from '../utils/domainBlacklist.js';
import { RedirectBlockedError, RedirectLoopError } from '../utils/errors.js';

export function resolveRedirectUrl(location: string, currentUrl: string): string {
  try {
    return new URL(location, currentUrl).href;
  } catch {
    throw new RedirectBlockedError(currentUrl, location);
  }
}

export function assertRedirectPermitted(
  originalUrl: string,
  redirectUrl: string,
  allowCrossHost: boolean,
): void {
  const orig = new URL(originalUrl);
  const redir = new URL(redirectUrl);

  if (!allowCrossHost) {
    if (orig.hostname !== redir.hostname || orig.port !== redir.port) {
      throw new RedirectBlockedError(originalUrl, redirectUrl);
    }
  }

  if (isDomainBlocked(redir.hostname)) {
    throw new RedirectBlockedError(originalUrl, redirectUrl);
  }
}

export function checkRedirectLimit(count: number, max: number): void {
  if (count >= max) throw new RedirectLoopError(max);
}
