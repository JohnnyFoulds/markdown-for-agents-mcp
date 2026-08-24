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
    ├─► Search fanout ──► [Brave API]    ─── HTTPS ───► api.search.brave.com (US)
    │                 ──► [Serper API]   ─── HTTPS ───► google.serper.dev (US)
    │                 ──► [SearXNG]      ─── HTTP ────► searxng.mcp-system (in-cluster)
    │                 ──► [DuckDuckGo]   ─── HTTPS ───► duckduckgo.com (US, no agreement)
    │                         │
    │                         └──────────────────────► [DDG / Mojeek / etc.] (engines.searxng.org)
    │
    ├─► Result cache  ──► [Valkey / SQLite]  (in-cluster; TTL-bounded for search results;
    │                                         crawl job records: see §Crawl job storage below)
    │
    ├─► Page fetcher  ──► [Chromium render / HTTP fetch]
    │       │                   │
    │       │                   └──► Target URL (public internet, HTTPS)
    │       ▼
    │   [urlCache]  ← Process-global LRU, shared across all callers.
    │   Markdown text  See §Shared page cache below.
    │       │
    │       └──► [Reranker]  (TEI service at RERANK_TEI_URL, or local ONNX worker)
    │                │
    │                └── TEI sends query + page chunks to RERANK_TEI_URL (operator-hosted)
    │
    ├─► download_file ──► Target URL ──► Local filesystem path (caller-supplied)
    │
    └─► MCP response (Markdown + metadata) ──► Agent / LLM
```

---

## What leaves the cluster

### 1. Query text → paid search providers

| Provider | Trigger | Data sent | Endpoint | s72 basis |
|---|---|---|---|---|
| Brave Search API | `BRAVE_API_KEY` present | Query string, `country`, `language`, `freshness` | `api.search.brave.com` (US) | Contractual DPA |
| Serper | `SERPER_API_KEY` present | Query string, `country`, `language` | `google.serper.dev` (US) | Contractual DPA |
| DuckDuckGo | Always active (no config gate) | Query string (scraped HTML endpoint) | `duckduckgo.com` (US) | **No agreement — gap, see §6** |

### 2. Query text → SearXNG (in-cluster)

SearXNG runs in-cluster. The MCP server sends queries to `http://searxng:8080/search`.
This traffic does not leave the cluster. SearXNG then forwards query strings to its
configured upstream engines (Mojeek, Marginalia, Brave free, Wikipedia, etc.) over
the public internet.

With `SEARXNG_ENGINE_PROFILE=clean`, all upstream engines permit automated access.
With `SEARXNG_ENGINE_PROFILE=full`, upstream engines include Google and Bing, which
do not permit automated access (see `docs/enterprise/TERMS_OF_SERVICE.md`).

### 3. Page fetch requests → public internet

When `searchDepth=basic` or `searchDepth=advanced`, the server fetches each result URL.
The HTTP request is:

- From the cluster's egress IP
- To the result URL (public internet, HTTPS)
- With a standard browser `User-Agent` string
- With the Chromium render tier for JS-heavy pages

`fetch_page` and `fetch_urls` accept custom `headers` (e.g. `Authorization`, `Cookie`)
which are forwarded to the target URL. See §Shared page cache for how this affects
caching.

### 4. Query + page content → reranker (TEI mode)

When `RERANK_BACKEND=tei`, the reranker **posts query text and page content** to the
TEI service at `RERANK_TEI_URL`. If that URL resolves outside the cluster, this is a
cross-border transfer of potentially personal information. The system does not validate
whether `RERANK_TEI_URL` is in-cluster; the operator must ensure it is.

### 5. Model weights → HuggingFace (local mode only, at startup)

When `RERANK_BACKEND=local`, the ONNX model is pulled from HuggingFace at process start.
Model weights are not personal information. No query text or page content is sent to
HuggingFace after the initial pull.

### 6. SOCKS5 / HTTP proxy (when configured)

When `PROXY_PINS` or `SOCKS5_UPSTREAM_URL` is set, all HTTP traffic is routed through
the proxy. When `SOCKS5_LISTEN_MODE=intercept`, the proxy performs TLS interception —
all fetched content (including page content and query strings) is decrypted and
processed by the proxy vendor. This makes the proxy vendor an **operator processing
decrypted content** (POPIA s20/s21 and s72). This is a separate undisclosed s72 transfer
obligation and must be assessed against Vodacom's vendor agreements.

