# Trust Overview — markdown-for-agents-mcp

> **For enterprise evaluation.** This document is written for procurement reviewers,
> security teams, and DPOs assessing this software before adoption. It is unsigned
> and does not claim compliance with any regulation. Each claim in this document either
> names the test that demonstrates it or states plainly that it is a limitation.
>
> **How to use this document:** The final section, §8, tells you how to verify each
> claim independently — test names to run, metrics to scrape, endpoints to hit.
> A reviewer who can check a claim for themselves does not have to trust our word for it.

---

## §1 — What this software does

`markdown-for-agents-mcp` is a Model Context Protocol (MCP) server that provides
AI agents with web search, page fetching, crawling, and document conversion capabilities.
It runs in-cluster as a Kubernetes Deployment.

It processes:
- **Query strings** — forwarded to search providers, logged (hashed), used to fetch pages.
- **Fetched page content** — rendered to Markdown, temporarily cached, optionally re-ranked.
- **Tool arguments** — scanned for structured PII identifiers before any egress.

---

## §2 — Data handling summary

| Category | Handling |
|---|---|
| Query strings | Logged as HMAC-SHA-256 hashes (per-process random salt); forwarded to configured search providers; discarded after request. |
| Page content | Cached for up to `SEARCH_CACHE_TTL_MS` (default 1 h); crawl results swept after `CRAWL_RETENTION_MS` (default 7 days); `PRAGMA secure_delete = ON` on SQLite. |
| SA ID numbers, MSISDNs, PANs | Blocked before any egress in `POPIA_MODE=enforce` (default). |
| Email addresses | Detected and audited (not blocked by default — legal sign-off required for blocking; see §6). |
| Request headers (`Authorization`, `Cookie`) | Scrubbed from logs; requests bearing these headers are not served from the shared cache. |
| Prometheus metrics | Scraped in-cluster. **No label captures a URL, query, or personal-data value** — this is documented as a code invariant in `src/obs/metrics.ts`. |
| Audit events | Written to container stderr, bypassing `LOG_LEVEL`/`LOG_FORMAT`. Durability depends on the operator's log pipeline. |

The system has **no telemetry endpoint, no version-check callback, and no analytics
service**. The only outbound network calls are search-provider requests, page fetches,
and (when configured) the SOCKS5/HTTP proxy relay.

---

## §3 — Sub-processors and data location

Outbound transfers depend on operator configuration. Every active transfer path is
listed below, including the one provider that has no contractual agreement.

| Processor | Location | Data transferred | Basis | Active when |
|---|---|---|---|---|
| Brave Search API | United States | Query string | Contractual DPA — operator must verify adequacy | `BRAVE_API_KEY` set |
| Serper | United States | Query string | Contractual DPA — operator must verify adequacy | `SERPER_API_KEY` set |
| DuckDuckGo | United States | Query string (scraped HTML) | **No DPA exists** | `SEARCH_ENABLE_DUCKDUCKGO=true` (default — **set `false` in production if no DPA obtained**) |
| SearXNG (in-cluster) | Operator-defined | Query string | In-cluster; upstream engines depend on `SEARXNG_ENGINE_PROFILE` | `SEARXNG_URL` set |
| TEI reranker | Operator-defined | Query string + page chunks | Operator responsibility | `RERANK_BACKEND=tei`, `RERANK_TEI_URL` set |
| SOCKS5/HTTP proxy | Vendor-defined | All HTTP traffic; decrypted if intercept mode | Vendor agreement required | `SOCKS5_UPSTREAM_URL` or `HTTP_PROXY_URL` set |
| HuggingFace | N/A | No personal information — model must be pre-baked in the image; `allowRemoteModels: false` | N/A | N/A — no runtime pull |

**DuckDuckGo** is the only processor with no contractual DPA. Setting
`SEARCH_ENABLE_DUCKDUCKGO=false` removes it from the search fanout entirely.
This setting is required for a POPIA s72-clean deployment in South Africa unless a DPA
is obtained.

---

## §4 — Retention and deletion

