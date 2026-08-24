# CLAUDE.md

This file provides guidance to Claude Code when working with the `markdown-for-agents-mcp` codebase.

## Purpose

An MCP server that fetches URLs with a 3-tier render ladder (plain HTTP → Lightpanda → Playwright/Chromium), converts pages to clean markdown for AI agents, provides web search with optional reranking, and supports async site crawls via a pluggable job queue.

## Architecture

```
MCP Layer (src/server/registry.ts + src/tools/definitions.ts)
  ↓
Render Ladder (src/render/ladder.ts)
  ├── Tier 1: HttpTier      — plain HTTP via undici
  ├── Tier 2: LightpandaTier — CDP to Lightpanda sidecar (LIGHTPANDA_ENABLED)
  └── Tier 3: PlaywrightTier — Chromium via BrowserPool + PoolRegistry (proxy rotation)

Extract pipeline (src/extract/pipeline.ts) — CSS selectors, output formats, pagination
Search fan-out  (src/services/webSearch.ts → src/search/ providers)
Reranker        (src/rank/) — local ONNX worker thread or TEI endpoint
Crawl engine    (src/crawl/engine.ts) — sync BFS + async job queue
Store layer     (src/store/) — memory | sqlite | redis backends
Observability   (src/obs/metrics.ts) — prom-client registry, /healthz /readyz /metrics
```

## File Structure

```
src/
├── index.ts              Entry point: HTTP/stdio/worker bootstrap, lifecycle drain
├── config.ts             Zod-validated env vars (all documented in .env.example)
├── fetcher.ts            URL fetcher — delegates to renderLadder.render()
├── converter.ts          HTML → markdown (markdown-for-agents)
├── server/
│   ├── registry.ts       Tool registration loop: metrics, timeout, error mapping
│   └── lifecycle.ts      Ordered graceful drain (Phase 7)
├── tools/
│   ├── definitions.ts    All 14 tool definitions (name, inputSchema, outputSchema, handler, toText)
│   ├── fetchUrl.ts       fetch_url service
│   ├── fetchUrls.ts      fetch_urls service
│   └── types.ts          Shared tool output types
├── render/
│   ├── ladder.ts         3-tier render ladder with tier-memo
│   ├── heuristic.ts      Escalation signal scoring (pure, fixture-tested)
│   ├── browserPool.ts    BrowserPool — stealth launcher, per-proxy pool
│   ├── poolRegistry.ts   Per-proxy pool map for round-robin rotation
│   └── tiers/            httpTier, lightpandaTier, playwrightTier
├── extract/
│   ├── pipeline.ts       HTML → format pipeline (markdown/html/text, selectors, pagination)
│   └── selector.ts       CSS selector extraction (tag, #id, .class, tag.class, tag#id)
├── http/
│   ├── client.ts         UndiciHttpClient (retry, robots, rate-limit, DNS guard)
│   ├── rateLimiter.ts    Token-bucket per host; wires to RateLimitStore in HTTP mode
│   ├── proxy.ts          resolveProxy / resolveProxyList / PROXY_PINS rotation
│   └── …                 retry, robots, encoding, fingerprint, redirect, dnsGuard
├── search/
│   └── providers/        brave, serper, searxng, duckduckgo
├── rank/
│   ├── index.ts          getReranker() — noop | local ONNX | TEI
│   ├── chunker.ts        Markdown chunker (400-token, heading-path prefix)
│   └── …                 noopReranker, teiReranker, transformersReranker, rerankWorker
├── crawl/
│   └── engine.ts         crawlSync (BFS), startAsyncCrawl, runWorkerLoop
├── store/
│   ├── types.ts          KeyValueStore, RateLimitStore, JobQueue interfaces
│   ├── factory.ts        initStores() / getStores() / closeStores()
│   └── memory/ sqlite/ redis/   backends
├── obs/
│   └── metrics.ts        prom-client registry with all named metric constants
└── utils/
    ├── cache.ts
    ├── domainBlacklist.ts
    ├── errors.ts
    └── logger.ts
```

## MCP Tools (14 total)

| Tool | Description |
|---|---|
| `fetch_url` | Fetch a URL → markdown. Supports `headers` for auth/cookie passthrough. |
| `fetch_urls` | Batch fetch → markdown per URL. Supports `headers`. |
| `web_search` | DuckDuckGo/Brave/Serper/SearXNG search → optional page fetch + rerank. |
| `health_check` | Server status, cache stats, fetch metrics. |
| `download_file` | Download a binary file to disk (stream, byte-capped). |
| `extract_urls` | Fetch multiple URLs → extract with CSS selectors, format, pagination. |
| `map_site` | Discover all URLs on a site (sitemap.xml or BFS link crawl). |
| `crawl_site` | Synchronous bounded BFS crawl (returns when complete). |
| `crawl_start` | Start an async crawl job → returns jobId. |
| `crawl_status` | Get job status (pending/running/completed/cancelled). |
| `crawl_results` | Paginated crawled page results. |
| `crawl_cancel` | Cancel a running crawl job. |
| `crawl_list` | List all crawl jobs. |

## Prerequisites

- **Node.js >= 22.0.0** (required for `node:sqlite` built-in)
- npm

## Development

```bash
npm install
npm run build          # tsc
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run dev            # watch mode
```

## Running

```bash
# stdio (default — zero config)
npx markdown-for-agents-mcp

# HTTP server
npx markdown-for-agents-mcp --http 3000

# Worker only (crawl jobs)
npx markdown-for-agents-mcp --role=worker

# Docker
docker compose up
```

## Coding Standards

- Strict TypeScript; no implicit `any` in new code
- No JSDoc on obvious signatures; comments only for non-obvious WHY
- No AI co-authorship lines in commits
- Conventional Commits with a body bullet per logical change
- All new tools must have `outputSchema` and `toText` — enforced by `registry.test.ts` invariant

## Testing

```bash
npm test                          # all unit tests (415+ as of Phase 9)
RUN_BROWSER_TESTS=1 npm test      # include real-browser tests
REDIS_URL=redis://localhost:6379 npm test  # include Redis store contract
```

Tests are in `*.test.ts` beside source files, and `__contract__/` for store backends.
Live / network tests are in `*.live.test.ts` and skipped without credentials.

## Probe endpoints (HTTP mode)

| Path | Auth | Purpose |
|---|---|---|
| `/healthz` | None | Process-level liveness |
| `/readyz` | None | Pool warm + stores reachable (gates readiness) |
| `/metrics` | Bearer (or `METRICS_BIND_PORT`) | Prometheus text format |
| `/mcp` | Bearer (`MCP_AUTH_TOKEN`) | MCP Streamable HTTP transport |

## Branch Strategy

- `main` — production releases
- `development` — active development (all phases merged here)
