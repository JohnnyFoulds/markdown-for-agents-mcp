# Production Authorisation to Operate — markdown-for-agents-mcp

> **This document is not legal advice and not a compliance certificate.**
> It records (a) the technical state of the system — each claim naming the test that
> demonstrates it — and (b) the legal determinations required from counsel before
> production use in a POPIA-regulated context. The determinations in §3 are *inputs*
> to this document, not conclusions reached by it. No engineer can discharge them.
>
> **Do not cite this document to a regulator as evidence of compliance.** It is a gate
> that refuses to say "authorised" while obligations are outstanding. Under POPIA
> s105(3)(b), an inaccurate compliance assertion is evidence of failing to take
> reasonable steps. A correctly-drafted gate that says NOT AUTHORISED is better
> regulatory evidence than a gate that overclaims.

---

**Status:**           NOT AUTHORISED
**Authorised on:**    —
**Expires:**          — (12 months from date of authorisation, or on any trigger in §6)
**Document version:** 1.0
**Act:**              Protection of Personal Information Act 4 of 2013 (POPIA), South Africa
**Scope:**            MCP server and worker as deployed via `deploy/k8s/` in the Vodacom environment

---

## §1 — Deployment tiers

Because the s72 trans-border obligations depend on which external providers are active,
two deployment tiers are defined. Tier 1 can be authorised before legal review of
provider agreements is complete. Tier 2 requires full sign-off.

**Machine-enforced** means a config var controls the behaviour and `src/config.parity.test.ts`
asserts it exists in the schema. **Policy-only** means there is no code gate — it is a
human promise, stated as such so that it is not mistaken for enforcement.

### Tier 1 — Restricted (no cross-border PII egress)

A configuration in which no personal information leaves the cluster. Deployable once
the Tier 1 conditions in §3 are signed.

| Setting | Value | Enforcement |
|---|---|---|
| `POPIA_MODE` | `enforce` | Machine-enforced (blocks SA ID/MSISDN/PAN pre-egress) |
| `SEARCH_ENABLE_DUCKDUCKGO` | `false` | Machine-enforced |
| `BRAVE_API_KEY` | unset | Machine-enforced (provider fails closed on missing key) |
| `SERPER_API_KEY` | unset | Machine-enforced (provider fails closed on missing key) |
| `SEARXNG_URL` | unset OR in-cluster address | Machine-enforced only if unset; in-cluster URL is policy-only |
| `RERANK_BACKEND` | `none` | Machine-enforced (`tei` would send content to `RERANK_TEI_URL`) |
| `RERANK_TEI_URL` | unset | Machine-enforced (TEI path only reached when backend=tei) |
| `USE_ALLOWLIST_MODE` | `true` | Machine-enforced — **requires `BLOCKLIST_DOMAINS` to be non-empty** |
| `BLOCKLIST_DOMAINS` | `<explicit internal domain list>` | Machine-enforced (empty = deny-all; allowlist logic in `src/utils/domainBlacklist.ts:192`) |
| `SOCKS5_LISTEN_ENABLED` | `false` (default) | Machine-enforced (intercept mode causes `process.exit(1)` at startup) |
| `SOCKS5_UPSTREAM_URL`, `HTTP_PROXY_URL`, `PLAYWRIGHT_PROXY`, `PROXY_PINS` | all unset | Machine-enforced (proxy bypasses dnsGuard — a removal of the SSRF guard) |
| `LIGHTPANDA_ENABLED` | `false` (default) | Machine-enforced |
| `STEALTH_ENABLED` | `false` (default) | Machine-enforced |
| `LOG_REDACT_QUERIES` | `true` (default) | Machine-enforced |

**Tier 1 ceilings that cannot be addressed by configuration:**

1. **Chromium egress is not configurable.** `render/ladder.ts` has no `RENDER_MAX_TIER`
   cap. `PlaywrightTier.isAvailable()` is hardcoded `return true`. Chromium in-browser
   subresource loading (XHR, fetch, scripts) passes through a route handler that filters
   only `image/stylesheet/font/media` — all other resource types are forwarded with no
   domain check. A `page.goto` to a target URL on an allowed domain can load scripts
   from arbitrary third-party CDNs. This is an **accepted ceiling** — sign-off required
   in §3 (ATC-01).

