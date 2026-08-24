# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Security hardening

### ⚠ Breaking change — HTTP mode now requires authentication

**`MCP_AUTH_TOKEN` is now required when running in HTTP mode.** If the token
is absent (unset or empty), the server exits at startup with an actionable
error message rather than serving requests unauthenticated.

**If you run without a token and want to keep that behaviour**, set
`MCP_AUTH_ALLOW_ANONYMOUS=true` to explicitly opt out. Anonymous access is
not recommended for internet-facing deployments.

**Migration**: set `MCP_AUTH_TOKEN` in your `.env`, Secrets Manager entry,
or compose/k8s environment before upgrading. The compose and k8s manifests
already thread `MCP_AUTH_TOKEN` through — you only need to supply the value.

---

## [Unreleased] — Phases 0–10 (Tavily Parity)

### Added — Phase 3: Zero-budget search reliability
- `src/search/providers/searxng.ts` — detect HTML/403/429 responses and throw `BotChallengeError` (was bare `SyntaxError`); add `language` and `time_range` (from `freshness`) params to outgoing SearXNG query
- `src/search/fanout.ts` — wire `CircuitBreaker` into every provider call; open breakers skip the provider and increment `search_degraded_total{reason:breaker_open}` instead of wasting every request on a failing upstream
- `src/services/webSearch.ts` — `KeyValueStore`-backed result cache keyed on `search:{SEARXNG_ENGINE_PROFILE}:{queryHash}`; `SEARCH_CACHE_TTL_MS` controls TTL (default 1 h); `search_cache_total{result}` metric tracks hit rate
- `src/obs/metrics.ts` — add `search_degraded_total{reason}` and `search_cache_total{result}` counters
- `deploy/k8s/components/searxng/` — Kustomize Component (Deployment + Service + ConfigMap) for SearXNG; `settings.yml` ships the `clean` engine profile (ToS-safe: Mojeek, Marginalia, Brave free, Wikipedia, Wikidata); `full` profile commented out with ToS warning
- `deploy/searxng/settings.yml` — same settings for docker-compose
- `docker-compose.yml` — `searxng` profile: `docker compose --profile searxng up`; `SEARXNG_URL` and `SEARXNG_ENGINE_PROFILE` threaded through server + worker
- `SEARXNG_ENGINE_PROFILE` (default `clean`) and `SEARCH_CACHE_TTL_MS` (default `3600000`) added to all four config locations

### Fixed — Phase 2: Activate search quality (was silently noop-ing)
- `src/tools/definitions.ts` — expose `searchDepth` (`fast`/`basic`/`advanced`) and `chunksPerSource` in the `web_search` input schema; update description from single-provider to multi-provider fan-out language
- `src/tools/webSearch.ts` — thread `searchDepth` and `chunksPerSource` through to the services layer (both were silently dropped)
- `src/services/webSearch.ts` — change default depth from `basic` to `fast`; fix `shouldFetch` logic so `fast` performs zero fetches, explicit `fetchResults: true/false` overrides depth
- `src/rank/rerankWorker.ts` — fix error field name: worker posted `{type:'error', message}` but parent read `msg.error`, surfacing every init failure as `Error(undefined)`
- `src/rank/transformersReranker.ts` — fail loudly when `RERANK_BACKEND=local` and the optional dep or model is absent; silent noop was indistinguishable from a working reranker
- `src/index.ts` — wire `getReranker().warmup()` in HTTP mode (non-blocking); `/readyz` gates on `rerankerGuard.isReady()` so k8s holds traffic until the 280 MB model finishes loading; stdio mode skips warmup

### Added — Phase 2: Config, locale, compliance
- `SEARCH_DEFAULT_COUNTRY` (default `za`) and `SEARCH_DEFAULT_LANGUAGE` (default `en`) — ZA locale default for Vodacom user population
- `LOG_REDACT_QUERIES` (default `true`) — hash query text in logs for POPIA compliance
- All three vars added to `src/config.ts`, `.env.example`, `deploy/k8s/base/configmap.yaml`, and `deploy/k8s/DEPLOYMENT.md`

