# Evolving `markdown-for-agents-mcp` into a self-hosted Tavily equivalent

> **Document roles** — `FUTURE_WORK.md` is the **gap catalogue and competitive analysis**:
> what is missing and why it matters. This document is the **execution plan**: phases,
> interfaces, file layouts, effort estimates, and verification. Update `FUTURE_WORK.md`
> when the competitive landscape changes; update this document when implementation
> decisions change. Do not let them drift apart.

## Context

**Why.** Tavily's value is not its crawler — it is a pipeline: fan out to a SERP, fetch
~20 pages concurrently, extract clean text, then **rank chunks against the query with a
cross-encoder** and return only the best. `markdown-for-agents-mcp` today has a good
extraction story (`markdown-for-agents`, MCP tools, structured output schemas, full data
locality) but is missing steps 1, 2, and 4, and it cannot run at enterprise scale because
several pieces of state are process-local by construction.

**Locked decisions:**

| Decision | Choice |
| --- | --- |
| Architecture | **Evolve in place, monolith.** One npm package, one image, N replicas behind the existing Streamable HTTP transport. |
| Ranking | **Cross-encoder reranker only.** No `answer` field, no LLM dependency in the tool. |
| Search backend | **Pluggable: paid primary (Brave/Serper) + SearXNG dev tier + existing DuckDuckGo scraping as last resort**, with multi-provider fan-out and URL dedup. |
| JS rendering | **3-tier escalation ladder:** plain HTTP → Lightpanda over CDP → Playwright + stealth. |

**Answer to "is Playwright the only option?"** No, and it should not be the default path.
Measured costs:

| Path | Memory | Latency |
| --- | --- | --- |
| Plain HTTP client | 1–10 MB | 100–500 ms |
| Lightpanda (933 URLs, 25 procs, m5.xlarge) | **123 MB peak** | **4.81 s** |
| Chrome, same benchmark | **2.0 GB peak** | **46.70 s** |
| Chrome, per concurrent rendering instance | 300–500 MB | 1–5 s/page |

Most pages need no browser at all. Taking the common case off Chromium is the
single highest-leverage change in this plan.

**Two independent milestones:** *Tavily-comparable result quality* (Phases 0–4) and
*enterprise scale* (Phases 6–7). Either can ship first.

---

## What this supersedes in `FUTURE_WORK.md`

| FUTURE_WORK claim | Status | Why |
| --- | --- | --- |
| L282, L328–450: async crawl via **tmux + SQLite** | **Superseded** | tmux needs a TTY, is single-machine, dies with the pod, and cannot be scheduled. Replaced by a `JobQueue` abstraction + a `--role=worker` process of the same binary. The `markdown-mcp crawl` CLI verbs are kept, re-pointed at `JobQueue`. |
| L440: "multiple workers against one SQLite DB on NFS" | **Wrong, removed** | SQLite advisory locking over NFS/CIFS is unreliable and silently corrupts. |
| L568: "distributed crawl needs a proper job queue" — listed as a ceiling | **Now the plan** | |
| Moat 4 "Enterprise infra not addressable, document ceiling" | **Reversed** | Phase 7 addresses it. |
| L66 table row `Enterprise-scale infra: ❌` | Changed to 🔲 | |
| "Zero external SaaS dependency" | **Qualified** → "zero *required* SaaS dependency" | Paid SERP and TEI are opt-in. |
| Priority row 13, LLM-assisted schema extraction | **Dropped** | Conflicts with the locked no-LLM decision. |
| FW #1 (anti-bot/stealth), previously P1 | **Demoted to Phase 8** | Only applies to Tier 3, which most requests will never reach. |
| Moat 1 (CAPTCHA solving) | **Preserved as out of scope** | ToS/CFAA exposure. Unchanged. |

---

## Phasing

| Phase | Theme | Effort |
| --- | --- | --- |
| **0** | Prerequisite refactors: tool registry, parameterised extraction, config-driven cache, `isPrivateIp` export | 3–5 d |
| **1** | Unified HTTP layer: retry/backoff, rate limit, robots, proxy, encoding, DNS guard | 5–8 d |
| **2** | 3-tier render ladder + browser pool | 8–12 d |
| **3** | Search provider abstraction + fan-out + fix silent failure | 5–7 d |
| **4** | Chunking + reranking, `searchDepth`, `chunksPerSource` | 6–10 d |
| **5** | `extract_urls` / `map_site`, output formats, CSS selectors, pagination | 4–6 d |
| **6** | Pluggable stores + queue-driven crawl (sync + async) | 10–15 d |
| **7** | Containerisation, k8s, ECS Fargate, OTel/Prometheus, stateless HTTP, draining | 6–10 d |
| **8** | Stealth Layer 1 + proxy rotation (Tier 3 only) | 5–8 d |
| **9** | Docs truth-up, `.env.example` fix, auth/cookie passthrough | 2–3 d |
| **10** | SOCKS5 gateway: optional ingress listener + upstream chaining (AI Studio) | 4–6 d |

**≈58–90 dev-days.** Hard dependency edges: `0→1→2`, `1→3`, `3→4`, `0→5`, `1→6`,
`6→7`, `2→8`, `1→10`.

**Build Phase 10's listener early if the upstream proxy requires authentication** — it is
the only way to get Tier 3 (Chromium) through an authenticated SOCKS proxy, so it becomes
a Phase 2 blocker in that case rather than a late addition.

Do not attempt the quality and scale milestones concurrently with one engineer.

---

## Tavily surface mapping

| Tavily endpoint | MCP tool | Phase |
| --- | --- | --- |
| `POST /search` | `web_search` (evolved in place) | 3 + 4 |
| `POST /extract` | `extract_urls` (`fetch_urls` kept as thin alias) | 5 |
| `POST /map` | `map_site` | 5 |
| `POST /crawl` | `crawl_site` (sync) + `crawl_start`/`_status`/`_results`/`_cancel`/`_list` (async) | 6 |
| `GET /usage` | `health_check` extended + Prometheus `/metrics` (not billing) | 7 |
| `POST /research` | **not built** — agentic multi-hop is the calling agent's loop | — |
| `answer` field | **not built** — locked decision | — |

Retained unchanged: `fetch_url`, `download_file`, `health_check`.

Documented non-goals: answer synthesis, credit metering, CAPTCHA solving,
LLM-assisted extraction, `/research`.

---

## Phase 0 — Prerequisite refactors

### 0.1 Tool registry (unblocks every new tool)

[src/index.ts](src/index.ts) is 356 lines at **0% coverage**, ~40 lines of inline
`registerTool` + inline Zod schema per tool. Phases 2–6 add 8–10 tools. `health_check`
and `download_file` have no `outputSchema` at all.

New: `src/server/{registry,toolDefinition,errorMapper,lifecycle}.ts`,
`src/server/transports/{http,stdio}.ts`, `src/tools/definitions.ts`,
`src/tools/schemas/*.ts`.

```ts
export interface ToolDefinition<In extends ZodRawShape, Out extends ZodRawShape> {
  name: string; description: string;
  inputSchema: In; outputSchema: Out;   // REQUIRED — no longer optional
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<In>>, ctx: ToolContext) => Promise<z.infer<z.ZodObject<Out>>>;
  toText: (result: z.infer<z.ZodObject<Out>>) => string;
}
export interface ToolContext {
  requestId: string; signal: AbortSignal; logger: typeof Logger;
  deps: AppDeps; // { httpClient, ladder, searchFanout, reranker, stores, converter }
}
```

