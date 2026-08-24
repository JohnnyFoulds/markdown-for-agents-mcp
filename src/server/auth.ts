/**
 * HTTP authentication policy enforcement.
 *
 * Fail-closed in HTTP mode: a missing or empty MCP_AUTH_TOKEN is an error at
 * startup, not a runtime condition that silently disables auth. stdio mode is
 * unaffected — it has no HTTP surface to protect.
 */

/**
 * Asserts that the HTTP server has a valid authentication configuration.
 * Throws in HTTP mode when no auth token is set and anonymous access is not
 * explicitly opted into via MCP_AUTH_ALLOW_ANONYMOUS=true.
 *
 * @param authToken     Value of MCP_AUTH_TOKEN from config (undefined/'' = unset).
 * @param allowAnonymous  Value of MCP_AUTH_ALLOW_ANONYMOUS from config.
 * @param isHttpMode    True when the server is starting in HTTP mode.
 */
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
