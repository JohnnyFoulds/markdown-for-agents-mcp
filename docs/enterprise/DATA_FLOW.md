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
    ├─► Search fanout ──► [Brave API]    ─── HTTPS ───► api.search.brave.com
    │                 ──► [Serper API]   ─── HTTPS ───► google.serper.dev
    │                 ──► [SearXNG]      ─── HTTP ────► searxng.mcp-system (in-cluster)
    │                         │
    │                         └──────────────────────► [DDG / Mojeek / etc.] (engines.searxng.org)
    │
    ├─► Result cache  ──► [Valkey / SQLite]  (in-cluster, TTL-bounded)
    │
    ├─► Page fetcher  ──► [Chromium render / HTTP fetch]
    │       │                   │
    │       │                   └──► Target URL (public internet, HTTPS)
    │       ▼
    │   Markdown text
    │       │
    │       └──► [Reranker worker thread]  (in-process, no network)
    │
    └─► MCP response (Markdown + metadata) ──► Agent / LLM
```

---

## What leaves the cluster

### 1. Query text → paid search providers

| Provider | Trigger | Data sent | Endpoint |
|---|---|---|---|
| Brave Search API | `BRAVE_API_KEY` present | Query string, `country`, `language`, `freshness` | `api.search.brave.com` |
| Serper | `SERPER_API_KEY` present | Query string, `country`, `language` | `google.serper.dev` |

The query string is the only piece of potentially personal information sent to paid
providers. Both providers have contractual data processing agreements and are licensed
for API use.

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

No query text is included in these fetch requests. The fetch is a standard HTTP GET.

### 4. Domain metrics → in-process LRU cache

The `browser_recycles_total` and `fetch_requests_total` metrics include a `domain` label
in some configurations. The domain LRU is bounded to prevent cardinality explosion
(`src/utils/domainBlacklist.ts`). Hostname metrics are never sent to external systems.

---

## What stays in the cluster

| Data | Storage | TTL / retention |
|---|---|---|
| Search result cache | Valkey (or SQLite) | `SEARCH_CACHE_TTL_MS` (default: 1 h) |
| Crawl job queue | Valkey `crawl:queue:*` keys | Until processed; TTL set on enqueue |
| Rate-limiter buckets | In-process LRU (per replica) | Process lifetime |
| Prometheus metrics | In-process (per replica) | Scraped by Prometheus; no local persistence |
| Application logs | stdout → cluster log aggregator | Per cluster log policy |

---

## What is never stored

- **Query text**: queries are used to build the search request and then discarded.
  They are not written to any persistent store. The result cache key is a SHA-256 hash
  of the query (first 16 hex chars) — the original query string is not recoverable from
  the cache key.
- **Full page content**: fetched Markdown is held in memory for the duration of the
  tool call, returned to the agent, and then garbage-collected. It is never written to
  disk or a database.
- **User identity**: there is no user identity in the system. The MCP auth token
  authenticates the caller (an AI agent) as a single shared identity; individual
  agent requests are not distinguished.
- **API keys in logs**: `LOG_REDACT_QUERIES=true` (default) also prevents query text
  from appearing in DEBUG logs. API keys are injected as environment variables and are
  never logged.

---

## Data residency

All persistent storage (Valkey, SQLite) runs in-cluster in the same namespace
(`mcp-system`). No data is sent to a cloud storage service, a third-party analytics
endpoint, or any telemetry collector beyond the configured Prometheus scrape.

With `SEARXNG_ENGINE_PROFILE=clean` and no paid API keys, **the only data that leaves
the cluster is the query string and the page fetch requests**. Query strings go to
SearXNG's upstream engines; page fetch requests are standard HTTP GETs to public URLs.

---

## Log content

Application logs are JSON-structured. The fields logged per request:

| Field | Content | Notes |
|---|---|---|
| `level` | INFO / WARN / ERROR | |
| `requestId` | UUID (generated per request) | Not linked to user identity |
| `tool` | Tool name | e.g. `web_search` |
| `durationMs` | Elapsed time | |
| `query` | Hashed/truncated query | Only at DEBUG; `LOG_REDACT_QUERIES=true` |
| `provider` | Search provider name | |
| `url` | Fetch target URL | Only for page fetches |

Query text never appears at INFO level or above. At DEBUG level it is hashed when
`LOG_REDACT_QUERIES=true`.
