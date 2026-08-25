# POPIA Assessment — markdown-for-agents-mcp

> **DRAFT — for internal review only.**
> Claims marked ✓ name the test that demonstrates them. Claims marked ⚠ are
> stated gaps requiring sign-off or further work. Do not use as a compliance
> attestation until all items in §9 are resolved and the document is signed by an
> assessor.

**Act:** Protection of Personal Information Act 4 of 2013 (POPIA), South Africa
**Date of assessment:** 2026-08-25 (updated for Phases 1–7)
**Scope:** MCP server and worker as deployed via `deploy/k8s/` in the Vodacom environment

---

## Summary

| Condition | Status | Notes |
|---|---|---|
| Lawful processing | ⚠ Conditional | Legitimate business purpose; some data retained beyond request lifecycle (§4) |
| Purpose specification | ✓ Resolved | Dead fields removed (Phase 0); `crawl_start` no longer accepts `query`/`relevanceThreshold` |
| Further processing limitation | ✓ Implemented | Retention sweep runs every `RETENTION_SWEEP_INTERVAL_MS`; `retention_last_sweep_timestamp_seconds` metric is the evidence |
| Information quality | N/A | No personal records maintained |
| Openness | ✓ Implemented | `SEARCH_ENABLE_DUCKDUCKGO` gate added; DuckDuckGo excluded when set to `false` |
| Security safeguards | ⚠ Partial | RFC 9111 shared-cache conformance, log redaction, PII detection implemented; structural gaps remain (§5) |
| Data subject participation | ✗ Not achievable | No principal identity in the system — structural gap, explicitly deferred (§7) |
| Trans-border flow | ⚠ Requires sign-off | s72 basis documented per provider; legal sign-off still required (§6) |

---

## 1. What personal information is processed?

**Query text** may constitute personal information under POPIA s1 if the query contains
names, identification numbers, or other information that could identify a natural person.

**Structured identifiers** (SA ID numbers, MSISDNs, PANs) embedded in queries are
criminal offences under POPIA s105 if mishandled. s105(5) defines "account number"
broadly enough to cover MSISDNs. Phase 6 adds heuristic detection of these identifiers
and blocks them from reaching external providers when `POPIA_MODE=enforce` (default).

**Crawl page content** is potentially personal information when crawling authenticated
resources. `fetch_page` accepts `Authorization` and `Cookie` headers; page content
retrieved this way is personal information in the full POPIA sense.