2. **`USE_ALLOWLIST_MODE` uses the `BLOCKLIST_DOMAINS` variable for its allowlist.**
   Adding a domain to a variable named `BLOCKLIST_DOMAINS` *permits* it in allowlist mode.
   This is a naming inversion and a change-control risk — sign-off required (ATC-01).

3. **`SEARXNG_URL` pointing to a ClusterIP (`10.x`)** is blocked by `src/http/dnsGuard.ts`
   which rejects RFC1918 addresses. This creates an architectural conflict: the shipped
   in-cluster SearXNG component uses a ClusterIP address that the dnsGuard refuses. Tier 1
   with SearXNG requires either a public/non-RFC1918 SearXNG endpoint, or a code change
   to the dnsGuard. Policy-only "use in-cluster SearXNG" does not work as-is.

4. **`POPIA_SCAN_CONTENT` and `POPIA_AUDIT_ENABLED` are dead config.** Both are accepted
   by the config schema but have zero call sites. They do not control any behaviour. See
   known-gap 5 in `DATA_FLOW.md`.

5. **`fetch_url` / `fetch_urls` caller-supplied headers.** There is no config var to
   disable them. Restricting authenticated fetches to Tier 2 is policy-only.

### Tier 2 — Full (requires complete §3 sign-off)

External search providers active (`BRAVE_API_KEY`, `SERPER_API_KEY`, `SEARXNG_URL`
pointing externally, `SEARCH_ENABLE_DUCKDUCKGO=true`), authenticated `fetch_url`/
`fetch_urls` in use, external TEI reranker (`RERANK_BACKEND=tei`), proxy vendors.

All Tier 1 conditions apply plus the Tier 2 conditions marked in §3.

---

## §2 — Technical state summary

Controls that the code enforces today. Each claim names the test that demonstrates it.
This section cross-references `POPIA_ASSESSMENT.md §5` and `STANDARDS.md` rather than
duplicating them — a second copy is a second thing to go stale.

| Control | POPIA section | Evidence |
|---|---|---|
| RFC 9111 shared-cache — blocks `Cookie`/`Authorization`/`private`/`no-store` from cross-caller reuse | s19 safeguards | `src/http/cachePolicy.test.ts` — `cachePolicy.isStorable — RFC 9111 §3 / §3.5` |
| Automated retention sweep — `CRAWL_RETENTION_MS` (default 7 days), both keyspaces, `PRAGMA secure_delete = ON` | s14 retention | `retention_last_sweep_timestamp_seconds` metric; `src/store/__contract__/queue.test.ts` |
| `SEARCH_ENABLE_DUCKDUCKGO` gate — removes the only DPA-less provider from the fanout | s72 trans-border | `src/search/providers/duckduckgo.test.ts` |
| Audit events to stderr bypassing `LOG_LEVEL`/`LOG_FORMAT` | s22 notification | `src/privacy/audit.test.ts` |
| Log redaction — `redactUrl()`, `redactHeaders()`, `scrubSensitiveKeys()`, HMAC-SHA-256 per-process salt | s19 safeguards | `src/privacy/redact.test.ts` |
| PII detection — SA ID (Luhn + date), MSISDN, PAN — blocks pre-handler, pre-egress in `enforce` mode | s105(4) defence | `src/privacy/detect.test.ts`, `src/privacy/policy.test.ts` |
| `DOWNLOAD_DIR_ALLOWLIST` enforced in `download_file` handler | s19 safeguards | `src/services/downloadFile.test.ts` |
| `allowRemoteModels: false` on both TEI `from_pretrained` calls | s19 safeguards | `src/rank/transformersReranker.test.ts` |
| `readOnlyRootFilesystem: true` on both server and worker manifests | s19 safeguards | `src/server/k8sManifests.test.ts` — `has readOnlyRootFilesystem: true` |
| `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities: drop: ALL` | s19 safeguards | `src/server/k8sManifests.test.ts` |

For the full clause-level conformance register see `docs/enterprise/STANDARDS.md`.

---

## §3 — Conditions register

Each condition has: an ID; the obligation; the POPIA section or operational basis;
the single accountable signatory role; which tier requires it; and a checkbox.
A condition is **signed** when the named role adds their name, signature, and date to
§5 against that condition ID.

The build test `src/authorisation.test.ts` asserts that the status line in §4 reads
`NOT AUTHORISED` while any condition checkbox is unchecked.

### Information Officer (POPIA s55; deputies under s56)

