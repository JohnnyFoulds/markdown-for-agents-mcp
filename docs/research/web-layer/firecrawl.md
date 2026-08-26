# Firecrawl: Web Crawl/Scrape/Extract Platform

> Research compiled August 2026. Sources: docs.firecrawl.dev, firecrawl.dev/pricing, raw GitHub source (docker-compose.yaml, .env.example), and independent third-party comparisons. All API schemas verified against the live v2 API reference.

---

## Table of Contents

1. [Overview and Strategic Context](#1-overview-and-strategic-context)
2. [AGPL-3.0 Licence Analysis](#2-agpl-30-licence-analysis)
3. [Complete API Surface](#3-complete-api-surface)
   - 3.1 /scrape
   - 3.2 /crawl
   - 3.3 /map
   - 3.4 /search
   - 3.5 /extract (legacy)
   - 3.6 /agent
   - 3.7 /parse
   - 3.8 /interact and /browser
   - 3.9 /monitor
   - 3.10 Batch Scrape
4. [Self-Hosted Docker Compose Deployment](#4-self-hosted-docker-compose-deployment)
5. [LLM Extraction Mode](#5-llm-extraction-mode)
6. [Crawl Configuration Deep-Dive](#6-crawl-configuration-deep-dive)
7. [Webhook and Async Delivery](#7-webhook-and-async-delivery)
8. [JavaScript and Python SDKs](#8-javascript-and-python-sdks)
9. [Dynamic Sites and Playwright](#9-dynamic-sites-and-playwright)
10. [Non-HTML Content: PDF, DOCX, and Others](#10-non-html-content-pdf-docx-and-others)
11. [Performance, Concurrency, and Cost Model](#11-performance-concurrency-and-cost-model)
12. [Implementing a Firecrawl-Compatible /scrape in Node.js](#12-implementing-a-firecrawl-compatible-scrape-in-nodejs)
13. [Competitor Comparison](#13-competitor-comparison)
14. [Known Limitations, Issues, and Gotchas](#14-known-limitations-issues-and-gotchas)
15. [What to Build vs What to Skip](#15-what-to-build-vs-what-to-skip)

---

## 1. Overview and Strategic Context

Firecrawl (GitHub: firecrawl/firecrawl, formerly mendableai/firecrawl) is an HTTP API that converts URLs into clean, LLM-ready data. The company calls it "The Web Data API for AI" and it is backed by Y Combinator and a $14.5M Series A led by Nexus Venture Partners (August 2025). GitHub stars as of July 2026: 151,400, making it the most-starred tool in this category.

The product has two deployment paths:

- **Firecrawl Cloud** (`api.firecrawl.dev/v2`): fully managed, includes proprietary anti-bot (Fire-engine), the /agent, /interact, and /browser endpoints, and enterprise controls.
- **Open Source Self-Host** (AGPL-3.0): the core scraping engine running on Docker Compose. Does not include Fire-engine, /agent, or /browser. LLM-backed features (/extract, JSON mode) require you to wire in your own OpenAI-compatible provider.

**Why this matters for markdown-for-agents-mcp:**
- We cannot embed the Firecrawl core engine without triggering AGPL copyleft (see Section 2).
- We **can** call the Firecrawl Cloud API from our MCP server as a client — this triggers no AGPL obligations.
- We **can** self-host Firecrawl as a sidecar and proxy to it, and keep our own code MIT-licensed, if (and only if) we do not modify Firecrawl's source.
- The API surface is the canonical reference for what a production web-scraping API should look like. We should implement a compatible subset.

---

## 2. AGPL-3.0 Licence Analysis

Source: github.com/firecrawl/firecrawl/blob/main/LICENSE (confirmed AGPL-3.0), and the README which explicitly documents the licence split.

### The Split

| Component | Licence |
|---|---|
| Core engine (`apps/api`, `apps/playwright-service-ts`) | AGPL-3.0 |
| JavaScript SDK (`firecrawl-js`) | MIT |
| Python SDK (`firecrawl-py`) | MIT |
| MCP server (`firecrawl-mcp-server`) | MIT |
| CLI | MIT |
| UI components / docs | MIT |

### What AGPL-3.0 Triggers

AGPL-3.0 is the strongest copyleft licence. It extends GPL's network use clause: if you **run a modified version of the software as a network service** that users interact with, you must provide the complete source of your modifications under AGPL-3.0 to those users.

Scenarios by risk level:

| Scenario | Risk | Verdict |
|---|---|---|
| Call Firecrawl Cloud API from our MIT MCP server | None — we are a client calling a third-party service | Safe |
| Self-host unmodified Firecrawl via Docker, our server proxies to it | AGPL applies to Firecrawl's own code, not ours. Unmodified copy means no disclosure obligations beyond Firecrawl's own source already being public. | Safe |
| Embed Firecrawl source directly in our codebase | AGPL copyleft propagates — our entire modified work must be AGPL | **AVOID** |
| Fork and modify Firecrawl, serve it as a service | Must release all modifications under AGPL | **AVOID** |
| Run Firecrawl in Docker for internal use only (no public access) | AGPL does not require source disclosure for purely internal services. But "internal" must mean no external users. | Likely safe (seek legal advice for SaaS) |

### Commercial Licence Option

Firecrawl offers a commercial (enterprise) licence for organisations that need to:
- Modify the engine without AGPL source disclosure.
- Embed it in a commercial product.
- Get SLA and dedicated support.

Contact: enterprise section at firecrawl.dev. No public pricing for the commercial licence — it is negotiated.

### Recommended Position for Our Project

Use the Cloud API as a backend option. For the self-hosted path, self-host an unmodified Firecrawl Docker stack as a sidecar — our MCP server code stays MIT. Never copy or modify Firecrawl's engine source directly.

---

## 3. Complete API Surface

All endpoints are at `https://api.firecrawl.dev/v2/`. Auth: `Authorization: Bearer fc-YOUR_API_KEY` header. No API key is required for basic scrape/search/interact on the keyless free tier (rate-limited by IP).

### 3.1 /scrape

**POST /v2/scrape**

The fundamental unit. Takes a single URL and returns clean data in one or more formats synchronously.

#### Request schema

```typescript
interface ScrapeRequest {
  // Required
  url: string;

  // Output formats — string names or format objects
  formats?: (
    | 'markdown'
    | 'html'
    | 'rawHtml'
    | 'links'
    | 'images'
    | 'summary'
    | 'branding'
    | 'product'
    | 'audio'
    | 'video'
    | { type: 'json'; prompt?: string; schema?: JSONSchema }
    | { type: 'screenshot'; fullPage?: boolean; quality?: number; viewport?: { width: number; height: number } }
    | { type: 'changeTracking'; modes?: ('json' | 'git-diff')[]; tag?: string; schema?: JSONSchema; prompt?: string }
    | { type: 'attributes'; selectors: Array<{ selector: string; attribute: string }> }
  )[];  // Default: ['markdown']

  // Content filtering
  onlyMainContent?: boolean;  // Default: true — strips nav, footer, ads
  onlyCleanContent?: boolean; // Default: false
  includeTags?: string[];     // CSS selectors to include
  excludeTags?: string[];     // CSS selectors to exclude

  // Cache control
  maxAge?: number;   // ms — return cached if fresher (default: 172800000 = 2 days)
  minAge?: number;   // ms — return cached if older than this
  storeInCache?: boolean; // Default: true

  // Request customisation
  headers?: Record<string, string>;  // Custom request headers (e.g. cookies, auth)
  mobile?: boolean;           // Default: false — emulate mobile viewport/UA
  skipTlsVerification?: boolean;
  timeout?: number;           // ms, default 60000, min 1000

  // Location / geotargeting
  location?: {
    country?: string;   // ISO 3166-1 alpha-2, default 'US'
    languages?: string[]; // e.g. ['en-US']
  };

  // JavaScript rendering
  waitFor?: number;   // ms extra wait before scraping (on top of smart-wait)
  actions?: Action[]; // Browser actions to run before scraping

  // Document parsing
  parsers?: ('pdf' | { type: 'pdf'; mode?: 'auto' | 'fast' | 'ocr'; maxPages?: number; pages?: boolean; blocks?: boolean; pageMarkers?: boolean })[];

  // Proxy
  proxy?: 'auto' | 'basic' | 'stealth' | 'none';

  // Privacy and security
  removeBase64Images?: boolean; // Default: true
  blockAds?: boolean;           // Default: true
  lockdown?: boolean;           // Default: false — lockdown mode (see 3.1.1)
  redactPII?: boolean;          // Default: false — PII redaction (+4 credits)
  zeroDataRetention?: boolean;  // Default: false
  threatProtection?: {
    riskScoreThreshold?: number;  // 0–100
    blacklist?: string[];
    whitelist?: string[];
    blockedTlds?: string[];
  };
}
```

#### Actions reference

Actions run in order before the final scrape. Combined wait time (waitFor + all wait actions) must not exceed 60 seconds. Maximum 50 actions per request.

```typescript
type Action =
  | { type: 'wait'; milliseconds?: number; selector?: string }  // wait ms OR wait for element
  | { type: 'click'; selector: string; all?: boolean }
  | { type: 'type'; selector: string; text: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'screenshot' }  // Take a screenshot mid-action sequence
  | { type: 'executeJavaScript'; script: string }
  | { type: 'press'; key: string }  // e.g. 'Enter', 'Escape'
  | { type: 'select'; selector: string; value: string }
  | { type: 'focus'; selector: string }
  | { type: 'hover'; selector: string }
  | { type: 'navigate'; url: string }
```

#### Response

```typescript
interface ScrapeResponse {
  success: boolean;
  data: {
    markdown?: string;
    html?: string;        // Cleaned HTML
    rawHtml?: string;     // Original HTML
    screenshot?: string;  // URL (expires 24 hours)
    audio?: string;       // Signed GCS URL (expires 1 hour)
    video?: string;       // Signed GCS URL (expires 1 hour)
    answer?: string;      // For query format
    highlights?: string;
    links?: string[];
    summary?: string;
    json?: object;        // Structured extraction result
    pages?: Array<{ pageNumber: number; markdown: string }>;  // PDF per-page
    blocks?: Array<{...}>;  // PDF layout blocks
    actions?: {
      screenshots?: string[];
      scrapes?: Array<{ url: string; html: string }>;
      javascriptReturns?: Array<{ type: string; value: unknown }>;
      pdfs?: string[];
    };
    metadata: {
      title?: string;
      description?: string;
      language?: string;
      sourceURL: string;
      url?: string;
      keywords?: string;
      ogTitle?: string;
      ogDescription?: string;
      ogUrl?: string;
      ogImage?: string;
      ogSiteName?: string;
      ogLocaleAlternate?: string[];
      statusCode: number;
      numPages?: number;
      totalPages?: number;
      contentType?: string;
      error?: string;
      scrapeId?: string;
      concurrencyLimited?: boolean;
      concurrencyQueueDurationMs?: number;
    };
    warning?: string;
    changeTracking?: {
      previousScrapeAt: string;  // ISO 8601
      changeStatus: 'new' | 'changed' | 'same';
      visibility: 'visible' | 'not-visible';
      diff?: string;
      json?: object;
    };
    branding?: { colorScheme: 'light' | 'dark'; logo?: string; colors?: {...}; fonts?: [...]; typography?: {...} };
  };
}
```

#### Credit costs for /scrape

| Feature | Additional credits |
|---|---|
| Base scrape | 1 |
| JSON mode | +4 |
| query / highlights formats | +4 per format |
| PII redaction | +4 |
| PDF page parsing | +1 per PDF page |
| audio or video extraction | +4 |

### 3.2 /crawl

**POST /v2/crawl** — starts a job, returns job ID  
**GET /v2/crawl/{id}** — poll status and paginated results  
**POST /v2/crawl/{id}/params-preview** — dry-run without launching  
**DELETE /v2/crawl/{id}** — cancel  
**GET /v2/crawl/{id}/errors** — pages Firecrawl failed to scrape  
**GET /v2/crawl/active** — list active crawls for the account

#### Request schema

```typescript
interface CrawlRequest {
  url: string;          // Starting URL (seed)

  // Scope control
  crawlEntireDomain?: boolean;    // Default: false
  allowSubdomains?: boolean;      // Default: false
  allowExternalLinks?: boolean;   // Default: false
  maxDiscoveryDepth?: number;     // Link depth limit from seed

  // URL filtering
  includePaths?: string[];        // Glob/regex patterns to include
  excludePaths?: string[];        // Glob/regex patterns to exclude
  ignoreQueryParameters?: boolean; // Default: false
  regexOnFullURL?: boolean;       // Default: false — apply regex to full URL vs path only

  // Sitemap behaviour
  sitemap?: 'include' | 'only' | 'ignore';  // Default: 'include'

  // Rate control
  delay?: number;         // ms delay between requests
  maxConcurrency?: number; // Max concurrent page fetches

  // Limits
  limit?: number;    // Max pages to crawl (default: 10000)

  // robots.txt
  ignoreRobotsTxt?: boolean;  // Default: false
  robotsUserAgent?: string;   // Custom UA for robots.txt fetching

  // NL-guided crawl
  prompt?: string;    // Natural language description of what to collect

  // Per-page scrape options
  scrapeOptions?: ScrapeOptions;  // All /scrape params except url

  // Privacy
  zeroDataRetention?: boolean;

  // Webhook
  webhook?: WebhookConfig;
}
```

#### Crawl status response

```typescript
interface CrawlStatusResponse {
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  creditsUsed: number;
  expiresAt: string;  // ISO — results expire 24 hours after completion
  next?: string;      // URL for next page of results (>10MB pagination)
  data: ScrapeDocument[];
}
```

**Important:** crawl results are paginated in 10MB chunks. SDKs handle this automatically. Direct API callers must follow `next` URLs manually. Results expire 24 hours after completion.

**Credit check before start:** Firecrawl checks you have enough credits to cover `limit` pages before starting. If not, it returns HTTP 402. Set a realistic `limit` to avoid this.

### 3.3 /map

**POST /v2/map**

Fast URL discovery without scraping page content. Uses sitemap + SERP index + previously crawled pages.

```typescript
interface MapRequest {
  url: string;
  search?: string;                // NL query to filter/rank results
  sitemap?: 'include' | 'only' | 'ignore';  // Default: 'include'
  includeSubdomains?: boolean;    // Default: true
  ignoreQueryParameters?: boolean; // Default: true
  ignoreCache?: boolean;          // Default: false
  limit?: number;                 // Default: 5000 (max 50000)
  location?: LocationOptions;
  timeout?: number;               // Default: 60000
}

interface MapResponse {
  success: boolean;
  links: Array<{
    url: string;
    title?: string;
    description?: string;
  }>;
}
```

**Cost:** 1 credit per call regardless of result count (even limit: 100000 is 1 credit). Synchronous — returns immediately.

### 3.4 /search

**POST /v2/search**

Web search with optional full-page content retrieval per result.

```typescript
interface SearchRequest {
  query: string;
  limit?: number;           // Results per source type
  sources?: ('web' | 'news' | 'research' | 'github' | 'developer' | 'mixed')[];
  scrapeOptions?: ScrapeOptions;  // If set, scrapes each result page too

  // Domain filtering
  includeDomains?: string[];
  excludeDomains?: string[];

  // Time filtering
  after?: string;     // ISO date
  before?: string;    // ISO date

  // Other
  country?: string;   // ISO 3166-1 alpha-2
  safeSearch?: boolean;
  timeout?: number;
  highlights?: boolean;   // Default: true — include query-relevant highlights
  zeroDataRetention?: boolean;
}

interface SearchResponse {
  success: boolean;
  data: {
    web?: SearchResult[];
    news?: NewsResult[];
    images?: ImageResult[];
    research?: ResearchResult[];
    github?: GitHubResult[];
    developer?: DeveloperResult[];
  };
}

interface SearchResult {
  url: string;
  title: string;
  description: string;
  position: number;
  // Plus scrapeOptions result fields if scrapeOptions provided:
  markdown?: string;
  html?: string;
  // etc.
}
```

**Cost:** 2 credits per 10 results. If scrapeOptions is set, add 1 credit per result page scraped.

**Self-hosted note:** The search endpoint in the self-hosted stack requires a SearXNG instance. Set `SEARXNG_ENDPOINT` and optionally `SEARCHAPI_API_KEY` / `SEARCHAPI_ENGINE` in your environment. Without these, /search returns errors.

### 3.5 /extract (legacy — use /agent for new work)

**POST /v2/extract** — start extraction job  
**GET /v2/extract/{id}** — poll status  

The original LLM-based multi-URL extraction endpoint. Still functional but superseded by /agent. Takes a list of URLs (supporting `/*` wildcards for domain-wide crawl) and a prompt/schema.

```typescript
interface ExtractRequest {
  urls: string[];       // Supports wildcards: 'https://example.com/*'
  prompt?: string;      // NL description (required if no schema)
  schema?: JSONSchema;  // Required if no prompt
  enableWebSearch?: boolean;  // Follow links outside specified domains
  scrapeOptions?: ScrapeOptions;
}

interface ExtractResponse {
  success: boolean;
  id?: string;  // Job ID for polling
  status: 'processing' | 'completed' | 'failed' | 'cancelled';
  data?: object;   // The extracted structured data
  expiresAt?: string;
  warning?: string;
}
```

### 3.6 /agent

**POST /v2/agent** — start agent job  
**GET /v2/agent/{id}** — poll status

The AI-powered successor to /extract. Does not require URLs — just describe what you want and the agent autonomously searches, navigates, and extracts. Cloud-only (not available in self-hosted stack).

```typescript
interface AgentRequest {
  prompt: string;          // What to find/extract
  urls?: string[];         // Optional starting URLs
  schema?: JSONSchema | ZodSchema | PydanticModel;
  model?: 'spark-2' | 'spark-1-mini' | 'spark-1-pro';  // Default: spark-1-pro
  maxCredits?: number;     // Cost cap — agent stops when reached
  webhook?: WebhookConfig;
}
```

Agent models (as of July 2026):

| Model | Character | Best for |
|---|---|---|
| spark-1-mini | Fast, economical | Simple lookups, low-cost tasks |
| spark-1-pro | Default, balanced | Most use cases |
| spark-2 | Most capable | Complex multi-hop research |

Pricing: 5 free daily runs during preview, then dynamic (credit-based) pricing.

### 3.7 /parse

**POST /v2/parse** — multipart form upload  

Converts local files to markdown/JSON. Unlike /scrape, accepts file uploads rather than URLs.

```typescript
// Multipart form fields:
// file: binary file data
// options: JSON string with ScrapeOptions

interface ParseRequest {
  // Form field: options (JSON)
  formats?: OutputFormats[];
  parsers?: ParserOptions[];
  // Note: parse does NOT support: changeTracking, screenshot, branding,
  //       actions, waitFor, location, mobile
}

interface ParseResponse {
  success: boolean;
  data: {
    markdown: string;
    pages?: Array<{ pageNumber: number; markdown: string }>;
    blocks?: LayoutBlock[];
    metadata: {
      title?: string;
      numPages?: number;    // Pages actually parsed
      totalPages?: number;  // True document page count
      sourceFile?: string;
    };
    json?: object;
  };
}
```

**Supported file formats:** PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), OpenDocument (ODT/ODS/ODP), EPUB, CSV, HTML.

**Public URL shortcut:** `firecrawl.scrape("https://example.com/report.pdf")` auto-detects and parses documents — no need to download first.

### 3.8 /interact and /browser

Browser session management. Cloud-only.

**POST /v2/scrape** → scrape returns `metadata.scrapeId`  
**POST /v2/scrape/{scrapeId}/interact** — interact with that page  
**DELETE /v2/scrape/{scrapeId}/interact** — stop session  

Alternatively, standalone browser sessions (no prior scrape needed):  
**POST /v2/browser** — create standalone session  
**POST /v2/browser/{sessionId}/execute** — run code in session  
**GET /v2/browser** — list sessions  
**DELETE /v2/browser/{sessionId}** — delete session

Interact response includes:

```json
{
  "success": true,
  "cdpUrl": "wss://browser.firecrawl.dev/...",
  "liveViewUrl": "https://liveview.firecrawl.dev/...",
  "interactiveLiveViewUrl": "https://liveview.firecrawl.dev/...",
  "output": "The price is $1,199.00.",
  "exitCode": 0,
  "killed": false
}
```

**Cost:** 2 credits per browser minute.

### 3.9 /monitor

**POST /v2/monitor** — create monitor  
**GET /v2/monitor** — list monitors  
**GET /v2/monitor/{id}** — get monitor  
**PATCH /v2/monitor/{id}** — update monitor  
**DELETE /v2/monitor/{id}** — delete monitor  
**POST /v2/monitor/{id}/run** — trigger manual check  
**GET /v2/monitor/{id}/checks** — list check history  
**GET /v2/monitor/{id}/checks/{checkId}** — get specific check

Three target types: `scrape` (known URLs), `crawl` (entire sites), `search` (web-scale new result detection).

**Cost:** 1 credit per page per check.

### 3.10 Batch Scrape

**POST /v2/batch/scrape** — start batch  
**GET /v2/batch/scrape/{id}** — poll status  
**DELETE /v2/batch/scrape/{id}** — cancel  
**GET /v2/batch/scrape/{id}/errors** — pages that failed

Batch scrape accepts an array of URLs and applies the same ScrapeOptions to all of them. Supports webhook delivery of results as each page completes.

```typescript
interface BatchScrapeRequest {
  urls: string[];
  formats?: OutputFormats[];
  // ...all other ScrapeOptions...
  webhook?: WebhookConfig;
}
```

---

## 4. Self-Hosted Docker Compose Deployment

Source: `docker-compose.yaml` and `.env.example` from `github.com/mendableai/firecrawl`, verified by independent third-party execution report (v2.11.0, July 2026).

### Services

```yaml
services:
  api:          # Node.js API server, port 3002
  playwright-service:  # Headless browser pool
  redis:        # Job queues and rate limiting
  rabbitmq:     # Message broker (3.x with management UI)
  nuq-postgres: # Queue persistence (custom Postgres image)
  foundationdb: # Experimental alternative queue backend (opt-in via NUQ_BACKEND=fdb)
```

### Quick Start

```bash
git clone https://github.com/mendableai/firecrawl
cd firecrawl
# For USE_DB_AUTHENTICATION=false, runs completely without API keys:
docker compose up --build
# API available at http://localhost:3002
```

Build time: ~10 minutes on first run (Playwright downloads browser binaries).

### Resource Limits (from docker-compose.yaml)

| Service | CPU | Memory |
|---|---|---|
| api | 4.0 cores | 8 GB |
| playwright-service | 2.0 cores | 4 GB |
| redis | (no limits set) | (no limits set) |
| rabbitmq | (no limits set) | (no limits set) |

### Complete Environment Variable Reference

```bash
# === Required ===
NUM_WORKERS_PER_QUEUE=8          # Worker processes per queue (recommended: 4-8)
PORT=3002
HOST=0.0.0.0
REDIS_URL=redis://redis:6379
REDIS_RATE_LIMIT_URL=redis://redis:6379
PLAYWRIGHT_MICROSERVICE_URL=http://playwright-service:3000/scrape

# === Authentication ===
USE_DB_AUTHENTICATION=false  # Set true to require API keys (needs Supabase)
SUPABASE_ANON_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_TOKEN=
TEST_API_KEY=                # API key for testing when auth is enabled

# === LLM Features (required for JSON format, extract, etc.) ===
OPENAI_API_KEY=              # Or any OpenAI-compatible provider
OPENAI_BASE_URL=             # Override base URL (for local Ollama, etc.)
MODEL_NAME=                  # Model override
MODEL_EMBEDDING_NAME=
OLLAMA_BASE_URL=             # Alternative: use Ollama locally

# === Search (required for /search endpoint) ===
SEARXNG_ENDPOINT=            # URL of your SearXNG instance
SEARXNG_ENGINES=             # Comma-separated engine list
SEARXNG_CATEGORIES=
SEARCHAPI_API_KEY=           # Commercial search API alternative
SEARCHAPI_ENGINE=google      # google, bing, baidu, etc.

# === Concurrency ===
CRAWL_CONCURRENT_REQUESTS=10    # Concurrent pages (recommended: 8-32)
MAX_CONCURRENT_JOBS=5           # Simultaneous crawl jobs
BROWSER_POOL_SIZE=5             # Playwright browser instances

# === Proxy ===
PROXY_SERVER=
PROXY_USERNAME=
PROXY_PASSWORD=
BLOCK_MEDIA=                 # Block media requests to save proxy bandwidth

# === Worker tuning ===
EXTRACT_WORKER_PORT=3004
WORKER_PORT=3005
HARNESS_STARTUP_TIMEOUT_MS=60000

# === Queue backend (default: Postgres) ===
NUQ_BACKEND=                 # Set to 'fdb' for FoundationDB (experimental)
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
POSTGRES_HOST=nuq-postgres
POSTGRES_PORT=5432

# === Webhooks ===
SELF_HOSTED_WEBHOOK_URL=     # Global webhook URL for all jobs
SELF_HOSTED_WEBHOOK_HMAC_SECRET=  # HMAC verification secret

# === Observability ===
LOGGING_LEVEL=INFO           # NONE | ERROR | WARN | INFO | DEBUG | TRACE
SLACK_WEBHOOK_URL=           # Health status notifications
POSTHOG_API_KEY=             # Analytics
POSTHOG_HOST=

# === Optional integrations ===
LLAMAPARSE_API_KEY=          # LlamaParse for enhanced PDF parsing
SCRAPING_BEE_API_KEY=        # Fallback for JS-blocked sites
BULL_AUTH_KEY=@              # BullMQ dashboard auth

# === x402 Micropayments (experimental) ===
X402_ENABLED=true
X402_PAY_TO_ADDRESS=
X402_NETWORK=base-sepolia
X402_ENDPOINT_PRICE_USD=0.01
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# === Enterprise / Partner ===
SIEM_LOGGING_ENCRYPTION_KEY=   # 32 bytes as 64 hex chars
PARTNER_EGRESS_PROXY_URL=
RESEND_API_KEY=                # Transactional emails
```

### What is Missing from Self-Host vs Cloud

Per official docs (verified):

| Feature | Self-Host | Cloud |
|---|---|---|
| Core scrape, crawl, map | Included | Included |
| Search (/search) | Included (needs SearXNG) | Managed |
| JSON/LLM extraction | Included (needs your LLM key) | Managed |
| Playwright JS rendering | Included | Managed |
| Fire-engine (IP rotation, advanced anti-bot) | **NOT included** | Included |
| /agent endpoint | **NOT included** | Included |
| /browser / /interact standalone sessions | **NOT included** | Included |
| Managed dashboard | **NOT included** | Included |
| SSO, enterprise controls | **NOT included** | Enterprise plan |

The Fire-engine gap is significant for adversarial sites. The self-hosted Playwright service handles basic JS rendering but does not rotate IPs or defeat advanced bot detection.

### Alternative Images

The docker-compose.yaml includes commented `image:` directives if you do not want to build locally:

```yaml
# api:
#   image: ghcr.io/firecrawl/firecrawl
# playwright-service:
#   image: ghcr.io/firecrawl/playwright-service:latest
# nuq-postgres:
#   image: ghcr.io/firecrawl/nuq-postgres:latest
```

### Valkey as Redis Alternative

The docker-compose.yaml includes a commented option to use Valkey (the open-source Redis fork under BSD-3) instead of Redis:

```yaml
# redis:
#   image: valkey/valkey:alpine  # uncomment to use Valkey
```

Note: "Using Valkey with Firecrawl is untested and not guaranteed to work."

---

## 5. LLM Extraction Mode

Firecrawl has three distinct LLM extraction mechanisms. Understanding which to use matters for our implementation.

### 5.1 JSON Format on /scrape (single page, synchronous)

The primary mechanism for extracting structured data from a known URL. Add `{ type: 'json', schema: yourSchema }` to the `formats` array.

```typescript
// TypeScript / Node.js with Zod
import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

const fc = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });

const schema = z.object({
  company_mission: z.string(),
  supports_sso: z.boolean(),
  is_open_source: z.boolean(),
  is_in_yc: z.boolean(),
  pricing_plans: z.array(z.object({
    name: z.string(),
    price_usd_monthly: z.number().nullable(),
  })).optional(),
});

const result = await fc.scrape('https://firecrawl.dev', {
  formats: [{ type: 'json', schema }],
  onlyMainContent: false,
  timeout: 120000,
});

console.log(result.json);
// {
//   company_mission: "AI-powered web scraping...",
//   supports_sso: true,
//   is_open_source: true,
//   is_in_yc: true
// }
```

**Schema format:** Standard JSON Schema (draft 7+). Zod and Pydantic models are converted by the SDK.

**Without schema:** Pass only a `prompt` string and the LLM chooses the output structure:

```json
{
  "formats": [{ "type": "json", "prompt": "Extract all product names and prices" }]
}
```

**Cost:** Base 1 credit + 4 additional credits for JSON mode.

**Self-hosted requirement:** Must have `OPENAI_API_KEY` (or compatible) set. Without it, JSON format returns a warning and empty `json` field.

### 5.2 /extract (multi-URL, async, legacy)

For extracting the same schema across many pages or an entire domain. Uses wildcards. Returns a job ID for polling.

```bash
# Extract from entire domain
curl -X POST https://api.firecrawl.dev/v2/extract \
  -H 'Authorization: Bearer fc-YOUR_API_KEY' \
  -d '{
    "urls": ["https://docs.firecrawl.dev/*"],
    "prompt": "Extract all code examples with their programming language",
    "schema": {
      "type": "object",
      "properties": {
        "examples": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "language": { "type": "string" },
              "code": { "type": "string" }
            }
          }
        }
      }
    },
    "enableWebSearch": false
  }'
```

**Credit cost:** 1 credit per LLM token batch (15 tokens = 1 credit). Complex extractions across large domains can run up thousands of credits.

### 5.3 /agent (autonomous, cloud-only)

Does not require URLs. The agent searches the web autonomously to find and extract data.

```typescript
const result = await fc.agent({
  prompt: "Find all Y Combinator companies from the W24 batch that are working on AI infrastructure",
  schema: z.object({
    companies: z.array(z.object({
      name: z.string(),
      description: z.string(),
      founders: z.array(z.string()),
      website: z.string().url().optional(),
    })),
  }),
  model: 'spark-1-pro',
  maxCredits: 500,  // Hard cap — agent stops here
});
```

### 5.4 How We Implement Something Similar

For our markdown-for-agents-mcp `/extract` tool:

```typescript
// In our MCP server (Node.js/TypeScript)
import Anthropic from '@anthropic-ai/sdk';
import { scrapeUrl } from './scraper'; // our own scrape impl

async function extractStructured(
  url: string,
  schema: JSONSchema,
  prompt?: string
): Promise<object> {
  // 1. Scrape the page (our implementation or proxy to Firecrawl)
  const markdown = await scrapeUrl(url, { onlyMainContent: true });

  // 2. Call LLM with the markdown + schema
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Extract structured data from this page following the schema.
${prompt ? `Goal: ${prompt}` : ''}

Schema:
${JSON.stringify(schema, null, 2)}

Page content:
${markdown}

Respond with a JSON object matching the schema exactly.`
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
  return JSON.parse(jsonMatch?.[1] ?? text);
}
```

---

## 6. Crawl Configuration Deep-Dive

### Path Filtering

Firecrawl uses glob-style patterns for `includePaths` and `excludePaths`. Patterns are applied against the URL path (not the full URL by default; set `regexOnFullURL: true` to apply to the full URL).

```json
{
  "url": "https://docs.firecrawl.dev",
  "includePaths": ["/features/*", "/api-reference/*"],
  "excludePaths": ["/blog/*", "/changelog/*", "*.pdf"],
  "regexOnFullURL": false
}
```

### Depth and Scope

```json
{
  "url": "https://example.com",
  "maxDiscoveryDepth": 3,      // Max link depth from seed URL
  "crawlEntireDomain": true,   // Include all paths under domain
  "allowSubdomains": true,     // Include subdomain.example.com
  "allowExternalLinks": false  // Stay on seed domain
}
```

### Sitemap Behaviour

| `sitemap` value | Behaviour |
|---|---|
| `"include"` (default) | Parse sitemap.xml AND follow HTML links |
| `"only"` | Parse sitemap.xml only, skip HTML link discovery |
| `"ignore"` | Ignore sitemap, rely entirely on HTML link discovery |

### robots.txt

Firecrawl respects `robots.txt` by default. To bypass:

```json
{
  "ignoreRobotsTxt": true,
  "robotsUserAgent": "MyBot/1.0"  // UA used when checking robots.txt
}
```

**Legal note:** Ignoring robots.txt may violate terms of service and, in some jurisdictions, computer access laws. The Firecrawl docs do not flag this prominently. For enterprise deployments, add a policy check before setting `ignoreRobotsTxt: true`.

### NL-Guided Crawl

The `prompt` parameter on /crawl lets you describe in plain English what to collect. This is experimental and uses LLM classification to decide which discovered pages to include:

```json
{
  "url": "https://news.ycombinator.com",
  "prompt": "Collect only stories about AI and machine learning",
  "limit": 50
}
```

### Concurrency

| Parameter | Default | Recommendation |
|---|---|---|
| `maxConcurrency` per crawl job | not set | 5–20 depending on site tolerance |
| `CRAWL_CONCURRENT_REQUESTS` (global) | 10 | 8–16 for most setups |
| `MAX_CONCURRENT_JOBS` | 5 | reduce to 1–2 for memory-constrained hosts |
| `BROWSER_POOL_SIZE` | 5 | equals `CRAWL_CONCURRENT_REQUESTS` |

### Deduplication

The crawler deduplicates URLs by normalizing and comparing. `ignoreQueryParameters: true` treats `?page=1` and `?page=2` as the same URL (only first visited). Useful for pagination traps.

---

## 7. Webhook and Async Delivery

Source: docs.firecrawl.dev/webhooks

### Configuration

Add a `webhook` object to any /crawl, /batch/scrape, /extract, or /agent request:

```typescript
interface WebhookConfig {
  url: string;           // Must be HTTPS
  headers?: Record<string, string>;  // Custom headers (auth tokens, etc.)
  metadata?: Record<string, unknown>; // Passed through in every event payload
  events?: WebhookEventType[];  // Filter to specific events; default: all
}

type WebhookEventType =
  | 'crawl.started'
  | 'crawl.page'
  | 'crawl.completed'
  | 'batch_scrape.started'
  | 'batch_scrape.page'
  | 'batch_scrape.completed'
  | 'extract.started'
  | 'extract.completed'
  | 'extract.failed'
  | 'agent.started'
  | 'agent.action'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.cancelled'
  | 'monitor.page'
  | 'monitor.check.completed';
```

### Payload Structure

All events share this envelope:

```json
{
  "success": true,
  "type": "crawl.page",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "data": [...],
  "metadata": { "your": "custom_data" },
  "error": "message if success is false"
}
```

### Retry Policy

| Attempt | Delay after failure |
|---|---|
| 1st | 1 minute |
| 2nd | 5 minutes |
| 3rd | 15 minutes |
| After 3rd | Marked as failed, no more attempts |

Your endpoint must respond with 2xx within **10 seconds**. Design webhooks to return 200 immediately and process async.

### HMAC Signature Verification

For self-hosted deployments, set `SELF_HOSTED_WEBHOOK_HMAC_SECRET` and verify webhook payloads:

```typescript
import crypto from 'crypto';
import express from 'express';

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.SELF_HOSTED_WEBHOOK_HMAC_SECRET!;
  const signature = req.headers['x-firecrawl-signature'] as string;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');

  if (signature !== `sha256=${expectedSig}`) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body.toString());
  // process event...
  res.sendStatus(200);
});
```

### WebSocket Alternative (for crawl jobs)

The Node.js SDK supports real-time streaming via WebSockets (with HTTP polling fallback):

```typescript
const { id } = await fc.startCrawl('https://docs.firecrawl.dev', { limit: 100 });

const watcher = fc.watcher(id, { kind: 'crawl', pollInterval: 2, timeout: 300 });

watcher.on('document', (doc) => console.log('PAGE:', doc.metadata.url));
watcher.on('error', (err) => console.error('ERR:', err));
watcher.on('done', (state) => console.log('DONE:', state.status, state.completed, 'pages'));

await watcher.start();
```

---

## 8. JavaScript and Python SDKs

### 8.1 Node.js / TypeScript SDK

**Package:** `firecrawl` (npm) — MIT licence

```bash
npm install firecrawl
```

#### Complete method list

```typescript
import { Firecrawl } from 'firecrawl';

const fc = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });
// No apiKey = keyless free tier (scrape, search, interact only)

// --- Core methods ---
fc.scrape(url, options)                     // Single URL → ScrapeResponse
fc.parse({ data, filename, contentType }, options) // Local file → ParseResponse
fc.crawl(url, options)                      // Crawl + wait → CrawlResponse
fc.startCrawl(url, options)                 // Crawl async → { id }
fc.getCrawlStatus(id, options)              // Poll + paginate
fc.cancelCrawl(id)                          // Cancel job
fc.map(url, options)                        // URL discovery
fc.search(query, options)                   // Web search

// --- Extraction ---
fc.extract(params)                          // Multi-URL extraction (polls until done)
fc.startExtract(params)                     // Async start → { id }
fc.getExtractStatus(id)                     // Poll status
fc.agent(params)                            // Agent (cloud-only, polls until done)
fc.startAgent(params)                       // Async start → { id }
fc.getAgentStatus(id)                       // Poll status

// --- Interact (cloud-only) ---
fc.interact(scrapeId, { prompt })           // Interact via NL
fc.stopInteraction(scrapeId)               // End session

// --- Browser sessions (cloud-only) ---
fc.browser(options)                         // Create standalone session
fc.browserExecute(sessionId, { code })     // Run Playwright code
fc.listBrowsers()                           // List active sessions
fc.deleteBrowser(sessionId)                // Close session

// --- Batch ---
fc.batchScrape(urls, options)              // Start batch + wait
fc.startBatchScrape(urls, options)         // Async start → { id }
fc.getBatchScrapeStatus(id, options)       // Poll + paginate
fc.cancelBatchScrape(id)

// --- Monitoring ---
fc.createMonitor(params)
fc.listMonitors()
fc.getMonitor(id)
fc.updateMonitor(id, params)
fc.deleteMonitor(id)
fc.runMonitor(id)
fc.listMonitorChecks(id)
fc.getMonitorCheck(id, checkId)

// --- Real-time streaming ---
fc.watcher(id, options)                    // Returns Watcher for crawl/batch
// watcher.on('document', cb)
// watcher.on('error', cb)
// watcher.on('done', cb)
// watcher.start()

// --- Pagination helpers ---
// getCrawlStatus and getBatchScrapeStatus support:
//   autoPaginate: boolean   (default: true — aggregates all pages)
//   maxPages: number        (stop after N result pages)
//   maxResults: number      (stop after N documents)
//   maxWaitTime: number     (seconds before stopping wait)
```

### 8.2 Python SDK

**Package:** `firecrawl-py` (pip) — MIT licence

```bash
pip install firecrawl-py
```

Method names are snake_case equivalents of the Node SDK. Schema definitions use Pydantic `BaseModel` instead of Zod.

```python
from firecrawl import Firecrawl
from pydantic import BaseModel
from typing import Optional, List

fc = Firecrawl(api_key="fc-YOUR_API_KEY")

# Scrape
doc = fc.scrape("https://example.com", formats=["markdown", "html"])
print(doc.markdown)

# Structured extraction
class ProductSchema(BaseModel):
    name: str
    price: Optional[float]
    in_stock: bool

result = fc.scrape(
    "https://example.com/product",
    formats=[{"type": "json", "schema": ProductSchema.model_json_schema()}]
)
print(result.json)

# Crawl (blocking)
crawl = fc.crawl("https://docs.example.com", limit=50, poll_interval=5)
for doc in crawl.data:
    print(doc.metadata.source_url, len(doc.markdown))

# Crawl (async)
job = fc.start_crawl("https://docs.example.com", limit=50)
status = fc.get_crawl_status(job.id)

# Map
urls = fc.map("https://example.com", limit=1000)
print(urls.links)

# Extract (multi-URL)
result = fc.extract(
    urls=["https://example.com/*"],
    prompt="Extract all pricing plans",
    schema={"type": "object", "properties": {...}}
)

# Agent
from pydantic import BaseModel, Field

class FounderInfo(BaseModel):
    name: str
    role: Optional[str] = None

result = fc.agent(
    prompt="Find the founders of Firecrawl",
    schema=FounderInfo,
    model="spark-1-mini",
    max_credits=50
)
```

---

## 9. Dynamic Sites and Playwright

### When Playwright Fires

The Firecrawl stack has a two-stage fetch pipeline:

1. **Fast path (curl/fetch):** Attempt simple HTTP fetch first. Returns immediately if the page is fully server-rendered.
2. **Playwright path:** If the fast path fails or the content is insufficient (Firecrawl's heuristic), route to the Playwright microservice.

In the self-hosted stack, Playwright is a separate Node.js service (`apps/playwright-service-ts`) exposed on port 3000. The API service connects to it via `PLAYWRIGHT_MICROSERVICE_URL`.

### Controlling Playwright Behaviour

Force slow-path / extended wait:

```json
{
  "url": "https://spa-app.example.com",
  "waitFor": 3000,
  "actions": [
    { "type": "wait", "selector": "[data-loaded='true']" }
  ]
}
```

Mobile emulation:

```json
{
  "mobile": true,
  "location": { "country": "US", "languages": ["en-US"] }
}
```

Playwright actions for interaction before scraping (all execute before the markdown conversion):

```typescript
const result = await fc.scrape('https://example.com/login-wall', {
  formats: ['markdown'],
  actions: [
    { type: 'click', selector: '#cookie-accept' },
    { type: 'wait', milliseconds: 500 },
    { type: 'click', selector: '[data-tab="features"]' },
    { type: 'wait', selector: '[data-loaded]' },
    { type: 'screenshot' },  // capture mid-state
    { type: 'executeJavaScript', script: 'window.scrollTo(0, document.body.scrollHeight)' },
  ],
});
```

### Memory per Playwright Instance

From docker-compose.yaml: the playwright-service is limited to 4 GB RAM total with `BROWSER_POOL_SIZE` instances (default: 5). That is roughly 800 MB per browser instance. Each Chromium instance typically uses 200–500 MB at rest; heavier pages (video, many images) can spike higher.

**Practical self-hosting budget:** For 10 concurrent Playwright pages, allocate 4–8 GB RAM to the playwright-service container.

### Anti-Bot Limitations

The self-hosted Playwright service does **not** include:
- IP rotation (you must configure `PROXY_SERVER` / `PROXY_USERNAME` / `PROXY_PASSWORD`)
- Cloudflare Bot Management bypass (Fire-engine, cloud-only)
- Browser fingerprint spoofing beyond basic Playwright defaults

For sites with aggressive bot detection, the self-hosted stack will fail where the Cloud API succeeds. Fallback options: set `SCRAPING_BEE_API_KEY` to route hard pages through ScrapingBee.

---

## 10. Non-HTML Content: PDF, DOCX, and Others

### Auto-Detection

When you call `/scrape` on a URL that returns a PDF, DOCX, or other document, Firecrawl auto-detects the content type and routes to the appropriate parser. No special options required:

```typescript
// Auto-detected as PDF:
const result = await fc.scrape('https://example.com/annual-report.pdf', {
  formats: ['markdown'],
});
console.log(result.markdown); // Clean markdown from PDF
console.log(result.metadata.numPages);
```

### Parser Options

```typescript
{
  parsers: [{
    type: 'pdf',
    mode: 'auto',     // 'fast' (text only) | 'auto' (fast + OCR fallback) | 'ocr' (force OCR)
    maxPages: 50,     // Cap page count
    pages: true,      // Return per-page markdown in result.pages[]
    blocks: true,     // Return layout blocks (bounding boxes, types) in result.blocks[]
    pageMarkers: true // Insert <!-- page N --> markers in markdown
  }]
}
```

#### Parsing modes

| Mode | Speed | Use when |
|---|---|---|
| `fast` | Fastest | PDF has embedded text (native, not scanned) |
| `auto` | Medium | Unknown — fast first, OCR fallback if needed |
| `ocr` | Slowest | Scanned documents, image-heavy PDFs |

### Local File Upload (/parse)

```typescript
import fs from 'node:fs';

const doc = await fc.parse(
  {
    data: fs.readFileSync('./financial-report.pdf'),
    filename: 'financial-report.pdf',
    // contentType auto-detected from filename
  },
  {
    parsers: [{ type: 'pdf', mode: 'auto', pages: true }],
    formats: ['markdown'],
  }
);

// Per-page access:
for (const page of doc.pages ?? []) {
  console.log(`Page ${page.pageNumber}:`, page.markdown.substring(0, 200));
}
```

**Supported formats for /parse:** PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, EPUB, CSV, HTML.

**Not supported by /parse:** screenshots, branding extraction, browser actions, changeTracking, location settings.

### Credit cost for documents

- PDF URL via /scrape: 1 credit base + 1 credit per PDF page parsed
- Local file via /parse: 1 credit base + 1 credit per PDF page parsed (for non-PDF formats, cost structure may differ)

---

## 11. Performance, Concurrency, and Cost Model

### Cloud Throughput (self-reported benchmarks, not independently verified)

- Benchmark claim from third-party: "50x faster than Apify" for certain agent workflows.
- Cloud rate limits by plan:

| Plan | Price/month | Concurrent requests | Credits/month |
|---|---|---|---|
| Free | $0 | 2 | 1,000 |
| Hobby | $16 | 5 | 5,000 |
| Standard | $83 | 25 | 100,000 |
| Growth | $333 | 50 | 500,000 |
| Scale | $599 | 100 | 1,000,000 |
| Enterprise | Custom | Custom | Custom |

### Self-Hosted Throughput Estimates

Based on default configuration (10 concurrent requests, 5 browser pool):

| Metric | Estimate |
|---|---|
| Simple HTML pages (no JS) | ~50–200 pages/min |
| JS-rendered pages (Playwright) | ~10–40 pages/min |
| Playwright startup cold | ~2–5 seconds per new instance |
| Redis job queue latency | <100ms |
| PDF parsing (100 pages, OCR) | 30–120 seconds |

These are rough estimates; actual performance depends heavily on target site response time.

### Cost Model (Cloud)

```
Scrape: 1 credit/page
Crawl: 1 credit/page
Map: 1 credit/call
Search: 2 credits/10 results + 1 credit/scraped result page
Interact: 2 credits/browser minute
Monitor: 1 credit/page/check
Agent: 5 free runs/day; then dynamic (credit-based)
JSON format: +4 credits/page
PII redaction: +4 credits/page
PDF page parsing: +1 credit/page
Audio/video extraction: +4 credits/page

Rollover: only on Scale and Enterprise plans
Failed requests: not charged
```

**Cost example (markdown-for-agents-mcp use case):** A typical agent that searches 5 queries and scrapes 10 pages each = 2×5 + 10×1×5 = 60 credits. At Standard plan ($83/month = 100,000 credits), that is $0.05 per agent invocation.

---

## 12. Implementing a Firecrawl-Compatible /scrape in Node.js

This section documents how to implement a `/scrape` endpoint in our markdown-for-agents-mcp Node.js server that is API-compatible with Firecrawl's v2 `/scrape`. The goal is to accept the same request format so callers can swap between our server and the Firecrawl Cloud without code changes.

### Minimal Implementation

```typescript
// src/routes/scrape.ts
import express, { Request, Response } from 'express';
import { chromium, Browser } from 'playwright';
import TurndownService from 'turndown';

const router = express.Router();
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

// Singleton browser (managed by a pool in production)
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

interface ScrapeRequest {
  url: string;
  formats?: string[];
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
  headers?: Record<string, string>;
  mobile?: boolean;
  actions?: Action[];
}

router.post('/v2/scrape', async (req: Request, res: Response) => {
  const body = req.body as ScrapeRequest;

  if (!body.url) {
    return res.status(422).json({ success: false, error: 'url is required' });
  }

  const formats = body.formats ?? ['markdown'];
  const timeout = body.timeout ?? 60000;

  try {
    const b = await getBrowser();
    const ctx = await b.newContext({
      isMobile: body.mobile ?? false,
      extraHTTPHeaders: body.headers ?? {},
    });
    const page = await ctx.newPage();

    await page.goto(body.url, { waitUntil: 'networkidle', timeout });

    if (body.waitFor) {
      await page.waitForTimeout(body.waitFor);
    }

    // Execute browser actions
    if (body.actions) {
      for (const action of body.actions) {
        await executeAction(page, action);
      }
    }

    const result: Record<string, unknown> = {};

    // Build requested formats
    if (formats.includes('rawHtml') || formats.includes('html') || formats.includes('markdown')) {
      const rawHtml = await page.content();
      if (formats.includes('rawHtml')) result.rawHtml = rawHtml;
      if (formats.includes('html') || formats.includes('markdown')) {
        // Strip nav/footer/aside if onlyMainContent
        const mainHtml = body.onlyMainContent !== false
          ? await extractMainContent(page)
          : rawHtml;
        if (formats.includes('html')) result.html = mainHtml;
        if (formats.includes('markdown')) result.markdown = td.turndown(mainHtml);
      }
    }

    if (formats.includes('links')) {
      result.links = await page.$$eval('a[href]', (els) =>
        els.map((el) => el.getAttribute('href')).filter(Boolean)
      );
    }

    if (formats.includes('screenshot') || formats.some((f) => typeof f === 'object' && (f as any).type === 'screenshot')) {
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      result.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
    }

    const title = await page.title();
    const description = await page.$eval(
      'meta[name="description"]',
      (el) => el.getAttribute('content') ?? '',
    ).catch(() => '');

    await ctx.close();

    return res.json({
      success: true,
      data: {
        ...result,
        metadata: {
          title,
          description,
          sourceURL: body.url,
          url: page.url(),
          statusCode: 200,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

async function extractMainContent(page: import('playwright').Page): Promise<string> {
  // Remove boilerplate elements and return main content HTML
  return page.evaluate(() => {
    const remove = ['nav', 'header', 'footer', 'aside', '[role="banner"]', '[role="navigation"]', '#cookie-banner'];
    remove.forEach((sel) => document.querySelectorAll(sel).forEach((el) => el.remove()));
    return document.querySelector('main, article, [role="main"], body')?.innerHTML ?? document.body.innerHTML;
  });
}

async function executeAction(page: import('playwright').Page, action: any): Promise<void> {
  switch (action.type) {
    case 'wait':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: 30000 });
      } else {
        await page.waitForTimeout(action.milliseconds ?? 1000);
      }
      break;
    case 'click':
      await page.click(action.selector);
      break;
    case 'type':
      await page.fill(action.selector, action.text);
      break;
    case 'scroll':
      await page.evaluate(({ direction, amount }) => {
        window.scrollBy(0, direction === 'down' ? (amount ?? 500) : -(amount ?? 500));
      }, action);
      break;
    case 'executeJavaScript':
      await page.evaluate(action.script);
      break;
  }
}

export default router;
```

### Producing Firecrawl-Compatible Error Responses

Firecrawl error format:

```typescript
// HTTP 402 — payment / credits
{ "error": "Payment required to access this resource." }

// HTTP 429 — rate limited
{ "error": "Request rate limit exceeded. Please wait and try again later." }

// HTTP 500 — server error
{ "error": "An unexpected error occurred on the server." }

// HTTP 422 — validation
{ "error": "Validation error", "details": [...] }
```

Our server should mirror these exactly on the same HTTP status codes for compatibility.

### What to Proxy to Firecrawl Cloud

When our self-hosted scraper fails (bot detection, complex JS, timeouts), fall back to Firecrawl Cloud:

```typescript
async function scrapeWithFallback(url: string, opts: ScrapeRequest) {
  try {
    return await selfHostedScrape(url, opts);
  } catch (err) {
    if (process.env.FIRECRAWL_API_KEY) {
      const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
      return await fc.scrape(url, opts);
    }
    throw err;
  }
}
```

---

## 13. Competitor Comparison

Source: RECATOOLS comparison guide (July 2026, verified against primary sources), plus independent analysis.

### Feature Matrix

| Feature | Firecrawl | Crawl4AI | Jina Reader | Browser Use |
|---|---|---|---|---|
| Licence | AGPL-3.0 (SDKs: MIT) | Apache-2.0 | Apache-2.0 (model: CC-BY-NC) | MIT |
| Self-host parity | Partial (no Fire-engine, no /agent) | Full (nothing withheld) | Stateless (no proxy pool) | Partial (cloud has stealth/captcha) |
| JS rendering | Yes (Playwright) | Yes (Playwright) | Yes (headless Chrome) | Yes (full browser) |
| Search endpoint | Yes | No | `s.jina.ai` | No |
| Structured extraction | JSON format + /extract + /agent | CSS/XPath/LLM schemas | No schema | No declarative schema |
| robots.txt default | Respected | Opt-in flag | Not documented | Not documented |
| Official MCP server | Yes (MIT) | Yes (in Docker server) | None documented | Yes (local + cloud) |
| Crawl | Yes | Yes | No | No |
| Map | Yes (URL discovery) | No | No | No |
| PDF/DOCX parsing | Yes | Limited | Yes (PDF) | No |
| Pricing model | Credit-based, free tier | Free (no cloud product yet) | Free tier + tokens | Free tier, $29/mo dev |
| GitHub stars (Jul 2026) | 151k | 74k | 12k | 106k |
| Funding | $14.5M Series A (Aug 2025) | Community-funded | Acquired by Elastic (Oct 2025) | $17M seed (Mar 2025) |

### Positioning for markdown-for-agents-mcp

| Scenario | Recommendation |
|---|---|
| Simple URL-to-markdown (no JS) | Implement in-house with `undici` + `turndown` |
| JS-rendered pages (known URLs) | Self-hosted Firecrawl or direct Playwright |
| Anti-bot / complex sites | Firecrawl Cloud API as fallback |
| Autonomous web research | Firecrawl /agent or Tavily (if agent is overkill) |
| URL discovery (site map) | Firecrawl /map or our own sitemap.xml parser |
| Document parsing (PDF, DOCX) | Firecrawl /parse or `pdfjs-dist` + `mammoth` |
| Internal knowledge indexing | Our Phase 2 enterprise knowledge index (SharePoint + Confluence) |

### Jina Reader Specific Notes

- Simplest possible integration: `GET https://r.jina.ai/{url}`
- No API key needed at 20 RPM
- Does not support crawling, batch operations, or structured extraction
- The `ReaderLM-v2` model is CC-BY-NC 4.0 — commercial use prohibited; this only matters if you run the model locally, not when calling the API
- Post-Elastic acquisition: healthy but roadmap opaque

### ScrapingBee

- Commercial service (not open source)
- Strengths: mature, excellent Cloudflare bypass, JavaScript rendering
- Firecrawl actually supports ScrapingBee as a fallback: `SCRAPING_BEE_API_KEY` in env routes hard pages through it
- Pricing starts at $49/month for 100,000 credits

---

## 14. Known Limitations, Issues, and Gotchas

### AGPL Copyleft Risk (Already Covered, Emphasised Again)

The single biggest risk: if you modify Firecrawl's engine source and run it as a service, you must AGPL-license your entire derivative work. This includes any internal tools that directly embed modified Firecrawl code.

### Fire-Engine Gap in Self-Hosted

The most common failure mode when self-hosting: sites with Cloudflare, PerimeterX, DataDome, or similar bot management will fail silently or return bot-detection pages. The self-hosted stack has no IP rotation and no advanced browser fingerprinting. Mitigation:
1. Set `PROXY_SERVER` to a rotating residential proxy (Oxylabs, Bright Data, etc.)
2. Set `SCRAPING_BEE_API_KEY` as a fallback
3. Accept that some percentage of scrapes will fail on adversarial sites

### LLM Extraction Requires External LLM

Self-hosted JSON format and /extract require `OPENAI_API_KEY` (or compatible). Without it, these features silently return no data with a `warning` field. There is no local fallback — you must wire in Ollama or another provider.

### 24-Hour Job Result Expiry

Crawl, batch scrape, and extract job results expire 24 hours after completion. For long-running crawls, read results promptly or use webhooks to stream them. Activity logs persist longer, but the raw data does not.

### Credit Check Before Crawl Start

Firecrawl checks your remaining credits against the `limit` before starting a crawl. If you set `limit: 10000` but only have 5000 credits, the crawl returns HTTP 402 and never starts. Set `limit` to match your actual credit budget.

### Pagination in Crawl API

Direct API callers (not SDK): responses over 10 MB are paginated via a `next` URL. You must loop through all pages to get all results. SDK handles this automatically when `autoPaginate: true` (default).

### Rate Limits

Free tier: 2 concurrent requests. Keyless tier: rate-limited by IP. Exceeding limits returns HTTP 429 with `Retry-After` header. The SDK does not auto-retry on 429 — implement your own backoff.

### Actions Combined Wait Limit

The combined `waitFor` + all `wait` action durations cannot exceed 60 seconds per scrape request. Exceeding this causes a 422 validation error.

### Screenshots Expire in 24 Hours

Screenshot URLs in scrape results are signed GCS URLs that expire after 24 hours. Download and store immediately if needed.

### Audio/Video URLs Expire in 1 Hour

Audio and video extraction (YouTube, etc.) returns signed GCS URLs that expire after 1 hour. Shorter than screenshots.

### Crawl Scope: Domain vs Subdomain Gotcha

By default, crawls do NOT follow subdomains. `https://docs.example.com` starting from `https://example.com` will be ignored unless `allowSubdomains: true`. This catches teams who expect `docs.example.com` to be crawled from `example.com` start.

### Self-Hosted Search Requires SearXNG

The /search endpoint on the self-hosted stack requires a running SearXNG instance (`SEARXNG_ENDPOINT`). Without it, /search returns errors. Running SearXNG requires either a separate Docker container or a hosted SearXNG instance.

### robots.txt Default is Respected

Unlike some scrapers that ignore robots.txt by default, Firecrawl respects it. If your target site blocks crawlers in robots.txt, set `ignoreRobotsTxt: true` — but verify this is legally and ethically acceptable for your use case.

### FoundationDB Queue Backend is Experimental

The `NUQ_BACKEND=fdb` option for using FoundationDB as a queue backend is marked experimental. Do not use in production. The default Postgres backend is stable.

### `product` Format Requires External Service

The `product` scrape format (structured product extraction from e-commerce pages) requires `PRODUCT_EXTRACTION_SERVICE_URL` to be set. Without it, requesting the `product` format returns a warning and no data.

### No Streaming for Single /scrape Calls

Individual /scrape calls are synchronous and blocking. For LLM-heavy scrapes (JSON mode, large PDFs), timeouts can be long. Consider setting a high `timeout` value (up to 300000ms for complex pages).

---

## 15. What to Build vs What to Skip

### Build (MVP, Phase 1)

**Implement in our Node.js MCP server:**

1. **`scrape` tool** — URL → markdown, HTML, links, screenshot. Use Playwright for JS rendering. API-compatible with Firecrawl /scrape request format. This is the core use case.

2. **`search` tool** — Web search returning titles, URLs, descriptions. Optionally scrape top N results. Use a search provider (SearXNG self-hosted, Bing Search API, or Firecrawl Cloud as a backend).

3. **`map` tool** — Discover URLs from a site. Parse sitemap.xml ourselves first; fall back to Firecrawl /map for sites without sitemaps.

4. **`parse` tool** — Convert local files (PDF, DOCX) to markdown. Use `pdfjs-dist` and `mammoth` locally. Fall back to Firecrawl /parse for complex documents.

5. **Firecrawl Cloud fallback** — When our scraper fails, proxy to Firecrawl Cloud API. This gives us access to Fire-engine without AGPL concerns.

### Build (Phase 2)

6. **`crawl` tool** — Recursive site crawl. Implement with our own queue (Bull + Redis) around our Playwright scraper. Webhook delivery of results as pages complete.

7. **Structured JSON extraction** — Pass page markdown to our LLM (Claude) with the user's schema. Mirror the /scrape JSON format semantics but use our own LLM call.

8. **Enterprise knowledge index** — SharePoint + Confluence connectors with per-user Entra ID ACL enforcement. This differentiates us from Firecrawl which has no on-premises document index.

### Skip

- **/agent** — Cloud-only, dynamic pricing, hard to replicate. Refer users to Firecrawl Cloud directly.
- **/interact / /browser** — Cloud-only. Out of scope for MVP; complex browser session management not core to our knowledge index use case.
- **/monitor** — Useful but not core to our agent use case. Could be added as Phase 3.
- **Forking Firecrawl** — AGPL copyleft risk. Use as a dependency or client only.
- **Self-hosting the full Firecrawl stack** — Operationally complex (7+ services). Use the Cloud API or a minimal Playwright service instead.

### Recommended Architecture

```
markdown-for-agents-mcp (MIT)
  ├── MCP tools: scrape, search, map, parse, crawl, extract
  ├── Local Playwright service (for simple JS rendering)
  ├── Local SearXNG (for /search)
  ├── Local LLM call (Claude API for structured extraction)
  └── Firecrawl Cloud API (optional fallback for adversarial sites)

Phase 2 additions:
  ├── SharePoint connector (Graph API + Entra ID transitiveMemberOf)
  ├── Confluence connector
  └── Per-user ACL enforcement layer
```

This gives us Firecrawl-compatible semantics, MIT licence throughout our own code, and a clear commercial upgrade path (direct Firecrawl Cloud integration for enterprise customers who need Fire-engine and /agent).

---

*Sources:*
- *https://docs.firecrawl.dev (August 2026)*
- *https://docs.firecrawl.dev/api-reference/endpoint/scrape*
- *https://docs.firecrawl.dev/features/scrape*
- *https://docs.firecrawl.dev/features/crawl*
- *https://docs.firecrawl.dev/features/map*
- *https://docs.firecrawl.dev/features/search*
- *https://docs.firecrawl.dev/features/extract*
- *https://docs.firecrawl.dev/features/agent*
- *https://docs.firecrawl.dev/features/parse*
- *https://docs.firecrawl.dev/features/interact*
- *https://docs.firecrawl.dev/features/monitor*
- *https://docs.firecrawl.dev/webhooks/overview*
- *https://docs.firecrawl.dev/webhooks/event-types*
- *https://docs.firecrawl.dev/contributing/open-source-or-cloud*
- *https://docs.firecrawl.dev/sdks/node*
- *https://docs.firecrawl.dev/advanced-scraping-guide*
- *https://firecrawl.dev/pricing*
- *https://raw.githubusercontent.com/mendableai/firecrawl/main/docker-compose.yaml*
- *https://raw.githubusercontent.com/mendableai/firecrawl/main/apps/api/.env.example*
- *https://recatools.com/guides/firecrawl-vs-crawl4ai-vs-jina-reader-vs-browser-use/ (July 2026)*
- *DuckDuckGo search results for licence, AGPL, competitor comparisons (August 2026)*
