# Web Scraping APIs and Headless Browser Services

**Status:** Research complete — August 2026  
**Scope:** ScrapingBee, Apify, Spider.cloud, ZenRows, Scrapfly — comparative analysis, implementation patterns, and build decisions for markdown-for-agents-mcp

---

## Table of Contents

1. [Executive Summary and Build Decisions](#1-executive-summary-and-build-decisions)
2. [ScrapingBee — Complete API Reference](#2-scrapingbee--complete-api-reference)
3. [Spider.cloud — Complete API Reference](#3-spidercloud--complete-api-reference)
4. [Apify — Actor Model Architecture](#4-apify--actor-model-architecture)
5. [ZenRows — Anti-Bot Infrastructure](#5-zenrows--anti-bot-infrastructure)
6. [Scrapfly — Middleware Anti-Bot Platform](#6-scrapfly--middleware-anti-bot-platform)
7. [Anti-Bot Systems: How They Work and How to Beat Them](#7-anti-bot-systems-how-they-work-and-how-to-beat-them)
8. [Residential Proxy Networks](#8-residential-proxy-networks)
9. [Headless Browsers: Playwright, Puppeteer, Lightpanda](#9-headless-browsers-playwright-puppeteer-lightpanda)
10. [Our Three-Tier Render Ladder vs Commercial Scrapers](#10-our-three-tier-render-ladder-vs-commercial-scrapers)
11. [Caching Strategy: Redis LRU for Fetch Results](#11-caching-strategy-redis-lru-for-fetch-results)
12. [Polite Crawling: robots.txt, Crawl-Delay, Rate Limiting](#12-polite-crawling-robotstxt-crawl-delay-rate-limiting)
13. [Node.js Fetch Pipeline Architecture](#13-nodejs-fetch-pipeline-architecture)
14. [Comparative Pricing Table](#14-comparative-pricing-table)
15. [Feature Comparison Matrix](#15-feature-comparison-matrix)

---

## 1. Executive Summary and Build Decisions

### What We Are Building

markdown-for-agents-mcp is a self-hosted MIT-licensed MCP server. The web layer needs to fetch arbitrary URLs and return clean markdown to AI agents. The fetch pipeline must handle:

- Plain HTTP pages (fast path, 95% of requests)
- JavaScript-rendered SPAs (Lightpanda middle tier)
- Heavily protected pages with anti-bot defenses (Playwright top tier)
- Optional fallback to a commercial API (ScrapingBee or Scrapfly) when local render fails

### Verdict: What to Build, What to Skip

**Build yourself:**
- Three-tier fetch ladder (HTTP → Lightpanda → Playwright) — already planned, correct decision
- Redis LRU cache keyed by `(url, render_tier, content_hash)` with configurable TTLs
- robots.txt parser with per-domain crawl-delay enforcement
- Per-domain rate limiter using token bucket
- TLS fingerprint spoofing via `curl_cffi`-equivalent in Node.js (undici with custom TLS settings or native fetch with patched headers)
- Playwright browser context pool (not separate browser processes)
- Gaussian timing noise on all Playwright requests

**Integrate optionally (user-supplied API key):**
- ScrapingBee as Tier 4 fallback for Cloudflare/DataDome-protected pages — cheapest premium proxy access, `mode=auto` reduces guesswork
- Scrapfly as Tier 4 alternative — better anti-bot SLA, `asp=true` is a single flag
- Spider.cloud for bulk crawl jobs — dramatically cheaper per-page than any other option ($0.48-$0.65 per 1,000 pages vs ScrapingBee's ~$2.40/1,000)

**Skip entirely:**
- Apify — actor model is a deployment platform, not a fetch library; overkill and expensive for our use case
- ZenRows Browser Sessions — charges for Puppeteer/Playwright proxy routing, not needed since we run our own browser
- Residential proxy subscriptions — cost $2-$15/GB and require managing proxy lists; commercial API fallback is cheaper at the volumes an MCP server handles
- Building your own anti-bot fingerprint spoofing stack — the engineering cost exceeds the value; use commercial APIs for the 5% of requests that need it

**Critical insight from research:** The commercial scraping APIs exist precisely because fingerprint spoofing is a full-time engineering problem. Cloudflare Bot Management and Akamai Bot Manager use ML models that detect patterns invisible to rules-based evasion. The right architecture is: do everything cheaply yourself, fall back to professionals for the hard cases. The fallback rate for a general-purpose MCP server fetching arbitrary web content should be under 5%.

---

## 2. ScrapingBee — Complete API Reference

**Source:** https://www.scrapingbee.com/documentation/  
**Base URL:** `https://app.scrapingbee.com/api/v1`  
**Auth:** `Authorization: Bearer YOUR-API-KEY` (query param `api_key` deprecated)

### Complete Parameter Schema

| Parameter | Type | Default | Description |
|---|---|---|---|
| `api_key` | string | required | API key (deprecated; use Authorization header) |
| `url` | string | required | Target URL, must be URL-encoded |
| `render_js` | boolean | `true` | Render JavaScript with headless browser |
| `premium_proxy` | boolean | `false` | Route through residential proxy pool |
| `stealth_proxy` | boolean | `false` | Route through special stealth pool (more expensive) |
| `country_code` | string | `""` | Geolocation for premium proxy (e.g. `"us"`, `"gb"`) |
| `session_id` | integer | `""` | Route multiple requests through same IP |
| `screenshot` | boolean | `false` | Return screenshot as base64 |
| `screenshot_full_page` | boolean | `false` | Full-page screenshot |
| `screenshot_selector` | string | `""` | CSS selector for partial screenshot |
| `wait` | integer | `0` | Extra ms to wait after JS render (on top of 2000ms default) |
| `wait_browser` | string | `"domcontentloaded"` | Browser event to wait for: `domcontentloaded`, `networkidle0`, `networkidle2`, `load` |
| `wait_for` | string | `""` | CSS or XPath selector to wait for in DOM |
| `window_width` | int | `1920` | Viewport width in pixels |
| `window_height` | int | `1080` | Viewport height in pixels |
| `block_ads` | boolean | `false` | Block ads |
| `block_resources` | boolean | `true` | Block images and CSS (reduces bandwidth and cost) |
| `cookies` | string | `""` | Custom cookies (format: `name=value;name2=value2`) |
| `forward_headers` | boolean | `false` | Forward custom `Spb-*` headers to target, plus ScrapingBee-generated headers |
| `forward_headers_pure` | boolean | `false` | Forward only custom `Spb-*` headers, nothing else |
| `return_page_markdown` | boolean | `false` | Return content as markdown |
| `return_page_source` | boolean | `false` | Return original HTML before JS rendering |
| `return_page_text` | boolean | `false` | Return plain text content |
| `json_response` | boolean | `false` | Wrap response in JSON envelope |
| `transparent_status_code` | boolean | `false` | Return target's actual HTTP status code |
| `extract_rules` | stringified JSON | `""` | CSS-selector-based structured extraction |
| `ai_extract_rules` | stringified JSON | `""` | AI-powered extraction from description |
| `ai_query` | string | `""` | Natural language question to answer from page |
| `ai_selector` | string | `""` | CSS selector to focus AI extraction on |
| `js_scenario` | stringified JSON | `{}` | JavaScript scenario (click, fill, scroll, etc.) |
| `scraping_config` | string | `""` | Pre-saved configuration name |
| `mode` | string | `""` | Set to `"auto"` to let ScrapingBee pick cheapest config that succeeds |
| `max_cost` | integer | `""` | Cap credits Auto-Mode can spend (requires `mode=auto`) |
| `own_proxy` | string | `""` | Use your own proxy provider URL |
| `timeout` | int | `140000` | Request timeout in ms (max 30s for the API call itself) |
| `tag` | string | `""` | Custom label returned in response headers |
| `device` | string | `"desktop"` | Device type: `"desktop"` or `"mobile"` |

### Credit Cost Multipliers

| Feature | Credit cost |
|---|---|
| Plain HTTP (render_js=false) | 1 credit |
| JS rendering (render_js=true) | 5 credits |
| Premium proxy | 10 credits base |
| Premium proxy + JS render | 25 credits |
| Stealth proxy + JS render | 75 credits |
| Screenshot | +additional credits |

### TypeScript Integration Example

```typescript
// npm install axios
import axios from 'axios';

interface ScrapingBeeParams {
  url: string;
  render_js?: boolean;
  premium_proxy?: boolean;
  country_code?: string;
  wait?: number;
  wait_for?: string;
  return_page_markdown?: boolean;
  json_response?: boolean;
  mode?: 'auto';
  max_cost?: number;
  transparent_status_code?: boolean;
  block_resources?: boolean;
}

async function scrapingBeeFetch(
  targetUrl: string,
  apiKey: string,
  params: Partial<ScrapingBeeParams> = {}
): Promise<{ html: string; markdown?: string; status: number }> {
  const response = await axios.get('https://app.scrapingbee.com/api/v1', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: {
      url: targetUrl,
      render_js: false,
      return_page_markdown: true,
      json_response: true,
      transparent_status_code: true,
      block_resources: true,
      ...params,
    },
    timeout: 35000, // ScrapingBee retries for 30s; give 5s buffer
  });

  return {
    html: response.data.body ?? '',
    markdown: response.data.markdown,
    status: response.status,
  };
}

// Auto-mode: let ScrapingBee pick cheapest config that succeeds
async function scrapingBeeAutoFetch(targetUrl: string, apiKey: string) {
  return scrapingBeeFetch(targetUrl, apiKey, {
    mode: 'auto',
    max_cost: 25,         // cap at 25 credits; won't use stealth
    return_page_markdown: true,
  });
}
```

### js_scenario Schema

ScrapingBee accepts a JavaScript scenario for interaction before extraction:

```typescript
interface JsScenario {
  instructions: Array<
    | { click: string }              // CSS selector
    | { fill: [string, string] }     // [selector, value]
    | { wait: number }               // ms
    | { wait_for: string }           // CSS selector
    | { scroll_x: number }
    | { scroll_y: number }
    | { evaluate: string }           // raw JS string
  >;
}

const scenario: JsScenario = {
  instructions: [
    { wait_for: '#content' },
    { scroll_y: 1000 },
    { wait: 500 },
    { click: '#load-more' },
    { wait_for: '.loaded' },
  ],
};

// Usage:
params.js_scenario = JSON.stringify(scenario);
```

### Pricing Tiers (August 2026)

| Plan | Price/month | Credits | Concurrency | Notes |
|---|---|---|---|---|
| Free | $0 | 1,000 | — | Trial only |
| Starter | ~$20 | ~50K | limited | |
| Freelance | $49 | 150,000 | limited | Good for dev/test |
| Startup/Team | $99 | 1,000,000 | higher | Most popular |
| Premium | $249 | — | higher | |
| Business | $599 | 5,000,000 | max | |
| Enterprise | $1,000+ | custom | custom | |

Source: https://www.scrapingbee.com/pricing/ and https://costbench.com/software/web-scraping/scrapingbee/

### Gotchas and Limitations

- Default 30-second retry window. If the target 404s or 403s on every attempt, you still wait 30s.
- `render_js=true` costs 5 credits, not 1. At scale this multiplies quickly.
- `forward_headers_pure` can cause issues if ScrapingBee's generated headers (User-Agent, etc.) are stripped — the request may look bot-like.
- `session_id` persists the IP but not authentication cookies across domains.
- Response body is raw HTML unless `json_response=true`. For MCP markdown output, always set `return_page_markdown=true&json_response=true`.
- Auto-mode (`mode=auto`) does not guarantee success — it stops at `max_cost` and returns whatever it got.
- No webhook support for async delivery; every call is synchronous.
- Rate limiting: the account's concurrent request limit applies globally across all projects.

---

## 3. Spider.cloud — Complete API Reference

**Source:** https://spider.cloud/docs/api  
**Base URL:** `https://api.spider.cloud`  
**Auth:** `Authorization: Bearer sk-xxxx...`  
**Notable:** Rust-based, claims 100K pages/second, dramatically cheaper than competitors

### Common Parameters (shared across Crawl, Scrape, Links, Screenshot, Fetch)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Target URL |
| `blacklist` | array | — | Regex patterns for paths to skip |
| `block_ads` | boolean | `true` | Block ads (browser/smart mode) |
| `block_analytics` | boolean | `true` | Block analytics trackers |
| `block_stylesheets` | boolean | `true` | Block CSS (performance boost) |
| `budget` | object | — | Page limits per path: `{"*": 1}` = root only, `{"/docs/": 100}` |
| `chunking_alg` | object | — | Segment output: `{"type": "bysentence", "value": 2}` |
| `concurrency_limit` | number | unlimited | Max concurrent requests (for slow targets) |
| `crawl_timeout` | object | 2 min | Max crawl duration: `{"secs": 300, "nanos": 0}` |
| `data_connectors` | object | — | Stream results to S3/GCS/Sheets/Azure/Supabase (see below) |
| `depth` | number | `25` | Max crawl depth (0 = unlimited) |
| `disable_first_party_javascript` | boolean | `false` | Block even first-party JS (strict mode) |
| `disable_first_party_stylesheets` | boolean | `false` | Block first-party CSS too |
| `disable_first_party_visuals` | boolean | `false` | Block first-party images/media |
| `disable_intercept` | boolean | `false` | Disable request interception (helps with third-party script sites) |
| `event_tracker` | object | — | Track network requests/responses and automation screenshots |
| `exclude_selector` | string | — | CSS selector for content to exclude from output |
| `execution_scripts` | object | — | Path-specific JS: `{"/checkout": "window.scrollTo(0,99999)"}` |
| `external_domains` | array | — | Treat these as the same domain; `["*"]` = follow all |
| `full_resources` | boolean | — | Download all page resources |
| `max_credits_allowed` | number | — | Spend cap per run (10,000 credits = $1) |
| `max_credits_per_page` | number | — | Per-page spend cap |
| `metadata` | boolean | `false` | Collect title, description, keywords |
| `preserve_host` | boolean | — | Keep original host in URLs |
| `redirect_policy` | string | — | How to handle redirects |
| `request` | string | `"http"` | Mode: `"http"`, `"browser"`, `"smart"` |
| `request_timeout` | number | — | Per-request timeout in ms |
| `root_selector` | string | — | CSS selector for root content extraction |
| `run_in_background` | boolean | — | Async job (get results via webhook) |
| `session` | boolean | — | Maintain session cookies |
| `sitemap` | boolean | — | Use sitemap.xml for discovery |
| `sitemap_only` | boolean | — | Only crawl URLs from sitemap |
| `sitemap_path` | string | — | Custom sitemap path |
| `subdomains` | boolean | — | Follow subdomain links |
| `tld` | boolean | — | Follow TLD variations |
| `user_agent` | string | — | Custom User-Agent string |
| `wait_for` | string | — | CSS selector to wait for (browser mode) |
| `webhooks` | object | — | Delivery endpoint for async results |
| `whitelist` | array | — | Regex patterns for paths to include |

### Endpoint Reference

```
POST /crawl      — recursive link discovery from a root URL
POST /scrape     — fetch specific URLs without following links
POST /links      — extract links only (no content)
POST /screenshot — capture screenshots
POST /search     — web search integration
POST /transform  — transform/convert already-fetched content
GET  /proxy      — route requests through Spider's proxy
POST /browser    — full browser CDP access
```

### data_connectors Schema

Spider can stream results directly to cloud storage as pages are crawled:

```typescript
interface DataConnectors {
  s3?: {
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    region?: string;
    prefix?: string;
    content_type?: string;
  };
  gcs?: {
    bucket: string;
    service_account_base64: string;
    prefix?: string;
  };
  google_sheets?: {
    spreadsheet_id: string;
    service_account_base64: string;
    sheet_name?: string;
  };
  azure_blob?: {
    connection_string: string;
    container: string;
    prefix?: string;
  };
  supabase?: {
    url: string;
    anon_key: string;
    table: string;
  };
  on_find?: boolean;         // stream as found
  on_find_metadata?: boolean; // include metadata with each find
}
```

### Request Modes: http vs browser vs smart

| Mode | Cost | When to use |
|---|---|---|
| `"http"` | 1 credit | Static HTML, server-rendered pages |
| `"browser"` | ~5 credits | SPAs, JavaScript-heavy pages |
| `"smart"` | auto-selects | Let Spider decide |

### TypeScript Integration Example

```typescript
interface SpiderScrapeRequest {
  url: string;
  request?: 'http' | 'browser' | 'smart';
  metadata?: boolean;
  return_format?: 'markdown' | 'html' | 'text' | 'bytes';
  wait_for?: string;
  execution_scripts?: Record<string, string>;
  max_credits_allowed?: number;
  block_ads?: boolean;
  block_analytics?: boolean;
  block_stylesheets?: boolean;
}

interface SpiderScrapeResult {
  url: string;
  content: string;
  status: number;
  metadata?: {
    title?: string;
    description?: string;
    keywords?: string;
  };
  error?: string;
}

async function spiderScrape(
  targetUrl: string,
  apiKey: string,
  options: Partial<SpiderScrapeRequest> = {}
): Promise<SpiderScrapeResult[]> {
  const response = await fetch('https://api.spider.cloud/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: targetUrl,
      request: 'http',
      return_format: 'markdown',
      block_ads: true,
      block_analytics: true,
      block_stylesheets: true,
      metadata: true,
      ...options,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spider API error: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

// Bulk crawl with budget limit
async function spiderCrawl(
  rootUrl: string,
  apiKey: string,
  maxPages = 50
): Promise<SpiderScrapeResult[]> {
  const response = await fetch('https://api.spider.cloud/crawl', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: rootUrl,
      return_format: 'markdown',
      budget: { '*': maxPages },
      depth: 3,
      block_ads: true,
      block_analytics: true,
      block_stylesheets: true,
      metadata: true,
      max_credits_allowed: maxPages * 5, // safety cap
    }),
  });

  return response.json();
}
```

### Pricing (August 2026)

Spider uses a credit system: **10,000 credits = $1.00**

| Request type | Credits | Effective cost per 1K pages |
|---|---|---|
| HTTP scrape | 1 | $0.10 |
| Browser scrape | ~5 | $0.50 |
| With anti-bot | varies | $0.48–$0.65 self-reported |

Compare to ScraperAPI at equivalent anti-bot configs: ~$7.48–$36.75 per 1K pages. Spider is 10-70x cheaper.

**Unlimited plan:** Concurrency-seat-based billing instead of per-request credits. Better for sustained high-volume workloads.

Source: https://spider.cloud/guides/pricing-and-plans/ and https://thegtmdirectory.com/tools/spider

### Gotchas

- Rust-based server is fast but documentation is sparse compared to Python-ecosystem tools
- `smart` mode is a black box — credit cost is unpredictable
- Data connectors require cloud service credentials; not useful for self-hosted MCP
- Anti-bot (`request="browser"`) does not match Scrapfly/ZenRows quality on heavily protected sites (Cloudflare Enterprise)
- No session/cookie persistence for authenticated scraping
- `chunking_alg` is Spider-specific; not useful when we do our own markdown conversion

---

## 4. Apify — Actor Model Architecture

**Source:** https://docs.apify.com  
**Position:** Platform/marketplace, not just an API. Wrong abstraction for our use case, but contains excellent open-source tools.

### What Apify Is

Apify is a cloud platform where developers package code as **Actors** — Docker containers with structured JSON I/O, README documentation, and access to Apify's storage and proxy infrastructure. Actors are shared on Apify Store and can be monetized.

This is fundamentally different from a scraping API: you're not calling an endpoint, you're running a cloud job. The value proposition is:

1. **Crawlee** — open-source Node.js/Python web crawling library (the real gem)
2. **Fingerprint Suite** — open-source browser fingerprint generation/injection
3. **impit** — Rust-based HTTP client with browser impersonation (very relevant)
4. **proxy-chain** — Node.js proxy server with SSL and upstream chaining

### Actor Architecture

```
Actor = Dockerfile + README.md + input_schema.json + output_schema.json
      + access to: KeyValueStore, Dataset, RequestQueue
```

```typescript
// Actors interact via Apify client
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'MY_APIFY_TOKEN' });

// Run an Actor
const run = await client.actor('apify/web-scraper').call({
  startUrls: [{ url: 'https://example.com' }],
  pageFunction: async ({ page, request }) => {
    return { url: request.url, title: await page.title() };
  },
});

// Fetch results from dataset
const { items } = await client.dataset(run.defaultDatasetId).listItems();
```

### Storage Types

| Storage | Use case | API |
|---|---|---|
| Dataset | Append-only scrape results | `client.dataset(id).listItems()` |
| KeyValueStore | Binary blobs, config | `client.keyValueStore(id).getRecord(key)` |
| RequestQueue | Crawl frontiers | `client.requestQueue(id).addRequest(req)` |

### Crawlee — The Actually Useful Part

Crawlee is the open-source library extracted from Apify's internals. It handles:
- Autoscaling concurrency based on memory/CPU
- Request deduplication
- Session rotation and cookie management
- Proxy rotation with health tracking
- `BrowserCrawler` (Playwright/Puppeteer) and `HttpCrawler`

```typescript
import { PlaywrightCrawler } from 'crawlee';

const crawler = new PlaywrightCrawler({
  maxConcurrency: 20,
  maxRequestsPerMinute: 120,
  sessionPoolOptions: { maxPoolSize: 50 },
  proxyConfiguration: await ProxyConfiguration.new({
    proxyUrls: ['http://proxy1:8080', 'http://proxy2:8080'],
  }),

  async requestHandler({ page, request, pushData }) {
    const title = await page.title();
    await pushData({ url: request.url, title });
  },
});

await crawler.run(['https://example.com']);
```

### impit — Browser TLS Impersonation in Node.js

**This is directly relevant to our fetch pipeline.** impit is a Rust-based HTTP client that replicates browser TLS fingerprints. It has Node.js bindings.

```typescript
// npm install impit
import { Impit } from 'impit';

const client = new Impit({
  browser: 'chrome',     // or 'firefox', 'safari'
  // Produces Chrome's exact JA3/JA4 fingerprint and HTTP/2 SETTINGS frame
});

const response = await client.fetch('https://httpbin.io/headers');
```

This is the Node.js equivalent of Python's `curl_cffi`. Use it as the HTTP client in Tier 1 of our fetch ladder instead of Node's native `fetch` or `axios` — the TLS fingerprint difference alone bypasses a significant fraction of bot detection.

### Pricing (August 2026)

| Plan | Price/month | Compute units | Actor store credit |
|---|---|---|---|
| Free | $0 | 5 | $5 |
| Starter | $29 | — | $5 |
| Scale | $199 | — | $5 |
| Business | $999 | — | $5 |

Compute units are billed by memory × time. A 1GB Actor running for 1 minute consumes 1 compute unit (~$0.25). For simple scraping, this is more expensive than Spider.cloud or ScrapingBee.

**Our verdict on Apify:** Skip the platform. Use **Crawlee** and **impit** as open-source libraries.

---

## 5. ZenRows — Anti-Bot Infrastructure

**Source:** https://docs.zenrows.com  
**Position:** "Web data infrastructure" — the clearest product framing of any competitor

### Primitives Architecture

ZenRows organizes its product around four primitives:

| Primitive | Description |
|---|---|
| **Fetch** | Get any page, bypass anti-bot, return clean content |
| **Extract** | Turn page into structured JSON (CSS or AI-based) |
| **Batch** | Process thousands of URLs as a managed job |
| **Browser Sessions** | Persistent Puppeteer/Playwright sessions through ZenRows proxy |

### Fetch API — Complete Parameters

**Endpoint:** `GET https://api.zenrows.com/v1/`

| Parameter | Type | Default | Cost multiplier | Description |
|---|---|---|---|---|
| `apikey` | string | required | — | API key |
| `url` | string | required | — | Target URL |
| `js_render` | boolean | `false` | 5x | JavaScript rendering |
| `premium_proxy` | boolean | `false` | 10x | Route through 55M residential IPs |
| `proxy_country` | string | — | — | ISO country code for proxy geolocation |
| `wait` | integer | — | — | Extra ms to wait after render |
| `wait_for` | string | — | — | CSS selector to wait for |
| `css_extractor` | string | — | — | CSS-based structured extraction |
| `autoparse` | boolean | `false` | — | Automatic structured data parsing |
| `session_id` | integer | — | — | Sticky IP across requests |
| `custom_headers` | boolean | `false` | — | Pass custom request headers |
| `original_status` | boolean | `false` | — | Return target's actual HTTP status |
| `block_resources` | boolean | `false` | — | Block images, fonts, media |
| `json_response` | boolean | `false` | — | Wrap in JSON envelope |

### TypeScript Integration Example

```typescript
import axios from 'axios';

interface ZenRowsParams {
  url: string;
  apikey: string;
  js_render?: boolean;
  premium_proxy?: boolean;
  proxy_country?: string;
  wait?: number;
  wait_for?: string;
  css_extractor?: string;
  session_id?: number;
  custom_headers?: boolean;
  original_status?: boolean;
  block_resources?: boolean;
}

async function zenRowsFetch(
  targetUrl: string,
  apiKey: string,
  options: Partial<Omit<ZenRowsParams, 'url' | 'apikey'>> = {}
): Promise<string> {
  const response = await axios.get('https://api.zenrows.com/v1/', {
    params: {
      url: targetUrl,
      apikey: apiKey,
      ...options,
    },
    headers: options.custom_headers
      ? { referer: 'https://www.google.com' }
      : undefined,
    timeout: 180000, // ZenRows recommends 180s timeout
  });

  // Check response headers for diagnostics
  const cost = response.headers['x-request-cost'];
  const remaining = response.headers['concurrency-remaining'];
  console.debug(`ZenRows: cost=${cost}, concurrency_remaining=${remaining}`);

  return response.data;
}

// Standard usage — cheapest path first
async function zenRowsTieredFetch(targetUrl: string, apiKey: string): Promise<string> {
  // Tier 1: try without premium proxy
  try {
    return await zenRowsFetch(targetUrl, apiKey, {
      js_render: true,
      block_resources: true,
    });
  } catch (e1: any) {
    if (e1.response?.status !== 422) throw e1;
  }

  // Tier 2: add premium proxy
  return zenRowsFetch(targetUrl, apiKey, {
    js_render: true,
    premium_proxy: true,
    proxy_country: 'us',
    wait: 2000,
  });
}
```

### Response Headers for Monitoring

ZenRows returns these headers on every response:

```
Concurrency-Limit: 5           // max concurrent requests for your plan
Concurrency-Remaining: 4       // available slots right now
X-Request-Cost: 10             // credits consumed by this request
```

### Premium Proxy Deep Dive

- **55 million residential IPs** across 190+ countries
- Automatically rotated per request (no sticky IP by default)
- Residential IPs come from real ISP connections (households, not data centers)
- Cost: **10x the standard rate** per request
- Anti-bot systems that specifically block datacenter CIDR ranges cannot block residential IPs without collateral damage to real users
- Combines with `js_render`, `wait`, and `custom_headers` for best results

**When standard proxy fails but residential succeeds:** Sites that use Cloudflare, Akamai, or DataDome with IP reputation as a signal. Examples: e-commerce platforms, financial sites, social media.

### Browser Sessions (Puppeteer/Playwright Proxy Mode)

ZenRows Browser Sessions let you route your own Playwright/Puppeteer through ZenRows proxies with anti-bot bypass applied:

```typescript
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(
  `wss://browser.zenrows.com?apikey=${API_KEY}`
);

const page = await browser.newPage();
await page.goto('https://example.com');
// ZenRows applies fingerprint spoofing and proxy rotation transparently
```

**Our verdict:** We do not need this. We run our own Playwright. The ZenRows Browser Sessions value prop is for teams that already have scraping code and want to add anti-bot bypass without rewriting it. We are building from scratch with the right architecture.

### Pricing (August 2026)

ZenRows uses a credit system. Plans:
- Free: 1,000 credits/month
- Developer: ~$49/month
- Professional: ~$99/month
- Business: ~$249/month

At 10x cost multiplier for premium proxy, a $99 plan with standard 100K credits per month yields only 10K premium proxy requests. Budget carefully.

---

## 6. Scrapfly — Middleware Anti-Bot Platform

**Source:** https://scrapfly.io/docs  
**Differentiator:** The most honest anti-bot SLA in the market; clearest documentation of what can and cannot be bypassed

### Core Products

| Product | Description |
|---|---|
| Web Scraping API | Main endpoint with ASP (Anti-Scraping Protection) |
| Cloud Browser | CDP-accessible browser with anti-bot bypass |
| Crawler API | Recursive site crawler (beta) |
| Screenshot API | Full-page screenshots |
| Extraction API | AI-powered structured data extraction |
| Proxy Saver | Bandwidth-optimized proxy routing with fingerprinting |
| MCP Server | Direct MCP integration for AI agents |

### Web Scraping API — Parameters

**Base URL:** `https://api.scrapfly.io/scrape`  
**Auth:** `key=YOUR_API_KEY` parameter (also available as header)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | Target URL |
| `key` | string | required | API key |
| `asp` | boolean | `false` | Anti-Scraping Protection (auto-handles all known anti-bot systems) |
| `render_js` | boolean | `false` | JavaScript rendering |
| `proxy_pool` | string | datacenter | `public_datacenter_pool`, `public_residential_pool`, `public_tor_pool` |
| `country` | string | — | ISO country code for proxy geolocation |
| `headers` | object | — | Custom headers to send to target |
| `cookies` | object | — | Custom cookies |
| `body` | string | — | Request body for POST/PUT/PATCH |
| `method` | string | `GET` | HTTP method: GET, POST, PUT, PATCH, HEAD, OPTIONS |
| `session` | string | — | Session ID for sticky IP |
| `cache` | boolean | `false` | Enable response caching |
| `cache_ttl` | integer | — | Cache TTL in seconds |
| `retry` | boolean | `true` | Auto-retry on failure |
| `timeout` | integer | `155000` | Timeout in ms (default: 155s) |
| `screenshots` | object | — | Screenshot configuration |
| `js_scenario` | object | — | JavaScript automation scenario |
| `extract_html_options` | object | — | HTML extraction options |
| `webhooks` | array | — | Webhook URLs for async delivery |
| `format` | string | `json` | Response format: `json`, `msgpack` |
| `dns` | boolean | `false` | Include DNS resolution info |
| `ssl` | boolean | `false` | Include SSL cert info |
| `debug` | boolean | `false` | Return debug info |
| `tags` | array | — | Custom labels for monitoring |

### Proxy Pools and Credit Costs

| Pool | Parameter value | Credits per request |
|---|---|---|
| Public datacenter | `public_datacenter_pool` | 1 |
| Public residential | `public_residential_pool` | 25 |
| Tor network (.onion) | `public_tor_pool` | 5 |

### ASP (Anti-Scraping Protection) — How It Works

ASP is a single `asp=true` parameter that activates Scrapfly's full anti-bot bypass stack. It is opaque by design.

What ASP does internally:
- Selects optimal proxy pool for the target site (may upgrade from datacenter to residential)
- Enables browser rendering if the site requires it
- Manages TLS fingerprint consistency (Chrome-based UA = Chrome TLS stack)
- Handles session/cookie reuse for challenge cookies
- Auto-generates `referer` if not present
- Fine-tunes `country`, `OS`, `user-agent`, `accept`, `content-type` headers
- Applies custom bypass logic for known high-profile anti-bot configurations

**SLA reality (from their own docs):** Anti-bot technology evolves continuously. Scrapfly engineers maintain bypass solutions on a best-effort basis:
- Common known anti-bot systems: 1 business day restoration after a breaking change
- Average: 3-7 business days
- No ETAs provided
- Credit cost may fluctuate if a site migrates to harder-to-bypass protection

Enterprise SLAs available from $50K/month minimum commitment.

```typescript
import axios from 'axios';

interface ScrapflyParams {
  url: string;
  key: string;
  asp?: boolean;
  render_js?: boolean;
  proxy_pool?: 'public_datacenter_pool' | 'public_residential_pool' | 'public_tor_pool';
  country?: string;
  session?: string;
  cache?: boolean;
  cache_ttl?: number;
  timeout?: number;
  retry?: boolean;
}

interface ScrapflyResponse {
  result: {
    content: string;
    status_code: number;
    format: 'html' | 'clob' | 'blob';
    url: string;
  };
  config: Record<string, unknown>;
  context: {
    asp?: {
      proxy_pool: string;
      js_rendered: boolean;
    };
  };
}

async function scrapflyFetch(
  targetUrl: string,
  apiKey: string,
  options: Partial<Omit<ScrapflyParams, 'url' | 'key'>> = {}
): Promise<ScrapflyResponse> {
  const params = new URLSearchParams({
    url: targetUrl,
    key: apiKey,
    ...(Object.fromEntries(
      Object.entries(options).map(([k, v]) => [k, String(v)])
    )),
  });

  const response = await fetch(
    `https://api.scrapfly.io/scrape?${params}`,
    {
      headers: {
        'Accept-Encoding': 'gzip',
        // Enable msgpack for 30% smaller payloads on large responses:
        // 'Accept': 'application/msgpack',
      },
    }
  );

  // Important: check error headers BEFORE reading body
  const rejectCode = response.headers.get('X-Scrapfly-Reject-Code');
  if (rejectCode) {
    const rejectDesc = response.headers.get('X-Scrapfly-Reject-Description');
    const retryable = response.headers.get('X-Scrapfly-Reject-Retryable');
    throw new ScrapflyError(rejectCode, rejectDesc ?? '', retryable === 'true');
  }

  const cost = response.headers.get('X-Scrapfly-Api-Cost');
  const remaining = response.headers.get('X-Scrapfly-Remaining-Api-Credit');
  console.debug(`Scrapfly: cost=${cost}, remaining=${remaining}`);

  return response.json();
}

class ScrapflyError extends Error {
  constructor(
    public code: string,
    public description: string,
    public retryable: boolean
  ) {
    super(`Scrapfly error ${code}: ${description}`);
  }
}

// Usage with ASP enabled
async function scrapflyAspFetch(targetUrl: string, apiKey: string) {
  const result = await scrapflyFetch(targetUrl, apiKey, {
    asp: true,
    country: 'us',
    timeout: 155000,
  });

  // Handle large object responses (CLOB/BLOB > 5MB)
  if (result.result.format === 'clob') {
    const contentResponse = await fetch(result.result.content, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return contentResponse.text();
  }

  return result.result.content;
}
```

### HTTP Status Code Meanings (Scrapfly-specific)

| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Bad request (missing/invalid parameter) |
| 401 | Invalid API key |
| 402 | Payment issue |
| 403 | Key lacks permission |
| 422 | Request failed (valid params, but target blocked or errored) |
| 429 | Free quota exhausted OR max concurrency reached OR domain throttled |
| 500/502/503 | Scrapfly server error |
| 504 | Scrape timed out |

The `X-Scrapfly-Reject-Code` header on 422 responses contains the machine-readable error code for your retry logic.

### Large Object Handling

Responses over 5MB are "offloaded" from the main JSON response:
- `result.format` = `"clob"` (text) or `"blob"` (binary)
- `result.content` = URL to download the actual content
- Download URL requires authentication with the same API key
- URL is valid until the log expires (dashboard retention period)

This is Scrapfly-specific behavior with no equivalent in other APIs. Handle it explicitly.

### Cloud Browser (CDP Access)

Scrapfly's Cloud Browser provides a remotely-accessible browser via Chrome DevTools Protocol:

```typescript
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(
  `wss://browser.scrapfly.io?key=${API_KEY}&asp=true&country=us`
);
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://protected-site.com');
```

Features: Captcha solving, human-in-the-loop mode, live VNC control, session resume.

---

## 7. Anti-Bot Systems: How They Work and How to Beat Them

Sources: 
- https://dev.to/vhub_systems_ed5641f65d59/how-anti-bot-systems-detect-scrapers-in-2026-and-the-9-bypasses-that-still-work-2jfi
- https://scrapfly.io/blog/posts/ja3-ja4-tls-fingerprinting-guide-to-detection-and-evasion
- https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/

### Detection Layers

#### Layer 1: Network-Level Detection (happens before any JS)

**TLS/JA3/JA4 Fingerprinting**

Every HTTPS client produces a unique TLS Client Hello based on:
- Cipher suite list and ordering
- TLS extensions present and their ordering
- Supported groups (curves)
- Signature algorithms

Python's `requests` library has a distinctive JA3 fingerprint that is trivially identified. The hash is computed by Cloudflare at the edge before the request reaches any application logic.

```
JA3 = MD5(TLSVersion,Ciphers,Extensions,EllipticCurves,EllipticCurvePointFormats)
JA4 = more_granular_version_with_ordering_sensitivity
```

**HTTP/2 Fingerprinting**

HTTP/2 clients configure SETTINGS frames differently. The frame ordering, stream priorities, and HEADERS frame format differ between Chrome, Firefox, and Python HTTP clients.

**IP Reputation**

AWS, GCP, Azure, Hetzner, and other data center CIDR ranges are instantly flagged. ASN of a residential ISP passes this check.

#### Layer 2: Browser Fingerprinting (JavaScript execution)

**Canvas Fingerprint:** Hidden `<canvas>` element rendered via WebGL. GPU driver, OS, and font rendering all affect the output. Headless Chrome has a recognizable pattern.

**WebGL Renderer:** `RENDERER` attribute exposes GPU. Headless Chrome often reports `SwiftShader Indirect` — an immediate flag.

**Navigator Properties Checklist:**
```javascript
navigator.webdriver === true          // headless browsers leak this
navigator.plugins.length === 0        // Chrome always has plugins
typeof window.chrome === 'undefined'  // Chrome defines this object
navigator.languages.length === 0      // real browsers have language preferences
performance.memory                    // undefined in some headless environments
```

**How stealth plugins patch these:**
```javascript
// puppeteer-extra-plugin-stealth approach (conceptual, not actual code):
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', {
  get: () => [/* realistic plugin array */],
});
window.chrome = { runtime: {}, loadTimes: function() {} };
// Canvas: hook CanvasRenderingContext2D.getImageData to add noise
```

#### Layer 3: Behavioral Analysis

**Request Timing:** Machine-perfect intervals are flagged. Human requests have Gaussian noise.

```typescript
function humanDelay(minMs = 1500, maxMs = 4000): Promise<void> {
  const base = minMs + Math.random() * (maxMs - minMs);
  const noise = gaussianRandom(0, 300); // mean=0, stddev=300ms
  return new Promise(resolve => setTimeout(resolve, Math.max(500, base + noise)));
}

function gaussianRandom(mean: number, stddev: number): number {
  // Box-Muller transform
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
```

**Session Depth:** Real users visit home page, navigate, follow links. Scrapers hit target pages directly.

**Mouse Movement:** Real users have curved, jittery paths. Bots move in straight lines or not at all.

#### Layer 4: ML-Based Anomaly Detection

Cloudflare Bot Management and Akamai Bot Manager run ML models trained on billions of requests. They detect:
- Accept-Language / geography mismatch
- User-Agent claiming Windows but HTTP/2 settings matching Linux
- Cookie handling inconsistencies
- "Overcorrected" mouse movements (too jittery, not natural)

**No single rule patch defeats this.** The key insight: every signal must tell the same consistent story.

### Specific Anti-Bot Vendors

#### Cloudflare Bot Management

Cloudflare operates at two levels:
1. **JS Challenge / Managed Challenge:** A JavaScript challenge that fingerprints the browser before serving content. Solved by real browsers automatically; headless browsers must pass it via stealth patches.
2. **Turnstile CAPTCHA:** User-visible challenge embedded in forms. Requires human solving or specialized solvers.
3. **Bot Score (1-99):** ML-computed score available in `cf.bot_management.score`. Scores below ~30 = automated traffic.

**Cloudflare detection signals:**
- TLS fingerprint (JA3/JA4)
- HTTP/2 SETTINGS frame
- Bot score from ML model
- IP reputation + ASN
- Canvas/WebGL fingerprint
- Behavioral analysis

**Effective bypass (in order of success rate):**
1. Residential proxy + full stealth Playwright = highest success
2. `curl_cffi` with `impersonate="chrome124"` (TLS + HTTP/2) = good for non-JS-challenge sites
3. Commercial APIs (Scrapfly ASP, ZenRows) = managed, up-to-date bypass

#### DataDome

DataDome is a client-side ML detection system injected as a JavaScript tag:

```html
<script src="https://dd.example.com/tags.js"></script>
```

It sends behavioral telemetry (mouse, keyboard, scroll, touch) to DataDome servers which return a session token. Pages check for this token.

**Bypass:** Requires running full browser with DataDome's JS executing normally. Stealth patches + residential proxy generally sufficient. Commercial APIs handle it in ASP/stealth mode.

#### Akamai Bot Manager

Similar to DataDome — client-side JavaScript injection with behavioral analytics. Sends sensor data to Akamai edge. More aggressive than DataDome; harder to bypass consistently.

#### PerimeterX (now HUMAN Security)

Injects JavaScript challenge, uses advanced fingerprinting including hardware-level signals (deviceMemory, hardwareConcurrency). Residential proxy + full stealth browser required.

### Bypasses That Still Work in 2026

| Bypass | What it defeats | Difficulty |
|---|---|---|
| `impit`/`curl_cffi` with Chrome impersonation | TLS/JA3, HTTP/2 fingerprint | Easy (Node.js: `impit` library) |
| Residential proxies | IP reputation, ASN checks | Easy (costs money) |
| Playwright + stealth plugin | Navigator leaks, canvas, WebGL | Medium |
| Gaussian timing noise | Machine-interval detection | Easy |
| Session depth simulation | Single-page-hit patterns | Medium |
| Consistent Accept-Language + geo match | Header inconsistency ML signals | Easy |
| Cookie jar persistence across requests | Session tracking checks | Easy |
| Human mouse path replay | Interactive behavior analysis | Hard |

### What Does Not Work in 2026

- Rotating User-Agent strings alone — JA3 is not in the User-Agent
- Simple datacenter proxy rotation for Cloudflare Enterprise sites
- `headless=true` without stealth patches — detected in under 1 second
- Fixed `setTimeout(2000)` between requests — machine-perfect timing is flagged

---

## 8. Residential Proxy Networks

### How They Work

Residential proxies are IP addresses assigned by ISPs to household internet connections. These are collected by proxy providers through one of:
1. **SDK/app embedding:** A mobile app or desktop utility includes proxy code that uses the user's bandwidth in exchange for service. Controversial ethically — users may not fully understand.
2. **Peer-to-peer networks:** Similar approach via peer networks like Hola (notorious for misuse).
3. **ISP partnerships:** Direct arrangements with ISPs to route traffic through unused residential bandwidth.

### Ethical Concerns

The residential proxy industry has well-documented ethical problems:
- Many networks obtain IP addresses without meaningful informed consent
- Residential IPs used for scraping can cause real users' IPs to get flagged
- Some providers have been exposed for malware-style distribution

**For our self-hosted MCP server:** We recommend using commercial API fallbacks (ScrapingBee, Scrapfly) rather than purchasing residential proxy access directly. The commercial APIs absorb the ethical and operational complexity.

### Major Providers and Pricing (August 2026)

| Provider | Residential IPs | Price | Notes |
|---|---|---|---|
| Bright Data | 72M+ | $8.40/GB | Industry leader, most expensive |
| Oxylabs | 100M+ | $8/GB | Enterprise focus |
| Smartproxy | 40M+ | $7/GB | Good mid-tier |
| SOAX | 8M+ | $6/GB | Smaller but ethical sourcing claims |
| ZenRows (via API) | 55M | Bundled | Use via API, no direct proxy access |
| Scrapfly (via API) | Undisclosed | Bundled | Use via API, no direct proxy access |

**Recommendation:** For our use case (MCP server making occasional hard-to-fetch requests), paying per-request via ScrapingBee or Scrapfly is cheaper and simpler than purchasing GB-based residential proxy access. A residential proxy subscription makes sense at >10K requests/day.

---

## 9. Headless Browsers: Playwright, Puppeteer, Lightpanda

### Playwright (Node.js) — Primary Choice

**Why Playwright over Puppeteer:**
- Multi-browser support (Chromium, Firefox, WebKit) — WebKit uniquely fingerprints differently
- Better async model with `await` throughout
- Network request interception is more capable
- Built-in `BrowserContext` for session isolation without separate processes
- Actively maintained by Microsoft

### BrowserContext Pool Pattern

The critical architectural decision: **do not launch one browser process per request**. Use a pool of `BrowserContext` instances within a shared browser process.

```typescript
import { Browser, BrowserContext, Page, chromium } from 'playwright';

interface PooledContext {
  context: BrowserContext;
  inUse: boolean;
  createdAt: number;
  requestCount: number;
}

class PlaywrightContextPool {
  private browser: Browser | null = null;
  private pool: PooledContext[] = [];
  private readonly maxContexts: number;
  private readonly maxRequestsPerContext: number;
  private readonly contextMaxAgeMs: number;

  constructor(options: {
    maxContexts?: number;
    maxRequestsPerContext?: number;
    contextMaxAgeMs?: number;
  } = {}) {
    this.maxContexts = options.maxContexts ?? 5;
    this.maxRequestsPerContext = options.maxRequestsPerContext ?? 50;
    this.contextMaxAgeMs = options.contextMaxAgeMs ?? 5 * 60 * 1000; // 5 min
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        // Anti-detection: don't use default Chromium args that leak headless
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }

  async acquire(): Promise<{ context: BrowserContext; release: () => Promise<void> }> {
    if (!this.browser) await this.initialize();

    // Find an available context
    const available = this.pool.find(
      p => !p.inUse && this.isContextHealthy(p)
    );

    if (available) {
      available.inUse = true;
      available.requestCount++;
      return {
        context: available.context,
        release: async () => { available.inUse = false; },
      };
    }

    // Create new context if pool not full
    if (this.pool.length < this.maxContexts) {
      const context = await this.browser!.newContext({
        // Stealth settings
        userAgent: this.getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        // Block fingerprinting via permissions
        permissions: ['geolocation'],
        geolocation: { longitude: -74.006, latitude: 40.7128 },
      });

      // Stealth: patch navigator properties
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ],
        });
        (window as any).chrome = {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
          app: {},
        };
      });

      const pooled: PooledContext = {
        context,
        inUse: true,
        createdAt: Date.now(),
        requestCount: 1,
      };
      this.pool.push(pooled);

      return {
        context,
        release: async () => {
          pooled.inUse = false;
          // Retire context if it has exceeded request limit
          if (!this.isContextHealthy(pooled)) {
            await this.retireContext(pooled);
          }
        },
      };
    }

    // Pool full — wait for a slot
    return this.waitForAvailable();
  }

  private isContextHealthy(pooled: PooledContext): boolean {
    return (
      pooled.requestCount < this.maxRequestsPerContext &&
      Date.now() - pooled.createdAt < this.contextMaxAgeMs
    );
  }

  private async retireContext(pooled: PooledContext): Promise<void> {
    const idx = this.pool.indexOf(pooled);
    if (idx !== -1) this.pool.splice(idx, 1);
    try { await pooled.context.close(); } catch { /* ignore */ }
  }

  private async waitForAvailable(): Promise<{ context: BrowserContext; release: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = setInterval(async () => {
        if (Date.now() - startTime > 30000) {
          clearInterval(check);
          reject(new Error('Playwright context pool exhausted after 30s'));
        }
        const available = this.pool.find(p => !p.inUse && this.isContextHealthy(p));
        if (available) {
          clearInterval(check);
          available.inUse = true;
          available.requestCount++;
          resolve({
            context: available.context,
            release: async () => { available.inUse = false; },
          });
        }
      }, 100);
    });
  }

  private getRandomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }

  async destroy(): Promise<void> {
    for (const pooled of this.pool) {
      try { await pooled.context.close(); } catch { /* ignore */ }
    }
    this.pool = [];
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

// Usage
const pool = new PlaywrightContextPool({ maxContexts: 5, maxRequestsPerContext: 50 });
await pool.initialize();

async function fetchWithPlaywright(url: string): Promise<string> {
  const { context, release } = await pool.acquire();
  let page: Page | null = null;

  try {
    page = await context.newPage();

    // Block unnecessary resources for performance
    await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,otf}', r => r.abort());
    await page.route('**/analytics/**', r => r.abort());
    await page.route('**/tracking/**', r => r.abort());

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Human-like random delay before extraction
    await page.waitForTimeout(gaussianRandom(800, 300));

    return await page.content();
  } finally {
    if (page) await page.close().catch(() => {});
    await release();
  }
}
```

### Memory Management

**Key causes of Playwright memory leaks:**
1. Contexts that are never closed (most common)
2. One browser process per request (process per page)
3. Long-lived browser processes accumulating state

**Memory baseline:** Chrome headless uses ~150-300MB per process base. Each `BrowserContext` adds ~20-50MB. Each active `Page` adds ~20-50MB.

**With context pool (5 contexts, up to 3 pages each):**
- Base Chrome: ~200MB
- 5 contexts × 30MB: ~150MB  
- Up to 15 pages × 25MB: ~375MB
- Total: ~725MB resident

**Without pool (one browser per request):**
- 5 concurrent: 5 × 200MB base = 1GB just for browser processes

The pool provides a ~60% memory reduction for equivalent concurrency.

### Lightpanda — The Alternative Worth Watching

**Source:** https://lightpanda.io  
**Status:** Production-ready, open-source (MIT), cloud offer available

Lightpanda is a headless browser written from scratch in Zig. It is not a Chromium fork.

| Metric | Lightpanda | Chrome Headless |
|---|---|---|
| Startup time | ~milliseconds | 1-3 seconds |
| Memory per instance | ~123MB | ~2GB (at load) |
| Execution speed | 9-11x faster | baseline |
| CDP compatible | Yes | Yes (it is the standard) |
| Playwright compatible | Yes | Yes |
| Anti-bot detection risk | Higher (less common fingerprint) | Lower (matches real Chrome) |

**How to use Lightpanda with Playwright:**
```typescript
// Lightpanda Cloud (wss endpoint)
const browser = await chromium.connectOverCDP(
  'wss://euwest.cloud.lightpanda.io/ws?token=YOUR_TOKEN'
);

// Self-hosted (runs CDP server on port 9222)
// lightpanda serve --host 127.0.0.1 --port 9222
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

// The rest of Playwright code is unchanged
const page = await browser.newPage();
await page.goto('https://example.com');
```

**When to use Lightpanda vs Chrome Headless:**

| Use case | Recommendation |
|---|---|
| Speed-critical content extraction (no anti-bot) | Lightpanda — 9-11x faster |
| Anti-bot protected sites (Cloudflare, DataDome) | Chrome Headless — fingerprint matches real users |
| High-throughput bulk crawl | Lightpanda — 16x less memory means more parallelism |
| Interactive automation (login flows) | Chrome Headless — better JS compatibility |

**For our three-tier ladder:** Lightpanda is an excellent Tier 2 (lightweight JS rendering). Reserve Chrome Headless for Tier 3 (anti-bot protected sites) where the Chrome fingerprint is an advantage.

---

## 10. Our Three-Tier Render Ladder vs Commercial Scrapers

### Our Architecture

```
Tier 1: HTTP (undici/impit with Chrome TLS impersonation)
  └── handles: 70-80% of requests
  └── cost: free
  └── latency: 200-500ms

Tier 2: Lightpanda (JS rendering, lightweight)
  └── handles: 15-20% of requests (SPAs, simple JS)
  └── cost: memory (123MB per instance)
  └── latency: 1-3s

Tier 3: Playwright + Stealth (full browser, Chrome fingerprint)
  └── handles: 5-10% of requests (complex SPAs, some anti-bot)
  └── cost: memory (200MB+ per context)
  └── latency: 3-10s

Tier 4: Commercial API fallback (user-supplied key)
  └── handles: <1% of requests (Cloudflare Enterprise, DataDome)
  └── cost: per-request API credits
  └── latency: 5-30s
```

### How We Compare to Each Competitor

| Feature | Our Stack | ScrapingBee | Spider.cloud | Scrapfly | ZenRows |
|---|---|---|---|---|---|
| Plain HTTP | impit (Chrome TLS) | ✓ | ✓ | ✓ | ✓ |
| Lightweight JS | Lightpanda | ✗ (all headless Chrome) | ✗ | ✗ | ✗ |
| Full headless | Playwright (pooled) | headless Chrome | headless Chrome | headless Chrome | headless Chrome |
| Anti-bot | Stealth patches + noise | premium_proxy | smart mode | ASP | stealth mode |
| Cloudflare Enterprise | Tier 4 API | ✓ (stealth_proxy) | limited | ✓ (ASP) | ✓ (stealth mode) |
| Cost at scale | $0 (self-hosted) | per-request | per-credit | per-credit | per-credit |
| Markdown output | TurndownService/MDX | return_page_markdown | return_format=markdown | post-process | custom |
| Latency | 200ms-10s | 2-30s | 500ms-5s | 500ms-30s | 2-30s |

**Our key advantage:** We run Tier 1-3 for free on the operator's infrastructure. Commercial APIs are only needed for Tier 4 edge cases. An MCP server fetching typical enterprise/public web content will rarely hit Tier 4.

**Our key weakness:** We cannot consistently beat Cloudflare Enterprise, Akamai Bot Manager, or DataDome for the hardest targets. We need the Tier 4 commercial fallback for those cases.

### Detection Risk: Our Tier 3 vs Commercial

Commercial scrapers invest full-time engineering in maintaining their fingerprint profiles against current anti-bot versions. Our Playwright stealth config will fall behind over time unless maintained. 

**Mitigation:** Ship a configurable stealth profile that can be updated independently, and make the Tier 4 commercial fallback easy to configure. The 5% of requests that need it can be routed to ScrapingBee or Scrapfly without any code change.

---

## 11. Caching Strategy: Redis LRU for Fetch Results

### What to Cache

| Content type | Cache? | TTL | Rationale |
|---|---|---|---|
| Static docs (versioned URLs) | Yes | 24h | Rarely change |
| News articles | Yes | 1-4h | Useful for agents asking about recent content |
| Product pages | Yes | 30-60min | Prices/availability change |
| Search results | Yes | 5-15min | Fresh enough for agent queries |
| Dashboard/auth-gated pages | No | — | Per-user content |
| Real-time data (stock prices) | No | — | Stale data is dangerous |
| Form-submission pages | No | — | POST responses should not be cached |

### Cache Key Design

```typescript
import { createHash } from 'crypto';

interface FetchCacheKey {
  url: string;
  renderTier: 'http' | 'lightpanda' | 'playwright' | 'api';
  // Do NOT include user identity — MCP fetches are for public web content
}

function buildCacheKey(key: FetchCacheKey): string {
  // Normalize URL: sort query params, lowercase scheme/host
  const normalized = normalizeUrl(key.url);
  const hash = createHash('sha256')
    .update(`${key.renderTier}:${normalized}`)
    .digest('hex')
    .slice(0, 16);
  return `mcp:fetch:${hash}`;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Sort query params for cache hit consistency
    u.searchParams.sort();
    // Remove tracking params
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid', 'gclid']) {
      u.searchParams.delete(param);
    }
    return u.toString();
  } catch {
    return url;
  }
}
```

### Redis Configuration

```typescript
import { createClient } from 'redis';

const redis = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // For cache use, prefer allkeys-lru so Redis self-manages eviction
  // Set in redis.conf: maxmemory 512mb, maxmemory-policy allkeys-lru
});

interface CachedFetchResult {
  content: string;         // markdown string
  url: string;             // final URL after redirects
  status: number;          // HTTP status
  fetchedAt: number;       // unix timestamp ms
  renderTier: string;      // which tier was used
  contentHash: string;     // SHA-256 of content (for ETag equivalent)
}

async function getCached(key: FetchCacheKey): Promise<CachedFetchResult | null> {
  const cached = await redis.get(buildCacheKey(key));
  if (!cached) return null;
  return JSON.parse(cached) as CachedFetchResult;
}

async function setCached(
  key: FetchCacheKey,
  result: CachedFetchResult,
  ttlSeconds: number
): Promise<void> {
  await redis.setEx(
    buildCacheKey(key),
    ttlSeconds,
    JSON.stringify(result)
  );
}

// Dynamic TTL based on content type heuristics
function inferTtl(url: string, status: number): number {
  if (status !== 200) return 60; // Don't cache errors long — site may recover

  const u = new URL(url);
  const path = u.pathname.toLowerCase();

  // Versioned assets / doc pages — cache long
  if (/\/v\d+\/|@\d+\.\d+|\?v=/.test(url)) return 86400; // 24h
  if (path.includes('/docs/') || path.includes('/documentation/')) return 3600; // 1h

  // News / blog — medium cache
  if (/\/(blog|news|articles?|posts?)\//.test(path)) return 1800; // 30min

  // Product pages — shorter
  if (/\/(products?|shop|store|pricing)\//.test(path)) return 900; // 15min

  // Default
  return 3600; // 1h
}
```

### Redis Eviction Policy for Fetch Cache

**Recommended:** `allkeys-lru` (Least Recently Used across all keys)

```
# redis.conf
maxmemory 512mb              # tune to available RAM; 512MB holds ~50K average pages
maxmemory-policy allkeys-lru # evict LRU keys when maxmemory reached
maxmemory-samples 5          # samples checked per eviction (higher = more accurate but slower)
```

Why `allkeys-lru` over `volatile-lru`: Our cache keys all have TTLs set (via `setEx`), but `allkeys-lru` gives Redis the ability to evict any key when under memory pressure, not just TTL-expired ones. This prevents cache-full stalls.

**Alternative: `allkeys-lfu`** (Least Frequently Used) — better if you have power-law access patterns where a few URLs are fetched much more often than others. LFU keeps the "hot" pages in cache even if they haven't been accessed in the last minute.

### Cache Stampede Prevention

When a cached item expires and many concurrent requests arrive for the same URL, all of them may simultaneously trigger a fetch. Use probabilistic early expiration (PER):

```typescript
async function fetchWithCache(url: string, apiKey?: string): Promise<string> {
  const key: FetchCacheKey = { url, renderTier: 'http' };
  const cacheKey = buildCacheKey(key);
  const ttl = await redis.ttl(cacheKey);
  const cached = await getCached(key);

  if (cached) {
    // Probabilistic early expiration: refresh 10% of requests when < 10% TTL remains
    const fullTtl = inferTtl(url, cached.status);
    const shouldRefresh = ttl < fullTtl * 0.1 && Math.random() < 0.1;
    if (!shouldRefresh) return cached.content;
  }

  // Use a Redis lock to prevent concurrent fetches for the same URL
  const lockKey = `lock:fetch:${cacheKey}`;
  const locked = await redis.set(lockKey, '1', { NX: true, EX: 30 });
  if (!locked && cached) return cached.content; // another worker is fetching, use stale
  if (!locked) {
    await new Promise(r => setTimeout(r, 1000)); // wait and retry once
    const retried = await getCached(key);
    if (retried) return retried.content;
  }

  try {
    const result = await tieredFetch(url, apiKey);
    const ttlSeconds = inferTtl(url, result.status);
    await setCached(key, result, ttlSeconds);
    return result.content;
  } finally {
    await redis.del(lockKey);
  }
}
```

---

## 12. Polite Crawling: robots.txt, Crawl-Delay, Rate Limiting

Sources:
- https://evomi.com/blog/respecting-robots.txt-and-crawl-delay-ethical-scraping-that-still-scales
- https://www.sparkproxy.io/blog/guide-on-ethical-scraping-and-rate-limiting
- https://blog.crawlex.net/blog/crawl-politeness-robots-txt/

### Why It Matters for an Enterprise MCP Server

An MCP server making requests on behalf of AI agents can generate request patterns that look like DDoS to small-to-medium website operators. More importantly, enterprise deployments (Phase 2 with SharePoint/Confluence connectors) will need to demonstrate compliance-grade fetch behavior.

### robots.txt Parsing

robots.txt parsing is non-trivial:
- Multiple `User-agent:` groups
- Wildcard matching (`/api/v*/`)
- `Crawl-delay:` directive (not in RFC 9309 but widely used)
- `Sitemap:` discovery
- `Allow:` overrides `Disallow:` for more specific paths

```typescript
import robotsParser from 'robots-parser'; // npm install robots-parser

interface RobotsCache {
  allowed: boolean;
  crawlDelayMs: number;
  sitemapUrls: string[];
  fetchedAt: number;
}

const robotsCache = new Map<string, RobotsCache>();

async function checkRobots(url: string, userAgent: string = 'mcp-fetch-bot/1.0'): Promise<{
  allowed: boolean;
  crawlDelayMs: number;
}> {
  const { hostname, protocol } = new URL(url);
  const robotsUrl = `${protocol}//${hostname}/robots.txt`;
  const cacheKey = hostname;

  // Cache robots.txt for 1 hour
  const cached = robotsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 3600000) {
    return { allowed: cached.allowed, crawlDelayMs: cached.crawlDelayMs };
  }

  let robotsTxt = '';
  try {
    const response = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': userAgent },
    });
    if (response.ok) robotsTxt = await response.text();
  } catch {
    // robots.txt fetch failure = allow (cannot penalize for server errors)
    return { allowed: true, crawlDelayMs: 1000 };
  }

  const robots = robotsParser(robotsUrl, robotsTxt);
  const allowed = robots.isAllowed(url, userAgent) ?? true;
  
  // Crawl-delay in seconds → ms (not all parsers expose this; check docs)
  const crawlDelaySec = robots.getCrawlDelay(userAgent) ?? 1;
  const crawlDelayMs = Math.max(crawlDelaySec * 1000, 500); // minimum 500ms

  robotsCache.set(cacheKey, {
    allowed,
    crawlDelayMs,
    sitemapUrls: robots.getSitemaps() ?? [],
    fetchedAt: Date.now(),
  });

  return { allowed, crawlDelayMs };
}
```

### Per-Domain Rate Limiter (Token Bucket)

```typescript
class DomainRateLimiter {
  // Per-domain token buckets
  private buckets = new Map<string, {
    tokens: number;
    lastRefill: number;
    crawlDelayMs: number;
  }>();

  async acquire(hostname: string, crawlDelayMs: number): Promise<void> {
    const now = Date.now();
    let bucket = this.buckets.get(hostname);

    if (!bucket) {
      bucket = { tokens: 1, lastRefill: now, crawlDelayMs };
      this.buckets.set(hostname, bucket);
      return; // First request is always allowed
    }

    // Refill: 1 token per crawlDelayMs
    const elapsed = now - bucket.lastRefill;
    const newTokens = Math.floor(elapsed / crawlDelayMs);
    bucket.tokens = Math.min(bucket.tokens + newTokens, 3); // burst cap: 3
    if (newTokens > 0) bucket.lastRefill = now;

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    // Wait for next token
    const waitMs = crawlDelayMs - (now - bucket.lastRefill);
    await new Promise(r => setTimeout(r, Math.max(waitMs, 0)));
    bucket.tokens = 0;
    bucket.lastRefill = Date.now();
  }
}

const rateLimiter = new DomainRateLimiter();

async function politeFetch(url: string): Promise<string> {
  const { hostname } = new URL(url);
  const { allowed, crawlDelayMs } = await checkRobots(url);

  if (!allowed) {
    throw new Error(`robots.txt disallows fetching ${url}`);
  }

  await rateLimiter.acquire(hostname, crawlDelayMs);

  // Add Gaussian noise to timing
  await new Promise(r => setTimeout(r, gaussianRandom(100, 50)));

  return fetchContent(url);
}
```

### Enterprise Deployment Recommendations

For enterprise self-hosted deployments:

1. **Always check robots.txt.** Cache for 1 hour. Respect `Crawl-delay:`.
2. **Identify your bot.** Set `User-Agent: mcp-fetch-bot/1.0 (+https://your-org.com/mcp-bot)`. Operators who fetch robots.txt and then ignore `Crawl-delay` are worse than operators who never fetch it — the monitoring distinction is real.
3. **Rate limit to 1 request per 2 seconds per domain by default**, regardless of `Crawl-delay`. The default `Crawl-delay` of 0 (not specified) does not mean unlimited speed.
4. **Cache aggressively.** Repeated fetches of the same URL from different agent sessions is waste. The TTL logic above covers this.
5. **Off-peak crawling.** For bulk knowledge index tasks (Phase 2 SharePoint/Confluence), schedule during off-peak hours.
6. **Expose bypass flag.** Let operators configure `bypassRobots: true` for intranet content (SharePoint, Confluence) that doesn't publish robots.txt.

---

## 13. Node.js Fetch Pipeline Architecture

### Complete Three-Tier Implementation

```typescript
import { createClient, RedisClientType } from 'redis';
import { Browser, chromium } from 'playwright';
import TurndownService from 'turndown';

// ─── Types ─────────────────────────────────────────────────────────────────

type RenderTier = 'http' | 'lightpanda' | 'playwright' | 'api';

interface FetchOptions {
  maxTier?: RenderTier;         // don't escalate above this tier
  apiKey?: string;              // commercial API key for Tier 4
  apiProvider?: 'scrapingbee' | 'scrapfly'; // which Tier 4 provider
  timeout?: number;             // ms per tier attempt
  bypassRobots?: boolean;       // skip robots.txt check (for intranets)
  bypassCache?: boolean;        // force fresh fetch
  cacheTtlOverride?: number;    // override TTL inference
}

interface FetchResult {
  markdown: string;
  url: string;                  // final URL after redirects
  status: number;
  tier: RenderTier;
  cached: boolean;
  fetchedAt: number;
  error?: string;
}

// ─── Turndown (HTML → Markdown) ─────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Remove nav, header, footer, ads
turndown.remove(['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript']);

function htmlToMarkdown(html: string): string {
  // Pre-process: strip invisible elements
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return turndown.turndown(cleaned);
}

// ─── Tier 1: HTTP with Chrome TLS Impersonation ──────────────────────────────

async function fetchTier1(url: string, timeoutMs = 10000): Promise<FetchResult> {
  // Use undici with custom TLS settings to reduce fingerprint difference
  // In production, replace with impit (npm install impit) for Chrome TLS impersonation
  const { fetch: undiciFetch } = await import('undici');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const html = await response.text();
    const markdown = htmlToMarkdown(html);

    // Heuristic: if markdown is mostly empty, JS rendered the real content
    if (markdown.trim().length < 500) {
      throw new TierEscalationError('Page requires JavaScript rendering');
    }

    return {
      markdown,
      url: response.url,
      status: response.status,
      tier: 'http',
      cached: false,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tier 2: Lightpanda (lightweight JS) ─────────────────────────────────────

async function fetchTier2(url: string, timeoutMs = 15000): Promise<FetchResult> {
  // Connect to Lightpanda CDP endpoint (self-hosted or cloud)
  const lightpandaUrl = process.env.LIGHTPANDA_URL ?? 'http://127.0.0.1:9222';

  const browser = await chromium.connectOverCDP(lightpandaUrl);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const html = await page.content();
    const markdown = htmlToMarkdown(html);

    if (markdown.trim().length < 200) {
      throw new TierEscalationError('Page requires full Chrome rendering');
    }

    return {
      markdown,
      url: page.url(),
      status: 200,
      tier: 'lightpanda',
      cached: false,
      fetchedAt: Date.now(),
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ─── Tier 3: Playwright (full Chrome + stealth) ───────────────────────────────

async function fetchTier3(
  url: string,
  pool: PlaywrightContextPool,
  timeoutMs = 30000
): Promise<FetchResult> {
  const { context, release } = await pool.acquire();
  const page = await context.newPage();

  try {
    await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf}', r => r.abort());

    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForTimeout(gaussianRandom(800, 200));

    const html = await page.content();
    const markdown = htmlToMarkdown(html);

    // Check for anti-bot challenge pages (Cloudflare, DataDome signatures)
    if (isChallengePage(html)) {
      throw new TierEscalationError('Anti-bot challenge detected; escalating to commercial API');
    }

    return {
      markdown,
      url: page.url(),
      status: 200,
      tier: 'playwright',
      cached: false,
      fetchedAt: Date.now(),
    };
  } finally {
    await page.close().catch(() => {});
    await release();
  }
}

function isChallengePage(html: string): boolean {
  // Cloudflare signatures
  if (html.includes('cf-browser-verification') ||
      html.includes('cf_captcha_kind') ||
      html.includes('Checking if the site connection is secure')) return true;
  // DataDome
  if (html.includes('datadome.co/tags.js') && html.includes('blocked')) return true;
  // Generic
  if (html.includes('Please verify you are a human') ||
      html.includes('Access denied')) return true;
  return false;
}

// ─── Tier 4: Commercial API Fallback ─────────────────────────────────────────

async function fetchTier4(
  url: string,
  apiKey: string,
  provider: 'scrapingbee' | 'scrapfly' = 'scrapingbee'
): Promise<FetchResult> {
  if (provider === 'scrapingbee') {
    const response = await axios.get('https://app.scrapingbee.com/api/v1', {
      headers: { Authorization: `Bearer ${apiKey}` },
      params: {
        url,
        mode: 'auto',
        max_cost: 75,
        return_page_markdown: true,
        json_response: true,
        transparent_status_code: true,
      },
      timeout: 35000,
    });
    return {
      markdown: response.data.markdown ?? htmlToMarkdown(response.data.body ?? ''),
      url,
      status: response.status,
      tier: 'api',
      cached: false,
      fetchedAt: Date.now(),
    };
  }

  // Scrapfly
  const result = await scrapflyAspFetch(url, apiKey);
  return {
    markdown: htmlToMarkdown(result),
    url,
    status: 200,
    tier: 'api',
    cached: false,
    fetchedAt: Date.now(),
  };
}

class TierEscalationError extends Error {}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

export async function fetchUrl(
  url: string,
  options: FetchOptions = {},
  pool: PlaywrightContextPool,
  redis: RedisClientType
): Promise<FetchResult> {
  const {
    maxTier = 'api',
    apiKey,
    apiProvider = 'scrapingbee',
    timeout = 30000,
    bypassRobots = false,
    bypassCache = false,
    cacheTtlOverride,
  } = options;

  // 1. Check robots.txt
  if (!bypassRobots) {
    const { allowed, crawlDelayMs } = await checkRobots(url);
    if (!allowed) throw new Error(`robots.txt disallows fetching ${url}`);
    await rateLimiter.acquire(new URL(url).hostname, crawlDelayMs);
  }

  // 2. Check cache
  if (!bypassCache) {
    const cached = await getCachedResult(url, redis);
    if (cached) return { ...cached, cached: true };
  }

  // 3. Tier cascade
  const tiers: RenderTier[] = ['http', 'lightpanda', 'playwright', 'api'];
  const maxTierIndex = tiers.indexOf(maxTier);

  let lastError: Error | null = null;

  for (let i = 0; i <= maxTierIndex; i++) {
    const tier = tiers[i];
    try {
      let result: FetchResult;

      switch (tier) {
        case 'http':
          result = await fetchTier1(url, timeout);
          break;
        case 'lightpanda':
          if (!process.env.LIGHTPANDA_URL) continue; // skip if not configured
          result = await fetchTier2(url, timeout);
          break;
        case 'playwright':
          result = await fetchTier3(url, pool, timeout);
          break;
        case 'api':
          if (!apiKey) {
            throw new Error('Commercial API fallback requires apiKey to be configured');
          }
          result = await fetchTier4(url, apiKey, apiProvider);
          break;
      }

      // Cache the result
      const ttl = cacheTtlOverride ?? inferTtl(url, result.status);
      await cacheResult(url, result, ttl, redis);

      return result!;
    } catch (e: unknown) {
      lastError = e as Error;
      if (!(e instanceof TierEscalationError)) {
        // Non-escalation errors: don't try next tier for non-anti-bot failures
        // (404, 500, DNS failure, etc.)
        const err = e as any;
        if (err.response?.status >= 400 && err.response?.status < 500) {
          throw e; // Client errors — escalation won't help
        }
      }
      console.debug(`Tier ${tier} failed for ${url}: ${(e as Error).message}. Escalating.`);
    }
  }

  throw lastError ?? new Error(`All fetch tiers failed for ${url}`);
}
```

### Error Handling Summary

| Error condition | Behavior |
|---|---|
| robots.txt disallows | Throw immediately, do not escalate |
| HTTP 404 | Return 404 result, cache briefly (60s), do not escalate |
| HTTP 429 (rate limited by target) | Wait and retry once; if fails, escalate |
| JS rendering required (thin content) | Escalate to next tier |
| Anti-bot challenge page | Escalate to next tier |
| Commercial API key not set | Throw with configuration message |
| All tiers failed | Throw with last error |

---

## 14. Comparative Pricing Table

*All prices as of August 2026. All are per-request commercial API calls. Our self-hosted tiers 1-3 are $0.*

| Scenario | ScrapingBee | Spider.cloud | Scrapfly | ZenRows |
|---|---|---|---|---|
| Plain HTTP scrape | 1 credit ($0.00033) | 0.1 credit ($0.00001) | 1 credit ($0.001) | ~1 credit |
| JS rendering | 5 credits ($0.0017) | ~5 credits ($0.0005) | 1 credit + browser | 5x multiplier |
| Residential proxy | 10 credits ($0.0033) | N/A | 25 credits ($0.025) | 10x multiplier |
| Residential proxy + JS | 25 credits ($0.0083) | ~5 credits ($0.0005) | 25 credits ($0.025) | 50x multiplier |
| Stealth/ASP + proxy + JS | 75 credits ($0.025) | varies | ASP (variable) | varies |
| 1,000 plain pages | $0.33 | $0.10 | $1.00 | ~$0.50 |
| 1,000 JS-rendered pages | $1.65 | $0.50 | varies | ~$2.50 |
| Monthly plan entry | $49 (150K credits) | $10 (100K credits) | varies | $49 |

**Spider.cloud is dramatically cheaper** for volume scraping of non-anti-bot-protected pages. ScrapingBee is the best balance of price/features for mixed workloads. Scrapfly is the most expensive but has the best anti-bot SLA.

---

## 15. Feature Comparison Matrix

| Feature | ScrapingBee | Spider.cloud | Apify | ZenRows | Scrapfly | Our stack |
|---|---|---|---|---|---|---|
| **Access model** | API | API | Actor platform | API | API + Cloud Browser | Self-hosted |
| **Residential proxy** | ✓ premium_proxy | Limited | ✓ | ✓ 55M IPs | ✓ pools | Tier 4 via API |
| **Anti-bot bypass** | ✓ stealth_proxy | Limited smart | ✓ via Crawlee | ✓ stealth mode | ✓ ASP | Playwright stealth |
| **JS rendering** | ✓ render_js | ✓ browser mode | ✓ | ✓ js_render | ✓ render_js | Lightpanda + Playwright |
| **Markdown output** | ✓ return_page_markdown | ✓ return_format | via post-process | ✓ | via post-process | TurndownService |
| **AI extraction** | ✓ ai_query | ✓ AI Studio | ✓ | ✓ autoparse | ✓ LLM extraction | Phase 2 roadmap |
| **Structured extraction** | ✓ extract_rules | ✓ | ✓ | ✓ css_extractor | ✓ | Phase 2 roadmap |
| **Screenshot** | ✓ | ✓ | ✓ | — | ✓ | Phase 2 roadmap |
| **Bulk/batch** | Limited | ✓ crawl | ✓ datasets | ✓ Batch primitive | ✓ | Phase 2 |
| **Data streaming** | — | ✓ data_connectors | ✓ datasets | — | — | — |
| **Webhooks (async)** | — | ✓ | ✓ | — | ✓ | Phase 2 |
| **MCP server** | ✓ | ✓ | ✓ | ✓ | ✓ | We ARE the MCP server |
| **Session stickiness** | ✓ session_id | ✓ session | ✓ | ✓ session_id | ✓ session | Browser context pool |
| **Cloudflare bypass** | ✓ stealth | Partial | ✓ | ✓ | ✓ ASP | Tier 3 + Tier 4 |
| **DataDome bypass** | ✓ | Partial | ✓ | ✓ | ✓ ASP | Tier 4 |
| **Tor/.onion access** | — | — | — | — | ✓ tor pool | Phase 2 |
| **Open source** | SDKs only | SDKs + CLI | Crawlee, impit | SDKs | SDKs | MIT |
| **robots.txt respect** | — | — | ✓ Crawlee | — | — | ✓ built-in |
| **Self-hostable** | — | — | Actors (partial) | — | — | ✓ |
| **Pricing model** | Credits | Credits | Compute units | Credits | Credits | Infrastructure cost |

---

## Appendix: Key Source URLs

- ScrapingBee full parameter reference: https://www.scrapingbee.com/documentation/
- Spider.cloud API reference: https://spider.cloud/docs/api
- Apify documentation: https://docs.apify.com
- Scrapfly documentation: https://scrapfly.io/docs
- ZenRows documentation: https://docs.zenrows.com
- ZenRows Premium Proxy: https://docs.zenrows.com/fetch/features/premium-proxy
- Scrapfly Anti-Scraping Protection: https://scrapfly.io/docs/scrape-api/anti-scraping-protection
- Scrapfly Proxy documentation: https://scrapfly.io/docs/scrape-api/proxy
- Anti-bot detection guide (2026): https://dev.to/vhub_systems_ed5641f65d59/how-anti-bot-systems-detect-scrapers-in-2026-and-the-9-bypasses-that-still-work-2jfi
- TLS/JA3 fingerprinting guide: https://scrapfly.io/blog/posts/ja3-ja4-tls-fingerprinting-guide-to-detection-and-evasion
- Cloudflare JA3/JA4 docs: https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/
- Playwright BrowserContext scaling: https://www.zenrows.com/blog/playwright-browsercontext
- Lightpanda browser: https://lightpanda.io
- Lightpanda GitHub: https://github.com/lightpanda-io/browser
- Redis eviction policies: https://redis.io/docs/latest/develop/reference/eviction/
- Polite crawling guide: https://evomi.com/blog/respecting-robots.txt-and-crawl-delay-ethical-scraping-that-still-scales
- Spider.cloud pricing: https://spider.cloud/guides/pricing-and-plans/
- Apify Crawlee: https://docs.apify.com (open source section)
- Apify impit: https://github.com/apify/impit (Rust HTTP client with browser TLS)
