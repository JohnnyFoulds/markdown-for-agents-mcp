# POPIA Assessment — markdown-for-agents-mcp

> **DRAFT — for internal review only.**
> This document reflects gaps accurately. Do not use as a compliance attestation until
> all items in §9 are resolved and the document is signed by an assessor.

**Act:** Protection of Personal Information Act 4 of 2013 (POPIA), South Africa  
**Date of assessment:** 2026-08-24 (last updated)  
**Scope:** MCP server and worker as deployed via `deploy/k8s/` in the Vodacom environment

---

## Summary

| Condition | Status | Notes |
|---|---|---|
| Lawful processing | ⚠ Conditional | Processing is for legitimate business purpose; however, some data is retained beyond the request lifecycle (see §4) |
| Purpose specification | ⚠ Gap | `crawl_start` accepts `query` and `relevanceThreshold` fields that are persisted but never used — collecting PII with no purpose |
| Further processing limitation | ⚠ Gap | Crawl job records and page content are retained indefinitely; no automated pruning exists |
| Information quality | N/A | No personal records maintained |
| Openness | ⚠ Gap | DuckDuckGo receives query text unconditionally but is not disclosed in this document's previous version |
| Security safeguards | ⚠ Multiple gaps | See §5 |
| Data subject participation | ✗ Not achievable | No principal identity in the system — see §7 |
| Trans-border flow | ⚠ Requires sign-off | See §6; DuckDuckGo has no agreement |

---

## 1. What personal information is processed?

**Query text may constitute personal information** under POPIA s1 (definition of
"personal information") if the query contains names, identification numbers, or other
information that could identify a natural person.

This is a theoretical risk, not a systemic one. The tool is an internal AI search
assistant; queries are expected to be research queries, not personal records. However,
the system cannot distinguish between "best practices for kubernetes" and "John Smith
employee number 12345" — both are treated identically.

**Note on structured identifiers:** South African ID numbers (MSISDNs, PANs) embedded
in queries are criminal offences under POPIA s105 if mishandled, and s105(5) defines
"account number" broadly enough to cover MSISDNs. The identifier-detection controls in
the POPIA remediation plan address this specifically.

**Crawl page content** is also potentially personal information when crawling internal
or authenticated resources. `fetch_page` accepts `Authorization` and `Cookie` headers
for authenticated fetches. Page content retrieved this way is personal information in
the full POPIA sense, even if the source is nominally an internal system.

---

## 2. Lawful basis for processing (POPIA s11)

**Legitimate interests of the responsible party (Vodacom)** — POPIA s11(1)(f):
providing an internal AI search capability to improve employee productivity. The
processing is proportionate: query text is used to execute the search.

**Gap:** `crawl_start` persists the full `JobSpec` including `query` and
`relevanceThreshold` fields in two stores, and these fields are never read. This fails
POPIA s10 minimality. These fields will be removed in the POPIA remediation.

Alternatively: **consent of the data subject** — employees using an internal tool
operated by their employer under normal employment terms.

---

## 3. Purpose specification and further processing (POPIA s13–15)

**Specified purpose:** Execute a web search or crawl on behalf of an internal AI agent.

**For `web_search` / `fetch_page`:** Query text is forwarded to search providers and
then discarded after the response is returned. The result cache stores the full search
response object (including `query`) for up to `SEARCH_CACHE_TTL_MS` (default: 1 h).

**For `crawl_start`:** The full `JobSpec` (including the `query` field if supplied) is
persisted in `crawl_jobs.spec` and the KV store under `job:{id}:spec`. Both stores
have **no TTL** — records are retained indefinitely until a retention sweep runs.
Crawl page content (`crawl_pages.content`) is also retained indefinitely.

**Known gap:** There is no automated retention sweep. This is a live POPIA s14 violation.

---

## 4. Retention (POPIA s14)

| Data | Retention period | Status |
|---|---|---|
| Search result cache | `SEARCH_CACHE_TTL_MS` (default: 1 h) | TTL-bounded |
| Application logs | Per Vodacom log retention policy (not set by this system) | External |
| Crawl job spec | **No TTL** — indefinite | ⚠ Gap — no pruning exists |
| Crawl page content | **No TTL** — indefinite | ⚠ Gap — no pruning exists |
| Crawl job queue records | **No TTL** — indefinite | ⚠ Gap — no pruning exists |

**The absence of automated retention is the single highest-severity POPIA gap in this
system.** It is a live s14 violation. The POPIA remediation plan (Phase 2) implements
a configurable sweep via `CRAWL_RETENTION_MS` (default: 7 days) with a Prometheus
gauge (`retention_last_sweep_timestamp_seconds`) as evidence that sweeping runs.

**SQLite vs Redis nuance:** `/tmp` is an `emptyDir` volume — SQLite data is bounded by
pod lifetime. Redis/Valkey data is genuinely unbounded and typically AOF-persisted
across pod restarts. The gap is most severe in Redis deployments.

---

## 5. Security safeguards (POPIA s19)

**Technical measures:**

- TLS for all external API calls
- `LOG_REDACT_QUERIES=true` (default): query text hashed at DEBUG level
  - **Gap:** one production call site only (`duckduckgo.ts:88`). Query text may appear
    in logs via other paths.
  - **Gap:** hash is unsalted SHA-256 truncated to 8 hex chars — correlatable across
    replicas; ~65k-collision bound within one process.
- API keys stored as Kubernetes Secrets, not in ConfigMaps or logs
- Bearer token authentication for the MCP endpoint
- Container runs as non-root (`pwuser`, UID 1000)
- **Gap — shared page cache:** `urlCache` is process-global and ignores origin
  `Cache-Control: private/no-store` directives. Responses with `Authorization`/`Cookie`
  can be served to subsequent unauthenticated callers for the same URL. Addressed in
  Phase 1 of the POPIA remediation.
