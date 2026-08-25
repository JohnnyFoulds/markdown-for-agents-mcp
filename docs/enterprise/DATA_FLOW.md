# Data Flow — markdown-for-agents-mcp

This document inventories what data enters and leaves the system, where it is stored,
and for how long. It is the primary input to `docs/enterprise/POPIA_ASSESSMENT.md`.

---

## Data flow diagram (text)

```
Agent / LLM
    │  MCP call (tool name + arguments: query string, URL, options)
    ▼
MCP Server (Node.js, in-cluster)
    │
    ├─► PII scan (src/privacy/detect.ts, capped at 8 KB)
    │       │  sa_id / msisdn / pan → block (POPIA_MODE=enforce)
    │       │  email → audit; all → pass (POPIA_MODE=off)
    │       └──► audit event to stderr (src/privacy/audit.ts)
    │
    ├─► Search fanout ──► [Brave API]    ─── HTTPS ───► api.search.brave.com (US)
    │                 ──► [Serper API]   ─── HTTPS ───► google.serper.dev (US)
    │                 ──► [SearXNG]      ─── HTTP ────► searxng.mcp-system (in-cluster)
    │                 ──► [DuckDuckGo]   ─── HTTPS ───► duckduckgo.com (US, no DPA — see §6)
    │                         │
    │                         └──────────────────────► [DDG / Mojeek / etc.] (engines.searxng.org)
    │
    ├─► Result cache  ──► [Valkey / SQLite]  (in-cluster; SEARCH_CACHE_TTL_MS, default 1 h;
    │                                         crawl records: see §Crawl job storage below)
    │
    ├─► Page fetcher  ──► [Chromium render / HTTP fetch]
    │       │                   │
    │       │                   └──► Target URL (public internet, HTTPS)
    │       ▼
    │   [urlCache]  ← Process-global LRU, shared across all callers.
    │   Markdown text  RFC 9111 shared-cache policy applied — see §Shared page cache.
    │       │
    │       └──► [Reranker]  (TEI service at RERANK_TEI_URL, or local ONNX worker)
    │                │
    │                └── TEI: posts query + page chunks to RERANK_TEI_URL (operator-hosted)
    │
    ├─► download_file ──► Target URL ──► Local filesystem path (DOWNLOAD_DIR_ALLOWLIST)
    │
    └─► MCP response (Markdown + metadata) ──► Agent / LLM
```

---

## What leaves the cluster

### 1. Query text → paid search providers

| Provider | Trigger | Data sent | Endpoint | s72 basis |
|---|---|---|---|---|
| Brave Search API | `BRAVE_API_KEY` present | Query string, `country`, `language`, `freshness` | `api.search.brave.com` (US) | Contractual DPA — verify adequacy |
| Serper | `SERPER_API_KEY` present | Query string, `country`, `language` | `google.serper.dev` (US) | Contractual DPA — verify adequacy |
| DuckDuckGo | `SEARCH_ENABLE_DUCKDUCKGO=true` (default) | Query string (scraped HTML endpoint) | `duckduckgo.com` (US) | **No DPA — set `SEARCH_ENABLE_DUCKDUCKGO=false` if unresolved** |

### 2. Query text → SearXNG (in-cluster)

SearXNG runs in-cluster. The MCP server sends queries to `http://searxng:8080/search`.
This traffic does not leave the cluster. SearXNG then forwards query strings to its
configured upstream engines (Mojeek, Marginalia, Brave free, Wikipedia, etc.) over
the public internet.

With `SEARXNG_ENGINE_PROFILE=clean`, all upstream engines permit automated access.
With `SEARXNG_ENGINE_PROFILE=full`, upstream engines include Google and Bing, which
do not permit automated access — see `docs/enterprise/TERMS_OF_SERVICE.md`.

### 3. Page fetch requests → public internet

When `searchDepth=basic` or `searchDepth=advanced`, the server fetches each result URL.
The HTTP request is:

- From the cluster's egress IP
- To the result URL (public internet, HTTPS)
- With a standard browser `User-Agent` string
- With the Chromium render tier for JS-heavy pages

`fetch_url` and `fetch_urls` accept custom `headers` (e.g. `Authorization`, `Cookie`)
which are forwarded verbatim to the target URL. There is no config var to disable
caller-supplied headers — this is a policy-only restriction. See §Shared page cache
for how `Authorization`/`Cookie` headers affect caching.