| Data | Retention | Mechanism |
|---|---|---|
| Search result cache | `SEARCH_CACHE_TTL_MS` (default 1 h) | LRU eviction; `CACHE_MAX_BYTES` cap |
| Crawl job records | `CRAWL_RETENTION_MS` (default 7 days) | `runRetentionSweep` — automated, runs on every pod, every `RETENTION_SWEEP_INTERVAL_MS` (default 1 h) |
| Crawl page content | `CRAWL_RETENTION_MS` | Same sweep; `PRAGMA secure_delete = ON` overwrites freed SQLite pages |
| Application logs | Per operator log policy | External to this system |

**Evidence the sweep runs:** `retention_last_sweep_timestamp_seconds` Prometheus gauge.
Recommended alert: `time() - retention_last_sweep_timestamp_seconds > 7200`.

**Retention is unconditional.** It is not controlled by `POPIA_MODE`. An environment
variable that could disable retention sweeping would destroy the POPIA s105(4)
"took all reasonable steps" statutory defence.

**What is not swept:** The process-global `urlCache` (search result cache) is bounded
by `SEARCH_CACHE_TTL_MS` and LRU eviction, not by the crawl retention sweep.

---

## §5 — Standards conformance

Conformance claims are graded, not a badge list. The grading rule, stated explicitly in
`docs/enterprise/STANDARDS.md`, is: **cite the grade, never the bare standard number.**
"Implements RFC 1928/1929 SOCKS5 with authentication" is a defensible Grade A claim.
A bare "compliant with RFC N" claim must name the grade — otherwise a reviewer cannot
tell whether the behaviour is tested here, inherited from a dependency, or merely
opt-in.

Full clause-level register: `docs/enterprise/STANDARDS.md`.

**Grade A highlights (implemented and tested in this repository):**
- RFC 1928/1929 SOCKS5 with username/password authentication
- RFC 1918 / 3927 / 4193 private, link-local, and ULA address blocking (`dnsGuard`)
- RFC 9111 shared-cache — §3 storability, §3.5 `Authorization`, §4.1 `Vary`, §4.2 freshness

**Grade C — supported but not conformant by default:**
- RFC 9309 (robots.txt): `RESPECT_ROBOTS_TXT` defaults to `false`. Opt-in only.
- RFC 9309 §2.3.1.4: unreachable robots.txt defaults to `allow`; `ROBOTS_ON_ERROR=deny`
  enables the RFC-recommended deny behaviour.

---

## §6 — Open policy decisions requiring legal sign-off

The following items are technical choices whose legal implications are beyond
engineering's competence to resolve:

1. **Email addresses in PII enforcement.** `src/privacy/policy.ts` classifies email as
   `audit` (not `block`) in `enforce` mode. An email address is arguably a POPIA
   s105(5) unique identifier. This is a policy decision; it has not been resolved.

2. **s72 lawful basis per active provider.** Brave and Serper have contractual agreements;
   whether those constitute adequate DPAs under POPIA s72(1) is a legal determination.

3. **SearXNG engine profile.** `SEARXNG_ENGINE_PROFILE=full` forwards queries to Google
   and Bing, which do not permit automated access per their ToS. The `clean` profile
   (default) uses only engines that do. See `docs/enterprise/TERMS_OF_SERVICE.md`.

---

## §7 — Known limitations

These are stated because omitting them creates the same false-confidence problem the
system was designed to prevent. A reviewer who finds an unstated gap destroys trust in
everything else. A reviewer who finds stated gaps trusts that the rest is honest.

1. **PII detection is heuristic.** The detector finds structured identifiers: SA ID
   numbers (Luhn + date), MSISDNs, PANs, and email addresses. Free-text names,
   addresses, employee numbers, and non-SA phone numbers are **false negatives by
   construction**. This is documented as a passing test in `src/privacy/detect.test.ts`
   (the "documented false negatives" suite).

2. **`POPIA_MODE=off` is one ConfigMap edit.** Anyone with namespace edit rights can
   disable PII enforcement without changing code. The startup warning and
   `audit_events_total{popia_mode="off"}` metric are signals, not locks. RBAC controls
   who holds the edit right.

3. **Audit durability is at-most-once.** Audit events are written to container stderr.
   Durability depends on the operator's log shipper. In stdio mode, stderr is the MCP
   client's log channel with no shipper at all. A pod OOMKill mid-buffer loses the event.

