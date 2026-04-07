# Future Work

This document tracks gaps and potential improvements identified by comparing `markdown-for-agents-mcp` against similar tools in the ecosystem. It is organised by priority and theme.

Legend: ✅ implemented · 🔲 planned · ❌ not available

---

## Competitive Landscape Summary

### Current state

| Feature | This project | Official MCP Fetch | Firecrawl MCP | Playwright MCP | Jina Reader | Crawl4AI |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| JS rendering | ✅ | Partial | ✅ | ✅ | ✅ | ✅ |
| Batch fetch | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Web search | ✅ | ❌ | ✅ | ❌ | Separate | ❌ |
| In-process cache | ✅ | ❌ | ❌ | ❌ | Cloud | ✅ |
| Proxy support | ✅ | ✅ | Cloud-managed | ✅ | ✅ | ✅ |
| Structured output (MCP schema) | ✅ | ❌ | ✅ | Accessibility | ✅ | ✅ |
| MCP native | ✅ | ✅ | ✅ | ✅ | ❌ | Via Docker |
| No API key required | ✅ | ✅ | ❌ | ❌ | Free tier | ✅ |
| Local / self-hosted | ✅ | ✅ | Partial | ✅ | ❌ | ✅ |
| Binary file download | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Streamable HTTP + auth | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Interactive browser | ❌ | ❌ | ✅ | ✅ | ❌ | Partial |
| Site crawl | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Async crawl jobs | ❌ | ❌ | ✅ | ❌ | ❌ | Partial |
| Anti-bot stealth | Light | None | Cloud-managed | None | Cloud | Aggressive |
| Proxy list rotation | ❌ | ❌ | Cloud-managed | ❌ | Cloud | ✅ |
| Schema-based extraction | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Multiple output formats | ❌ | ❌ | ✅ | Accessibility | ✅ | ✅ |
| Auth / cookie passthrough | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| robots.txt compliance | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Content pagination | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Multi-browser support | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| CSS selector targeting | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Retry and back-off | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |

### After implementing all planned work

| Feature | This project | Official MCP Fetch | Firecrawl MCP | Playwright MCP | Jina Reader | Crawl4AI |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| JS rendering | ✅ | Partial | ✅ | ✅ | ✅ | ✅ |
| Batch fetch | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Web search | ✅ | ❌ | ✅ | ❌ | Separate | ❌ |
| In-process cache | ✅ | ❌ | ❌ | ❌ | Cloud | ✅ |
| Binary file download | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Streamable HTTP + auth | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| No API key required | ✅ | ✅ | ❌ | ❌ | Free tier | ✅ |
| Local / self-hosted | ✅ | ✅ | Partial | ✅ | ❌ | ✅ |
| Site crawl | 🔲 | ❌ | ✅ | ❌ | ❌ | ✅ |
| Async crawl jobs | 🔲 | ❌ | ✅ | ❌ | ❌ | Partial |
| Anti-bot stealth | 🔲 Strong | Cloud-managed | Cloud-managed | None | Cloud | Aggressive |
| Proxy list rotation | 🔲 | ❌ | Cloud-managed | ❌ | Cloud | ✅ |
| Schema-based extraction | 🔲 | ❌ | ✅ | ❌ | ❌ | ✅ |
| Multiple output formats | 🔲 | ❌ | ✅ | Accessibility | ✅ | ✅ |
| Auth / cookie passthrough | 🔲 | ❌ | ✅ | ✅ | ✅ | ✅ |
| Stateful browser sessions | 🔲 | ❌ | ✅ | ✅ | ❌ | Partial |
| robots.txt compliance | 🔲 | ✅ | ✅ | ❌ | ✅ | ✅ |
| Content pagination | 🔲 | ✅ | ❌ | ❌ | ✅ | ❌ |
| Multi-browser support | 🔲 | ❌ | ❌ | ✅ | ❌ | ✅ |
| CSS selector targeting | 🔲 | ❌ | ✅ | ❌ | ✅ | ✅ |
| Retry and back-off | 🔲 | ❌ | ✅ | ❌ | ❌ | ✅ |
| CAPTCHA bypass | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Enterprise-scale infra | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |

---

## Gaps to Address

### 1. Content Pagination

**Gap:** Very long pages are truncated at 100 KB. The official Anthropic MCP fetch server and Jina Reader both support chunked/paginated access via `start_index` / `max_length` parameters.

**Proposed change:** Add optional `offset` and `limit` (character or token count) parameters to `fetch_url` and `fetch_urls`. Return a `total_length` field in the structured output so callers know whether to paginate.

**Comparators with this feature:** Official MCP Fetch, Jina Reader

---

### 2. Structured JSON Extraction