- **Gap — `readOnlyRootFilesystem` omitted:** server.yaml and worker.yaml do not set
  `readOnlyRootFilesystem: true`, so `/home/pwuser` is writable in addition to `/tmp`
  and `/dev/shm`. `download_file` is not confined to the `/tmp` emptyDir.
- **Gap — `download_file` allowlist absent:** the tool validates only that the output
  path is absolute; no directory allowlist is enforced.

**Organisational measures:**

- Access to the `mcp-secrets` Kubernetes Secret should be restricted via RBAC to the
  deployment pipeline and named operators (see `docs/enterprise/OWNERSHIP.md`)
- Log access should follow Vodacom's existing log access controls

**Caveat — SSRF and NetworkPolicy:**
See `docs/enterprise/THREAT_MODEL.md §3`. On clusters without Calico or Cilium, the
NetworkPolicy SSRF guard is inert. This is a security gap that must be assessed against
Vodacom's cluster CNI choice before production sign-off.

---

## 6. Trans-border information flows (POPIA s72)

When paid providers are active, query strings are sent outside South Africa:

| Provider | Destination | Data sent | s72 basis | Status |
|---|---|---|---|---|
| Brave Search API | United States | Query string | Contractual DPA | ✓ Covered |
| Serper | United States | Query string | Contractual DPA | ✓ Covered |
| DuckDuckGo | United States | Query string (scraped HTML) | **No agreement** | ⚠ Gap |
| SearXNG upstreams (clean) | Varies | Query string | See TERMS_OF_SERVICE.md | Conditional |
| TEI reranker | Operator-defined | Query + page content | Operator responsibility | Verify |
| SOCKS5/HTTP proxy | Vendor-defined | All HTTP traffic | Vendor agreement required | If configured |

**DuckDuckGo gap:** `isConfigured()` returns `true` unconditionally — DuckDuckGo is
always in the search fanout. No `SEARCH_ENABLE_DUCKDUCKGO` config gate currently
exists. Query text reaches a US endpoint with no contractual data processing agreement.
This is a live s72 gap until a config gate is added (POPIA remediation Phase 3).

**Assessment:** Transfer to countries without adequate POPIA-equivalent protection
(including the US) requires one of the lawful bases in POPIA s72(1):
- Consent (employee using internal tooling)
- Necessary for contract performance
- Contractual clauses providing adequate protection (Brave, Serper API agreements)

Vodacom's legal team should confirm which basis applies for the specific provider mix
before production deployment in a regulated context.

---

## 7. Data subject rights (POPIA Part 3)

**No data subject can currently exercise rights because:**

1. No principal identity exists in the system. The single shared bearer token means
   the system cannot attribute a request or a stored record to a specific data subject.
2. There is no mechanism to link a query or a crawl result to an individual.
3. There is no s23–25 tooling (access, correction, deletion by subject).

**This gap is structural** and cannot be resolved without an authorisation model that
provides per-principal identity. The POPIA remediation plan explicitly defers this.

POPIA s22 breach notification requires identifying affected data subjects. With no
principal identity, this system **structurally cannot satisfy that requirement**. The
audit events added in POPIA Phase 4 provide an at-most-once log of tool calls; they
are not a substitute for subject-level breach notification.

If queries are stored in the cluster log aggregator, a data subject request would
require searching log infrastructure outside this system's scope.

---

## 8. Operator vs responsible party

| Party | Role | Obligation |
|---|---|---|
| Vodacom | Responsible party | Defines purpose, controls deployment |
| Brave / Serper | Operator (when keys set) | Processes query strings per API agreement |
| DuckDuckGo | De facto operator (always active) | No agreement — gap |
| SearXNG upstream engines | Sub-operator | Query forwarded by SearXNG; consent via engine ToS |
| TEI reranker vendor | Operator (if external URL) | Must have DPA covering query + page content |
| SOCKS5/HTTP proxy vendor | Operator (if configured) | Must have DPA covering all intercepted traffic |

Vodacom is the responsible party. Standard operator agreements (POPIA s20-21) must be
confirmed for Brave and Serper before those keys are activated in a regulated deployment.

---

## 9. Items requiring sign-off before production

- [ ] Confirm lawful basis for trans-border transfer (POPIA s72) for each active provider
- [ ] Confirm Brave Search API and Serper API agreements constitute adequate data
      processing agreements under POPIA
- [ ] **Resolve DuckDuckGo gap:** either obtain a DPA or implement `SEARCH_ENABLE_DUCKDUCKGO=false`
      and confirm it is set in production
- [ ] **Resolve retention gap:** confirm automated retention sweep is running
      (`retention_last_sweep_timestamp_seconds` metric must be advancing)
- [ ] **Resolve dead-field gap:** confirm `JobSpec.query` and `JobSpec.relevanceThreshold`
      are removed from `crawl_start`
- [ ] **Resolve page-cache gap:** confirm RFC 9111 shared-cache conformance is deployed
      (`cache_not_stored_total` metric must exist)
- [ ] Confirm Vodacom's log retention policy covers query text retention (even hashed)
- [ ] Confirm CNI choice (Calico/Cilium) for SSRF NetworkPolicy enforcement
- [ ] Internal disclosure to employees that an AI search tool processes query strings
      through external APIs (openness principle — POPIA s18)
- [ ] Legal sign-off on identifier-blocking policy in `src/privacy/policy.ts` (once
      implemented) — specifically whether email addresses are blocked as s105(5) identifiers
- [ ] Fill assessor name / sign this document only after all ⚠ gaps are resolved or
      accepted with documented rationale
