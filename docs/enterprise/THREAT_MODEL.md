# Threat Model — markdown-for-agents-mcp

> Honest by design. A reviewer who finds a limitation not disclosed here has found a
> governance failure. Every ceiling in this document should also appear in
> `docs/enterprise/SLO.md` and `DEPLOYMENT.md`. If they diverge, this document wins.

## Scope

This threat model covers the MCP server and worker as deployed in Kubernetes via
`deploy/k8s/`. It does not cover the stdio mode (used by local Claude Desktop
deployments), which has no network listener and a significantly smaller attack surface.

---

## 1. Authentication and authorisation

**Mechanism:** HTTP Bearer token (`MCP_AUTH_TOKEN`), timing-safe compare
(`crypto.timingSafeEqual`).

**Unauthenticated endpoints:** `/healthz` and `/readyz` are **deliberately
unauthenticated** — they must be reachable by Kubernetes liveness/readiness probes
without credentials. These endpoints return only binary health state and expose no
data.

**`/metrics`** is unauthenticated by default. In a shared cluster, restrict it at the
ingress or NetworkPolicy level to Prometheus scrape IPs only.

**Ceiling:** The bearer token is a shared secret, not per-user or per-session. There is
no RBAC, no audit log of which agent called which tool, and no rate-limiting by caller
identity. For department-wide deployment, this is acceptable; for multi-tenant exposure
it is not.

---

## 2. Input validation

**All MCP tool inputs** are validated by Zod schemas at the handler boundary
(`src/server/registry.ts`). Unknown properties are stripped; enum values are validated;
string lengths are bounded.

**URL inputs** (`fetch_page`, domain allow/block lists) go through:
1. Zod schema (must be a `z.string()`)
2. `domainOf()` parsing (rejects unparseable URLs)
3. `isPrivateIp()` guard before any network request

**Injection risk:** The Chromium render tier executes arbitrary web content in a sandboxed
browser context. The rendered output is Markdown text extracted by `htmlToText`; no
rendered JavaScript is preserved or executed in the Node.js process. The risk is
browser-native exploitation of the Chromium process itself.

---

## 3. SSRF — the honest ceiling {#3-ssrf}

**There are two SSRF mitigations, with different guarantees.**

### 3.1 App-level guard (`isPrivateIp()`)

`src/utils/domainBlacklist.ts` checks the destination hostname against RFC1918,
link-local, and loopback ranges before any HTTP request is made by the Node.js process
or Chromium.

**Ceiling:** Chrome resolves DNS *internally* (not through the Node.js process). A
DNS record that resolves to a public IP at check time but to a private IP at connection
time (DNS rebinding) bypasses `isPrivateIp()`. The guard is detect-and-discard on the
hostname string, not on the resolved IP.

The `ssrf_violations_total{stage="dns_guard"}` metric counts detections by this guard.
A spike is evidence that a DNS rebinding attempt is in progress, not necessarily that
it was blocked (see §3.2 for the kernel-level control).

### 3.2 NetworkPolicy (`mcp-egress`)

`deploy/k8s/base/networkpolicy.yaml` blocks egress to RFC1918 / link-local / loopback
at the kernel level, applied by the CNI plugin. This cannot be bypassed from within the
container — even if Chrome resolves a rebinding, the packet is dropped before it leaves
the node.

**Critical ceiling: NetworkPolicy enforcement requires Calico or Cilium.**  
`kindnet` and `Flannel` — the default CNIs for many managed k8s clusters — do not
enforce `NetworkPolicy` rules. On these clusters `mcp-egress` is silently inert and
the only SSRF control is the app-level guard (with its DNS rebinding weakness).

**Verify your CNI enforces NetworkPolicy before considering SSRF mitigated:**

```bash
# From inside a pod, attempt to reach a private IP that should be blocked:
kubectl exec -n mcp-system deployment/mcp-server -- \
  curl -m 3 http://169.254.169.254/latest/meta-data/ 2>&1
# Should timeout or be refused. If it returns data, NetworkPolicy is not enforced.
```

### 3.3 SOCKS5 upstream proxy

