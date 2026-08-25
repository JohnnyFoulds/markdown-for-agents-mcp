# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this project, please report it responsibly.

**Do not** create a public GitHub issue for security concerns. Instead, contact the maintainers directly through private channels.

---

## Security Features

### Input Validation
- All URLs are validated by `validateUrl()` in `src/utils/domainBlacklist.ts` before processing
- SSRF protection blocks private/loopback/RFC1918 addresses (127.x, 10.x, 192.168.x, 169.254.x, etc.)
- Decimal-encoded IPs (e.g. `2130706433`), IPv6 ULA (`fc00::/7`), and IPv6 link-local/unspecified are blocked
- URL format validation prevents injection attacks
- Domain blocking prevents access to known-bad sites

### DNS-rebinding Guard
`isPrivateIp()` in `src/utils/domainBlacklist.ts` is lexical on the hostname string. A hostname that resolves to a private IP at fetch time still passes the pre-check. The unified HTTP client (`src/http/dnsGuard.ts`) adds a second check: it resolves all DNS addresses and runs every result through `isPrivateIp` before connecting, then pins the resolved address via undici's `connect.lookup` hook to close the TOCTOU window. This provides defence in depth, but see the caveats below.

### SSRF — Chromium path caveat

When the Lightpanda or Playwright (Chromium) tier is used, the browser resolves DNS internally — the application-level `validateUrl` / `dnsGuardLookup` guard is **not consulted**. There is no app-level Chromium pre-flight. In this path, **network-level egress restriction is the primary SSRF control**: run the browser tiers in a pod with an egress NetworkPolicy enforced by a conformant CNI (Calico or Cilium). See `docs/enterprise/THREAT_MODEL.md §4.1` for the full ceiling. This gap is present under `docker run`, local dev, and stdio deployments which have no equivalent of the k8s NetworkPolicy.

### SSRF — proxy path caveat

When `HTTP_PROXY_URL`, `SOCKS5_UPSTREAM_URL`, or `PROXY_PINS` is configured, the upstream proxy resolves DNS. The application's `isPrivateIp` check degrades to hostname-lexical only — it cannot verify where the proxy will connect. SSRF prevention in this configuration is the proxy's and the network's responsibility, not the application's. Ensure your proxy enforces an egress allow-list.

### Network Security
- Configurable redirect limits (default: 10) to prevent redirect loops
- Same-origin redirect validation by default
- Domain allowlist/blocklist modes for fine-grained control
- Timeout enforcement prevents hanging connections

### Content Security
- Maximum content length enforcement (default: 100 KB)
- Script and iframe removal during content extraction
- Dangerous HTML element filtering

### Authentication
- Bearer token authentication (`MCP_AUTH_TOKEN`) uses `crypto.timingSafeEqual` to prevent timing-based token enumeration
- The `/healthz` and `/readyz` probe endpoints are intentionally unauthenticated — probes cannot carry secrets
- `/metrics` is behind the same bearer token, or can be isolated to a separate port via `METRICS_BIND_PORT`

### Secrets Management
- Never put `MCP_AUTH_TOKEN`, `BRAVE_API_KEY`, `SERPER_API_KEY`, or SOCKS5 credentials in environment variables in plain text in production
- Use Secrets Manager / SSM Parameter Store in ECS; use Kubernetes Secrets (sealed or external-secrets) in k8s
- Rotate tokens; never log them (the auth middleware masks tokens in log output)

### Configuration Security
- Environment variable validation at startup via Zod; invalid values cause a non-zero exit with a descriptive error
- Fail-fast on invalid configuration
- No secrets in code or logs

---

## SOCKS5 Intercept Mode Warning

`SOCKS5_LISTEN_MODE=intercept` is a MITM appliance. It terminates TLS with a private CA and reshapes response bodies. This mode:

- Requires installing your CA certificate into every client's trust store
- Breaks certificate pinning for any client that uses it
- Causes plaintext third-party content to flow through your application's memory and potentially your logs

**Recommendation: do not use intercept mode.** If AI Studio or another client needs page content, call the MCP tools or a plain HTTP `extract` endpoint directly — that is the honest, transparent interface. Intercept mode is provided for specific proxying scenarios only.

If intercept mode is used:
- You **must** supply your own CA (`SOCKS5_INTERCEPT_CA_CERT` / `SOCKS5_INTERCEPT_CA_KEY`); the server will never auto-generate a CA
- A startup warning is logged whenever intercept mode is active
- Treat the CA private key as a high-value credential

---

## Safe Practices

### For Users
1. Use allowlist mode (`USE_ALLOWLIST_MODE=true`) for production deployments
2. Explicitly blocklist known malicious domains
3. Set reasonable timeouts based on your network
4. Add an egress NetworkPolicy or egress proxy to control where Chromium can connect
5. Use `METRICS_BIND_PORT` to isolate the metrics endpoint from the public MCP endpoint

### For Developers
1. Never commit `.env` files with actual values
2. Use `.env.example` as a template
3. Run security audits before releases (`npm audit`)
4. Keep dependencies updated

---

## Dependencies

| Dependency | Purpose | Security Notes |
|------------|---------|----------------|
| `playwright` | Browser automation | Updates browsers regularly; pin to tested version |
| `zod` | Schema validation | Actively maintained |
| `@modelcontextprotocol/sdk` | MCP protocol | Official Anthropic SDK |
| `undici` | HTTP client | Node.js native, actively maintained |
| `ioredis` (optional) | Redis client | Used only when `STORE_BACKEND=redis` |
| `lightpanda/browser` (sidecar) | Tier 2 CDP browser | **AGPL-3.0** — run as a separate container, never imported. `docker-compose.yml` includes the `lightpanda:0.3.7` sidecar. Obtain legal sign-off before commercial/SaaS deployment (AGPL §13 network-use clause). |

---

## Version Support

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

Only the latest release receives security updates.