### 4. Query + page content → reranker (TEI mode)

When `RERANK_BACKEND=tei`, the reranker **posts query text and page content** to the
TEI service at `RERANK_TEI_URL`. If that URL resolves outside the cluster, this is a
cross-border transfer of potentially personal information. The system does not validate
whether `RERANK_TEI_URL` is in-cluster; the operator must ensure it is.

### 5. Model weights — not transferred at runtime

When `RERANK_BACKEND=local`, both `from_pretrained` calls pass `allowRemoteModels: false`.
No model pull happens at runtime. The model must already be present in the container
image or a mounted volume. The shipped Dockerfile does not bake model weights —
`RERANK_BACKEND=local` requires a custom image build.

When `RERANK_BACKEND=none`, no reranker runs and no model traffic occurs.

### 6. SOCKS5 / HTTP proxy (when configured)

When `PROXY_PINS` or `SOCKS5_UPSTREAM_URL` is set, all HTTP traffic (via the undici
client) is routed through the proxy. When `SOCKS5_LISTEN_MODE=intercept`, the proxy
performs TLS interception — all fetched content (including page content and query
strings) is decrypted and processed by the proxy vendor. This makes the proxy vendor
an **operator processing decrypted content** (POPIA s20/s21 and s72). This obligation
must be assessed against Vodacom's vendor agreements.

Note: `SOCKS5_LISTEN_MODE=intercept` currently causes `process.exit(1)` at startup
and is not a deployable configuration.

---

## What stays in the cluster

| Data | Storage | Retention |
|---|---|---|
| Search result cache | Valkey or SQLite | `SEARCH_CACHE_TTL_MS` (default: 1 h). **Cache value holds plaintext query string.** |
| Crawl job spec | KV store (`job:{id}:spec`, unprefixed) + `crawl_jobs.spec` column | Swept by `CRAWL_RETENTION_MS` (default 7 days). |
| Crawl page content | `crawl_pages.content TEXT` (SQLite) / `mcp:job:{id}:pages` (Redis) | Swept by `CRAWL_RETENTION_MS`. `PRAGMA secure_delete = ON` on all SQLite connections. |
| Crawl job queue | `mcp:job:{id}:*` keys | Swept by `CRAWL_RETENTION_MS`. Two keyspaces purged: `mcp:job:{id}` (queue) and `job:{id}:spec` (KV store, separate keyspace). |
| Rate-limiter buckets | Valkey (300 s TTL) or in-process LRU | 300 s (Valkey); process lifetime (memory/sqlite) |
| Prometheus metrics | In-process (per replica) | Scraped by Prometheus; no local persistence. No URL, query, or personal-data labels. |
| Application logs | stdout → cluster log aggregator | Per cluster log policy. Query text hashed (HMAC-SHA-256, per-process random salt). URL query-parameter values replaced with `[redacted]`. Auth/cookie headers scrubbed. |

**Retention is unconditional.** It is deliberately not controlled by `POPIA_MODE` —
an env var that could disable sweeping would be a foot-gun destroying the POPIA
s105(4) "took all reasonable steps" defence. Evidence: `retention_last_sweep_timestamp_seconds`
gauge (Prometheus). Alert: `time() - retention_last_sweep_timestamp_seconds > 7200`.

**Storage note:** The `/tmp` volume mount is an `emptyDir` backed by **node-local disk**
(not `medium: Memory`). Crawl page bytes are at rest on the node's filesystem; at-rest
encryption depends on node disk encryption.

---

## Shared page cache

`urlCache` in `src/fetcher.ts` is a **process-global LRU cache** shared across all
callers in the pod. It caches fetched HTML keyed on the URL and the secondary cache
key derived from `Vary` response headers.

RFC 9111 shared-cache policy is applied (`src/http/cachePolicy.ts`):

| RFC 9111 clause | Behaviour |
|---|---|
| §3 — `no-store` | Not stored; counted in `cache_not_stored_total{reason=no_store}` |
| §3 — `private` | Not stored; `cache_not_stored_total{reason=private}` |
| §3.5 — `Authorization` request header | Not stored (absent `public`/`s-maxage`/`must-revalidate`) |
| Convention — `Cookie` request header | Not stored |
| Convention — `Set-Cookie` in response | Not stored |
| §4.1 — `Vary` | Secondary key includes named request-header values; `Vary: *` never reused |
| §4.2 — freshness | `min(origin max-age, CACHE_TTL_MS)` |
| §4.3 — conditional revalidation | Not implemented (freshness optimisation, not a confidentiality control) |