**Gap:** The server returns markdown only. Firecrawl and Crawl4AI can extract structured data against a user-supplied JSON schema, which is significantly more useful for data pipeline use cases.

**Proposed change:** Implement in two phases:

- **Phase 1 (CSS/XPath-based):** Add an optional `schema` parameter (JSON Schema object) to `fetch_url`. Use `cheerio` selectors or XPath expressions mapped to schema fields for deterministic extraction. Covers the majority of structured pages (product listings, documentation, data tables) without requiring an LLM.
- **Phase 2 (LLM-assisted):** When CSS/XPath extraction yields insufficient confidence, optionally pass the page markdown + schema to a configured LLM endpoint and return structured JSON alongside the markdown. The LLM endpoint is user-supplied — the tool does not bundle a model.

**Comparators with this feature:** Firecrawl MCP (`extract` tool), Crawl4AI (LLM-driven extraction)

---

### 3. Site Crawling and Mapping

**Gap:** There is no way to crawl an entire site or enumerate all URLs under a domain. Firecrawl exposes `firecrawl_crawl` and `firecrawl_map` for this.

**Proposed change:** Implement in two phases aligned with the async job design (see [Async Job Execution and Resumable Crawls](#async-job-execution-and-resumable-crawls)):

- **Phase 1 (synchronous `crawl_site`):** A depth-limited BFS crawler that accepts a root URL, `maxDepth`, `maxPages`, and URL include/exclude patterns. Fetches each page using the existing Playwright fetcher and returns results inline. Suitable for small sites (< 100 pages).
- **Phase 2 (async `crawl_start` / job API):** For larger crawls, the async job system replaces the synchronous tool. The `crawl_site` tool is retained for small, agent-driven tasks; `crawl_start` is used for production crawls.

Both phases respect the existing domain blocklist/allowlist configuration and support politeness controls (request delay, `maxConcurrency`). robots.txt compliance (see [Gap 5](#5-robotstxt-compliance-option)) applies to both.

**Comparators with this feature:** Firecrawl MCP, Crawl4AI

---

### 4. Anti-Bot / Stealth Improvements

**Gap:** Current anti-detection is limited to `navigator.webdriver = false` and a small pool of randomised Chrome user-agents. Sophisticated sites (Cloudflare, Akamai) will still block or challenge these requests.

Stealth operates at two distinct layers that must be addressed separately:

#### Layer 1: Browser fingerprint stealth (JS-based detection)

Most bot detection (Cloudflare JS challenge, Akamai, Datadome) runs client-side JavaScript that inspects the browser environment. This layer is fully addressable with a library.

**Proposed changes:**

- **`playwright-extra` + stealth plugin** — drop-in replacement for the Playwright browser launch that patches ~30 known detection vectors: `navigator.webdriver`, `chrome.runtime`, `permissions.query`, `navigator.plugins`, `window.chrome`, WebGL renderer strings, and more
- **Randomise browser fingerprint per request:**
  - Viewport size (from a realistic distribution of common resolutions)
  - Timezone and locale (`Intl.DateTimeFormat` fingerprint)
  - Platform and CPU concurrency (`navigator.platform`, `navigator.hardwareConcurrency`)
  - Canvas and WebGL noise (per-session random offset on pixel values)
  - Accept-Language and Accept-Encoding headers
- **Behavioural signals:**
  - Randomised mouse movement to a point on the page before extraction (prevents "no mouse events" detection)
  - Randomised scroll before `networkidle` wait
  - Randomised delay between page load and content extraction (200–800 ms jitter)
- **TLS fingerprint** — Playwright's default TLS fingerprint is identifiable. Consider `rebrowser-patches` or a custom CDP session to randomise TLS JA3/JA4 fingerprints

**Implementation:** Replace `chromium.launch()` with `chromiumStealth.launch()` from `playwright-extra`. All other fetcher logic is unchanged. This is the highest-ROI stealth improvement — low effort, high impact.

#### Layer 2: IP reputation stealth (network-level detection)

IP-level blocking (datacentre IP ranges, Cloudflare's IP reputation scores) cannot be fixed with a library. It requires residential IP addresses. The tool's role here is to make plugging in residential proxies trivially easy — the user brings the proxy credentials.

**Proposed changes:**

#### A. Proxy list rotation

Extend the existing single `PLAYWRIGHT_PROXY` env var to support a list of proxies with automatic rotation:

```env
# Single proxy (existing behaviour)
PLAYWRIGHT_PROXY=socks5://user:pass@proxy.example.com:1080

# Proxy list file (new)
PLAYWRIGHT_PROXY_LIST=/path/to/proxies.txt   # one proxy URL per line

# Rotation strategy
PLAYWRIGHT_PROXY_ROTATION=random             # random | round-robin | sticky-per-domain
```

The fetcher selects a proxy per request (or per domain, in sticky mode) from the list. Failed requests with a given proxy automatically retry with a different one.

#### B. Residential proxy service integration

Document and test integration with the major residential proxy providers — all expose a standard SOCKS5/HTTP endpoint so no custom code is needed beyond the proxy rotation above:

| Provider | Protocol | Notes |
|---|---|---|
| Bright Data | SOCKS5 / HTTP | Largest residential pool; per-GB billing |
| Oxylabs | SOCKS5 / HTTP | Good geo-targeting; per-GB billing |
| Smartproxy | SOCKS5 / HTTP | Lower cost; good for general crawling |
| IPRoyal | SOCKS5 / HTTP | Cheapest residential tier |
| Tor | SOCKS5 (`127.0.0.1:9050`) | Free; slow; many sites block Tor exit nodes |

Provide a config example and a short setup guide in the README for each. The tool just needs a working SOCKS5/HTTP URL — the user manages credentials and billing.

#### C. Proxy health checking

Add a `proxy_check` MCP tool (and CLI command) that tests each proxy in the list against a known endpoint and reports latency, success rate, and detected IP geolocation. Removes dead proxies from the rotation automatically after N consecutive failures.

#### D. Per-domain proxy pinning

For crawls that must use a consistent IP for session continuity (e.g. sites that rate-limit by IP), allow pinning a specific proxy to a domain in config:

```env
PLAYWRIGHT_PROXY_PINS={"docs.example.com": "socks5://user:pass@proxy1.example.com:1080"}
```

#### What this does and doesn't solve

| Scenario | Layer 1 (stealth plugin) | Layer 2 (residential proxy) | Both |
|---|:---:|:---:|:---:|
| Cloudflare JS challenge | ✅ | ❌ | ✅ |
| Cloudflare IP reputation block | ❌ | ✅ | ✅ |
| Akamai behavioural detection | Partial | ❌ | ✅ |
| Datadome | ✅ | ❌ | ✅ |
| Simple user-agent checks | ✅ | ❌ | ✅ |
| Datacentre IP range block | ❌ | ✅ | ✅ |
| CAPTCHA (hCaptcha, reCAPTCHA) | ❌ | ❌ | ❌ |

CAPTCHA solving is explicitly out of scope — it requires a third-party solving service and raises ethical/legal questions beyond the scope of this tool. See [Moat 1: CAPTCHA Bypass](#moat-1-captcha-bypass).

**Comparators with stronger stealth:** Crawl4AI (3-tier anti-bot), Browserbase (paid stealth mode with managed residential IPs)

---

### 5. robots.txt Compliance Option

**Gap:** The server does not check or respect `robots.txt`. The official Anthropic MCP fetch server enforces this by default. Some deployment environments (corporate, research) may require compliance.

**Proposed change:** Add a `RESPECT_ROBOTS_TXT` environment variable (default `false` for backwards compatibility). When enabled, fetch and parse `robots.txt` for the target domain before each request and block disallowed paths. Cache parsed `robots.txt` per domain with a longer TTL (e.g. 1 hour). The crawl worker (see [Gap 3](#3-site-crawling-and-mapping)) also respects this setting.

**Comparators with this feature:** Official MCP Fetch (enforced by default), Firecrawl MCP, Crawl4AI

---

### 6. CSS Selector Targeting

**Gap:** Content extraction uses a fixed priority chain (`<main>` > `<article>` > `#content` > `.content` > `<body>`). Jina Reader supports explicit `X-Target-Selector` and `X-Remove-Selector` headers for precise targeting.

**Proposed change:** Add optional `includeSelector` and `excludeSelectors` parameters to `fetch_url`. When supplied, scope extraction to the matched element(s) and strip the excluded elements before conversion. Useful for sites where the fixed priority chain picks the wrong region, and as a building block for Phase 1 of schema-based extraction (see [Gap 2](#2-structured-json-extraction)).

**Comparators with this feature:** Jina Reader, Firecrawl MCP, Crawl4AI

---

### 7. Multi-Browser Support

**Gap:** Only Chromium is supported. Playwright MCP supports Chrome, Firefox, WebKit (Safari), and Edge.

**Proposed change:** Add a `PLAYWRIGHT_BROWSER` environment variable accepting `chromium` (default), `firefox`, or `webkit`. Some sites render differently or are blocked only on Chromium — having a fallback browser is useful. Note: the stealth plugin (see [Gap 4, Layer 1](#layer-1-browser-fingerprint-stealth-js-based-detection)) is Chromium-specific; Firefox and WebKit would run without it.

**Comparators with this feature:** Playwright MCP, Crawl4AI

---

### 8. Authentication / Cookie Passthrough

**Gap:** There is no way to fetch authenticated pages without a full browser session. Jina Reader supports `X-Set-Cookie` header forwarding; Browserbase supports persistent authenticated sessions.

**Proposed change:** Add an optional `cookies` parameter to `fetch_url` (array of `{ name, value, domain }` objects) and a `storageState` parameter (path to a Playwright storage state JSON file) for full session replay. This covers the common case of fetching a page behind a login without requiring a stateful session.

For full multi-step login flows and interactive authenticated pages that cannot be handled by replaying a storage state file, see [Moat 2: Stateful Interactive Browser Sessions](#moat-2-stateful-interactive-browser-sessions).

**Comparators with this feature:** Jina Reader (`X-Set-Cookie`), Browserbase (session persistence), Firecrawl MCP, Crawl4AI

---

### 9. Multiple Output Formats

**Gap:** The server always returns markdown. Jina Reader can return raw HTML, plain text, screenshots, and full-page images.

**Proposed change:** Add an optional `outputFormat` parameter to `fetch_url` accepting:

- `markdown` (default) — current behaviour
- `html` — raw cleaned HTML before markdown conversion
- `text` — plain text, whitespace-normalised
- `screenshot` — base64 PNG of the full rendered page

The `screenshot` format is the foundation for visual extraction use cases (see [Moat 3: Visual / Screenshot-Based Extraction](#moat-3-visual--screenshot-based-extraction)) — the agent can pass the returned PNG to a vision LLM for content extraction from pages where the DOM does not faithfully represent the content.

**Comparators with this feature:** Jina Reader, Firecrawl MCP, Crawl4AI

---

### 10. Retry and Back-off Logic

**Gap:** Failed requests are not retried. Firecrawl has configurable exponential back-off with a `maxRetries` parameter.

**Proposed change:** Add `FETCH_MAX_RETRIES` (default `2`) and `FETCH_RETRY_DELAY_MS` (default `1000`) environment variables. Implement exponential back-off with jitter for transient failures (network errors, 429, 503). Log retry attempts at warn level. The crawl worker (see [Gap 3](#3-site-crawling-and-mapping)) uses the same retry logic, with per-page `retry_count` tracked in SQLite.

**Comparators with this feature:** Firecrawl MCP, Crawl4AI

---

## Making Firecrawl Obsolete

Firecrawl is the most feature-rich competitor in this space and the most commonly reached-for tool for web-to-markdown pipelines. This section analyses whether `markdown-for-agents-mcp` can realistically displace it for most users, and what that would require.

### What Firecrawl's moat actually is

Firecrawl has three genuine advantages that are hard to replicate without infrastructure investment:

1. **Cloud-managed stealth and IP rotation** — Firecrawl runs requests through a managed browser farm with residential proxies and Cloudflare bypass. This is infrastructure, not just code. See [Gap 4](#4-anti-bot--stealth-improvements) for the local equivalent using proxy list rotation.
2. **Async long-running crawl jobs** — Firecrawl crawls run asynchronously; callers poll for completion via job ID. See [Async Job Execution and Resumable Crawls](#async-job-execution-and-resumable-crawls) for the local equivalent using tmux + SQLite, which is argued to be superior in several respects.
3. **Enterprise reliability at scale** — rate limiting, retries, queuing, and observability are handled server-side. For high-volume crawls this matters. See [Addressing the Reliability Moat](#addressing-the-reliability-moat).

Everything else Firecrawl offers is implementable locally.

### What this project already has that Firecrawl doesn't

These are existing differentiators that make a compelling case for self-hosted users:

- **Zero cost** — no API key, no credit consumption, no rate limits from a third party
- **TypeScript/Node.js native** — no Python or Docker dependency; installs with `npm install`
- **In-process LRU cache** — avoids re-fetching the same URL within a session; Firecrawl has no equivalent exposed at the tool level
- **`download_file` tool** — binary download to local path; absent from Firecrawl
- **Streamable HTTP mode with bearer-token auth** — can be deployed as a shared team server; Firecrawl's MCP server is stdio-only
- **Full local execution** — data never leaves the machine; important for sensitive or proprietary content

### On "NL agent mode" — why this isn't actually a gap

Firecrawl's `firecrawl_agent` accepts a plain English task and autonomously navigates, clicks, and extracts. At first glance this looks like a hard-to-replicate product feature. It isn't.

**The MCP integration *is* the NL agent mode.** When Claude (or any MCP-capable agent) receives a natural language instruction like "find all the pricing plans on this site and extract them as JSON", it calls `fetch_url`, `crawl_site`, `web_search`, and `fetch_urls` in whatever sequence the task requires. The intelligence lives in the agent layer, not the tool layer. This is a better architecture — the agent adapts its strategy dynamically rather than being locked into Firecrawl's fixed autonomous loop.

This also means any improvement to the MCP tools (better markdown quality, schema extraction, crawling) directly improves the agent's capability without any agent-side changes.

### The four features that would close the gap

Closing ~90% of Firecrawl's functional advantage requires implementing four things, all achievable without cloud infrastructure:

#### 1. Site crawling (`crawl_site` / async job API)

This is Firecrawl's most-used feature for RAG ingestion pipelines. A depth-limited BFS crawler using the existing Playwright fetcher and the existing domain blocklist/allowlist infrastructure would cover most use cases. For large sites, the async job system (tmux + SQLite) provides parity with Firecrawl's async model. See [Gap 3](#3-site-crawling-and-mapping) and [Async Job Execution and Resumable Crawls](#async-job-execution-and-resumable-crawls).

#### 2. Schema-based structured extraction

Firecrawl's `extract` tool turns a page into a typed JSON object against a user-supplied schema. Implement CSS/XPath-based extraction first (no LLM required, covers most structured pages), then add LLM-assisted extraction as an optional enhancement for unstructured content. See [Gap 2](#2-structured-json-extraction).

#### 3. Stealth improvements

The current anti-bot posture fails against Cloudflare and similar. Integrating `playwright-extra` with the stealth plugin covers JS-based detection; proxy list rotation with a residential proxy service covers IP reputation blocking. See [Gap 4](#4-anti-bot--stealth-improvements).

#### 4. Retry and back-off

Firecrawl's reliability story depends partly on transparent retries. Adding configurable exponential back-off with jitter removes one of the last remaining reliability objections. See [Gap 10](#10-retry-and-back-off-logic).

### Async Job Execution and Resumable Crawls

Firecrawl's async model (start crawl → get job ID → poll status → retrieve results) is one of its most practically important features for large sites. The equivalent can be built locally using **tmux + SQLite**, giving parity without cloud infrastructure and with additional advantages.

#### Design

**Job lifecycle:**

1. Agent (or CLI user) calls `crawl_start` with a root URL and options → receives a `jobId` (UUID) and a tmux session name
2. The MCP server spawns a tmux session running the crawl worker process
3. Agent can call `crawl_status(jobId)` at any time to get progress (pages fetched, queued, failed, estimated completion)
4. Agent calls `crawl_results(jobId, offset, limit)` to page through completed results as they arrive — no need to wait for the full crawl to finish
5. `crawl_stop(jobId)` sends SIGTERM to the tmux session; state is persisted so the crawl can be resumed
6. `crawl_resume(jobId)` relaunches the tmux session; the worker reads SQLite state and skips already-visited URLs

**SQLite schema (one database per job, stored in `~/.markdown-mcp/jobs/<jobId>.db`):**

```sql
-- Job metadata
CREATE TABLE job (
  id TEXT PRIMARY KEY,
  root_url TEXT NOT NULL,
  status TEXT NOT NULL,        -- queued | running | paused | completed | failed
  options TEXT NOT NULL,       -- JSON: maxDepth, includePatterns, excludePatterns, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- URL queue and results
CREATE TABLE pages (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL,        -- queued | fetching | done | failed | skipped
  depth INTEGER NOT NULL,
  discovered_at INTEGER NOT NULL,
  fetched_at INTEGER,
  markdown TEXT,               -- NULL until fetched
  title TEXT,
  error TEXT,                  -- NULL unless failed
  retry_count INTEGER DEFAULT 0
);

-- Index for efficient status polling
CREATE INDEX idx_pages_status ON pages(status);
```

**MCP tools exposed:**

| Tool | Input | Output |
|---|---|---|
| `crawl_start` | `url`, `maxDepth`, `maxPages`, `includePatterns`, `excludePatterns`, `fetchContent`, `delay` | `jobId`, `sessionName` |
| `crawl_status` | `jobId` | `status`, `queued`, `fetching`, `done`, `failed`, `skipped`, progress % |
| `crawl_results` | `jobId`, `offset`, `limit`, `status` filter | Array of `{ url, title, markdown, fetchedAt }` |
| `crawl_stop` | `jobId` | Confirmation, final counts |
| `crawl_resume` | `jobId` | New `sessionName`, counts of remaining URLs |
| `crawl_list` | — | All jobs with status summary |
| `crawl_delete` | `jobId` | Removes SQLite DB and cleans up |

**CLI interface:**

The same SQLite job store is accessible via a CLI command (`markdown-mcp crawl`) for users who prefer not to go through an agent:

```bash
# Start a crawl
markdown-mcp crawl start https://docs.example.com --max-depth 3

# Watch live progress (attaches to tmux session)
markdown-mcp crawl attach <jobId>

# Check status without attaching
markdown-mcp crawl status <jobId>

# Export results to JSONL or individual markdown files
markdown-mcp crawl export <jobId> --format jsonl --output ./results/

# Resume a stopped crawl
markdown-mcp crawl resume <jobId>

# List all jobs
markdown-mcp crawl list
```

#### Why this is better than Firecrawl's async model

| Aspect | Firecrawl | This design |
|---|---|---|
| Job persistence | Cloud server (lost if they have an outage) | Local SQLite (survives machine reboots) |
| Resume after stop | Yes (cloud-managed) | Yes (skip visited URLs from SQLite) |
| Results inspection | API only | SQLite — queryable with any SQL tool |
| Progress visibility | API polling | tmux attach — watch it happen live |
| Cost per page | Credit-based | Free |
| Data locality | Firecrawl's servers | Local disk only |
| Partial results | Via polling | Immediately queryable as pages complete |
| Export formats | API response | JSONL, individual `.md` files, SQLite direct |

#### Implementation notes

- The crawl worker is a separate Node.js process (not the MCP server process) so it survives MCP session termination
- tmux is assumed to be available; the CLI should check and warn if not installed
- Job IDs are UUIDs; the SQLite file path is deterministic (`~/.markdown-mcp/jobs/<jobId>.db`) so they are portable
- The worker uses the retry/back-off logic from [Gap 10](#10-retry-and-back-off-logic) with `retry_count` tracked per page in SQLite
- The worker respects the existing domain blocklist/allowlist configuration and `RESPECT_ROBOTS_TXT` (see [Gap 5](#5-robotstxt-compliance-option))
- Politeness controls: configurable `delay` between requests (default 500 ms), `maxConcurrency` (default 3 workers per job)
- The MCP `crawl_results` tool supports streaming via the existing Streamable HTTP transport

### Addressing the Reliability Moat

Firecrawl's managed infrastructure moat has two components: distributed queuing and SLA-backed uptime. Both are addressable locally for the vast majority of use cases.

**Concurrency and queuing** are already designed into the async crawl proposal. The SQLite queue + configurable `maxConcurrency` per job is functionally equivalent to Firecrawl's queuing model. The worker pulls URLs from the queue and processes them in parallel batches; new URLs discovered during crawling are inserted into the same queue. No external message broker is needed.

**Process reliability** is handled by tmux — the crawl worker survives MCP session termination, network drops, and Claude context resets. Combined with SQLite-backed resumability (skip already-visited URLs on restart), this matches Firecrawl's reliability story for all practical purposes outside of enterprise SLAs.

**What remains genuinely hard to replicate locally:**

- *Distributed crawling across multiple machines* — partially addressable by running multiple worker processes pointing at the same SQLite DB on a shared volume (NFS, network mount). Not a first-class feature but viable for power users.
- *SLA-backed uptime* — irrelevant for self-hosted tools where the user controls the machine.

**Large crawl scalability** (10k+ pages) requires a few additional constraints to avoid resource exhaustion on a single machine:

- Stream markdown to disk immediately rather than buffering in memory — already implied by the SQLite design (markdown stored per row as it arrives)
- Add a `maxPages` cap per job (configurable, default e.g. 5000)
- Optional gzip compression of stored markdown in SQLite for large crawls
- Configurable `delay` between requests (default 500 ms) to avoid hammering targets and triggering rate limits

With these in place, the local design is viable for crawls up to tens of thousands of pages. Firecrawl's infrastructure advantage only becomes meaningful at millions of pages or when 99.9% uptime SLAs are contractually required — neither of which is a typical use case for an MCP-integrated developer tool.

---

## Recommended Implementation Order

To maximise impact per unit of effort, across all gaps:

| Priority | Gap | Feature | Effort | Impact |
| --- | --- | --- | --- | --- |
| 1 | Gap 4 (Layer 1) | Stealth: `playwright-extra` fingerprint plugin | Low | High — unblocks many currently-failing sites immediately |
| 2 | Gap 10 | Retry and back-off | Low | High — removes reliability objection; needed by crawl worker |
| 3 | Gap 3 (Phase 1) | Synchronous `crawl_site` tool | Medium | Very high — closes the biggest functional gap |
| 4 | Gap 2 (Phase 1) | Schema extraction: CSS/XPath-based | Medium | High — enables data pipeline use cases without LLM dependency |
| 5 | Gap 3 (Phase 2) | Async crawl jobs: tmux + SQLite | Medium-High | Very high — matches Firecrawl's async model; unlocks large-site crawling |
| 6 | Gap 4 (Layer 2) | Stealth: proxy list rotation + residential proxy docs | Medium | High — closes IP reputation gap for users with proxy subscriptions |
| 7 | Gap 9 | Multiple output formats (html, text, screenshot) | Low-Medium | Medium — unlocks visual extraction path via agent |
| 8 | Gap 6 | CSS selector targeting | Low | Medium — improves extraction accuracy; building block for Gap 2 |
| 9 | Gap 8 | Auth / cookie passthrough (`storageState`) | Low-Medium | Medium — unblocks authenticated page fetching without full sessions |
| 10 | Gap 5 | robots.txt compliance option | Low | Low-Medium — compliance requirement for some deployments |
| 11 | Gap 1 | Content pagination | Low | Low-Medium — niche need; most agents re-call with refined queries |
| 12 | Gap 7 | Multi-browser support (Firefox, WebKit) | Low | Low — edge case; Chromium covers >95% of sites |
| 13 | Gap 2 (Phase 2) | Schema extraction: LLM-assisted | High | Medium — covers complex/unstructured pages |
| 14 | Moat 2 | Stateful browser sessions (`session_*` tools) | High | High — unlocks login flows and interactive SPAs |

Completing priorities 1–6 would make `markdown-for-agents-mcp` the preferred choice over Firecrawl for any team that values local execution, zero cost, data privacy, or TypeScript-native deployment — which describes the majority of individual developers and small teams.

---

## Remaining Moats After All Planned Work

This section catalogues what competitors would still do better after everything in this document is implemented. These are not gaps to necessarily close — some are out of scope by design, some require third-party infrastructure, and some represent genuinely different product categories. The purpose is to be honest about where the ceiling is.

---

### Moat 1: CAPTCHA Bypass

**Who has it:** Firecrawl (via integrations), Browserbase (via third-party solvers)

**What it is:** Automated solving of hCaptcha, reCAPTCHA v2/v3, Cloudflare Turnstile, and similar challenges. Firecrawl integrates with services like 2captcha and Anti-Captcha; Browserbase can route CAPTCHA challenges to human solvers.

**Why it's hard to close:**

- Requires a third-party solving service (2captcha, Anti-Captcha, CapSolver) — adds a paid dependency
- reCAPTCHA v3 is score-based and largely unsolvable without genuine human-like behaviour over time
- Raises ethical and legal questions (ToS violations, potential CFAA exposure depending on jurisdiction)

**Verdict:** Explicitly out of scope. The right answer for a page that requires CAPTCHA solving is to use a browser session with real user credentials (see [Moat 2](#moat-2-stateful-interactive-browser-sessions)) rather than automated bypassing. Document this limitation clearly in the README.

---

### Moat 2: Stateful Interactive Browser Sessions

**Who has it:** Playwright MCP, Browserbase, Firecrawl (`firecrawl_interact`)

**What it is:** A persistent browser session where the agent can issue a sequence of actions — navigate, click a button, fill a form, wait for a response, extract content — across multiple tool calls. The browser state (cookies, localStorage, DOM) persists between calls.

**Why it requires a significant design change:**

The current architecture is deliberately stateless: each `fetch_url` call spawns a fresh Playwright page, extracts content, and closes. This is the right design for content retrieval — it is simple, safe, and cache-friendly. Stateful sessions require a fundamentally different model:

- A `session_create` tool that opens a browser context and returns a `sessionId`
- Subsequent tools (`session_click`, `session_type`, `session_navigate`, `session_extract`) operate on the live session
- A `session_close` tool that tears it down
- Session state must survive across MCP tool calls, which means the server must hold open browser contexts in memory between calls

Note: simple authenticated fetching (supplying cookies or a storage state file) is covered by [Gap 8](#8-authentication--cookie-passthrough) and does not require stateful sessions.

**What stateful sessions unlock beyond Gap 8:**

- Multi-step login flows where the login form itself requires interaction (JS-rendered fields, OTP entry, CAPTCHA-gated login pages)
- SPAs that require user interaction to reveal content (infinite scroll, tab navigation, accordion sections)
- Wizard-style pages where content only appears after completing steps
- Multi-page form submission workflows

**Verdict:** A meaningful scope expansion but achievable. It is a separate tool family (`session_*`) that runs alongside the existing stateless tools rather than replacing them. The stateless tools remain preferred for simple content retrieval; session tools are for pages that cannot be fetched otherwise. Implement after priorities 1–6 are complete.

**Implementation sketch:**

- Session store: a `Map<sessionId, BrowserContext>` held in the MCP server process
- Session TTL: auto-close idle sessions after a configurable timeout (default 10 minutes)
- Tools: `session_create`, `session_navigate`, `session_click`, `session_type`, `session_scroll`, `session_wait`, `session_extract`, `session_screenshot`, `session_close`
- Storage state export: `session_save(sessionId, path)` saves Playwright storage state JSON for reuse; this state file can then be used with [Gap 8](#8-authentication--cookie-passthrough) for subsequent stateless fetches

---

### Moat 3: Visual / Screenshot-Based Extraction

**Who has it:** Browserbase, Jina Reader (pageshot), Firecrawl (screenshot mode)

**What it is:** Pages where the meaningful content is not in the DOM — canvas-rendered applications, PDF-like layouts, complex data visualisations, or pages where the visual structure is essential context. These require passing a screenshot to a vision LLM to extract meaning.

**Why it is only partially addressable:**

- Requires a vision-capable LLM call per page — adds latency and cost
- Screenshot fidelity matters: full-page screenshots of long pages need stitching
- Not useful for most pages; should be opt-in, not default

**What this looks like in practice:**

- `fetch_url` with `outputFormat: "screenshot"` (see [Gap 9](#9-multiple-output-formats)) returns a base64 PNG
- The agent receiving that screenshot can pass it to a vision LLM for extraction — no tool-side change needed
- Optionally, a `fetch_url` with `outputFormat: "vision-extract"` could do this automatically if a vision model endpoint is configured by the user

**Verdict:** Partially addressable. The screenshot output format (Gap 9) gets you 80% of the way — the agent can handle the vision extraction step using its own multimodal capabilities. A first-class `vision-extract` mode is a nice-to-have for pipelines that want it done inside the tool, deferred until after Gap 9 is implemented.

---

### Moat 4: Managed Cloud Infrastructure at Enterprise Scale

**Who has it:** Firecrawl, Browserbase, Jina Reader

**What it is:** When crawling millions of pages, a single local machine hits hard limits: CPU, memory, disk I/O, network bandwidth, and IP reputation. Cloud providers distribute this across fleets of machines, manage IP rotation automatically, and offer contractual SLAs.

**Why it cannot be fully closed locally:**

- IP fleet management (hundreds of residential exit nodes with automatic failover) is infrastructure, not software
- Distributed crawl coordination across multiple machines requires a proper job queue (Redis, SQS) not just SQLite on a shared volume
- 99.9% uptime SLAs require redundant infrastructure

**What can be done:**

- The tmux + SQLite design handles everything up to tens of thousands of pages on a single machine
- Multi-machine distribution is partially addressable with a shared SQLite DB on a network volume — viable for small teams
- Proxy list rotation ([Gap 4, Layer 2](#layer-2-ip-reputation-stealth-network-level-detection)) with a residential proxy service subscription bridges the IP fleet gap for most use cases
- For users who hit single-machine limits, document a migration path to running multiple worker instances

**Verdict:** This moat only matters at enterprise scale (millions of pages, SLA requirements). For the target audience — individual developers, small teams, AI agent pipelines — the local design is sufficient. Acknowledge the ceiling clearly in the documentation rather than trying to engineer around it.

---

### Summary: What Remains After All Planned Work

| Remaining moat | Addressable? | Recommended stance |
|---|---|---|
| CAPTCHA bypass | No (out of scope by choice) | Document limitation; recommend credential-based auth instead |
| Stateful browser sessions | Yes (significant effort) | Implement as `session_*` tool family — see priority 14 |
| Visual/screenshot extraction | Partially (agent handles it) | Implement screenshot output (priority 7); leave vision LLM to the agent |
| Enterprise-scale infrastructure | No (infrastructure problem) | Document ceiling; proxy rotation closes the gap for most users |

---

## Strengths to Preserve

These are areas where this project leads — any future changes should avoid regressing them.

- **Zero external SaaS dependency** — no API key, no credits, no rate limits from a third party.
- **TypeScript/Node.js native** — the only JS-native MCP server with full Playwright rendering; avoids Python environment requirements.
- **In-process LRU cache** — 50 MB HTML cache with 15-minute TTL; no external Redis or CDN needed.
- **Batch fetch + search in one server** — the `fetch_urls` + `web_search` (DuckDuckGo, hybrid content fetch) combination is unique among free local tools.
- **`download_file` tool** — binary download to local path; not found in any comparator.
- **Streamable HTTP mode** — can run as a network-accessible server with bearer-token auth, not just stdio.
- **Structured MCP output schemas** — every tool returns both `text` and `structuredContent` (Zod-typed JSON).
- **Full data locality** — nothing leaves the machine; critical for sensitive or proprietary content pipelines.