> The designated Information Officer is a statutory role that must be registered with
> the Information Regulator (POPIA s55). The IO is accountable for this system's
> processing activities. Deputies may sign for specific scope areas (s56).

- [ ] **IO-01** · Tier 1 · Confirm the designated Information Officer is registered with the
  Information Regulator and that this system falls within their designated scope.
  *Basis: POPIA s55/s56.*

- [ ] **IO-02** · Tier 1 · s18 openness: confirm that internal employees have been notified
  that their search queries are processed through external APIs (SearXNG upstream engines
  at minimum; Brave, Serper, DuckDuckGo in Tier 2). Method and date of notification to
  be recorded here.
  *Basis: POPIA s18.*

- [ ] **IO-03** · Tier 1 · Accept the s23–25 structural gap: no principal identity exists
  (single shared bearer token). Records cannot be attributed to a specific data subject,
  data-subject access/correction/erasure rights cannot be exercised, and affected individuals
  cannot be individually notified in a s22 breach. This is a documented structural
  limitation, not an oversight.
  *Basis: POPIA Part 3; `POPIA_ASSESSMENT.md §7`.*

- [ ] **IO-04** · Tier 1 · Accept the heuristic-detection ceiling: `src/privacy/detect.ts`
  detects structured identifiers (SA ID, MSISDN, PAN, email) only. Free-text names,
  addresses, employee numbers, and non-SA phone formats are false negatives by
  construction. Documented as a passing test in `src/privacy/detect.test.ts` (the
  "documented false negatives" suite).
  *Basis: POPIA s19; s105(4) "reasonable steps" argument.*

- [ ] **IO-05** · Tier 1 · Accept the Chromium-egress ceiling (ATC-01): `page.goto` in the
  Playwright render tier bypasses `validateUrl`, `dnsGuard`, and the rate limiter.
  In-browser subresource requests (scripts, XHR, fetch) are domain-unfiltered. There is
  no config var to disable this. The risk is documented in `THREAT_MODEL.md §5` and
  `STANDARDS.md §Remaining ceilings`.
  *Basis: POPIA s19; `THREAT_MODEL.md §5`.*

- [ ] **IO-06** · Tier 1 · Accept that `POPIA_MODE=enforce` is a ConfigMap value, not a
  compile-time lock. Any operator with namespace edit rights can change it. Startup
  warning and `audit_events_total{popia_mode="off"}` metric are signals, not locks.
  The RBAC condition (PLT-03) mitigates but does not prevent this.
  *Basis: POPIA s105(4).*

### Legal Counsel

- [ ] **LC-01** · Tier 2 · Confirm s72 lawful basis for Brave Search API (US). Verify that the
  Brave Search API agreement constitutes an adequate DPA under POPIA s72(1).

- [ ] **LC-02** · Tier 2 · Confirm s72 lawful basis for Serper (US). Verify that the Serper
  API agreement constitutes an adequate DPA under POPIA s72(1).

- [ ] **LC-03** · Tier 2 · DuckDuckGo: either obtain a DPA, or confirm `SEARCH_ENABLE_DUCKDUCKGO=false`
  is pinned in the production ConfigMap. No contractual agreement currently covers query
  transfer to DuckDuckGo. Setting `false` in the ConfigMap is a Tier 1 requirement;
  this condition is the legal confirmation for Tier 2 use.

- [ ] **LC-04** · Tier 2 · Confirm s72 basis for SearXNG upstream engines when
  `SEARXNG_ENGINE_PROFILE=clean` (Mojeek, Marginalia, Brave free). Confirm whether
  `SEARXNG_ENGINE_PROFILE=full` (includes Google, Bing) is permitted — `TERMS_OF_SERVICE.md`
  classifies it as breaching those engines' terms.

- [ ] **LC-05** · Tier 1 · Legal sign-off on the email-blocking policy. `src/privacy/policy.ts`
  classifies email addresses as `audit` (not `block`) in `enforce` mode. An email address
  is arguably a s105(5) unique identifier. This is a policy decision requiring legal
  sign-off, not a legal conclusion the code has reached.

- [ ] **LC-06** · Tier 2 · If `RERANK_TEI_URL` is set to an external address: confirm s72 basis
  for transferring query strings and page content to the TEI vendor. If in-cluster only,
  this condition is satisfied by the operator's confirmation that the URL resolves to a
  private address.