---

## Log content

Application logs are structured. The fields logged per request depend on `LOG_FORMAT`:

- `LOG_FORMAT=json` (recommended for production): structured JSON, `data` object present
- `LOG_FORMAT=text` (default): the `data` object is **dropped entirely** — only `level`,
  `timestamp`, and `message` are emitted

Fields that only appear in JSON format:

| Field | Content | Notes |
|---|---|---|
| `requestId` | UUID (generated per request) | Not linked to caller or data-subject identity |
| `callerHash` | 16-hex HMAC of `x-mcp-caller-id` header (null when absent) | Pseudonymous caller attribution — self-asserted, not authenticated; trustworthy only when gateway sets the header |
| `url` | Fetch target URL (query-parameter values replaced with `[redacted]`) | Only at DEBUG level for page fetches |

`LOG_REDACT_QUERIES=true` (default) hashes query text using HMAC-SHA-256 with a
per-process random salt (16 hex chars). Hashes are uncorrelatable across pod restarts
and replicas. Set `LOG_REDACT_SALT` to a fixed value to enable cross-replica
correlation (explicit opt-in).

---

## Data residency

All persistent storage (Valkey, SQLite) runs in-cluster in the same namespace
(`mcp-system`). No data is sent to a cloud storage service, a third-party analytics
endpoint, or any telemetry collector beyond the configured Prometheus scrape.

**Data that leaves the cluster (active providers only):**

- Query strings → Brave (`BRAVE_API_KEY` set), Serper (`SERPER_API_KEY` set)
- Query strings → DuckDuckGo (`SEARCH_ENABLE_DUCKDUCKGO=true`, default — set `false` if no DPA)
- Query strings → SearXNG upstream engines (in-cluster SearXNG; engines depend on profile)
- Page content → TEI reranker at `RERANK_TEI_URL` (if set to an external address)
- All HTTP traffic → SOCKS5/HTTP proxy (if `PROXY_PINS`/`SOCKS5_UPSTREAM_URL` set)

**Data-sovereignty note:** All external egress depends on operator configuration. A
configuration with all external providers disabled and no proxy configured sends no
query text outside the cluster. The default configuration sends query text to
DuckDuckGo (US). See `docs/enterprise/PRODUCTION_AUTHORISATION.md` for the
deployment-tier definitions.

---

## Known gaps

1. **Caller attribution ≠ data-subject identity:** Audit events carry `callerHash` —
   a pseudonymous identifier of the operator that invoked the tool. The data subject is
   the person *named inside a query or fetched page*. Caller attribution does not enable
   individual s22 notification or s23–25 rights. Single shared bearer token; `requestId`
   and `callerHash` are not linked to data-subject identity.

2. **Chromium egress partially mitigated:** `RENDER_MAX_TIER` (default `playwright`)
   caps the render ladder — set to `http` to prevent any browser launch. However, when
   Playwright is permitted, `page.goto` bypasses `validateUrl`, `dnsGuard`, and the rate
   limiter. In-browser subresource requests (XHR, fetch, scripts) are domain-unfiltered.

3. **Audit durability is at-most-once:** Audit events are written directly to `stderr`
   bypassing `LOG_LEVEL`/`LOG_FORMAT`. Durability depends on the cluster log pipeline —
   a pod OOMKill mid-buffer, log rotation before ship, or shipper backpressure can lose
   events.

4. **s72 is documented, not enforced:** Cross-border transfers still happen by default
   (DuckDuckGo). The assessment records the lawful basis per provider; the code does not
   prevent transfers that lack a basis.

5. **`POPIA_SCAN_CONTENT` removed; `POPIA_AUDIT_ENABLED` wired:** `POPIA_SCAN_CONTENT`
   was removed from the schema — scanning fetched page bodies creates a POPIA obligation
   rather than discharging one (the PII was already processed before the scan). 
   `POPIA_AUDIT_ENABLED` now gates the stderr write in `emitAudit()` (default `true`;
   metric counter increments regardless).

6. **`urlCache` is outside the retention sweep:** The process-global search result cache
   (`src/fetcher.ts`) is not swept by `CRAWL_RETENTION_MS`. It is bounded by
   `SEARCH_CACHE_TTL_MS` (default 1 h) and `CACHE_MAX_BYTES` via LRU eviction.