When `SOCKS5_HOST` is set, all Chromium traffic is routed through the upstream proxy.
With `socks5h://` the proxy resolves DNS — the app-level check is now lexical-only on
the hostname string. Connection pinning is unenforceable: the proxy decides where to
connect. Real SSRF prevention in proxy mode depends on the proxy's own ACLs.

See `src/proxy/policy.ts:20–22` for the explicit caveat in code.

---

## 4. Chromium sandbox and container security

**`--no-sandbox` flag:** The Playwright base image requires `--no-sandbox` in most
Linux environments without user namespaces. This means a successful Chromium renderer
RCE gets the container. Mitigations:

- The container runs as `pwuser` (UID 1000), not root (Phase 1 security hardening adds
  `runAsNonRoot: true`)
- `allowPrivilegeEscalation: false` prevents privilege escalation from the container
- `capabilities: {drop: [ALL]}` removes all Linux capabilities from the process
- The Tier-1-first ladder means most requests never open Chromium; only
  `fetch_page` and `crawl_start` (explicitly requested) and `basic`/`advanced` web
  searches invoke the browser

**Residual risk:** A renderer RCE still gets a container with network access (limited
by the NetworkPolicy, but the NetworkPolicy ceiling above applies). This is the
standard accepted risk for any headless browser deployment. The mitigations reduce the
blast radius; they do not eliminate it.

---

## 5. SOCKS5 `intercept` mode

`intercept` mode (TLS MITM proxy) is **not implemented**. When `SOCKS5_LISTEN_MODE=intercept`
is set in the environment, the server exits with code 1 (`src/index.ts`). This is a
deliberate refusal to ship a TLS-MITM appliance; the functionality gap is a security
positive. Do not implement it.

---

## 6. API key exposure

Paid provider keys (`BRAVE_API_KEY`, `SERPER_API_KEY`) and `MCP_AUTH_TOKEN` are
injected as Kubernetes Secrets, not ConfigMap values. They are:

- Never logged (the logger's `LOG_REDACT_QUERIES=true` default also hashes query text)
- Never included in MCP tool responses
- Not accessible via `/metrics` or any HTTP endpoint

`LOG_REDACT_QUERIES=true` (default) hashes or truncates query text in DEBUG-level logs.
Set to `false` only for local development; never in production.

---

## 7. Dependency supply chain

Production dependencies are locked via `package-lock.json`. Notable risks:

- `playwright` / `chromium` — large, frequently-updated; security fixes are often
  bundled with other changes. Run `npm audit` in CI and update promptly for security
  advisories.
- `@huggingface/transformers` + `onnxruntime-node` — the model is baked into the image
  at build time from a pinned HuggingFace model ID. The model binary does not change at
  runtime. An attacker would need to compromise the HuggingFace model repository or
  the CI build pipeline to poison the model.
- No server-side `eval()` or `vm.runInNewContext()` in the application code.

---

## 8. Data in transit

All outbound API calls (Brave, Serper, SearXNG) use HTTPS. The SearXNG instance is
in-cluster and communicates over HTTP (cluster-internal — not public). No client query
data is sent to external services beyond what the configured search providers require.

See `docs/enterprise/DATA_FLOW.md` for a full inventory of what leaves the cluster.

---

## 9. Summary of mitigations and residual risks

| Threat | Mitigation | Residual risk |
|---|---|---|
| SSRF via Chromium | `isPrivateIp()` + NetworkPolicy | DNS rebinding bypasses app guard; NetworkPolicy inert on Flannel/kindnet |
| SSRF via SOCKS5 proxy | Policy check (lexical) | Proxy-resolved DNS, no pinning |
| Auth bypass | Timing-safe bearer token | Shared secret; no per-user isolation |
| Chromium RCE → container escape | `--no-sandbox` + `runAsNonRoot` + `capabilities: drop ALL` | Renderer RCE still gets container with NetworkPolicy-limited egress |
| API key exfiltration | K8s Secrets + no logging | K8s Secret access via compromised service account |
| Query privacy | `LOG_REDACT_QUERIES=true` + no persistent query log | Queries reach configured search providers |
| TLS MITM (intercept mode) | Not implemented; exits 1 | None |
| Supply chain (npm) | `npm audit` in CI; lock file pinned | Transitive dep compromise |
