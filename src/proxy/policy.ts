import { isDomainBlocked, isPrivateIp } from '../utils/domainBlacklist.js';

export type PolicyVerdict = 'allow' | 'deny';

export interface PolicyResult {
  verdict: PolicyVerdict;
  reason?: string;
}

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/**
 * Pure allow/deny policy for a SOCKS5 CONNECT target.
 *
 * Checks:
 *   1. Port must be in the allowed set (80, 443, 8080, 8443)
 *   2. Host must not match the domain blocklist
 *   3. Host must not be a private/loopback/metadata IP (SSRF guard)
 *
 * Note on the SSRF guarantee: `socks5h://` resolves DNS at the upstream proxy,
 * so this check is lexical-only on the hostname string. Real SSRF prevention
 * requires network-level egress control; this check is defence in depth only.
 */
export function checkPolicy(host: string, port: number): PolicyResult {
  if (!ALLOWED_PORTS.has(port)) {
    return { verdict: 'deny', reason: `port ${port} not in allowed set` };
  }

  if (isDomainBlocked(host)) {
    return { verdict: 'deny', reason: `domain blocked: ${host}` };
  }

  if (isPrivateIp(host)) {
    return { verdict: 'deny', reason: `SSRF: private/local address ${host}` };
  }

  return { verdict: 'allow' };
}