**Known limitation:** Detection is heuristic structured-identifier matching only.
Free-text names, addresses, and employee numbers (e.g. "John Smith employee number
12345") are **false negatives by design**. This is documented as a passing test in
`src/privacy/detect.test.ts` (the "documented false negatives" suite).

---

## 2. Lawful basis for processing (POPIA s11)

**Legitimate interests of the responsible party (Vodacom)** — POPIA s11(1)(f):
providing an internal AI search capability to improve employee productivity. Processing
is proportionate: query text is used to execute the search and then discarded or
swept by the retention mechanism.

**Phase 0 resolution:** `crawl_start` previously persisted `query` and
`relevanceThreshold` fields that were never read. Both fields have been removed from
`JobSpec`, the tool input schema, and the tool description. POPIA s10 minimality now
holds for the `crawl_start` input path.

---

## 3. Purpose specification and further processing (POPIA s13–15)

**Specified purpose:** Execute a web search or crawl on behalf of an internal AI agent.

**For `web_search` / `fetch_page`:** Query text is forwarded to search providers and
discarded after the response. The result cache stores the full search response for up
to `SEARCH_CACHE_TTL_MS` (default: 1 h).

**For `crawl_start`:** Crawl job metadata and page content are retained in the store
backends. The retention sweep (`CRAWL_RETENTION_MS`, default 7 days) runs periodically
and deletes records older than the window. The `retention_last_sweep_timestamp_seconds`
gauge is alertable as "no sweep in 2 h" and constitutes evidence the sweep runs.

---

## 4. Retention (POPIA s14)

| Data | Retention period | Status |
|---|---|---|
| Search result cache | `SEARCH_CACHE_TTL_MS` (default: 1 h) | ✓ TTL-bounded |
| Application logs | Per Vodacom log retention policy | External — not set by this system |
| Crawl job spec | `CRAWL_RETENTION_MS` (default: 7 days) | ✓ Swept — Phase 2 |
| Crawl page content | `CRAWL_RETENTION_MS` (default: 7 days) | ✓ Swept — Phase 2 |
| Crawl queue records | `CRAWL_RETENTION_MS` (default: 7 days) | ✓ Swept — Phase 2 |
| SQLite page bytes | Bounded by pod lifetime (`emptyDir`) + sweep | ✓ `PRAGMA secure_delete = ON` |
| Redis page bytes | `CRAWL_RETENTION_MS` sweep via `ZRANGEBYSCORE` + `UNLINK` | ✓ Swept — Phase 2 |

**Retention is unconditional** — it is deliberately not under `POPIA_MODE`. An env var
that could disable sweeping would be a foot-gun that destroys the s105(4) argument.

**Evidence:** `retention_last_sweep_timestamp_seconds` gauge (Prometheus). Alert rule:
`time() - retention_last_sweep_timestamp_seconds > 7200` (no sweep in 2 h).

**Nuance:** `/tmp` is an `emptyDir` volume so SQLite data is *de facto* bounded by pod
lifetime. Redis/Valkey is genuinely unbounded and typically AOF-persisted. The sweep
is required in both backends.

---

## 5. Security safeguards (POPIA s19)

### Cache isolation — RFC 9111 shared-cache conformance (Phase 1)

`urlCache` is process-global and shared across all callers. Prior to Phase 1, it
ignored origin `Cache-Control` directives, allowing a response retrieved with
`Cookie: session=A` to be served to a subsequent unauthenticated caller for the same
URL (active cross-caller disclosure).

Phase 1 introduced `src/http/cachePolicy.ts` implementing RFC 9111 shared-cache rules:

| RFC 9111 clause | Control |
|---|---|
| §3 — `no-store` | Not stored; `cache_not_stored_total{reason=no_store}` |
| §3 (shared cache) — `private` | Not stored; `cache_not_stored_total{reason=private}` |
| §3.5 — `Authorization` header | Not stored (absent `public`/`s-maxage`/`must-revalidate`) |
| Convention — `Cookie` header | Not stored (Varnish default VCL) |
| Convention — `Set-Cookie` in response | Not stored (nginx default behaviour) |
| §4.1 — `Vary` | Secondary cache key includes named request-header values |
| §4.1 — `Vary: *` | Never reused |
| §4.2 — freshness | `min(origin max-age, CACHE_TTL_MS)` |

**Not implemented:** RFC 9111 §4.3 conditional revalidation (`ETag`/`If-None-Match`)
is a freshness optimisation, not a confidentiality control — explicitly out of scope.

**Test evidence:** `src/http/cachePolicy.test.ts` — one assertion per clause.

### Log redaction (Phase 5)

- `redactQuery()` uses HMAC-SHA-256 with a per-process random salt (16 hex chars).
  Hashes are uncorrelatable across restarts and replicas by default.
- `redactUrl()` removes embedded credentials and replaces query-parameter values with
  `[redacted]` (human-readable in log output).
- `redactHeaders()` scrubs `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`,
  `X-Api-Key`, `X-Auth-Token`, `X-csrf-token`.
- `formatJsonEntry()` applies `scrubSensitiveKeys()` to the structured log data object.
- `LOG_REDACT_SALT` (optional) enables cross-replica hash correlation.

### PII detection and enforcement (Phase 6)

- `src/privacy/detect.ts` detects SA ID numbers, MSISDNs, email addresses, and PANs
  in tool arguments.
- `src/privacy/policy.ts` maps detected classes to actions per `POPIA_MODE`:
  - `enforce` (default): blocks requests containing SA ID, MSISDN, or PAN.
  - `monitor`: audits without blocking.
  - `off`: disabled (loud startup warning; `popia_mode=off` label in metrics).
- Scan capped at 8 KB to prevent 50 MB hot-path abuse; truncations counted in
  `pii_scan_truncated_total{tool}`.

### Disk surface controls (Phase 3)

- `DOWNLOAD_DIR_ALLOWLIST` (default `/tmp`) enforced in `download_file` handler.
- `allowRemoteModels: false` on both TEI `from_pretrained` calls.

### Audit trail (Phase 4 — s22)

`emitAudit()` writes one JSON line directly to `process.stderr`, bypassing `LOG_LEVEL`
and `LOG_FORMAT`. Fields: `requestId`, `tool`, `timestamp`, `outcome`, `piiClasses`
(names only, max 8), `action`, `popiaMode`.

**Known limitations (s22):**
- s22 requires notifying the Regulator *and* affected data subjects. With a single
  shared bearer token and no principal identity, this system cannot identify affected
  data subjects.
- The audit trail is **at-most-once**. Durability depends on the cluster log pipeline
  (pod OOMKill mid-buffer, log rotation before ship, shipper backpressure). In stdio
  mode, stderr is the MCP client's log channel with no shipper.
- See `deploy/k8s/DEPLOYMENT.md` for required log shipper configuration.

### Remaining security gaps

- **`readOnlyRootFilesystem` omitted:** `server.yaml` and `worker.yaml` do not set
  `readOnlyRootFilesystem: true`, so `/home/pwuser` is writable.
- **Chromium egress unguarded:** `page.goto` in the Playwright tier bypasses
  `validateUrl`, `dnsGuard`, and the rate limiter.
- **SSRF NetworkPolicy inert without CNI:** See `THREAT_MODEL.md §3`.

---

## 6. Trans-border information flows (POPIA s72)

| Provider | Destination | Data sent | s72 basis | Status |
|---|---|---|---|---|
| Brave Search API | United States | Query string | Contractual DPA | ✓ Covered — verify agreement |
| Serper | United States | Query string | Contractual DPA | ✓ Covered — verify agreement |
| DuckDuckGo | United States | Query string (scraped HTML) | No agreement | ✓ Gated by `SEARCH_ENABLE_DUCKDUCKGO` (Phase 3) |
| SearXNG upstream engines | Varies | Query string | Engine ToS | Conditional — `SEARXNG_ENGINE_PROFILE=clean` |
| TEI reranker | Operator-defined | Query + page content | Operator responsibility | In-cluster only if `RERANK_TEI_URL` is a cluster address |
| HuggingFace model pull | United States | No personal information — model weights only | N/A | One-time at startup if `RERANK_BACKEND=local` |
| SOCKS5/HTTP proxy | Vendor-defined | All HTTP traffic | Vendor agreement required | Only when `SOCKS5_UPSTREAM_URL` or `HTTP_PROXY_URL` set |

**Assessment:** Transfer to countries without adequate POPIA-equivalent protection
(including the US) requires one of the lawful bases in POPIA s72(1). Vodacom's legal
team must confirm the applicable basis for each active provider before production
deployment in a regulated context.

**DuckDuckGo** is the only provider with no contractual DPA. The `SEARCH_ENABLE_DUCKDUCKGO`
gate (Phase 3) allows operators to exclude it from the fanout; this must be verified as
part of the production checklist.

---

## 7. Data subject rights (POPIA Part 3)

**No data subject can currently exercise rights because:**

1. No principal identity exists. The single shared bearer token means records cannot be
   attributed to a specific data subject.
2. There is no s23–25 tooling (access, correction, deletion by subject).

**This gap is structural** and cannot be resolved without a per-principal identity
model. The POPIA remediation plan explicitly defers this. `purgeOlderThan` (Phase 2)
is the primitive a subject-scoped erasure would extend — it would require a predicate,
not a rewrite.

---

## 8. Operator vs responsible party

| Party | Role | Obligation |
|---|---|---|
| Vodacom | Responsible party | Defines purpose, controls deployment |
| Brave / Serper | Operator (when keys set) | Processes query strings per API agreement |
| DuckDuckGo | Operator (when `SEARCH_ENABLE_DUCKDUCKGO=true`) | No DPA — set `false` in production if unresolved |
| SearXNG upstream engines | Sub-operator | Query forwarded by SearXNG; consent via engine ToS |
| TEI reranker vendor | Operator (if external URL) | Must have DPA covering query + page content |
| SOCKS5/HTTP proxy vendor | Operator (if configured) | Must have DPA covering all intercepted traffic |
| SOCKS5 intercept CA vendor | Operator (if `SOCKS5_LISTEN_MODE=intercept`) | Decrypted content processing — s20/21 + s72 obligation |

---

## 9. Items requiring sign-off before production

- [x] Remove `JobSpec.query`/`relevanceThreshold` dead fields — Phase 0
- [x] RFC 9111 shared-cache conformance deployed — Phase 1; verified by `cachePolicy.test.ts`
- [x] Automated retention sweep running — Phase 2; verified by `retention_last_sweep_timestamp_seconds`
- [x] `SEARCH_ENABLE_DUCKDUCKGO` gate available — Phase 3
- [x] Audit trail emitted to stderr bypassing LOG_LEVEL/LOG_FORMAT — Phase 4
- [x] Log redaction covers all fetch paths — Phase 5
- [x] PII detection (SA ID, MSISDN, PAN) blocks in enforce mode — Phase 6
- [ ] Confirm `SEARCH_ENABLE_DUCKDUCKGO=false` is set in production (if no DuckDuckGo DPA)
- [ ] Confirm `retention_last_sweep_timestamp_seconds` is advancing in production
- [ ] Confirm Brave Search API and Serper API agreements constitute adequate DPAs under POPIA
- [ ] Confirm lawful basis for trans-border transfer per active provider (POPIA s72)
- [ ] Confirm CNI choice (Calico/Cilium) for SSRF NetworkPolicy enforcement
- [ ] Internal employee disclosure that queries are processed through external APIs (POPIA s18 openness)
- [ ] **Legal sign-off on email-blocking policy** in `src/privacy/policy.ts` — email is currently `audit` not `block`; an email address is arguably a s105(5) unique identifier
- [ ] Fill assessor name and sign this document once all ⚠ gaps are resolved or accepted with documented rationale