4. **No data-subject rights tooling.** There is no mechanism for a data subject to
   exercise POPIA Part 3 rights (access, correction, deletion). The single shared bearer
   token means records cannot be attributed to a specific individual.

5. **Chromium egress is unguarded by configuration.** The Playwright render tier (`page.goto`)
   bypasses application-level URL filtering, the SSRF guard, and the rate limiter.
   In-browser subresource requests (scripts, XHR, fetch) are not domain-filtered.
   There is no config var to disable the Chromium tier.

6. **Inherited conformance is not our conformance.** Grade B standards (`undici`,
   `robots-parser`, `prom-client`, `@modelcontextprotocol/sdk`) are implemented by those
   libraries. A major-version bump can change behaviour silently. See `STANDARDS.md §Grade B`.

7. **The PII scan cap is 8 KB.** Tool arguments larger than 8 KB are truncated before
   scanning. In `enforce` mode, content past the cap egresses without PII checking.
   Truncations are counted in `pii_scan_truncated_total`.

8. **The scope of this system ends at the MCP boundary.** The MCP server returns Markdown
   to the calling agent. If that agent is hosted by a third-party LLM provider, the
   retrieved content is transferred to them. This system does not control what the
   calling model does with the content.

---

## §8 — How to verify the claims in this document

A due-diligence reviewer can independently verify the following without access to a
running deployment:

**1. PII detection and blocking:**
```sh
cd /path/to/repo && npm test -- src/privacy/detect.test.ts src/privacy/policy.test.ts
```
The `detect.test.ts` suite includes the "documented false negatives" case — a passing
test that names the things the detector cannot find.

**2. RFC 9111 shared-cache isolation:**
```sh
npm test -- src/http/cachePolicy.test.ts
```
One assertion per RFC clause. Includes the cross-caller disclosure test: `fetch_page`
with `Cookie: session=A` does not return the cached result to a subsequent call with
no credentials.

**3. Retention sweep:**
```sh
npm test -- src/store/__contract__/queue.test.ts
```
Tests `purgeOlderThan` across memory, SQLite, and (if `REDIS_URL` set) Redis backends.

**4. Audit events bypass `LOG_LEVEL` and `LOG_FORMAT`:**
```sh
npm test -- src/privacy/audit.test.ts
```
The test sets `LOG_LEVEL=error` and `LOG_FORMAT=text` and asserts that the audit line
still reaches stderr.

**5. Log redaction:**
```sh
npm test -- src/privacy/redact.test.ts
```
Tests `redactUrl()`, `redactHeaders()`, HMAC-SHA-256 per-process salt. Includes the
cross-process hash-divergence test (two processes with no `LOG_REDACT_SALT` produce
different hashes).

**6. DuckDuckGo gate:**
```sh
npm test -- src/search/providers/duckduckgo.test.ts
```

**7. Metrics do not contain PII labels:**
Scrape `/metrics` after a run containing SA IDs, MSISDNs, and PANs. Confirm no label
value is a 13-digit number, +27-format phone, or valid PAN. The label sets in
`src/obs/metrics.ts` are: `tool`, `outcome`, `pii_detected`, `popia_mode`, `class`,
`action`, `provider`, `tier`, `backend`, `reason`, `from_tier`, `to_tier`, `job`,
`status`, `stage`, `result`, `op`. None of these carry data-plane values.

**8. `readOnlyRootFilesystem`, `runAsNonRoot`, capability drops:**
```sh
npm test -- src/server/k8sManifests.test.ts
```

**9. Standards register accuracy:**
```sh
npm test -- src/standards.test.ts
```
Asserts that every Grade A source file, test file, and test name cited in
`docs/enterprise/STANDARDS.md` resolves and exists.

**10. Authorisation gate coherence:**
```sh
npm test -- src/authorisation.test.ts
```
Asserts that the status in `PRODUCTION_AUTHORISATION.md §4` reads `NOT AUTHORISED`
while any condition checkbox is unchecked, and that every cited config var and test
name exists.

---

## §9 — Disclosure process

Vulnerability reports: `SECURITY.md` at the repository root.

Licence: MIT (`LICENSE`).

Support model: `docs/enterprise/OWNERSHIP.md`. There is no vendor SLA. This is
internally supported software.