### Added — Phase 10: SOCKS5 Gateway
- `src/proxy/socks5Server.ts` — RFC 1928/1929 SOCKS5 listener (`tunnel` and `intercept` modes)
- `src/proxy/policy.ts` — allow/deny policy enforcing existing domain blocklist + SSRF guard
- `SOCKS5_LISTEN_*` config vars; `SOCKS5_UPSTREAM_*` for upstream credential injection
- Solves Chromium SOCKS5 credential limitation (microsoft/playwright#10567) via loopback relay

### Added — Phase 9: Docs & Auth
- `.env.example` fully documents all ~80 config vars
- `CLAUDE.md` updated to reflect 13-tool surface and current architecture
- Bearer token comparison uses `crypto.timingSafeEqual` (timing-safe)
- Auth passthrough: `fetch_url` / `fetch_urls` / `extract_urls` accept custom `headers`

### Added — Phase 8: Stealth + Proxy Rotation
- `STEALTH_ENABLED` flag wires `playwright-extra` stealth plugin into Tier 3
- `PROXY_PINS` JSON array enables round-robin proxy rotation via `src/render/poolRegistry.ts`
- Per-proxy `BrowserPool` instances in `PoolRegistry` (Playwright proxy is launch-time)

### Added — Kubernetes manifests & deployment guide
- `deploy/k8s/base/` — Kustomize base: Namespace, ConfigMap, Deployments (server + worker), Service, HPA, PDB, NetworkPolicy
- `deploy/k8s/components/valkey/` — optional Kustomize component: Valkey (BSD-licensed Redis-compatible) for shared rate-limit store and crawl queue
- `deploy/k8s/overlays/docker-desktop/` — local development overlay: single replica, `imagePullPolicy: Never`, LoadBalancer service on port 3000
- `deploy/k8s/overlays/prod/` — production overlay: `imagePullPolicy: Always`, Ingress with cert-manager TLS, image registry placeholder
- `deploy/k8s/DEPLOYMENT.md` — complete deployment guide: architecture, config reference, secrets, Prometheus integration, HPA setup (prometheus-adapter), rolling updates, smoke test suite, teardown, Docker Desktop walkthrough with containerd image import
- `scripts/smoke-tests.mjs` — Docker Compose smoke tests (10 modes: stdio, HTTP/sqlite, memory, Lightpanda, Redis, auth, role=both, role=worker, readyz gate)
- `scripts/k8s-smoke-tests.mjs` — k8s smoke tests (13 suites, 67 assertions: inventory, probes, MCP protocol, tool call, auth, HPA, PDB, stateless, NetworkPolicy, self-healing)
- `package.json` scripts: `test:smoke` and `test:k8s`

### Added — Phase 7: Containerisation & Observability
- `Dockerfile` using `playwright:jammy` runtime stage + `node:22-bookworm-slim` build stage
- `docker-compose.yml` (server + worker + Redis) and `docker-compose.scale-test.yml` (scale proof)
- `scripts/scale-proof.mjs` — 20-assertion integration proof (stateless, shared queue, rate-limit, drain)
- `src/obs/metrics.ts` — prom-client registry with all named metric constants
- `/healthz`, `/readyz`, `/metrics` probe endpoints
- `src/server/lifecycle.ts` — ordered graceful drain (flip readyz → close HTTP → release leases → await in-flight → browser drain)
- `MCP_HTTP_MODE=stateless` — per-request McpServer+transport factory; N replicas behind a plain load balancer with no session affinity
- `SHUTDOWN_DRAIN_MS` / `SHUTDOWN_TIMEOUT_MS` config

### Added — Phase 6: Pluggable Stores + Async Crawl
- `src/store/types.ts` — `KeyValueStore`, `RateLimitStore`, `JobQueue` interfaces
- `src/store/memory/` — in-process implementations (default for stdio)
- `src/store/sqlite/` — `node:sqlite`-backed implementations (default for single-replica HTTP)
- `src/store/redis/` — `ioredis`-backed implementations with Lua-atomic `LEASE_SCRIPT` / `FAIL_SCRIPT`
- `src/store/factory.ts` — `initStores()` / `STORE_BACKEND=auto|memory|sqlite|redis`
- `src/crawl/engine.ts` — `crawlSync` (BFS), `startAsyncCrawl`, `runWorkerLoop`
- `crawl_start`, `crawl_status`, `crawl_results`, `crawl_cancel`, `crawl_list` MCP tools
- `MCP_ROLE=server|worker|both` — same binary, different role
- `src/store/__contract__/` — 44-test contract suite for all three backends (KV, RateLimit, JobQueue)
- Fixed `MemoryJobQueue.lease` to sort by depth (BFS order), matching SQLite/Redis behaviour
- Fixed rate-limit store wiring: removed `isHttpMode` guard so all roles use shared Redis bucket

### Added — Phase 5: Extract, Map, Formats, Selectors
- `extract_urls` MCP tool — fetch multiple URLs with CSS selectors, output format, pagination
- `map_site` MCP tool — discover all URLs via sitemap.xml or BFS link crawl
- `crawl_site` MCP tool — synchronous bounded BFS crawl
- `src/extract/pipeline.ts` — `outputFormat: markdown|html|text|screenshot`, pagination (`offset`/`limit`/`totalLength`/`truncated`)
- `src/extract/selector.ts` — CSS selector extraction (tag, `#id`, `.class`, `tag.class`, `tag#id`)

### Added — Phase 4: Chunking + Reranking
- `src/rank/chunker.ts` — ATX-heading-aware chunker, 400-token chunks, 64-token overlap, heading-path prefix
- `src/rank/transformersReranker.ts` — `@huggingface/transformers` ONNX backend (`dtype: q8`, `device: cpu`)
- `src/rank/rerankWorker.ts` — worker-thread isolation to keep event loop free during inference
- `src/rank/teiReranker.ts` — TEI HTTP endpoint backend (optional, GPU-capable)
- `RERANK_BACKEND=none|local|tei` config; `web_search` `searchDepth` parameter

### Added — Phase 3: Search Provider Abstraction
- `src/search/providers/` — Brave, Serper, SearXNG, DuckDuckGo adapters
- `src/search/fanout.ts` — multi-provider fan-out with RRF merge, URL canonicalisation, dedup
- `src/search/breaker.ts` — shared circuit breaker (stored in `KeyValueStore` so replicas share state)
- Fixed silent-failure bug: `AllProvidersFailedError` now propagates as `isError: true`
- Fixed bot-challenge detection: `BotChallengeError` triggers fan-out fallback rather than empty result
- Fixed missing `title` arg in `convertWithMetadata` (results headed `# <url>` instead of `# <title>`)

### Added — Phase 2: 3-Tier Render Ladder
- `src/render/ladder.ts` — escalation ladder with tier-memo in `KeyValueStore`
- `src/render/heuristic.ts` — pure signal-scoring escalation heuristic (fixture-tested)
- `src/render/tiers/httpTier.ts` — Tier 1: plain HTTP via undici
- `src/render/tiers/lightpandaTier.ts` — Tier 2: CDP to Lightpanda sidecar (`LIGHTPANDA_ENABLED`)
- `src/render/tiers/playwrightTier.ts` — Tier 3: Chromium via BrowserPool
- `src/render/browserPool.ts` — warm pool, per-context isolation, recycle on crash/max-jobs/max-age
- Fixed `waitUntil: "networkidle"` → `"domcontentloaded"` + bounded settle race to prevent infinite hangs
- Fixed shared-context cookie leak (new context per request)

### Added — Phase 1: Unified HTTP Layer
- `src/http/client.ts` — `UndiciHttpClient` with retry, robots, rate-limit, DNS guard
- `src/http/retry.ts` — exponential backoff with full jitter, `Retry-After` honour
- `src/http/rateLimiter.ts` — per-host token bucket wired to `RateLimitStore`
- `src/http/robots.ts` — `robots-parser` integration, cached in `KeyValueStore`
- `src/http/dnsGuard.ts` — resolves all DNS addresses, pins via undici `connect.lookup`
- `src/http/encoding.ts` — `Content-Type` charset → BOM → `<meta charset>` detection
- `src/http/fingerprint.ts` — single source of UA strings (replaces three scattered constants)
- `src/http/proxy.ts` — `resolveProxy` / `resolveProxyList` / `PROXY_PINS` rotation

### Added — Phase 0: Prerequisite Refactors
- `src/server/registry.ts` — tool registration loop with metrics, timeout AbortSignal, error mapping
- `src/tools/definitions.ts` — all tool definitions with required `outputSchema` + `toText`
- `src/extract/pipeline.ts` — host-side extraction pipeline (replaces hardcoded `page.evaluate` pruning)
- `src/utils/domainBlacklist.ts` — exports `isPrivateIp()` for DNS guard
- Config-driven cache construction (was hardcoded `50MB`/`15min`, ignoring `CACHE_*` env vars)
- Fixed HTML-level truncation (was cutting mid-tag); truncation now post-conversion at paragraph boundary

---

## [1.0.1] - 2026-04-06

### Fixed
- `scripts/install-playwright.js` added to `files` array — postinstall hook was silently failing for all npm users because the file was excluded from the published package
- `repository.url` changed from SSH (`git@github.com:...`) to HTTPS so npm renders the repository link correctly on the package page

### Added
- `homepage`, `bugs`, and `author` fields in `package.json`
- Expanded `keywords`: `web-scraping`, `fetch`, `spa`, `chromium`, `llm`, `mcp-server`, `javascript-rendering`
- Improved `description` — explicitly mentions React/Vue/Angular, Playwright/Chromium, and token efficiency

---

## [1.0.0] - 2026-04-06

### Added
- **Structured output** — `fetch_url`, `fetch_urls`, and `web_search` now return typed `structuredContent` alongside the text response (fields: `url`, `title`, `markdown`, `fetchedAt`, `contentSize`), compatible with MCP SDK 1.11+
- **HTTP server mode** — `--http [port]` flag or `HTTP_PORT` env var starts a Streamable HTTP transport server at `/mcp`; optional bearer token auth via `MCP_AUTH_TOKEN`
- **Proxy support** — `PLAYWRIGHT_PROXY` and `PLAYWRIGHT_PROXY_BYPASS` env vars route Playwright traffic through a proxy
- **Page title extraction** — `document.title` is extracted during rendering and used as the markdown heading (`# Title\n\nSource: url`) instead of the raw URL
- **Tool annotations** — all tools declare `readOnlyHint`, `idempotentHint`, and `destructiveHint` for MCP-aware clients
- `src/tools/types.ts` — shared `FetchUrlResult`, `FetchUrlsResult`, `WebSearchResult` interfaces

### Changed
- Migrated `index.ts` from `Server` + `setRequestHandler` to `McpServer` + `registerTool` (MCP SDK high-level API)
- Updated `@modelcontextprotocol/sdk` pin from `^1.0.0` to `^1.29.0`
- All tool functions now return typed result objects instead of raw markdown strings
- `converter.convertWithMetadata` gains optional `title` parameter

---

## [0.4.0] - 2026-04-06

### Changed
- Upgraded `typescript` from 5.x to 6.0
- Upgraded `eslint` from 9.x to 10.x
- Upgraded `@types/node` from 20.x to 25.x
- Upgraded `markdown-for-agents` from 1.0.0 to 1.3.4 (Node 22 support, bug fixes)

### Fixed
- TypeScript 6.0 compatibility: added `"types": ["node"]` to `tsconfig.json`
- TypeScript 6.0 compatibility: replaced removed `Global` type with plain interface in `config.ts`

---

## [0.3.0] - 2026-04-06

### Added
- `download_file` MCP tool — downloads binary files (PDFs, images, ZIPs, etc.) from a URL to a local path
- CLI `--download` / `-d` and `--output` / `-o` flags for downloading files
- `MAX_DOWNLOAD_BYTES` config option (default 50 MB) — separate limit from HTML truncation
- Mocked Playwright tests covering timeout, redirect, cache, and domain-blocking paths

### Fixed
- SSRF protection: block decimal-encoded IPs (e.g. `2130706433` = 127.0.0.1), IPv6 ULA (`fc00::/7`), and IPv6 unspecified (`::`)
- ReDoS protection: user-supplied `BLOCKLIST_URL_PATTERNS` now validated before compilation
- `download_file`: filename now derived from final URL after redirects (not the original)
- `download_file`: off-by-one in redirect loop
- `download_file`: uses `MAX_DOWNLOAD_BYTES` instead of `MAX_CONTENT_LENGTH`
- `outputPath` validated as absolute path before use
- `parseInt` missing radix in CLI argument parser
- `navigator.plugins` mock corrected to empty array
- Removed dead `validateConfig()` function from `config.ts`
- CI: pinned `codecov/codecov-action` to commit SHA; added `downloadFile.js` to build verification

### Changed
- Test coverage improved from 79% to 92%+

---

## [0.2.0] - 2026-04-06

### Added
- Centralized configuration module with Zod validation
- Structured logging with configurable log levels (DEBUG, INFO, WARN, ERROR)
- JSON log format support
- Request correlation IDs for tracing
- Graceful shutdown with signal handlers (SIGTERM, SIGINT)
- Health check tool for monitoring server status
- LRU cache with TTL and configurable size limits
- Domain blocking and URL pattern filtering
- Configurable redirect handling with loop detection
- Web search tool via DuckDuckGo with optional fetch-to-markdown
- CI/CD pipeline with Node.js matrix testing and npm publish workflow

### Changed
- Replaced hardcoded constants with centralized configuration
- Improved error messages and error handling
- Better initialization order safety with fallback config values

### Security
- Input validation using Zod schemas
- Domain allowlist/blocklist modes
- URL validation before fetching
- Redirect validation (same-origin only)

---

## [0.1.0] - 2026-04-04

### Added
- Initial release
- MCP server with `fetch_url` and `fetch_urls` tools
- JavaScript rendering with Playwright
- HTML to markdown conversion optimized for AI agents
- Content extraction that removes navigation, ads, and boilerplate
- Concurrent fetch limiting
- Content truncation for large pages
- Cache hit/miss logging
- Fetch duration metrics