`registry.ts` wraps every handler in request-ID generation, metrics, in-flight counting,
a timeout `AbortSignal`, and the shared `errorMapper`. `index.ts` shrinks to ~60 lines.
`ToolContext.deps` is the DI seam that finally makes it testable. Add a `registry.test.ts`
invariant test (every definition has description + `outputSchema` + `toText`) so the
missing-schema gap cannot recur.

### 0.2 Parameterise extraction (unblocks Phase 5 and the ladder)

DOM pruning is hardcoded **inside `page.evaluate`** at
[src/fetcher.ts:282-304](src/fetcher.ts#L282-L304). This blocks CSS-selector targeting
(FW #6), output formats (FW #9), and the ladder itself — **Tier 1 has no DOM**, so
extraction cannot live in browser-side JS.

`page.evaluate` reduces to `{ html: document.documentElement.outerHTML, title: document.title }`.
All extraction moves host-side into `src/extract/pipeline.ts` as a pure
`extract(html, opts): ExtractResult` — identical for all three tiers, fixture-testable
with no browser.

**Reuse what's already installed.** [src/converter.ts](src/converter.ts) uses 3 of ~15
`markdown-for-agents` options. Verified in `node_modules/markdown-for-agents/dist/types-*.d.mts`:

- `extract: { stripTags, stripClasses, stripRoles, stripIds, keepHeader, keepFooter, keepNav }` →
  **replaces the entire hardcoded removal list, no new dependency**
- `baseUrl` → resolves relative links. Currently unused, so every relative link in output
  markdown is broken today. Live quality bug.
- `frontmatter` → YAML metadata for `extract_urls`; `deduplicate` → boilerplate removal for crawls
- `tokenCounter` / `ConvertResult.tokenEstimate` → free token counts for the Phase 4
  chunker, **no tokeniser dependency**
- `ConvertResult.contentHash` → free crawl dedup key for identical pages under different URLs

For arbitrary CSS selectors beyond tag/class/id, add `linkedom` (light; not jsdom).

Also: truncation happens on **HTML** at [src/fetcher.ts:320-323](src/fetcher.ts#L320-L323),
which can cut mid-tag and corrupt the markdown. Move it post-conversion, on markdown, at
a paragraph boundary, returning `totalLength` + `truncated` — this is also FW #11
(pagination) for free.

### 0.3 Cache honours config

[src/fetcher.ts:20-29](src/fetcher.ts#L20-L29) hardcodes `50MB`/`15min`;
[src/config.ts:24-25](src/config.ts#L24-L25) validates `CACHE_MAX_BYTES`/`CACHE_TTL_MS`
that **nothing ever reads**. Construct the caches lazily from `getConfig()` behind a
`getCaches()` accessor, keeping the current exports as getters so `fetcher.test.ts`'s
`urlCache.clear()` calls keep working. Add the test that would have caught it.

### 0.4 DNS-rebinding SSRF gap

[src/utils/domainBlacklist.ts](src/utils/domainBlacklist.ts) is thorough (RFC1918,
loopback, 169.254 metadata, IPv6 ULA/link-local, decimal/octal/hex forms) but **lexical
on the hostname string only**. `evil.example.com` → `169.254.169.254` passes, then
Chromium fetches instance metadata. Phase 0 exports `isPrivateIp(ip)` from the existing
logic; Phase 1 wires it into the HTTP client; Phase 2 adds the Chromium pre-flight +
post-check.

---

## Phase 1 — Unified HTTP layer

```
src/http/{client,types,retry,rateLimiter,robots,encoding,proxy,redirect,dnsGuard,fingerprint,testing}.ts
```

New dep **`undici`** — chosen over bare `fetch` for `ProxyAgent`, per-origin connection
caps + keep-alive, a pluggable `connect.lookup` for the DNS guard, and `MockAgent` for
wire-level tests with no network.

```ts
export interface HttpRequest {
  url: string; method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number;
  skipRateLimit?: boolean; skipRobots?: boolean;
  maxRedirects?: number; allowCrossHostRedirect?: boolean; // SERP redirect wrappers
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  purpose: "page" | "search" | "download" | "robots" | "api";
  requestId?: string;
}
export interface HttpResponse {
  url: string; status: number; headers: Record<string, string>; body: Buffer;
  text(): string; charset: string; redirectChain: string[];
  attempts: number; durationMs: number; serverAddress?: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  stream(req: HttpRequest, sink: WritableStream<Uint8Array>, maxBytes: number): Promise<HttpResponse>;
  close(): Promise<void>;
}
```

- **Retry** (`retry.ts`, pure): retryable on `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/
  `ECONNREFUSED` and `408, 425, 429, 500, 502, 503, 504`; never on other 4xx,
  `DomainBlockedError`, `RobotsDeniedError`, SSRF rejections. Exponential backoff with
  **full jitter**, honouring `Retry-After` (seconds and HTTP-date).
- **Rate limit** (`rateLimiter.ts`): per-registrable-domain token bucket over Phase 6's
  `RateLimitStore`, so it becomes **global across replicas**. Exceeding
  `RATE_LIMIT_MAX_WAIT_MS` throws `RateLimitTimeoutError`, never a silent stall.
- **robots.txt**: new dep `robots-parser` (zero-dep; wildcards, `$`, longest-match,
  `Crawl-delay`, `Sitemap:`). Cached in `KeyValueStore`. 4xx → allow; 5xx/timeout →
  `ROBOTS_ON_ERROR` (default allow). `RESPECT_ROBOTS_TXT=false` default. `Crawl-delay`
  feeds the rate limiter.
- **Proxy**: `resolveProxy(url, {domain})` is the single source of truth for *all* paths.
  `HTTP_PROXY_URL` is canonical; `PLAYWRIGHT_PROXY` kept as a deprecated alias. Note:
  Playwright proxy is launch-time, so rotation needs per-proxy browser pools — a Phase 8
  cost.
- **Encoding**: `Content-Type charset` → BOM → `<meta charset>` in first 2 KB →
  `HTTP_DEFAULT_CHARSET`, decoded with built-in `TextDecoder`. Fixes the blind
  `data.toString('utf8')` at [src/services/webSearch.ts:233](src/services/webSearch.ts#L233).
- **DNS guard**: `dns.lookup(host, {all:true})`, run every address through `isPrivateIp`,
  then pin via a custom `lookup` in undici's `Agent.connect` to close the TOCTOU window.
- **Fingerprint**: `fingerprint.ts` is the one place UA strings live, killing today's
  three-UAs-in-three-files problem.

**Caller migration** (separate commits, each preserving its DI seam):

- [src/services/webSearch.ts](src/services/webSearch.ts): delete hand-rolled `fetchHtml`
  (L172–245); `fetchHtmlImpl` seam becomes an injected `HttpClient`.
- [src/services/downloadFile.ts](src/services/downloadFile.ts): delete `httpGet`
  (L24–58) + manual redirect loop → `httpClient.stream(..., maxBytes)`. **This fixes a
  live OOM bug** — the body is currently buffered in full before being compared against
  `MAX_DOWNLOAD_BYTES` (L129). `_httpGet` seam becomes `_httpClient`.
- [src/fetcher.ts](src/fetcher.ts): redirect handling (L240–280) delegates to
  `redirect.ts`.

---

## Phase 2 — The 3-tier render ladder

```
src/render/{ladder,heuristic,browserPool,cdpClient,types}.ts
src/render/tiers/{httpTier,lightpandaTier,playwrightTier}.ts
src/render/__fixtures__/*.html
```

```ts
export type RenderTier = "http" | "lightpanda" | "playwright";

export interface RenderRequest {
  url: string; timeoutMs: number;
  minTier?: RenderTier; // extractDepth 'advanced' → floor at 'lightpanda'
  maxTier?: RenderTier; // extractDepth 'basic'    → ceiling at 'http'
  blockResources?: ResourceType[]; includeSelector?: string; excludeSelectors?: string[];
  screenshot?: boolean; requestId?: string;
}

export interface RenderResult {
  url: string; html: string; title: string; status: number; tier: RenderTier;
  escalations: Array<{ from: RenderTier; to: RenderTier; reason: string }>;
  screenshotPng?: Buffer; durationMs: number;
}

export interface RenderTierImpl {
  readonly tier: RenderTier;
  isAvailable(): Promise<boolean>;
  render(req: RenderRequest): Promise<RenderResult>;
  warmup?(): Promise<void>;
  drain?(): Promise<void>;
}
```

### Escalation heuristic (`heuristic.ts`) — pure, synchronous, fixture-tested

Weights live in one exported const so they are reviewable and tunable without code changes.

| Signal | Detection | Weight |
| --- | --- | --- |
| Bot/challenge markers | `cf-mitigated` header, `__cf_chl`, `"Just a moment..."`, `_Incapsula_`, `datadome`, status 403/429/503 | **jump straight to `playwright`** — Lightpanda has no stealth |
| Near-empty body | visible text < `RENDER_MIN_TEXT_CHARS` (400) | 0.35 |
| Text-to-HTML ratio | `visibleTextLen / htmlLen` < 0.05 | 0.25 |
| SPA hydration payload | `__NEXT_DATA__`, `window.__NUXT__`, `__remixContext`, `__INITIAL_STATE__`, `ng-version` | 0.20 |
| Empty root mount | `#root`/`#app`/`#__next`/`[data-reactroot]` with no element children | 0.25 |
| Script-heavy | `<script src>` ≥ 8 and body text < 1500 chars | 0.10 |
| `<noscript>` tells you | contains "enable JavaScript" / "requires JavaScript" | 0.20 |
| Negative | ≥ 3 `<p>` totalling > 1500 chars, or `<article>` > 1000 chars | **−0.5** |
| Negative | content-type not `text/html` | **never escalate** |

`escalate = score ≥ RENDER_ESCALATE_THRESHOLD` (0.45).

**Amortising the wasted Tier-1 fetch.** Memoise the verdict in `KeyValueStore` keyed
`tier:<host>:<pathShape>`, where `pathShape` replaces numeric/hex segments with `:id`.
On a memo hit, start at the memoised tier. Decay memos occasionally
(`RENDER_TIER_MEMO_DECAY_PROB=0.05`) so sites that get simpler stop paying for a browser
forever. Emit `fetch_escalations_total{from,to,reason}` so hit rate is observable.

### Tier 1 — `httpTier.ts`

Plain `HttpClient.request({purpose:'page'})`. Browser-plausible headers from
`fingerprint.ts`. Returns raw HTML for the heuristic. **This is the highest-leverage
change in the plan.** It takes the common case off Chromium entirely.

### Tier 2 — `lightpandaTier.ts`

Lightpanda (`github.com/lightpanda-io/browser`): Zig, V8 for JS + its own DOM, libcurl
HTTP, html5ever parsing, **no graphical rendering engine**. 34k stars, v0.3.7
(2026-08-16), actively developed.

**Integration is cheap because it speaks CDP.** Run
`lightpanda serve --host 127.0.0.1 --port 9222`, then
`await chromium.connectOverCDP(LIGHTPANDA_CDP_URL)` — the existing
`newContext`/`newPage`/`goto`/`evaluate`/`close` code is reused verbatim. `cdpClient.ts`
holds shared connect/reconnect/health logic for Tiers 2 and 3.

**Fallback is mandatory, not optional.** Lightpanda is v0.3.x pre-1.0 with **partial/WIP
Web API support**; expect real failure rates on complex SPAs.

- Any throw, CDP disconnect, timeout, or a result that still trips `needsJsRendering` →
  escalate to Tier 3, `reason: 'lightpanda_insufficient'`.
- **Circuit breaker**: rolling 50 attempts; above `LIGHTPANDA_MAX_FAILURE_RATE` (0.4),
  open for 5 min and route Tier 1 → Tier 3 directly. Without this, a Lightpanda
  regression silently doubles latency on every fetch.

**AGPL-3.0 notice.** Lightpanda is AGPL-3.0; this repo is MIT.

- ✅ Run it as a **separate process/container** and talk CDP. Arm's-length IPC, not
  linking. Our MIT code stays MIT.
- ❌ Do not vendor, fork, link, `import`, or FFI into Lightpanda. Never an npm dependency.
- ⚠️ Baking a prebuilt binary into our Docker image is distribution of Lightpanda.
  Cleaner posture: **separate sidecar image** referenced from compose/k8s.
- 🔒 **Get legal sign-off before any commercial/SaaS deployment.** AGPL §13's network-use
  clause needs a lawyer's eye. Ships `LIGHTPANDA_ENABLED=false`.

### Tier 3 — `playwrightTier.ts`

Today's `Fetcher` logic behind `RenderTierImpl`, re-pointed at the pool.

- `waitUntil: "networkidle"` ([src/fetcher.ts:246](src/fetcher.ts#L246)) →
  `"domcontentloaded"` + bounded settle
  `Promise.race([waitForLoadState('networkidle'), sleep(RENDER_SETTLE_MS)])`. `networkidle`
  is Playwright-discouraged and hangs on long-poll/websocket/analytics pages — a real
  source of the current 30 s timeouts.
- Request interception on by default. Stealth (Phase 8) plugs in **here only**.

### Browser pool (`browserPool.ts`)

Memory facts (cite in code comments and ops docs): cold Chromium idle floor 50–150 MB;
300–500 MB per concurrent render; Browserless rule of thumb ~10 concurrent/GB; launch is
the most CPU-intensive phase (2–3 s cold) — **never launch per request**; blocking
CSS/images/fonts/media cuts renderer memory 60–70%.

```ts
export class BrowserPool {
  async warmup(): Promise<void>;                  // launch `size` browsers at boot
  async acquire(signal?: AbortSignal): Promise<PageLease>;
  async drain(graceMs: number): Promise<void>;
  stats(): { browsers: number; contexts: number; inUse: number; queued: number; recycles: number };
  isHealthy(): boolean;  // feeds /readyz
}
```

- **Warm at boot**, awaited before `/readyz` returns 200 — removes the cold-start from
  the request path.
- `acquire()` → global semaphore → least-loaded browser → `browser.newContext()`. A fresh
  context per job also **fixes a live isolation bug**: [src/fetcher.ts:106](src/fetcher.ts#L106)
  shares one `BrowserContext` across all fetches, leaking cookies between them.
- `release()` always closes the context. Recycle the browser at `maxJobsPerBrowser` /
  `maxBrowserAgeMs` / on crash, launching the replacement in the background.
- Interception: `context.route('**/*', ...)` blocks by resource type. Must be **disabled**
  for `outputFormat: 'screenshot'` — the lease carries an override flag.
- Replaces the fake batch pool at [src/fetcher.ts:369-410](src/fetcher.ts#L369-L410)
  (batch-of-5 `Promise.all`) with `src/utils/pool.ts` `mapPool(items, concurrency, fn)`.

**Default sizing** — deliberately below "10 per GB", because the browser is not the only
tenant; the same process holds markdown buffers, the content cache, and the ONNX session:

| Pod memory | `BROWSER_POOL_SIZE` | `RENDER_MAX_CONCURRENCY` |
| --- | --- | --- |
| 1 GiB | 1 | 2 (dev only) |
| 2 GiB | 1 | 4 (minimum prod) |
| 4 GiB | 2 | 8 (**recommended**) |
| 8 GiB | 3 | 16 |

---

## Phase 3 — Search provider abstraction

```
src/search/{provider,fanout,canonicalize,breaker,filter}.ts
src/search/providers/{brave,serper,searxng,duckduckgo}.ts
src/search/__fixtures__/*
```

```ts
export interface SearchProvider {
  readonly kind: "licensed" | "serp" | "meta" | "scrape";
  readonly tier: 1 | 2 | 3;  // lower = tried first
  isConfigured(): boolean;
  supports(q: SearchProviderQuery): { ok: true } | { ok: false; reason: string };
  search(q: SearchProviderQuery, ctx: { signal: AbortSignal; requestId: string }): Promise<ProviderResult[]>;
}
```

| Provider | Tier | Notes | Config |
| --- | --- | --- | --- |
| **Brave Search API** | 1 | $5/1k, licensed independent index (~20 B pages). No ToS risk. | `BRAVE_API_KEY` |
| **Serper** | 1 | Real Google SERP, best raw quality. | `SERPER_API_KEY` |
| **SearXNG** | 2 | Self-hosted, free, good for dev. **Google/Bing/DDG actively block SearXNG under sustained load** — dev/cheap tier only, never enterprise primary. | `SEARXNG_URL` |
| **DuckDuckGo HTML** | 3 | Existing regex scraping, **last resort only**. Default when no keys are set; startup `Logger.warn` when it is the only provider in HTTP mode. | none |

Each adapter splits into `buildRequest(q)` and a **pure `parse(raw)`**, unit-tested
against committed fixtures with zero network — exactly the coverage the two live regexes
at [src/services/webSearch.ts:96,106](src/services/webSearch.ts#L96) lack today.

**Fan-out** (`fanout.ts`): select providers → fan out tier 1 with `Promise.allSettled`
under a shared deadline → fall back to tier 2 then 3 → `AllProvidersFailedError` if all
fail → canonicalise for dedup (strip `www.`, tracking params, unwrap redirect wrappers) →
merge with **Reciprocal Rank Fusion** `score = Σ 1/(60 + rank)` → filter via
`includeDomains`/`excludeDomains` (lift `passesAllowedList`/`passesBlockedList` from
[src/services/webSearch.ts:50-77](src/services/webSearch.ts#L50-L77) into
`src/search/filter.ts`) → truncate to `SEARCH_FANOUT_RESULTS`.

**Circuit breaker** (`breaker.ts`): shared primitive reused by Lightpanda and TEI. State
in `KeyValueStore` so replicas share it — otherwise each replica independently discovers
the same outage and 10× the wasted billing.

**Fixing the silent-failure bug.** [src/services/webSearch.ts:319-333](src/services/webSearch.ts#L319-L333)
swallows every error and returns `{results: []}` plus a fake "Search Error" entry —
indistinguishable from "no results" to the MCP client, no `isError`. Bot-challenge
detection at [L277](src/services/webSearch.ts#L277) only `Logger.warn`s.

1. New error classes in [src/utils/errors.ts](src/utils/errors.ts): `SearchProviderError`,
   `BotChallengeError`, `AllProvidersFailedError`, `RobotsDeniedError`,
   `RateLimitTimeoutError`, `SsrfViolationError`.
2. `parse()` throws `BotChallengeError` on a challenge page → fan-out treats it as a
   provider failure and **fails over**. Today's silent zero-result becomes a successful
   fallback.
3. Delete the catch-all-return-empty; let `AllProvidersFailedError` propagate to
   `errorMapper` with `isError: true`.
4. Test "genuinely zero results" and "all providers failed" as distinct outcomes.
5. One-line fix at [src/services/webSearch.ts:306](src/services/webSearch.ts#L306):
   `convertWithMetadata(r.markdown, r.url)` omits the third `title` arg, so hybrid-mode
   results are headed `# <url>` instead of `# <title>`. Add a regression test.

---

## Phase 4 — Chunking and reranking (the actual Tavily moat)

```
src/rank/{reranker,chunker,transformersReranker,rerankWorker,teiReranker,noopReranker,fuse,types}.ts
```

```ts
export interface Reranker {
  readonly name: string; readonly maxSequenceTokens: number;
  /** Returns ALL chunks, score-annotated, descending. Caller does top-k. */
  rank(query: string, chunks: Chunk[], opts?: { signal?: AbortSignal }): Promise<ScoredChunk[]>;
  warmup(): Promise<void>; isReady(): boolean; close(): Promise<void>;
}
```

**Chunking** (`chunker.ts`), applied **after** HTML→markdown: split on ATX headings
keeping the heading path; pack paragraphs to 400 tokens with 64 overlap; **prefix each
chunk with its heading path** (measurably improves cross-encoder scores on documentation);
never split inside a fenced code block or table. Token counting via `markdown-for-agents`'
`tokenCounter` hook — **no tokeniser dependency**. 400 tokens + query fits
`bge-reranker-base`'s 512-token window.

**Local backend** (`transformersReranker.ts`): `@huggingface/transformers` on
`onnxruntime-node`. Model `Xenova/bge-reranker-base` (default) or
`onnx-community/bge-reranker-v2-m3-ONNX` (multilingual). **`dtype: 'q8'`, `device: 'cpu'`
— not a preference: fp16 ONNX exports fail session init on the CPU execution provider.**
Lazy `await import()` so install and stdio startup stay fast (`optionalDependencies`); on
import failure fall back to `NoopReranker` with a warn, never a crash.

**Event-loop hazard, and the fix.** ONNX inference is synchronous native CPU work;
in-process, a 200-chunk rerank blocks the event loop for hundreds of milliseconds, stalling
every other client in HTTP mode. `rerankWorker.ts` hosts the model in a `worker_threads`
Worker with a request/response channel. This is a **non-optional cost of the monolith
constraint** — build it in Phase 4, do not retrofit.

**TEI backend** (`teiReranker.ts`, optional): GPU-capable HuggingFace Text Embeddings
Inference via the unified `HttpClient`. Falls back `tei → local → none` behind the shared
breaker. Config: `RERANK_TEI_URL`. Stays strictly opt-in so `npx markdown-mcp` needs
nothing external.

**Where it slots in:**

```
web_search(query, searchDepth)
├─ fast:     SERP fan-out → dedup → RRF → filter → truncate → snippets only  (~300–800 ms)
├─ basic:    SERP fan-out (top 10) → RRF → mapPool(render, maxTier='http')
│            → extract → chunk → rerank → top-1 chunk/URL → order by score
└─ advanced: SERP fan-out (20, all providers) → RRF → mapPool(render, full ladder)
             → extract → chunk → rerank [worker thread]
             → top-`chunksPerSource`/URL → order by best score → truncate to maxResults
```

**The key inversion: the reranker replaces provider rank order as the final authority.**
RRF decides *which 20 URLs to fetch*; the cross-encoder decides what the agent sees.
Retrieve wide, rank on actual content — that is Tavily's pipeline shape. The same
`Reranker` also powers `crawl_start`'s `relevanceThreshold` gate. One component, two uses,
no LLM.

---

## Phase 5 — Extract, map, formats, selectors

Builds directly on Phase 0.2's `extract()`. Adds `extract_urls` (`/extract`),
`map_site` (`/map`), `outputFormat: markdown|html|text|screenshot` (FW #9),
`includeSelector`/`excludeSelectors` (FW #6), and pagination via `maxChars`/`offset` +
`totalLength`/`truncated` (FW #11). `fetch_urls` stays as a thin alias for compatibility.

---

## Phases 6–7 — Enterprise scale within the monolith

### The bug that blocks N replicas today

[src/index.ts:294-327](src/index.ts#L294-L327) creates **one**
`StreamableHTTPServerTransport` and shares it across every HTTP connection. Stateful mode
404s unknown session IDs, so with N replicas and no session affinity, `initialize` lands
on replica A and the next call on replica B → 404. Horizontal scaling is broken by
construction.

Fix — new `MCP_HTTP_MODE`:

- **`stateless` (new HTTP default)**: `sessionIdGenerator: undefined`,
  `enableJsonResponse: true`. Every POST self-contained, any replica serves any request, a
  plain load balancer round-robins correctly. None of our tools use server→client
  notifications, which is why this is the right default.
- `session`: current behaviour **plus a per-session transport map** plus a documented
  load-balancer affinity requirement on `Mcp-Session-Id`.

### What must become shared state

| State | Today | Externalise? | Why |
| --- | --- | --- | --- |
| Per-host rate-limit buckets | absent | **Must** | N replicas × local buckets = N× the configured RPS at the target. This is how you get IP-banned. |
| Crawl queue + visited set | absent | **Must** | Workers must not fetch the same URL; needs atomic claim + shared visited set. |
| Content cache | module-level in [src/fetcher.ts:20-29](src/fetcher.ts#L20-L29) | **Should** | Turns a 1/N hit rate into ~1. |
| Breaker state | absent | **Should** | Each replica independently discovers the same outage, 10× the wasted calls. |
| robots cache, render-tier memo | absent | Nice | Saves fetches. |
| Browser pool, ONNX session | in-process | **Must stay local** | Not shareable; they are why replicas are heavy. |

### Pluggable stores — preserving the `npm install` story

```
src/store/{types,factory}.ts + memory/ sqlite/ redis/ postgres/ + __contract__/
```

```ts
export interface KeyValueStore {
  get(k: string): Promise<Buffer | undefined>;
  set(k: string, v: Buffer, ttlMs: number): Promise<void>;
  del(k: string): Promise<void>;
  setNx(k: string, v: Buffer, ttlMs: number): Promise<boolean>; // atomic, for leases
  stats(): Promise<{ backend: string; entries?: number; bytes?: number }>;
  close(): Promise<void>;
}
export interface RateLimitStore {
  /** Atomic token-bucket take. Returns ms to wait (0 = proceed). */
  take(key: string, rps: number, burst: number, now: number): Promise<number>;
}
export interface JobQueue {
  createJob(job: JobSpec): Promise<string>;
  enqueue(jobId: string, items: QueueItem[]): Promise<number>; // count NEW only
  lease(jobId: string, n: number, leaseMs: number): Promise<LeasedItem[]>; // atomic claim
  heartbeat(items: LeasedItem[], leaseMs: number): Promise<void>;
  complete(item: LeasedItem, record: PageRecord): Promise<void>;
  fail(item: LeasedItem, error: string, retryable: boolean): Promise<void>;
  claimJob(workerId: string, leaseMs: number): Promise<JobLease | undefined>;
  status(jobId: string): Promise<JobStatus>;
  results(jobId: string, offset: number, limit: number, filter?: PageStatus): Promise<PageRecord[]>;
  cancel(jobId: string): Promise<void>;
  list(): Promise<JobSummary[]>;
}
```

Defaults by mode — this preserves the local story:

- **stdio** → `memory` everything. Zero config; `npx markdown-mcp` still just works.
- **HTTP, single replica** → `sqlite` via **`node:sqlite`**, built into Node — no new
  dependency. (Requires Node ≥ 22; see ceilings §10.)
- **HTTP, N replicas** → `redis` (KV + rate limits + queue, Lua-atomic claim), optionally
  `postgres` for durable queue + result storage.

`ioredis` and `pg` go in `optionalDependencies`, lazily imported by `factory.ts`. If
`STORE_BACKEND=redis` and the import fails, **fail loudly at startup** — a silent
downgrade to per-replica rate limiting is how you get banned.

### Worker role — replacing tmux

Same package, same image, different role: `markdown-mcp --role=worker` /
`MCP_ROLE=server|worker|both`. Worker loop: `claimJob` → `lease(n)` → render+extract via
the ladder → `complete` → `enqueue` discovered links (deduped against the shared visited
set) → repeat, heartbeating leases so a killed pod's work is reclaimed after
`QUEUE_LEASE_MS`.

### Container basics (Phase 7)

New: `Dockerfile`, `docker-compose.yml`, `.dockerignore`.

- **Not Alpine.** Playwright ships no musl Chromium. `BUILD_INSTRUCTIONS.md`'s
  `node:20-alpine` + `apk add chromium` example is broken twice over — the `ca-certures`
  typo at L310 *and* the fact Playwright cannot drive an apk-installed Chromium without
  `executablePath`. Use `mcr.microsoft.com/playwright:v<exact-dep-version>-jammy` as the
  runtime stage.
- **`/dev/shm` — the one gotcha that will bite in production.** Docker's default is
  **64 MB**; Chromium renderers exhaust it and crash in a cascade under concurrency. Provide
  a properly-sized `/dev/shm` (see k8s and ECS sections below) and gate
  `--disable-dev-shm-usage` behind `BROWSER_DISABLE_DEV_SHM=false` as an escape hatch for
  restricted runtimes.
- **`init: true` / dumb-init** for zombie reaping — Chrome forks children.
- **Bake the reranker model** into the image — otherwise every cold start pulls ~280 MB
  from HuggingFace, which is a slow single point of failure for readiness.
- **Chrome 132 dropped `--headless=old`**; the lighter `chrome-headless-shell` binary is
  now separate. Select via `BROWSER_CHANNEL`, defaulting to the shell when
  `outputFormat !== 'screenshot'`.

### k8s shape (`deploy/k8s/`)

Two Deployments **of the same image** — this is how the monolith constraint and
independent scaling coexist:

| | `mcp-server` | `mcp-worker` |
| --- | --- | --- |
| args | `--http 3000` | `--role=worker` |
| replicas | 3 (HPA 3→20) | 2 (HPA 2→50) |
| requests → limits | 1 CPU / 2Gi → 2 CPU / 4Gi | 2 CPU / 4Gi → 4 CPU / 8Gi |
| `RENDER_MAX_CONCURRENCY` | 8 | 16 |

- `terminationGracePeriodSeconds: 90` must exceed `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`
  (50), or SIGTERM kills in-flight renders.
- `readinessProbe: /readyz` (pool warm **and** stores reachable); `livenessProbe: /healthz`
  (process only — **never** make liveness depend on Redis, or a Redis blip restarts the
  fleet).
- `emptyDir{medium: Memory, sizeLimit: 1Gi}` mounted at `/dev/shm`.
- PDB `minAvailable: 2`; `topologySpreadConstraints` across zones.
- **HPA on CPU alone is wrong** — browser workloads spike at launch then idle on network.
  Use `prometheus-adapter` with `mcp_inflight_requests` (target 6/pod) for the server and
  `crawl_queue_depth` (target 50/pod) for workers. `scaleDown.stabilizationWindowSeconds: 300`
  because scaling down throws away warm browsers.

### AWS ECS Fargate deployment (`deploy/ecs/`)

**Check `aib-genai-standards` for the house IaC choice (Terraform vs CDK)** rather than
picking here — this is a personal repo but the deployment target is AI Studio.

Two ECS Services of one task-definition family / one image, mirroring the two k8s
Deployments. `MCP_HTTP_MODE=stateless` lets the ALB round-robin with no stickiness —
same property that makes the k8s Service work.

**Fargate-specific changes to the container design:**

| Concern | Fargate answer |
| --- | --- |
| `/dev/shm` sizing | **`sharedMemorySize` is not supported on Fargate.** Use `linuxParameters.tmpfs` at `/dev/shm` — **supported on Fargate since 2026-01-06** (recent enough that most guidance still says this is impossible). See verification step. |
| Zombie reaping | `linuxParameters.initProcessEnabled: true` is supported — no need to bake dumb-init/tini into the image. |
| Image size | Set `ephemeralStorage.sizeInGiB: 40`. Default 20 GiB gets tight with Chromium + ONNX + model + crawl scratch. |
| Reranking | **No GPU on Fargate.** `RERANK_BACKEND=local` (q8, worker thread) is the default. TEI moves to an EC2 capacity provider or a SageMaker endpoint. |
| Task sizing | Server: 2 vCPU / 4 GB. Worker: 4 vCPU / 8 GB. |
| Drain | `stopTimeout: 90` (Fargate max is 120). Must exceed `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS` (50). |
| ALB timeout | Raise idle timeout to **120 s** — the default 60 s cuts advanced searches (p95 ~10–15 s). Use `/readyz` as the TG health check so a task isn't registered before the browser pool is warm. |
| Autoscaling | Application Auto Scaling **target tracking on a CloudWatch custom metric**: `mcp_inflight_requests` (target 6) for the server, `crawl_queue_depth` (target 50) for workers. **Not CPU** — same oscillation reason as k8s. |
| Metrics transport | No Prometheus scrape in ECS by default. Either an **ADOT sidecar** scraping `/metrics`, or a **CloudWatch EMF** emitter in `src/obs/metrics.ts`. Custom-metric autoscaling needs this to exist first — verify the metric appears in CloudWatch before wiring the scaling policy. |
| Lightpanda | A second container in the same task definition. Fargate containers share a network namespace, so `LIGHTPANDA_CDP_URL=ws://127.0.0.1:9222` works unchanged. Keeps the AGPL separate-image posture intact. |
| Stores | ElastiCache Redis + RDS/Aurora Postgres in the same VPC. Ingress from the task security group. |
| Secrets | `MCP_AUTH_TOKEN`, `BRAVE_API_KEY`, `SERPER_API_KEY`, and SOCKS credentials go in `secrets[].valueFrom` → Secrets Manager/SSM. **Never `environment`** — ECS renders `environment` in plain text in `describe-tasks`. |
| Egress cost | NAT Gateway data processing is billed per GB. A crawl at scale is a real line item. `RENDER_BLOCK_RESOURCES` is a **cost control** as well as a memory one. Add VPC endpoints for AWS APIs. |

```json
"linuxParameters": {
  "initProcessEnabled": true,
  "tmpfs": [{ "containerPath": "/dev/shm", "size": 1024,
              "mountOptions": ["rw", "noexec", "nosuid"] }]
}
```

### SOCKS5 gateway (Phase 10)

Two independently-optional halves. Both off by default.

```
src/proxy/socks5Server.ts   # ingress listener (RFC 1928 + RFC 1929 userpass)
src/proxy/policy.ts         # shared allow/deny for a (host, port) pair
src/http/socks.ts           # upstream SOCKS5 egress, wired into resolveProxy()
```

```
AI Studio ──socks5──> [ mcp server: listener ] ──┬── direct ──> internet
                                                 └── socks5 ──> upstream proxy ──> internet
```

**Egress (`SOCKS5_UPSTREAM_URL`)** — a new branch in Phase 1's `resolveProxy()`, so all
three tiers honour it from one place:

| Tier | Mechanism | Auth |
| --- | --- | --- |
| Tier 1 (undici) | Native `Socks5ProxyAgent` (built into undici since v7.23.0). No new dependency. Marked *Stability: Experimental* — keep `fetch-socks` noted as the stable fallback and for proxy chaining. | ✅ userpass |
| Tier 2 (Lightpanda) | libcurl honours `ALL_PROXY` / `socks5h://` | ✅ |
| Tier 3 (Playwright) | `proxy.server = 'socks5://…'` | ❌ **Chromium has no SOCKS5 credential support** — microsoft/playwright#10567, open since Nov 2021, still P3. Chromium throws rather than degrading. |

**Consequence, and why the two halves are one design.** If the upstream proxy requires
credentials, Tier 3 cannot reach it. The standard fix is a local no-auth SOCKS relay that
adds credentials upstream — and **that is exactly the ingress listener with
`SOCKS5_UPSTREAM_*` set**. Chromium points at `socks5://127.0.0.1:1080`, the listener
adds credentials, and Tier 3 works. **Build the listener first if the upstream is
authenticated — otherwise Phase 2 silently loses its top tier behind the corporate proxy.**

**Ingress (`SOCKS5_LISTEN_ENABLED`)** — two modes:

- **`tunnel` (default, recommended).** A policy-enforcing SOCKS5 relay. It sees only
  `CONNECT host:port`, never content, so it is genuinely transparent — a drop-in for AI
  Studio tooling with zero code change on the client side. Adds a single audited egress
  choke point: `isDomainBlocked`, the DNS/SSRF guard, per-host rate limits, and
  `socks_connections_total{outcome}` metrics. No CA, no TLS termination, no plaintext
  logging.
- **`intercept` (opt-in, not recommended).** Terminate TLS with a private CA, run the
  ladder, return markdown. This is a MITM appliance: it requires your CA in AI Studio's
  trust store, breaks certificate pinning, and puts plaintext third-party content through
  your logs. **Recommendation: do not use it.** If AI Studio wants markdown, the honest
  interface is the MCP tools or a plain HTTP `extract` endpoint. Ship it behind an explicit
  flag, require the operator to supply the CA (never auto-generate one), and log a startup
  warning whenever it is on.

**DNS and the SSRF guard — an honest tension.** With any upstream proxy, the proxy resolves
and connects, so `isPrivateIp` connection pinning is **unenforceable** and the Phase 1
guard degrades to hostname-lexical checking. SSRF prevention is the proxy's and the
network's job. Say so in `SECURITY.md` next to the equivalent Chromium caveat.

### Observability

New `src/obs/{metrics,otel}.ts` — `prom-client`, plus `@opentelemetry/sdk-node` in
`optionalDependencies` gated on `OTEL_ENABLED=false`. Add `GET /healthz`, `/readyz`,
`/metrics`. The current auth middleware at [src/index.ts:302-309](src/index.ts#L302-L309)
guards everything — probes need an explicit allowlist (`/healthz` and `/readyz`
unauthenticated; `/metrics` behind the bearer token or a separate `METRICS_BIND_PORT`).

Metric names in one exported const (so they are greppable):
`mcp_tool_calls_total{tool,outcome}`, `mcp_tool_duration_seconds{tool}`,
`mcp_inflight_requests` ← HPA signal, `fetch_requests_total{tier,outcome}`,
`fetch_duration_seconds{tier}`, `fetch_escalations_total{from_tier,to_tier,reason}` ←
ladder health, `render_tier_memo_total{result}`,
`browser_pool_{browsers,contexts,in_use,queued}`, `browser_recycles_total{reason}`,
`browser_launch_duration_seconds`, `search_provider_requests_total{provider,outcome}` ←
cost attribution, `rerank_duration_seconds{backend}`,
`store_operations_total{backend,op,result}`, `rate_limit_waits_seconds`,
`robots_denied_total`, `crawl_queue_depth{job}` ← HPA signal,
`crawl_pages_total{job,status}`, `ssrf_violations_total{stage}`,
`socks_connections_total{outcome}`.

**No `hostname` label anywhere** — unbounded cardinality kills Prometheus.

Related live fix: `Logger.domainMetrics` ([src/utils/logger.ts:97](src/utils/logger.ts#L97))
is an **unbounded Map keyed by hostname** — a genuine slow leak. Replace with a bounded
top-N (reuse `LRUCache` with `maxLength=500`) purely for `health_check` output.

### Graceful drain

Today [src/index.ts:27-57](src/index.ts#L27-L57) waits 100 ms, closes the browser, exits,
while `startHttpServer` registers a **second** `SIGTERM` handler that races the first.

Replace with one idempotent ordered drain in `src/server/lifecycle.ts`: flip `readyz=false`
+ wait `SHUTDOWN_DRAIN_MS` → `httpServer.close()` → stop claiming + release held leases →
await in-flight calls up to `SHUTDOWN_TIMEOUT_MS` → `browserPool.drain()` → close
reranker/workers/httpClient/stores → close SOCKS5 listener → exit, with an unref'd hard
timeout as backstop.

---

## Phases 8–9

**8 — Stealth + proxy rotation** (FW #1 demoted, FW #6): `playwright-extra` fingerprint
hardening in Tier 3 only, plus proxy rotation. Note the structural cost: Playwright proxy
is launch-time, so rotation requires per-proxy browser pools.

**9 — Docs truth-up:** `.env.example` currently documents 2 phantom vars
(`STABILIZATION_DELAY_MS`, `WEB_SEARCH_MAX_RESULTS` — validated nowhere, read nowhere;
Zod uses `safeParse` without `.strict()` so they are silently ignored) and omits 5 real
ones. `CLAUDE.md` documents 4 tools. `server.json` says 1.0.0 while `package.json` says
1.0.1. Fix `BUILD_INSTRUCTIONS.md`'s Dockerfile. Add auth/cookie passthrough (FW #8).
Make the bearer comparison timing-safe (`crypto.timingSafeEqual`).

---

## Verification

Build on the repo's existing test strengths (4,670 test lines, 92.69% statement coverage)
and its two established DI seam patterns: `vi.mock('playwright')` with a hand-built mock
browser/context/page ([src/fetcher.test.ts:6-14](src/fetcher.test.ts#L6-L14)) and explicit
injectable implementations.

| Layer | Approach |
| --- | --- |
| Tool registry | Call handlers with a fake `ToolContext` — no transport boot. Invariant test over `TOOLS`: every definition has description + `outputSchema` + `toText`. |
| HTTP client | (a) Pure functions (`shouldRetry`, `computeBackoff`, `detectCharset`, `canonicalize`) table-driven. (b) Wire-level via undici `MockAgent` — retry counts, `Retry-After`, redirect policy, proxy selection, byte-cap abort — all offline. |
| **Escalation heuristic** | **The most important new suite — the heuristic is the ladder's cost model.** Fixtures: `next-app-shell.html`, `nuxt-shell.html`, `static-article.html`, `empty-root-div.html`, `cf-challenge.html`, `json-response.txt`, `noscript-warning.html`. Assert both `escalate` **and** `targetTier` — the CF fixture must jump to `playwright`, not `lightpanda`. |
| Render tiers | Tier 1 via `FakeHttpClient`; Tiers 2 & 3 share `cdpClient.ts`, so one `vi.mock('playwright')` covers both. Assert escalation sequences and that Lightpanda failure falls through. |
| Browser pool | Mock `chromium.launch`: warmup; semaphore caps; recycle at max jobs and on crash; replacement launches in background; `drain()` awaits leases. One opt-in real-browser test (`RUN_BROWSER_TESTS=1`). |
| Search providers | Pure `parse(raw)` against one fixture each, including `duckduckgo-challenge.html`. |
| Fan-out | Fake providers with scripted delays/empties/throws/`BotChallengeError`. RRF ordering, canonical dedup, breaker transitions, both silent-failure regression tests. |
| Reranker | `FakeReranker` (query-term frequency) for pipeline tests. Chunker purely: heading splits, overlap, never splitting fenced code or tables, heading-path prefixing. One opt-in `RUN_MODEL_TESTS=1` test (CI-nightly) loading `bge-reranker-base` q8 and asserting a known ordering over three passages. |
| Stores | **One contract suite parameterised over every backend** (`memory`, `sqlite`, `redis`, `postgres`): TTL expiry, `setNx` atomicity, claim exclusivity under concurrent leasers, lease reclaim, visited-set dedup. |
| Crawl engine | Injected `JobQueue` + injected renderer against a fake 20-page graph: depth limits, `maxPages`, include/exclude, cycles, resume-after-restart (SQLite). |
| SOCKS5 | Real SOCKS5 handshake against a loopback echo server: greeting/method negotiation, RFC 1929 userpass, blocklisted host refused with the correct reply code, IPv4/IPv6/domain address types, upstream chaining. `policy.ts` is a pure `(host, port) → allow/deny` function. |
| Lifecycle | Drain ordering, hard-timeout force-exit, SOCKS5 listener stops before in-flight tunnels are awaited. |
| Live network | `*.live.test.ts` gated on credentials: `brave`, `serper`, `searxng`, `lightpanda`, and **`ladder.live`** — 10 curated URLs (3 static, 4 SPA, 3 bot-protected) asserting each lands on the expected tier. Run nightly; **alert on tier drift**. |

Add `coverage.thresholds` to `vitest.config.ts` (`lines: 90, statements: 90, branches: 80`)
with `src/server/**` and `src/tools/definitions.ts` explicitly included.

**End-to-end milestones:**

1. `npm run build && npm test && npm run typecheck && npm run lint`
2. **stdio smoke:** `npx markdown-mcp` with no env → `fetch_url`, `web_search` (DDG
   fallback), `extract_urls` all work. Non-negotiable regression gate — the zero-config
   local story must survive every phase.
3. **Ladder proof:** run `ladder.live` and read `fetch_escalations_total`. Success: a
   static-article corpus resolves at **Tier 1 with no browser launched**.
4. **Lightpanda gate:** enable Tier 2 and measure `fetch_escalations_total{from_tier="lightpanda"}`.
   **Only promote to default if the escalation rate is < ~20%** — above that, Tier 2 is
   negative value (a wasted hop before the browser you were always going to need).
5. **Rerank proof:** `advanced` search on 10 queries with `RERANK_BACKEND=none` vs `local`;
   hand-inspect ordering. Confirm the worker thread keeps the event loop free.
6. **Scale proof:** `docker compose up --scale mcp=3` with Redis. Assert: stateless calls
   succeed across replicas; aggregate RPS honours `RATE_LIMIT_PER_HOST_RPS` (not 3×); a
   200-page `crawl_start` with 2 workers fetches no URL twice; a killed worker's leases
   reclaim and the crawl finishes.
7. **k8s proof:** both Deployments; `/readyz` gates on pool warmup; HPA scales on
   `crawl_queue_depth`; rolling restart drops zero in-flight requests.
8. **ECS Fargate proof:** both Services. (a) `cat /proc/mounts | grep /dev/shm` inside the
   task shows **1 GB tmpfs, not 64 MB** — the single most likely production failure; (b) 8
   concurrent Tier-3 renders complete with no crash; (c) 90-second-draining task
   deregisters from ALB before stopping; (d) target-tracking autoscaling fires on the
   custom metric — verify the metric appears in CloudWatch *before* wiring the policy.
9. **SOCKS5 proof:** `curl --socks5-hostname 127.0.0.1:1080 https://example.com` →
   byte-identical content + `socks_connections_total` increment; blocklisted host refused at
   CONNECT; with `SOCKS5_UPSTREAM_URL` pointing to an **authenticated** upstream, **Tier 3
   Playwright succeeds through the loopback listener** while a direct
   `proxy.server=socks5://user:pass@…` fails — that contrast should be a committed test.

---

## Honest ceilings — do not promise parity

1. **Relevance quality.** `bge-reranker-base` is a generic MS MARCO cross-encoder. Real
   gap on ambiguous/domain-specific queries vs Tavily's proprietary scorer. Closing it
   requires fine-tuning on your own traffic — a separate ML programme, not this plan.
2. **No warm index.** Every advanced search renders live. **This is the single largest
   latency and cost difference and is not closable without building an index** — a
   different product.
3. **Latency.** Realistic advanced-search p50 ~3–6 s, p95 ~10–15 s. TEI closes the rerank
   gap but is a sidecar.
4. **Cost is not obviously lower.** Brave + Serper fan-out ≈ $8–12/1k searches *plus* your
   own render CPU — the same ballpark as Tavily credits. **The case is data locality,
   control, and self-hosting, not price.** Price only wins with SearXNG/DDG primary, which
   is not enterprise-viable.
5. **Lightpanda is pre-1.0 with partial Web API support.** Tier 2's real hit rate is
   unknown until measured (see verification gate 4).
6. **Lightpanda AGPL-3.0 is unresolved risk.** Get legal sign-off before any
   commercial/SaaS deployment.
7. **SSRF in the Chromium path cannot be fully closed.** Chrome resolves DNS itself;
   pre-flight + `serverAddr()` post-check is *detect-and-discard*, not prevent. The real
   control is network-level egress restriction. Say so in `SECURITY.md`.
8. **robots.txt compliance vs SERP scraping is genuinely inconsistent.** Brave/Serper are
   licensed; DDG/SearXNG scraping is ToS-questionable. State this plainly in the README.
9. **Where the monolith constraint hurts:** one image carries Chromium (~400 MB), ONNX, and
   the model (~280 MB); render and request capacity scale together; markdown conversion of
   a 100 KB page is synchronous CPU on the main loop; one blast radius, no bulkhead; you
   scale out earlier because everything shares one address space. Acceptable trades —
   but trades.
10. **Fargate tmpfs is new.** The capability dates to 2026-01-06. Confirm it in your region
    and platform version before committing to Fargate for the render roles — verification
    step 8(a) exists precisely for this.
11. **SOCKS5 `intercept` mode is a MITM appliance.** If enabled, the CA is a high-value
    credential and plaintext third-party content flows through your logs. Compliance
    conversations, not engineering ones.
12. **Chromium's missing SOCKS5 auth is upstream and unlikely to move** (open since 2021,
    P3). The loopback-relay workaround is sound but adds a hop and a process to keep alive;
    if the listener dies, Tier 3 loses egress entirely. Health-check it and include it in
    the drain sequence.
13. **`node:sqlite` needs Node ≥ 22.** `engines.node` says `>=20`, which is **already
    wrong** — the repo's own `markdown-for-agents` dependency declares `>=22`. Bump it.

---

## Critical files

| File | Role in this plan |
| --- | --- |
| [src/index.ts](src/index.ts) | Phase 0 splits it into `src/server/registry.ts` + `src/tools/definitions.ts`; Phase 7 fixes the stateful-transport-blocks-N-replicas bug (L294–327), the double SIGTERM handler (L27–57), and the auth allowlist (L302–309). |
| [src/fetcher.ts](src/fetcher.ts) | Becomes `render/tiers/playwrightTier.ts` + `render/browserPool.ts`. Source of: hardcoded `page.evaluate` pruning (L282–304), hardcoded caches (L20–29), shared-context cookie leak (L106), `networkidle` hang (L246), HTML-level truncation (L320–323), fake batch pool (L369–410). |
| [src/services/webSearch.ts](src/services/webSearch.ts) | Becomes `search/providers/duckduckgo.ts`. Source of: silent-failure bug (L319–333), warn-only bot detection (L277), missing `title` arg (L306), blind utf-8 decode (L233), hand-rolled HTTP path to delete (L172–245). `passesAllowedList`/`passesBlockedList` (L50–77) lift to `src/search/filter.ts`. |
| [src/services/downloadFile.ts](src/services/downloadFile.ts) | Migrates to `httpClient.stream()`, fixing the buffer-then-check OOM (L129). |
| [src/config.ts](src/config.ts) | Every phase adds vars; home of the never-read `CACHE_MAX_BYTES`/`CACHE_TTL_MS` (L24–25). |
| [src/converter.ts](src/converter.ts) | Expands into `src/extract/pipeline.ts` using the `markdown-for-agents` options it already has but does not use. |
| [src/utils/domainBlacklist.ts](src/utils/domainBlacklist.ts) | Must export `isPrivateIp` for the DNS-rebinding fix. |
| [src/utils/logger.ts](src/utils/logger.ts) | `domainMetrics` unbounded-Map leak (L97); `formatTextEntry` drops `data`; `logCacheHit`/`Miss` double-count into `fetchCount`; `getSummary().cacheUtilization` is the hit rate, not byte utilization. |
| `FUTURE_WORK.md` | See the supersedes table above. |

**New deps:** `undici`, `robots-parser` (runtime); `@huggingface/transformers`, `ioredis`,
`pg`, `@opentelemetry/*` (optional, lazily imported); `prom-client` (Phase 7); `linkedom`
only if arbitrary CSS selectors are required. Lightpanda is **never** an npm dependency.
Phase 10 adds no runtime dep in the common case — undici's `Socks5ProxyAgent` covers
egress and the listener is `node:net` — with `fetch-socks` held in reserve for proxy
chaining.
