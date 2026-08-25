/**
 * HTTP authentication policy enforcement.
 *
 * Fail-closed in HTTP mode: a missing or empty MCP_AUTH_TOKEN is an error at
 * startup, not a runtime condition that silently disables auth. stdio mode is
 * unaffected — it has no HTTP surface to protect.
 */

import type { Config } from '../config.js';

/**
 * Asserts that the HTTP server has a valid authentication configuration.
 * Throws in HTTP mode when no auth token is set and anonymous access is not
 * explicitly opted into via MCP_AUTH_ALLOW_ANONYMOUS=true.
 *
 * @param authToken     Value of MCP_AUTH_TOKEN from config (undefined/'' = unset).
 * @param allowAnonymous  Value of MCP_AUTH_ALLOW_ANONYMOUS from config.
 * @param isHttpMode    True when the server is starting in HTTP mode.
 */
/**
 * Returns true if the URL's host does not look like a cluster-internal address.
 * Used to warn when RERANK_TEI_URL / SEARXNG_URL point outside the cluster.
 * Heuristic only — single-label hostnames and RFC 1918 / loopback are treated as in-cluster.
 */
function looksExternal(urlStr: string): boolean {
  try {
    const { hostname } = new URL(urlStr);
    // RFC 1918 + loopback
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(hostname)) return false;
    if (hostname === 'localhost' || hostname === '::1') return false;
    // IPv6 ULA (fc00::/7)
    if (/^f[cd]/iu.test(hostname)) return false;
    // Single-label = k8s service name (no TLD)
    if (!hostname.includes('.')) return false;
    // Cluster-local FQDN suffixes
    if (hostname.endsWith('.cluster.local') || hostname.endsWith('.svc')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a list of human-readable warnings for privacy-relevant configuration.
 * Each warning names the config var and the POPIA section it relates to.
 * Call at startup and log each entry at WARN level.
 *
 * Does not throw — privacy warnings are surfaced to operators but must not
 * prevent the server from starting (the purpose of POPIA_MODE=off).
 */
export function assertPrivacyPolicy(config: Config): string[] {
  const warnings: string[] = [];

  if (config.POPIA_MODE === 'off') {
    warnings.push(
      'POPIA_MODE=off: all privacy controls are disabled. ' +
      'This forfeits the s105(4) "took all reasonable steps" statutory defence. ' +
      'Use monitor mode for debugging — do not set off in production.',
    );
  }

  if (!config.LOG_REDACT_QUERIES) {
    warnings.push(
      'LOG_REDACT_QUERIES=false: query text reaches log storage in plaintext. ' +
      'Set to true (the default) to reduce s19 exposure. Use for debugging only.',
    );
  }

  if (config.SOCKS5_LISTEN_MODE === 'intercept') {
    warnings.push(
      'SOCKS5_LISTEN_MODE=intercept: TLS is terminated by this proxy, making any ' +
      'configured upstream a data processor of decrypted content (POPIA s20/s21; s72 ' +
      'if the upstream is cross-border). Use tunnel mode unless TLS inspection is a ' +
      'deliberate, documented policy decision.',
    );
  }

  if (config.RERANK_TEI_URL && looksExternal(config.RERANK_TEI_URL)) {
    warnings.push(
      `RERANK_TEI_URL (${config.RERANK_TEI_URL}) does not appear to be a cluster-local ` +
      'address. The reranker POSTs query text and page content to this URL; verify the ' +
      's72 transfer basis and data-processing agreement.',
    );
  }

  if (config.SEARXNG_URL && looksExternal(config.SEARXNG_URL)) {
    warnings.push(
      `SEARXNG_URL (${config.SEARXNG_URL}) does not appear to be a cluster-local address. ` +
      'Search queries reach this URL; verify the s72 transfer basis.',
    );
  }

  if (config.PROXY_PINS) {
    warnings.push(
      'PROXY_PINS is set: the listed proxy vendors relay request content. ' +
      'Verify s72 data-processing agreements for each vendor.',
    );
  }

  if (config.SOCKS5_UPSTREAM_URL) {
    warnings.push(
      `SOCKS5_UPSTREAM_URL (${config.SOCKS5_UPSTREAM_URL}) is set: the upstream SOCKS5 ` +
      'vendor relays all browser traffic. Verify s72 data-processing agreements.',
    );
  }

  // Per-caller attribution warnings
  if (config.MCP_REQUIRE_CALLER_IDENTITY && !config.MCP_CALLER_ID_SALT) {
    warnings.push(
      'MCP_REQUIRE_CALLER_IDENTITY=true without MCP_CALLER_ID_SALT: enforcement is active but ' +
      'hashes are uncorrelatable across replicas and restarts (per-process random salt). ' +
      'This is almost always a mistake — set MCP_CALLER_ID_SALT in a Secret for fleet-wide ' +
      'incident attribution, or leave MCP_REQUIRE_CALLER_IDENTITY=false during the observe phase.',
    );
  }

  if (config.MCP_REQUIRE_CALLER_IDENTITY) {
    warnings.push(
      'MCP_REQUIRE_CALLER_IDENTITY=true: the x-mcp-caller-id header is required on every /mcp ' +
      'request. Attribution is only trustworthy when a trusted upstream gateway sets the header ' +
      'AND strips any client-supplied copy. Without gateway enforcement, any caller holding the ' +
      'shared bearer token can spoof any identity.',
    );
  }

  return warnings;
}

export function assertHttpAuthPolicy(
  authToken: string | undefined,
  allowAnonymous: boolean,
  isHttpMode: boolean,
): void {
  if (!isHttpMode) return;
  if (authToken) return;
  if (allowAnonymous) return;
  throw new Error(
    'HTTP mode requires authentication.\n' +
    '  Set MCP_AUTH_TOKEN to a shared secret bearer token, or\n' +
    '  set MCP_AUTH_ALLOW_ANONYMOUS=true to explicitly allow unauthenticated access.\n' +
    '\n' +
    '  MCP_AUTH_ALLOW_ANONYMOUS=true is not recommended for internet-facing deployments.\n' +
    '  See docs/security/SECURITY_SCANNING.md for guidance.',
  );
}

/**
 * Asserts that per-caller identity enforcement is compatible with the transport mode.
 *
 * MCP_REQUIRE_CALLER_IDENTITY=true is unsatisfiable in stdio mode: stdio has no
 * HTTP headers, so every audit line would emit callerHash:null while the config
 * claims identity is required.  That is a compliance illusion — the same kind that
 * assertHttpAuthPolicy exists to prevent.
 *
 * Throw before the port binds (or before stdio connects) so the error is visible
 * in container logs before the health check ever passes.
 */
export function assertCallerIdentityPolicy(
  requireIdentity: boolean,
  isHttpMode: boolean,
): void {
  if (!requireIdentity) return;
  if (isHttpMode) return;
  throw new Error(
    'MCP_REQUIRE_CALLER_IDENTITY=true is not supported in stdio mode.\n' +
    '  stdio has no HTTP headers; every audit line would emit callerHash:null forever\n' +
    '  while the config claims identity is required.\n' +
    '  Set HTTP_PORT to use HTTP mode, or set MCP_REQUIRE_CALLER_IDENTITY=false.',
  );
}
