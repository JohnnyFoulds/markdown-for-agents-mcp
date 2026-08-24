import { isDomainBlocked } from '../utils/domainBlacklist.js';

export function passesAllowedList(domain: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  return allowedDomains.some(a => domain === a || domain.endsWith(`.${a}`));
}

export function passesBlockedList(domain: string, blockedDomains?: string[]): boolean {
  if (!blockedDomains || blockedDomains.length === 0) return true;
  return !blockedDomains.some(b => domain === b || domain.endsWith(`.${b}`));
}

export function passesSystemBlocklist(domain: string): boolean {
  return !isDomainBlocked(domain);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
