# Security Findings Register

**Purpose.** This register answers security findings that vendors, customers, or
penetration testers are likely to raise against this service. It classifies findings into
three categories — false positive, accepted risk, and real gap — so that a predictable
finding arrives with a written answer rather than an escalation.

**Important.** Being listed in this register does **not** close or dismiss a finding.
A finding in §1 is not exploitable for the structural reason stated; a finding in §2 is
real but understood and accepted; a finding in §3 is real, mitigated elsewhere, and the
mitigation has known limits. A penetration tester may produce findings outside this
register, and those carry no pre-classification.

This register must not grow by reclassification. A §1 entry is only valid if accompanied
by a passing test that proves the structural argument. Moving a §3 entry to §1 because
it is inconvenient to fix would invalidate the document.

---

## §1 False Positives

Findings that are not exploitable, with the structural reason and a test citation.

Each row's **Test** column cites a test file and test name that must exist and pass.
The test is what makes the classification machine-verifiable. If the test is deleted,
the `src/findingsRegister.test.ts` citation guard goes RED.

| Finding (as scanner phrases it) | Common tools | Why not exploitable | Test |
|---|---|---|---|
| Reflected XSS: `jobId` / `query` / `url` parameter echoed in tool error output | ZAP Active Scan, Burp Scanner, OWASP ZAP | The `/mcp` endpoint always responds `Content-Type: application/json`. JSON does not parse `<script>` tags and there is no HTML sink. Echoing invalid input in an error message is correct and intentional behaviour; it is not reflected XSS unless the body is rendered in a browser as HTML. | `src/security/dastDetectors.test.ts` · `"crawl_status XSS echo in JSON → info (not exploited)"` |
| SSRF: metadata endpoint URL echoed in error body indicates SSRF success | ZAP Active Scan, Burp Scanner, custom SSRF probes | The probe URL (`http://metadata.google.internal/…`) is echoed in the DNS failure error message (`getaddrinfo ENOTFOUND metadata.google.internal`). The body contains the token only because the request **failed**. Token-matching a response body cannot distinguish an echo from retrieved content. | `src/security/dastDetectors.test.ts` · `"fetch_urls GCP DNS failure → inconclusive (not exploited)"` |
| Verb tampering: `GET /mcp` returns 200 | Burp Scanner, ZAP, Netsparker | `GET /mcp` with `Accept: text/event-stream` is the MCP Streamable HTTP spec-mandated SSE stream-open request (§4.2.2). The SDK advertises `Allow: GET, POST, DELETE`. This is not a REST verb-tampering finding; the 200 response opens the SSE connection as required by the protocol. | `src/security/dastDetectors.test.ts` · `"GET /mcp with SSE Accept — evaluateProbe does not produce exploited for a text/event-stream response"` |
| Verb tampering: `DELETE /mcp` returns 200 | Burp Scanner, ZAP, Netsparker | `DELETE /mcp` is the MCP Streamable HTTP spec-mandated session teardown method (§4.2.4). The SDK advertises `Allow: GET, POST, DELETE`. This is a protocol-required operation, not a REST verb-tampering vulnerability. | `src/security/dastDetectors.test.ts` · `"DELETE /mcp → 200 — evaluateProbe does not produce exploited for an empty JSON response"` |
| SSRF (CRITICAL): DAST scan reports metadata token in response body | Custom DAST scanners using substring matching | Old DAST detector used `body.includes('computeMetadata')` — the token matches because it appears in the probe URL itself, not in retrieved metadata content. Structural fix: all exploitation token checks now run on `redactEcho(body, args)` which strips all probe input values from the body before any match. | `src/security/dastDetectors.test.ts` · `"SSRF targets — echoed URL in isError body must not be exploited"` |
| ZAP: Storable and Cacheable Content (Informational) | OWASP ZAP passive scan | ZAP's passive rule fires on any 200 response with no `Cache-Control: no-store` header. This is a JSON API used by MCP clients; it is not a browser-rendered surface and user-session data is not included in scan responses. Informational ZAP findings do not block the gate. | `src/security/dastDetectors.test.ts` · `"injection payloads — echoed XSS payload in JSON must not be exploited"` |

---

## §2 Accepted Risks

Risks that are real, understood, and accepted by the Engineering Owner. The authoritative
record for each is the ATO residual-risk register (`docs/enterprise/PRODUCTION_AUTHORISATION.md`).

| Risk | Status | ATO reference |
|---|---|---|
| Shared bearer token — no per-user RBAC | Accepted | `THREAT_MODEL.md §1` |
| No data-subject rights tooling (POPIA Ch 3) | Accepted (ATO condition) | `PRODUCTION_AUTHORISATION.md §6.7` |
| DuckDuckGo search provider has no DPA | Accepted (ATO condition) | `PRODUCTION_AUTHORISATION.md §6.6 (LC-03)` |
| Playwright renderer executes arbitrary web content in container | Accepted — standard headless browser risk | `THREAT_MODEL.md §5` |

---

## §3 Real Gaps with Compensating Controls

Risks that are real, mitigated elsewhere, and whose mitigations have known limits.

### Browser-tier DNS gap (TOCTOU)

**Gap.** The Lightpanda and Playwright render tiers call `page.goto()` directly. Chromium and
Lightpanda resolve DNS internally — `dnsGuardLookup` is never consulted for browser-tier
requests. A URL that resolves to a public IP at the HTTP-tier check time may resolve to a
private IP at browser connection time (DNS rebinding), or the render heuristic may escalate
a tier-0-approved URL to a browser tier that re-resolves it without any app-level guard.

**Compensating control.** `deploy/k8s/base/networkpolicy.yaml` (`mcp-egress`) blocks all
egress to RFC1918, link-local, CGNAT (100.64/10), and loopback ranges at the kernel level
via CNI, regardless of how DNS resolved. This cannot be bypassed from within the container.

**Known limits of the compensating control.**
- The egress NetworkPolicy **only exists on k8s** and only where Calico or Cilium enforces
  `NetworkPolicy` rules. `kindnet` and Flannel (common on managed clusters) do not enforce
  them. On those clusters `mcp-egress` is silently inert.
- `docker run`, local development, and stdio deployments have no equivalent control.
  The only SSRF guard in those environments is the app-level `dnsGuardLookup` (HTTP tier
  only), the metadata hostname denylist, and the lexical IP-form checks.
- The Phase 2 fail-closed fix (commit `b5125d1`) removes the error-triggered bypass:
  `SsrfViolationError` at any tier is now rethrown rather than escalated. Heuristic
  escalation (content-based) remains a TOCTOU window.

**Classification.** This is a §3 entry (real gap, mitigated by deployment) — not a §1
false positive. Any scanner that finds a private-IP reachable from a browser tier is
reporting a real finding for that deployment, not a false positive.

---

## Ceilings of this register

1. **`inconclusive` is not `blocked`.** Off-cloud, metadata hostnames do not resolve, so
   SSRF probes prove nothing about the guard. A green report from a local run is not
   evidence the guard works in production.
2. **This register covers predictable findings.** A competent tester will produce findings
   not listed here. Those carry no pre-classification from this document.
3. **Entries decay.** Each §1 entry is true only for the code that the cited test covers.
   The `src/findingsRegister.test.ts` citation guard enforces this: deleting a cited test
   goes RED.
4. **The register must not grow by reclassification.** A §1 entry requires a structural
   argument and a passing test. A §3 entry cannot be promoted to §1 because it is
   inconvenient to fix.