---

## What stays in the cluster

| Data | Storage | Retention |
|---|---|---|
| Search result cache | Valkey or SQLite | `SEARCH_CACHE_TTL_MS` (default: 1 h). **Cache value holds plaintext `query`.** |
| Crawl job spec | KV store (`job:{id}:spec`, unprefixed) + `crawl_jobs.spec` column | **No EXPIRE set. Unbounded until manual deletion or retention sweep.** |
| Crawl page content | `crawl_pages.content TEXT` (SQLite) / `mcp:job:{id}:pages` (Redis) | **No TTL. Unbounded until manual deletion or retention sweep.** |
| Crawl job queue | `mcp:job:{id}:*` keys | No TTL on enqueue. |
| Rate-limiter buckets | Valkey (300 s TTL) or in-process LRU (no TTL, sqlite) | 300 s (Valkey); process lifetime (memory/sqlite) |
| Prometheus metrics | In-process (per replica) | Scraped by Prometheus; no local persistence |
| Application logs | stdout → cluster log aggregator | Per cluster log policy |

**Known gap — retention:** No automated pruning exists. Crawl job records and page
content accumulate indefinitely until a manual deletion or a future retention sweep is
implemented. This is a live POPIA s14 limitation.

---

## Shared page cache

`urlCache` in `src/fetcher.ts` is a **process-global LRU cache** shared across all
callers in the pod. It caches fetched HTML keyed on the URL only. From POPIA Phase 1
onward, the cache policy conforms to RFC 9111 shared-cache semantics: responses with
`no-store`, `private`, or `Set-Cookie` are never stored; requests with `Authorization`
or `Cookie` headers are not served from cache. Before Phase 1, **the cache ignores all
origin cache directives** and a credential-bearing request can be served to a subsequent
unauthenticated caller for the same URL.

---

## Log content

Application logs are structured. The fields logged per request depend on `LOG_FORMAT`:

- `LOG_FORMAT=json` (recommended for production): structured JSON, `data` object present
- `LOG_FORMAT=text` (default): the `data` object is **dropped entirely** — only `level`,
  `timestamp`, and `message` are emitted

Fields that only appear in JSON format:

| Field | Content | Notes |
|---|---|---|
| `requestId` | UUID (generated per request) | Not linked to user identity |
| `url` | Fetch target URL | Only for page fetches at DEBUG level |

`LOG_REDACT_QUERIES=true` (default) hashes query text when it is logged. The hash is
unsalted SHA-256 truncated to 8 hex chars — correlatable across replicas with the same
salt, and within 65k collisions within one process.

---

## Data residency

All persistent storage (Valkey, SQLite) runs in-cluster in the same namespace
(`mcp-system`). No data is sent to a cloud storage service, a third-party analytics
endpoint, or any telemetry collector beyond the configured Prometheus scrape.

**Data that leaves the cluster:**
- Query strings → Brave, Serper, DuckDuckGo (always), SearXNG upstream engines
- Page content → TEI reranker at `RERANK_TEI_URL` (if set to an external address)
- All HTTP traffic → SOCKS5/HTTP proxy (if `PROXY_PINS`/`SOCKS5_UPSTREAM_URL` set)
- Model weights ← HuggingFace (pull at startup, local mode only)

---

## Known gaps (to be addressed in POPIA remediation phases)

1. **Retention (POPIA s14):** No automated pruning. Crawl job records and page content
   accumulate indefinitely.
2. **DuckDuckGo (POPIA s72):** No contractual agreement covers query transfer to
   DuckDuckGo. `SEARCH_ENABLE_DUCKDUCKGO` gate not yet implemented.
3. **Page cache (POPIA s19):** Cache ignores origin `Cache-Control: private/no-store`
   directives. RFC 9111 conformance is planned for Phase 1.
4. **Query field (POPIA s10):** `JobSpec.query` and `JobSpec.relevanceThreshold` are
   accepted by `crawl_start`, persisted in two stores, and never read. These dead fields
   will be removed.
5. **No principal identity:** No mechanism exists to identify or notify an affected data
   subject (POPIA s22/s23–25). Single shared bearer token.
