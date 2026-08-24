# markdown-for-agents-mcp

[![npm version](https://img.shields.io/npm/v/markdown-for-agents-mcp)](https://www.npmjs.com/package/markdown-for-agents-mcp)
[![npm downloads](https://img.shields.io/npm/dm/markdown-for-agents-mcp)](https://www.npmjs.com/package/markdown-for-agents-mcp)
[![Node.js](https://img.shields.io/node/v/markdown-for-agents-mcp)](https://nodejs.org)
[![codecov](https://codecov.io/gh/JohnnyFoulds/markdown-for-agents-mcp/branch/main/graph/badge.svg?token=cc1e1265-2c75-413a-95ea-3f07c9e81c62)](https://codecov.io/gh/JohnnyFoulds/markdown-for-agents-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that fetches URLs, searches the web, and crawls sites — converting everything to clean, token-efficient markdown for AI agents.

Powered by a **3-tier render ladder** (plain HTTP → [Lightpanda](https://github.com/lightpanda-io/browser) → [Playwright](https://playwright.dev)/Chromium) and the [`markdown-for-agents`](https://www.npmjs.com/package/markdown-for-agents) library. Most pages are served from the fast HTTP tier with no browser launched. Chromium fires only when JavaScript rendering is genuinely required. Strips ads, navigation, and boilerplate — delivering up to 80% fewer tokens than raw HTML.

---

## 3-Tier Render Ladder

Most pages are served from the fast HTTP tier. Chromium fires only when JavaScript rendering is genuinely required.

| Tier | Technology | When used | Memory |
| --- | --- | --- | --- |
| 1 — HTTP | `undici` plain HTTP | Static HTML, most news/docs sites | 1–10 MB |
| 2 — Lightpanda | CDP to Lightpanda sidecar | Light JS rendering (`LIGHTPANDA_ENABLED`) | ~123 MB |
| 3 — Playwright | Chromium via browser pool | React/Vue/Angular SPAs, bot-challenged pages | 300–500 MB |

The escalation heuristic scores signals (empty body, SPA hydration markers, `<noscript>` warnings, text-to-HTML ratio) and escalates only when the score exceeds the threshold. Tier decisions are memoised in the store to avoid re-probing the same site repeatedly.

**Token reduction example:** a typical news article page is ~150 KB of raw HTML (~40,000 tokens). After extraction and markdown conversion the same article becomes ~2,000 tokens — a 95% reduction.

---

## Table of Contents

- [3-Tier Render Ladder](#3-tier-render-ladder)
- [Features](#features)
- [Installation](#installation)
- [MCP Client Setup](#mcp-client-setup)
- [Available Tools](#available-tools)
  - [fetch_url](#fetch_url)
  - [fetch_urls](#fetch_urls)
  - [web_search](#web_search)
  - [extract_urls](#extract_urls)
  - [map_site](#map_site)
  - [download_file](#download_file)
  - [health_check](#health_check)
  - [Crawl Tools](#crawl-tools)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
- [Search Providers](#search-providers)
- [Reranking](#reranking)
- [Async Crawl Jobs](#async-crawl-jobs)
- [Deployment](#deployment)
- [Security](#security)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

---

## Features

- **3-Tier Render Ladder** — plain HTTP → Lightpanda CDP → Playwright/Chromium. Most pages served without a browser launch.
- **Async Site Crawl** — `crawl_start`/`crawl_status`/`crawl_results`/`crawl_cancel`/`crawl_list` for long-running jobs; workers and servers scale independently
- **Structured Output** — Tools return typed `structuredContent` alongside the text response, compatible with MCP SDK 1.11+
- **Smart Content Extraction** — CSS selector targeting, multiple output formats (`markdown`/`html`/`text`/`screenshot`), and pagination
- **Token Efficiency** — Up to 80% fewer tokens than raw HTML
- **Multi-Provider Web Search** — DuckDuckGo (zero-config), Brave, Serper, SearXNG with automatic fan-out, RRF merge, and bot-challenge fallback
- **Cross-Encoder Reranking** — Local ONNX (`bge-reranker-base`) or TEI endpoint ranks search results by actual content, not SERP position
- **Pluggable Stores** — memory (stdio), SQLite (single-server HTTP), or Redis (N-replica) for rate-limit buckets, job queue, and content cache
- **Per-Host Rate Limiting** — shared Redis token bucket enforces aggregate RPS across all replicas
- **robots.txt Compliance** — respects crawl rules, `Crawl-delay`, and sitemaps
- **SSRF Protection** — RFC1918, loopback, IPv6 ULA/link-local blocked; DNS-rebinding guard pins resolved addresses
- **Proxy Support** — HTTP/SOCKS5 proxy, round-robin `PROXY_PINS` rotation; stealth mode via `playwright-extra`
- **HTTP Server Mode** — stateless Streamable HTTP transport; N replicas behind any load balancer; bearer token auth
- **SOCKS5 Gateway** — optional ingress listener for AI Studio or SOCKS5-aware clients; upstream credential injection for Chromium
- **Prometheus Metrics** — `/healthz`, `/readyz`, `/metrics` endpoints; named metric constants for HPA and alerting
- **Zero Configuration** — `npx markdown-for-agents-mcp` with no env vars works out of the box; Chromium installed automatically

---

## Installation

```bash
npm install -g markdown-for-agents-mcp
```

Chromium is downloaded automatically via the `postinstall` script. If that fails, see [Troubleshooting](#troubleshooting).

You can also run without installing globally using `npx`:

```bash
npx markdown-for-agents-mcp
```

---

## MCP Client Setup

Add the server to your MCP client configuration.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp"
    }
  }
}
```

### VS Code (Copilot / Continue)

Add to your workspace or user `settings.json` under the relevant MCP extension key, for example:

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp"
    }
  }
}
```

### Cursor / Windsurf / Zed

Any client that implements the [MCP specification](https://modelcontextprotocol.io/specification) can use this server. The command entry point is `markdown-mcp` (available on `PATH` after global install) or the full path to `dist/index.js` for local builds.

### With environment variable overrides

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp",
      "env": {
        "FETCH_TIMEOUT_MS": "60000",
        "LOG_LEVEL": "DEBUG"
      }
    }
  }
}
```

### HTTP server mode

Instead of stdio, you can run the server as a standard HTTP endpoint — useful for shared deployments, Docker, or any client that prefers the Streamable HTTP transport:

```bash
# Start on port 3456
markdown-mcp --http 3456

# Or use the env var
HTTP_PORT=3456 markdown-mcp
```

All MCP traffic is handled at `POST|GET|DELETE /mcp`. To require a bearer token, set `MCP_AUTH_TOKEN`:

```bash
MCP_AUTH_TOKEN=mysecrettoken HTTP_PORT=3456 markdown-mcp
```

Clients must then pass `Authorization: Bearer mysecrettoken` with every request.

---

## Available Tools

### `fetch_url`

Fetches a single URL with full JavaScript rendering and returns clean markdown.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | yes | URL to fetch and convert |
| `timeout` | number | no | Request timeout in ms (overrides `FETCH_TIMEOUT_MS`) |

**Example:**

```
fetch_url(url="https://example.com/blog/post")
```

**Text output** (always present, backward-compatible):

```markdown
# Blog Post Title

Source: https://example.com/blog/post

This is the main content of the article, stripped of navigation, ads, and boilerplate.

## Related Section

More content here...

---
*Converted by markdown-for-agents-mcp*
```

**Structured output** (available to MCP SDK 1.11+ clients via `structuredContent`):

```json
{
  "url": "https://example.com/blog/post",
  "title": "Blog Post Title",
  "markdown": "# Blog Post Title\n\nSource: ...",
  "fetchedAt": "2026-04-06T17:00:00.000Z",
  "contentSize": 2048
}
```

---

### `fetch_urls`

Fetches multiple URLs concurrently and returns combined markdown, one section per URL.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urls` | string[] | yes | URLs to fetch |
| `timeout` | number | no | Per-request timeout in ms |

**Example:**

```
fetch_urls(urls=[
  "https://example.com/post1",
  "https://example.com/post2"
])
```

**Text output:**

```markdown
# Post 1 Title

Source: https://example.com/post1

...

---

# Post 2 Title

Source: https://example.com/post2

...

---
```

**Structured output** (via `structuredContent`):

```json
{
  "results": [
    {
      "url": "https://example.com/post1",
      "title": "Post 1 Title",
      "markdown": "...",
      "fetchedAt": "2026-04-06T17:00:00.000Z",
      "contentSize": 1820,
      "success": true
    },
    {
      "url": "https://example.com/post2",
      "title": "Post 2 Title",
      "markdown": "...",
      "fetchedAt": "2026-04-06T17:00:00.000Z",
      "contentSize": 2104,
      "success": true
    }
  ],
  "summary": { "total": 2, "succeeded": 2, "failed": 0 }
}
```

Parallelism is controlled by `MAX_CONCURRENT_FETCHES` (default: 5).

---

### `web_search`

Searches DuckDuckGo and optionally fetches top results as markdown. Uses a plain HTTP endpoint to avoid bot detection — no Playwright for the search itself.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query |
| `maxResults` | number | no | Max results to return (default: 10) |
| `allowedDomains` | string[] | no | Only include results from these domains |
| `blockedDomains` | string[] | no | Exclude results from these domains |
| `fetchResults` | boolean | no | Fetch and convert top result pages to markdown |
| `timeout` | number | no | Request timeout in ms |

**Example — search only:**

```
web_search(
  query="typescript tutorials",
  maxResults=5,
  allowedDomains=["typescriptlang.org", "github.com"]
)
```

**Example — search and fetch:**

```
web_search(
  query="react hooks guide",
  fetchResults=true,
  maxResults=3
)
```

**Text output:**

```markdown
# Web Search Results

## Query: typescript tutorials
**Found 5 results in 1234ms**

### Results:

1. [TypeScript Handbook](https://www.typescriptlang.org/docs/)
   The TypeScript Handbook provides comprehensive documentation...

2. [Best TypeScript Tutorials](https://github.com/danistefanovic/build-your-own-typescript)
   Learn TypeScript by building your own compiler...
```

**Structured output** (via `structuredContent`):

```json
{
  "query": "typescript tutorials",
  "results": [
    { "title": "TypeScript Handbook", "url": "https://www.typescriptlang.org/docs/", "snippet": "...", "domain": "typescriptlang.org" }
  ],
  "fetchedContent": [
    { "url": "https://www.typescriptlang.org/docs/", "markdown": "..." }
  ],
  "durationMs": 1234
}
```

> **Note:** `allowedDomains` and `blockedDomains` arguments apply to search result filtering only. Server-level `BLOCKLIST_DOMAINS` / `USE_ALLOWLIST_MODE` settings still apply when those results are subsequently fetched.

---

### `download_file`

Downloads a binary file (PDF, image, ZIP, etc.) from a URL and saves it to a local path. Uses a plain HTTP client — no Playwright required. SSRF protection and domain block list are enforced.

**Arguments:**

| Name         | Type   | Required | Description                                                              |
|--------------|--------|----------|--------------------------------------------------------------------------|
| `url`        | string | yes      | URL of the file to download                                              |
| `outputPath` | string | yes      | Absolute local path to save the file to (parent directory must exist)    |

**Example:**

```text
download_file(
  url="https://example.com/report.pdf",
  outputPath="/tmp/report.pdf"
)
```

**Output:**

```json
{
  "savedPath": "/tmp/report.pdf",
  "sizeBytes": 204800,
  "mimeType": "application/pdf",
  "filename": "report.pdf"
}
```

> **Note:** URLs with paths like `/download/...` are permitted for this tool even though they are blocked by `fetch_url` (to avoid binary download chains). Use `fetch_url` for HTML pages — `download_file` will reject `text/html` responses.

---

### `health_check`

Returns current server status, cache metrics, and fetch statistics. Useful for monitoring and debugging.

**Arguments:** none

**Example output:**

```json
{
  "status": "healthy",
  "cache": {
    "hits": 47,
    "misses": 15,
    "currentSize": 12,
    "totalBytes": 4194304,
    "maxBytes": 52428800
  },
  "metrics": {
    "totalFetches": 62,
    "successCount": 59,
    "errorCount": 3,
    "avgDuration": 1840,
    "cacheUtilization": 76
  }
}
```

---

### `extract_urls`

Fetches multiple URLs with optional CSS selector targeting, output format control, and pagination.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urls` | string[] | yes | URLs to fetch |
| `includeSelector` | string | no | CSS selector to extract (e.g. `main`, `.article`, `#content`) |
| `excludeSelectors` | string[] | no | CSS selectors to remove |
| `outputFormat` | string | no | `markdown` (default), `html`, `text`, `screenshot` |
| `offset` | number | no | Character offset for pagination |
| `limit` | number | no | Max characters per result |
| `headers` | object | no | Custom headers (auth/cookie passthrough) |

---

### `map_site`

Discovers all URLs on a site via `sitemap.xml` or BFS link crawl.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | yes | Root URL of the site |
| `maxUrls` | number | no | Maximum URLs to return |
| `includePattern` | string | no | Regex to include only matching URLs |
| `excludePattern` | string | no | Regex to exclude matching URLs |

---

### Crawl Tools

Five tools for async site crawls. Crawl jobs are persistent — start a crawl, check its status later, retrieve paginated results.

#### `crawl_start`

```
crawl_start(url="https://docs.example.com", maxPages=200, maxDepth=3)
```

Returns: `"Crawl started. Job ID: <uuid>\nStatus: running"`

#### `crawl_status`

```
crawl_status(jobId="<uuid>")
```

Returns job status, page counts (total/completed/failed/pending).

#### `crawl_results`

```
crawl_results(jobId="<uuid>", offset=0, limit=50, filter="completed")
```

Returns paginated `PageRecord` array with `url`, `markdown`, `status`, `crawledAt`, `depth`.

#### `crawl_cancel`

```
crawl_cancel(jobId="<uuid>")
```

Cancels a running crawl; leased items are abandoned and marked failed.

#### `crawl_list`

```
crawl_list()
```

Returns all jobs (running, completed, cancelled), sorted newest-first.

---

## CLI Usage

A standalone CLI (`markdown-cli`) is included for use outside the MCP protocol.

### Single URL

```bash
markdown-cli https://example.com
```

### Multiple URLs (batch mode)

```bash
markdown-cli -b https://example.com https://example.org https://example.net
```

### Save to file

```bash
markdown-cli https://example.com/article > article.md
```

### Download a binary file

```bash
markdown-cli -d -o /tmp/report.pdf https://example.com/report.pdf
```

### Command reference

| Command | Description |
|---------|-------------|
| `markdown-cli <url>` | Fetch a single URL and print markdown |
| `markdown-cli -b <url1> <url2> ...` | Fetch multiple URLs in batch mode |
| `markdown-cli -d -o <path> <url>` | Download a binary file to a local path |
| `markdown-cli --help` | Show help |

---

## Configuration

All settings are read from environment variables at startup and validated with Zod. Invalid values cause a non-zero exit with a descriptive error.

Copy `.env.example` to `.env` to get started:

```bash
cp .env.example .env
```

The full reference is in `.env.example`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_TIMEOUT_MS` | `30000` | Timeout per fetch request (ms) |
| `MAX_CONCURRENT_FETCHES` | `5` | Max parallel fetches in batch operations |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, or `ERROR` |
| `LOG_FORMAT` | `text` | `text` or `json` |
| `CACHE_MAX_BYTES` | `52428800` | Max LRU cache size (50 MB) |
| `CACHE_TTL_MS` | `900000` | Cache entry TTL (15 minutes) |
| `USE_ALLOWLIST_MODE` | `false` | When `true`, only listed domains are allowed |
| `BLOCKLIST_DOMAINS` | _(empty)_ | Comma-separated domains to block |
| `HTTP_PORT` | _(unset)_ | Start HTTP server on this port |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token for HTTP mode |
| `MCP_HTTP_MODE` | `stateless` | `stateless` (N-replica safe) or `session` |
| `STORE_BACKEND` | `auto` | `auto` \| `memory` \| `sqlite` \| `redis` |
| `STORE_REDIS_URL` | _(unset)_ | Redis URL when `STORE_BACKEND=redis` |
| `RATE_LIMIT_PER_HOST_RPS` | `0` | Max requests/sec per host (0 = unlimited) |
| `RESPECT_ROBOTS_TXT` | `false` | Honour robots.txt crawl rules |
| `HTTP_PROXY_URL` | _(unset)_ | Outbound proxy for all tiers |
| `PROXY_PINS` | _(unset)_ | JSON array of proxy URLs for round-robin rotation |
| `SEARCH_FANOUT_RESULTS` | `20` | Max URLs returned from search fan-out |
| `SEARCH_DEFAULT_COUNTRY` | `za` | Default country code for results (ISO 3166-1 alpha-2) |
| `SEARCH_DEFAULT_LANGUAGE` | `en` | Default language code for results (BCP 47) |
| `LOG_REDACT_QUERIES` | `true` | Hash query text in logs (POPIA compliance) |
| `RERANK_BACKEND` | `none` | `none` \| `local` \| `tei` |
| `MCP_ROLE` | `server` | `server` \| `worker` \| `both` |
| `SHUTDOWN_DRAIN_MS` | `5000` | Grace period before closing HTTP |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing |
| `CRAWL_RETENTION_MS` | `604800000` | Job + page retention window in ms (7 days). Unconditional — POPIA s14. |
| `RETENTION_SWEEP_INTERVAL_MS` | `3600000` | Retention sweep interval in ms (1 hour). |

All logs are written to `stderr` to keep `stdout` clean for the MCP protocol.

---

## Search Providers

`web_search` supports multiple backends with automatic fan-out and fallback:

| Provider | Tier | Config | Notes |
|----------|------|--------|-------|
| Brave Search API | 1 | `BRAVE_API_KEY` | Licensed index, $5/1k; best for fresh/current results |
| Serper | 1 | `SERPER_API_KEY` | Real Google SERP; highest quality |
| SearXNG | 2 | `SEARXNG_URL` | Self-hosted; dev/cheap tier |
| DuckDuckGo | 3 | none | Zero-config fallback; last resort in HTTP mode |

When multiple providers are configured, they are queried in parallel with results merged using Reciprocal Rank Fusion. A startup warning is logged when DuckDuckGo is the only configured provider in HTTP mode.

---

## Reranking

Set `RERANK_BACKEND=local` to rank search results by actual content relevance rather than SERP position. The local backend runs `bge-reranker-base` (ONNX, q8, CPU) in a worker thread to keep the event loop free.

The `web_search` tool exposes three depth modes via the `searchDepth` parameter:

| `searchDepth` | Behaviour | Typical latency |
|---|---|---|
| `fast` (default) | Snippet-only — zero page fetches | ~500 ms |
| `basic` | Fetch and render each result page | ~3–5 s |
| `advanced` | Fetch pages + rerank chunks by cross-encoder relevance | ~10–15 s |

Use `chunksPerSource` (default 1, `advanced` only) to control how many ranked content chunks are returned per source page.

```bash
RERANK_BACKEND=local web_search(query="...", searchDepth="advanced", maxResults=10, chunksPerSource=3)
```

When `RERANK_BACKEND=local` the server holds `/readyz` until the model finishes loading (the 300 s k8s startup probe covers this). If the model is absent at startup the process fails loudly instead of silently falling back to SERP order.

For GPU-accelerated reranking, point `RERANK_TEI_URL` at a TEI endpoint and set `RERANK_BACKEND=tei`.

---

## Async Crawl Jobs

Crawl jobs run in the background. Workers and servers are the same binary (`MCP_ROLE`), so they scale independently:

```bash
# Start the server
HTTP_PORT=3000 MCP_ROLE=server node dist/index.js

# Start workers (one or more, same binary)
MCP_ROLE=worker STORE_REDIS_URL=redis://localhost:6379 node dist/index.js
```

Workers claim jobs from the shared queue, crawl pages, and re-enqueue discovered links. If a worker dies mid-crawl, its leased items are reclaimed after `CRAWL_QUEUE_LEASE_MS` and picked up by another worker.

---

## Deployment

### Docker Compose

```bash
# Single-server with Redis
docker compose up

# Multi-replica scale test (3 servers, 2 workers)
docker compose -f docker-compose.scale-test.yml up --scale mcp-server=3 --scale mcp-worker=2
```

### Kubernetes

Two Deployments of the same image — `mcp-server` and `mcp-worker` — behind a single Service. HPA scales the server on `mcp_inflight_requests` and workers on `crawl_queue_depth`.

- Manifests: `deploy/k8s/` (Kustomize base + optional Valkey component)
- Overlays: `overlays/docker-desktop/` (local dev) and `overlays/prod/` (production)
- Full deployment guide: [`deploy/k8s/DEPLOYMENT.md`](deploy/k8s/DEPLOYMENT.md)

```bash
# Docker Desktop (local dev)
kubectl apply -k deploy/k8s/overlays/docker-desktop

# Production
kubectl apply -k deploy/k8s/overlays/prod

# Run k8s smoke tests (67 assertions against a live deployment)
npm run test:k8s
```

### AWS ECS Fargate

Two ECS Services of one task-definition family. The server runs behind an ALB with `MCP_HTTP_MODE=stateless`. Workers run without a load balancer. Key Fargate-specific settings:

```json
"linuxParameters": {
  "initProcessEnabled": true,
  "tmpfs": [{ "containerPath": "/dev/shm", "size": 1024 }]
}
```

See `deploy/ecs/` and `TAVILY_PARITY_PLAN.md` for full deployment details.

---

## Security

### Default domain blocklist

The following domains are blocked by default to prevent accidental fetches of trackers, ad networks, and social platforms that aggressively block bots or serve low-quality content:

`doubleclick.net`, `facebook.com`, `twitter.com`, `tiktok.com`, `hotjar.com`, `mixpanel.com`, `bit.ly`, and approximately 20 others (see `src/utils/domainBlacklist.ts` for the full list).

> If you need to fetch a blocked domain, add it to `BLOCKLIST_DOMAINS` with `USE_ALLOWLIST_MODE=false` — this **adds** to the block list and does not remove existing entries. To allow a default-blocked domain you will need to fork and modify `domainBlacklist.ts`.

### URL path blocking

Certain URL path patterns are blocked regardless of domain (e.g. OAuth callbacks, binary file downloads, payment/checkout paths, admin panels). These protect against accidental fetches of sensitive or non-content URLs.

### Allowlist mode

Set `USE_ALLOWLIST_MODE=true` and `BLOCKLIST_DOMAINS=yourdomain.com,trusted.org` to restrict the server to only fetching from explicitly listed domains. Recommended for production deployments.

### Redirect policy

Cross-origin redirects are blocked. The server only follows same-origin redirect chains (up to `MAX_REDIRECTS` hops).

For the full security model and reporting vulnerabilities, see [SECURITY.md](SECURITY.md).

---

## Architecture

```
MCP Layer (src/server/registry.ts)   ← 13 tools, timeout + metrics wrapper
  ↓
Render Ladder (src/render/ladder.ts)
  ├── Tier 1: HttpTier         ← plain HTTP via undici (most requests)
  ├── Tier 2: LightpandaTier   ← CDP to Lightpanda sidecar (opt-in)
  └── Tier 3: PlaywrightTier   ← Chromium via BrowserPool

Extract pipeline (src/extract/pipeline.ts)
  └── selectors, formats, pagination

Search fan-out  (src/search/)
  ├── providers: brave | serper | searxng | duckduckgo
  └── RRF merge → dedup → filter

Reranker (src/rank/)
  └── none | local ONNX worker thread | TEI endpoint

Crawl engine (src/crawl/engine.ts)
  └── BFS sync + async job queue + worker loop

Store layer (src/store/)
  └── memory | sqlite | redis (KV, RateLimit, JobQueue)

Observability (src/obs/metrics.ts)
  └── prom-client, /healthz /readyz /metrics
```

### Key components

| Component | Directory/File | Responsibility |
|-----------|---------------|----------------|
| Entry point | `src/index.ts` | Bootstrap: HTTP/stdio/worker, lifecycle drain |
| Tool registry | `src/server/registry.ts` | Metrics, timeout AbortSignal, error mapping |
| Tool definitions | `src/tools/definitions.ts` | All 13 tools with `outputSchema` + `toText` |
| Render ladder | `src/render/ladder.ts` | Tier selection + tier-memo |
| Escalation heuristic | `src/render/heuristic.ts` | Pure signal scoring (fixture-tested) |
| Browser pool | `src/render/browserPool.ts` | Warm Chromium instances, per-context isolation |
| HTTP client | `src/http/client.ts` | Retry, rate-limit, robots, DNS guard |
| Extract pipeline | `src/extract/pipeline.ts` | Format, selectors, pagination |
| Search fan-out | `src/search/fanout.ts` | Multi-provider parallel query + RRF |
| Reranker | `src/rank/` | ONNX worker thread or TEI |
| Crawl engine | `src/crawl/engine.ts` | BFS + async job worker |
| Store layer | `src/store/` | Pluggable KV, rate-limit, job queue |
| Config | `src/config.ts` | Zod-validated env var schema |
| Domain filter | `src/utils/domainBlacklist.ts` | Block/allowlist + `isPrivateIp` |

---

## Development

### Prerequisites

- Node.js >= 22.0.0 (required for `node:sqlite` built-in)
- npm

### Setup

```bash
git clone https://github.com/JohnnyFoulds/markdown-for-agents-mcp.git
cd markdown-for-agents-mcp
npm install        # also installs Chromium via postinstall
```

### Scripts

```bash
npm run build      # Compile TypeScript → dist/
npm run dev        # Watch mode
npm run typecheck  # Type-check without emitting
npm test           # Run Vitest suite
```

### Running locally

```bash
npm run build
node dist/index.js
```

### Debug logging

```bash
LOG_LEVEL=DEBUG node dist/index.js
LOG_LEVEL=DEBUG LOG_FORMAT=json node dist/index.js
```

---

## Troubleshooting

### Playwright fails to install Chromium

```bash
npx playwright install chromium
```

On Linux, also install OS-level dependencies:

```bash
npx playwright install-deps chromium
```

### MCP connection issues

Capture server logs:

```bash
markdown-mcp 2>&1 | tee mcp.log
```

### Domain blocked errors

By default, tracker, ad-network, and social media domains are blocked. Check `src/utils/domainBlacklist.ts` to see the full list. To add a domain to the blocklist (not remove from the default list), set `BLOCKLIST_DOMAINS=yourdomain.com`.

### Build errors

```bash
rm -rf node_modules dist
npm install
npm run build
```

---

## Roadmap

See [TAVILY_PARITY_PLAN.md](TAVILY_PARITY_PLAN.md) for the full implementation roadmap toward Tavily parity and enterprise scale — covering the 10-phase plan, 3-tier render ladder, reranking pipeline, pluggable-store scale design, ECS Fargate deployment, and SOCKS5 gateway.

See [FUTURE_WORK.md](FUTURE_WORK.md) for the gap catalogue and competitive analysis against Tavily and Firecrawl.

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines. The short version:

1. Branch from `development`
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): subject`)
3. Add or update tests — aim for >90% coverage
4. Open a pull request against `development`

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

---

## License

[MIT](LICENSE)