- [ ] **LC-07** · Tier 2 · If `SOCKS5_UPSTREAM_URL` or `PROXY_PINS` is configured: the proxy
  vendor receives all HTTP traffic. If `SOCKS5_LISTEN_MODE=intercept` (currently
  unimplemented — causes `process.exit(1)`): the vendor decrypts and processes fetched
  content, creating a s20/s21 + s72 processing obligation.

### Engineering Owner

- [ ] **EO-01** · Tier 1 · Confirm `retention_last_sweep_timestamp_seconds` is advancing in
  production. Evidence: Prometheus query `time() - retention_last_sweep_timestamp_seconds`
  must be below the 2-hour alert threshold within 72 hours of deployment.

- [ ] **EO-02** · Tier 1 · Confirm `POPIA_MODE=enforce` is set in the deployed ConfigMap and
  that no override is present in any environment-specific overlay.

- [ ] **EO-03** · Tier 1 · Confirm `SEARCH_ENABLE_DUCKDUCKGO=false` is set in the Tier 1
  deployed ConfigMap.

- [ ] **EO-04** · Tier 1 · Confirm `BLOCKLIST_DOMAINS` is set to a non-empty list of permitted
  internal domains when `USE_ALLOWLIST_MODE=true`. An empty value is deny-all.
  Document the allowlist in this record.

- [ ] **EO-05** · Tier 1 · Measured SLO values recorded in `docs/enterprise/SLO.md`. All
  "TBD" rows replaced with values measured against a live deployment.

- [ ] **EO-06** · Tier 1 · Every procedure in `docs/enterprise/RUNBOOK.md` executed at least
  once against a live deployment. Date of execution and outcome to be recorded in the
  runbook.

- [ ] **EO-07** · Tier 1 · `docs/enterprise/OWNERSHIP.md` placeholders (`[OWNER_NAME]`,
  `[OWNER_EMAIL]`, `[OWNER_HANDLE]`, `[TEAM_NAME]`, `[ROTATION_NAME]`) replaced with
  named individuals.

### Platform Owner

- [ ] **PLT-01** · Tier 1 · Confirm the CNI in use (Calico or Cilium) enforces `NetworkPolicy`
  resources. Without a conformant CNI, the SSRF egress NetworkPolicy is inert — all
  pod-to-pod and pod-to-external traffic is permitted regardless of the manifest.
  *Basis: `THREAT_MODEL.md §4`.*

- [ ] **PLT-02** · Tier 1 · Confirm the cluster log shipper is configured to collect container
  stderr reliably. Audit events are written to stderr (`src/privacy/audit.ts`) and their
  durability depends entirely on the log pipeline. OOMKill mid-buffer, log rotation before
  ship, and shipper backpressure can all lose events. In stdio mode, stderr is the MCP
  client's log channel with no shipper at all.
  *Basis: POPIA s22; `POPIA_ASSESSMENT.md §5 — Audit trail`.*

- [ ] **PLT-03** · Tier 1 · Confirm RBAC restricts `ConfigMap` edit rights in the `mcp-system`
  namespace to a named, audited set of operators. `POPIA_MODE` and
  `SEARCH_ENABLE_DUCKDUCKGO` are ConfigMap values — namespace edit access is the only
  technical barrier to flipping them.

- [ ] **PLT-04** · Tier 1 · Confirm node disk encryption is enabled on nodes running the
  `mcp-system` workloads. The `/tmp` emptyDir mount is backed by node-local disk (not
  `medium: Memory`) — crawl page content is at rest on the node's filesystem.
  *Basis: POPIA s19.*

### Security Operations

- [ ] **SEC-01** · Tier 1 · Alert rule deployed: `time() - retention_last_sweep_timestamp_seconds > 7200`
  (no retention sweep in 2 hours). Alert must page the Engineering Owner.

- [ ] **SEC-02** · Tier 1 · Alert rule deployed: `increase(audit_events_total{popia_mode="off"}[5m]) > 0`
  — fires if `POPIA_MODE` is switched to `off` in a running pod. Fires in the same
  namespace as the system.

- [ ] **SEC-03** · Tier 1 · Alert rule deployed: `pii_scan_truncated_total` counter advancing
  unexpectedly (tool arguments exceeding 8 KB). In `enforce` mode, content beyond 8 KB
  is not scanned and egresses unchecked.

---

## §4 — Authorisation status

The status below is parsed by `src/authorisation.test.ts`. The build fails if the
status reads `AUTHORISED` while any condition checkbox above is unchecked.

```
Status: NOT AUTHORISED
```

Authorised envelope: n/a (unsigned)

---

## §5 — Signature block

Each signatory signs for the conditions listed in their section of §3. Adding a
signature here is a declaration that the named conditions have been personally
assessed and are satisfied. It is not a declaration that all conditions are satisfied.

| Condition IDs | Role | Name | Signature | Date |
|---|---|---|---|---|
| IO-01 through IO-06 | Information Officer (POPIA s55) | [NAME] | [SIGNATURE] | [DATE] |
| LC-01 through LC-07 | Legal Counsel | [NAME] | [SIGNATURE] | [DATE] |
| EO-01 through EO-07 | Engineering Owner | [NAME] | [SIGNATURE] | [DATE] |
| PLT-01 through PLT-04 | Platform Owner | [NAME] | [SIGNATURE] | [DATE] |
| SEC-01 through SEC-03 | Security Operations | [NAME] | [SIGNATURE] | [DATE] |

> **Instructions for signatories:** Replace `[NAME]`, `[SIGNATURE]`, and `[DATE]`
> with your full name, signature, and the date of signing. Update the condition
> checkboxes in §3. When all checkboxes for your role are ticked, update the
> status in §4 to reflect the new state. The document reaches `AUTHORISED`
> status only when all conditions are ticked and all signatories have signed.
> The Engineering Owner is responsible for confirming the final authorised status.

---

## §6 — Accepted residual risks

The following limitations are accepted by the signatories in §5. Each one is stated
plainly rather than claimed away.

1. **A signed document is not a secure system.** This gate records who accepted which
   risk. It does not reduce the risk.

2. **Tier 1 is a configuration, not a lock.** Any operator with namespace ConfigMap
   edit rights can change the deployment to Tier 2 settings. PLT-03 mitigates and
   does not prevent this.

3. **Chromium egress is unguarded by configuration.** Accepted by IO-05. Subresource
   requests, in-browser fetches, and TLS OCSP/CRL/CT checks bypass all app-level
   URL filtering. A route interceptor is out of scope for the current revision.

4. **The PII scan cap is 8 KB.** Tool arguments larger than 8 KB are truncated before
   scanning. In `enforce` mode, content past the cap egresses without PII checking.
   `pii_scan_truncated_total` metric is the signal; SEC-03 is the alert.

5. **Audit durability is at-most-once.** Accepted by PLT-02. Durability depends on
   the cluster log pipeline, not this codebase.

6. **s72 is documented, not enforced.** Cross-border transfers to active providers
   happen by default in Tier 2. The assessment records the lawful basis; the code does
   not prevent transfers that lack a basis.

7. **No principal identity.** Accepted by IO-03. Data-subject rights (POPIA Part 3)
   cannot be exercised against this system. POPIA s22 breach notification cannot
   identify affected individuals.

8. **Grade B standards conformance is not our conformance.** `undici`, `robots-parser`,
   `prom-client`, and the MCP SDK implement the relevant RFC/protocol clauses. A
   major-version bump can change behaviour silently. See `STANDARDS.md §Grade B`.

9. **The guard test verifies internal consistency, not truth.** `src/authorisation.test.ts`
   confirms that cited tests exist and that the status is coherent. It does not
   confirm that a signatory read what they signed, or that the cited tests are adequate.

10. **`POPIA_ASSESSMENT.md` is the substantive assessment.** This document is a gate on
    top of it. If the two disagree, the assessment is authoritative.

---

## §7 — Revision history and re-authorisation triggers

Re-authorisation is required on any of the following:

- Expiry (12 months from last authorisation date)
- Any change to §3 conditions (addition, deletion, or modification)
- A major-version bump of a Grade B dependency (`undici`, `robots-parser`,
  `@modelcontextprotocol/sdk`, `prom-client`) that changes security-relevant behaviour
- Any new egress destination (new search provider, new external service call)
- Any change to the default value of `POPIA_MODE`
- Any substantive change to `src/privacy/` or `src/http/cachePolicy.ts`
- Any change to the deployed ConfigMap that affects a Tier 1 condition
- Any change to the `NetworkPolicy` egress rules

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0 | 2026-08-25 | Engineering | Initial issue |
