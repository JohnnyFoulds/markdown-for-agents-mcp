# Tavily AI — Complete Feature Analysis, Pricing, API Reference, and Implementation Patterns

**Research date:** 2026-08-26  
**Sources:** docs.tavily.com, tavily.com/pricing, agentsapis.com, coldiq.com, aipedia.wiki, deepwiki.com/tavily-ai, GitHub/tavily-ai

---

## Table of Contents

1. [What Tavily Is](#1-what-tavily-is)
2. [Pricing: Every Tier, Every Credit Cost](#2-pricing-every-tier-every-credit-cost)
3. [REST API Reference: All Endpoints](#3-rest-api-reference-all-endpoints)
4. [Search Endpoint: Full Parameter Schema](#4-search-endpoint-full-parameter-schema)
5. [Extract Endpoint: Full Parameter Schema](#5-extract-endpoint-full-parameter-schema)
6. [Crawl Endpoint: Full Parameter Schema](#6-crawl-endpoint-full-parameter-schema)
7. [Map Endpoint: Full Parameter Schema](#7-map-endpoint-full-parameter-schema)
8. [Research Endpoint: Full Parameter Schema](#8-research-endpoint-full-parameter-schema)
9. [Account Endpoints: Usage and Logs](#9-account-endpoints-usage-and-logs)
10. [JavaScript SDK: Complete Reference](#10-javascript-sdk-complete-reference)
11. [Python SDK: Complete Reference](#11-python-sdk-complete-reference)
12. [Rate Limits and Error Handling](#12-rate-limits-and-error-handling)
13. [MCP Server Integration](#13-mcp-server-integration)
14. [How Tavily Search Works Differently](#14-how-tavily-search-works-differently)
15. [Extract Deep Dive: JS Sites, Failures, Limits](#15-extract-deep-dive-js-sites-failures-limits)
16. [Crawl Deep Dive: Architecture and Limits](#16-crawl-deep-dive-architecture-and-limits)
17. [Best Practices and Cost Control Playbook](#17-best-practices-and-cost-control-playbook)
18. [Enterprise Options](#18-enterprise-options)
19. [Competitive Comparison: Tavily vs Exa vs Jina vs Brave](#19-competitive-comparison-tavily-vs-exa-vs-jina-vs-brave)
20. [Implementation Patterns for markdown-for-agents-mcp](#20-implementation-patterns-for-markdown-for-agents-mcp)
21. [What to Build and What to Skip](#21-what-to-build-and-what-to-skip)

---

## 1. What Tavily Is

Tavily (by Nebius) is a web intelligence API designed specifically for AI agents and RAG pipelines. It is not a consumer search engine. The positioning: give AI agents a single surface covering the full web-access pipeline — search, extract, map, crawl, research — and return results in LLM-ready formats (clean markdown, content chunks with relevance scores, structured answer synthesis).

**The five endpoints and their jobs:**

| Endpoint | Job | Primary use case |
|---|---|---|
| `/search` | Find relevant URLs with content snippets | Agent tool calls, RAG augmentation, news monitoring |
| `/extract` | Pull clean content from known URLs | Citation generation, page indexing, fact verification |
| `/map` | Graph-traverse a site to produce a URL list | Discovery before crawl, site structure understanding |
| `/crawl` | Map + extract in a single traversal | Site ingestion for RAG/knowledge base building |
| `/research` | Multi-step search + synthesis + structured report | Deep research, competitive intelligence, long-form analysis |

**Key differentiator from raw search APIs:** Tavily returns AI-ready results. Where a typical SERP API gives you titles + links, Tavily gives you ranked content snippets (short, reranked chunks), optional AI-synthesized answers, domain filtering, time filtering, and extracted raw content — all in one call. You do not need to scrape separately.

**Base URL:** `https://api.tavily.com`  
**Auth:** Bearer token, API key prefix `tvly-`  
**Claimed trust:** 2M+ developers, ranked #1 on SealQA and SimpleQA (verified by Tavily marketing, independently unverified)

Sources: [docs.tavily.com](https://docs.tavily.com), [tavily.com/product](https://tavily.com/product)

---

## 2. Pricing: Every Tier, Every Credit Cost

### 2.1 Plan Tiers (verified July 5, 2026 by coldiq.com against live docs)

| Plan | Credits/month | Monthly price | Price per credit |
|---|---|---|---|
| Researcher (Free) | 1,000 | $0 | — |
| Pay As You Go | Per usage | — | $0.008 |
| Project | 4,000 | $30 | $0.0075 |
| Bootstrap | 15,000 | $100 | $0.0067 |
| Startup | 38,000 | $220 | $0.0058 |
| Growth | 100,000 | $500 | $0.0050 |
| Enterprise | Custom | Custom | Custom |

Notes:
- When a monthly plan's credits are exhausted, overages bill at **$0.008/credit** (PAYG rate)
- Pricing is **37% cheaper** per credit from PAYG ($0.008) to Growth ($0.005)
- Credits reset on the **first of each month**, not on billing anniversary
- No credit card required for the Researcher free tier
- Enterprise pricing requires contacting sales; provides custom rate limits, SLAs, security review, dedicated infrastructure

### 2.2 Credit Costs Per Operation (official docs)

| Operation | Credit cost |
|---|---|
| Basic search (`search_depth=basic`) | 1 credit/request |
| Advanced search (`search_depth=advanced`) | 2 credits/request |
| Basic extract | 1 credit per **5 successful** URL extractions |
| Advanced extract | 2 credits per **5 successful** URL extractions |
| Map (no instructions) | 1 credit per **10 pages** returned |
| Map (with `instructions`) | 2 credits per **10 pages** returned |
| Crawl | Mapping cost + Extraction cost |
| Research (`model=mini`) | 4–110 credits (dynamic, per-request) |
| Research (`model=pro`) | 15–250 credits (dynamic, per-request) |

**Critical billing rules:**
- **Failed extractions are free.** You are never charged for a URL that fails to extract.
- **Extractions bill in batches of 5.** Pulling 4 URLs costs the same as pulling 5 (1 credit basic).
- **Crawl cost = map cost + extract cost.** Example: 10 pages at basic depth = 1 credit (map) + 2 credits (10/5 extractions) = 3 total credits.
- **Research is non-deterministic.** The system dynamically decides how many sub-searches and extractions to perform; a single `model=pro` call can cost up to $2.00 at PAYG rates.

### 2.3 Free Tier Reality Check

1,000 free credits/month translates to:
- 1,000 basic searches, OR
- 500 advanced searches, OR
- 5,000 URL basic extractions, OR
- Any mix of the above

For agents: a typical agent doing 5 basic searches per session hits the free ceiling at **200 sessions/month**. That is a prototype budget, not a production budget.

### 2.4 Budget Estimation Formula

```
monthly_credits = (searches_per_task × search_depth_multiplier × tasks_per_day × 30)
                + (extractions_per_task ÷ 5 × extract_depth_multiplier × tasks_per_day × 30)
                + (research_calls_per_day × avg_research_credits × 30)

search_depth_multiplier: basic=1, advanced=2
extract_depth_multiplier: basic=1, advanced=2
```

**Worked example (from coldiq.com):** Agent doing 4 advanced searches + 1 basic 5-URL extraction per task, 300 tasks/day, 1-in-10 tasks fires a 40-credit mini research call:
- Search: 4 × 2 × 300 × 30 = 72,000 credits
- Extract: (5÷5) × 1 × 300 × 30 = 9,000 credits
- Research: (300÷10) × 40 × 30 = 36,000 credits
- **Total: ~117,000 credits/month → Growth plan ($500) + 17,000 overage ($136) = ~$636/month actual bill**

Source: [coldiq.com/blog/tavily-pricing](https://coldiq.com/blog/tavily-pricing), [docs.tavily.com/documentation/api-credits](https://docs.tavily.com/documentation/api-credits)

---

## 3. REST API Reference: All Endpoints

### 3.1 Base URL and Authentication

```
Base URL: https://api.tavily.com

Authentication header:
  Authorization: Bearer tvly-YOUR_API_KEY

Optional project tracking header:
  X-Project-ID: your-project-id

Optional session tracking headers:
  X-Session-Id: 5874812a-2e9b-43ea-8978-6cc9225b587b
  X-Human-Id: h_4f9ac
```

The `X-Human-Id` is hashed before storage. `X-Session-Id` is automatically populated by the Tavily MCP server. Multiple projects can share one API key; the `X-Project-ID` header segments usage in dashboards.

### 3.2 Complete Endpoint List

| Method | Path | Purpose |
|---|---|---|
| POST | `/search` | Web search |
| POST | `/extract` | URL content extraction |
| POST | `/map` | Site URL discovery |
| POST | `/crawl` | Site-wide traversal + extraction |
| POST | `/research` | Create agentic research task |
| GET | `/research/{request_id}` | Poll research task status/result |
| GET | `/usage` | Account and key usage stats |
| POST | `/logs` | Submit usage logs |
| GET | `/enterprise/keys` | Enterprise API key generator |
| POST | `/enterprise/usage` | Organization-level usage |

### 3.3 Universal HTTP Error Codes

| Code | Meaning | Action |
|---|---|---|
| 200 | Success | Consume response |
| 400 | Bad request (invalid params, bad JSON) | Fix request; do not retry |
| 401 | Missing or invalid API key | Check key; do not retry |
| 403 | Permission denied | Check plan / feature access |
| 429 | Rate limited | Retry after `retry-after` header value |
| 432 | Plan usage limit exceeded | Upgrade plan or contact support |
| 433 | PAYG limit exceeded | Raise limit in dashboard |
| 500 | Internal server error | Retry with backoff (max 3 attempts) |

---

## 4. Search Endpoint: Full Parameter Schema

### 4.1 Request

**POST** `https://api.tavily.com/search`

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `query` | string | — | Yes | Search query, max 1500 chars |
| `search_depth` | `"basic"` \| `"advanced"` \| `"fast"` \| `"ultra-fast"` | `"basic"` | No | Latency/relevance tradeoff |
| `topic` | `"general"` \| `"news"` \| `"finance"` | `"general"` | No | Domain specialisation |
| `max_results` | integer | 5 | No | Number of results returned (up to ~20) |
| `chunks_per_source` | integer 1–5 | 3 | No | Content chunks per result |
| `time_range` | `"day"` \| `"week"` \| `"month"` \| `"year"` \| `"d"` \| `"w"` \| `"m"` \| `"y"` | null | No | Recency filter |
| `start_date` | string `YYYY-MM-DD` | null | No | Filter results after this date |
| `end_date` | string `YYYY-MM-DD` | null | No | Filter results before this date |
| `include_answer` | boolean \| `"basic"` \| `"advanced"` | false | No | Return AI-synthesised answer |
| `include_raw_content` | boolean \| `"markdown"` \| `"text"` | false | No | Return full page content |
| `include_images` | boolean | false | No | Return image URLs |
| `include_image_descriptions` | boolean | false | No | Return image alt/descriptions |
| `include_favicon` | boolean | false | No | Return favicon URL per result |
| `include_domains` | string[] | [] | No | Domain allowlist |
| `exclude_domains` | string[] | [] | No | Domain denylist |
| `country` | string | null | No | Country boost (ISO or name; `general` topic only) |
| `language` | string | `"en"` | No | ISO 639-1 code or English name |
| `filter_by_language` | boolean | false | No | Hard-filter (not boost) by language |
| `auto_parameters` | boolean | false | No | Let Tavily infer depth/topic |
| `exact_match` | boolean | false | No | Exact phrase matching |
| `safe_search` | boolean | false | No | Safe search filtering |
| `include_usage` | boolean | false | No | Return credits consumed |

### 4.2 Search Depth Details

| Depth | Latency | Relevance | Content type | When to use |
|---|---|---|---|---|
| `ultra-fast` | Lowest | Lower | NLP summary | Real-time UI autocomplete |
| `fast` | Low | Good | Reranked chunks | Low-latency agent calls |
| `basic` | Medium | High | Reranked chunks | Default for most use cases |
| `advanced` | Higher | Highest | Reranked chunks | Niche topics, recent pages, complex queries |

Note: `basic` previously returned a single page summary per source; it was updated to return reranked chunks. See Tavily changelog for migration details.

### 4.3 Response Schema

```json
{
  "query": "Who is Leo Messi?",
  "answer": "Lionel Messi, born in 1987, is an Argentine footballer...",
  "images": [],
  "results": [
    {
      "title": "Lionel Messi Facts | Britannica",
      "url": "https://www.britannica.com/facts/Lionel-Messi",
      "content": "Short reranked snippet from the page...",
      "score": 0.81025416,
      "raw_content": null,
      "favicon": "https://britannica.com/favicon.png",
      "images": [
        { "url": "...", "description": "..." }
      ],
      "id": "a3f9c2-04",
      "published_date": "2024-01-15"
    }
  ],
  "response_time": "1.67",
  "auto_parameters": {
    "topic": "general",
    "search_depth": "basic"
  },
  "usage": {
    "credits": 1
  },
  "request_id": "123e4567-e89b-12d3-a456-426614174111"
}
```

**Response field types:**
- `query` — string
- `answer` — string | null
- `images` — array of `{url: string, description?: string}`
- `results` — array (see below)
- `response_time` — string (seconds, as string)
- `auto_parameters` — object | null
- `usage` — `{credits: number}` | null (only if `include_usage: true`)
- `request_id` — string (UUID)

**Per-result fields:**
- `title` — string
- `url` — string
- `content` — string (chunk or summary)
- `score` — float (relevance, 0–1)
- `raw_content` — string | null
- `favicon` — string | null
- `images` — array | null
- `id` — string
- `published_date` — string | null (populated when `topic=news`)

### 4.4 TypeScript Example

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// Basic search
const basic = await tvly.search("Model Context Protocol specification", {
  searchDepth: "basic",
  maxResults: 5,
  includeUsage: true,
});

// News search with time filter
const news = await tvly.search("OpenAI GPT-5 release date", {
  topic: "news",
  timeRange: "week",
  maxResults: 8,
  includeAnswer: true,
});

// Domain-restricted documentation search
const docs = await tvly.search("rate limits", {
  includeDomains: ["docs.tavily.com"],
  searchDepth: "advanced",
  maxResults: 5,
  includeRawContent: "markdown",
  includeUsage: true,
});

// Multi-language search
const french = await tvly.search("actualités technologiques", {
  language: "fr",
  filterByLanguage: true,
  maxResults: 5,
});
```

---

## 5. Extract Endpoint: Full Parameter Schema

### 5.1 Request

**POST** `https://api.tavily.com/extract`

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `urls` | string \| string[] | — | Yes | URL or array of URLs (max 20) |
| `query` | string | null | No | Intent for reranking extracted chunks |
| `chunks_per_source` | integer 1–5 | 3 | No | Max 500-char chunks returned per URL |
| `extract_depth` | `"basic"` \| `"advanced"` | `"basic"` | No | Basic: standard HTML. Advanced: tables, embedded data, JS-rendered |
| `format` | `"markdown"` \| `"text"` | `"markdown"` | No | Output format (`text` may increase latency) |
| `include_images` | boolean | false | No | Include image URL list |
| `include_favicon` | boolean | false | No | Include favicon URL |
| `timeout` | integer 1–60 | varies | No | Seconds to wait (basic ~10s default, advanced ~30s default) |
| `include_usage` | boolean | false | No | Return credits consumed |

### 5.2 Response Schema

```json
{
  "results": [
    {
      "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
      "raw_content": "# Artificial Intelligence\n\nArtificial intelligence (AI)...",
      "images": ["https://en.wikipedia.org/static/image1.png"],
      "favicon": "https://en.wikipedia.org/static/favicon/wikipedia.ico"
    }
  ],
  "failed_results": [
    {
      "url": "https://example.com/paywalled-article",
      "error": "Failed to extract content: access denied"
    }
  ],
  "response_time": 0.02,
  "usage": {
    "credits": 1
  },
  "request_id": "123e4567-e89b-12d3-a456-426614174111"
}
```

**Critical:** `failed_results` is a separate array. Always check both arrays. The `results` array only contains successes; you are never charged for items in `failed_results`.

### 5.3 Limitations and Failure Modes

- **Maximum 20 URLs per request.** Exceeding this returns a `400` with message `"Max 20 URLs are allowed."`
- **Paywalled content:** Extraction fails silently (goes to `failed_results`). No workaround via API — Tavily does not bypass paywalls.
- **JavaScript-heavy SPAs at `extract_depth=basic`:** Basic depth uses HTML fetch; JS-rendered content (React SPAs, Angular apps) may return incomplete content. Use `advanced` depth for JS-heavy sites.
- **PDF and binary content:** Not supported. PDFs return to `failed_results`.
- **Login-required pages:** Fails; goes to `failed_results`.
- **Rate-limited source sites:** The source site itself may block Tavily's crawlers, causing failures.
- **`text` format vs `markdown`:** The `text` format can increase latency because additional post-processing strips markdown syntax.
- **Timeout default:** Basic ~10s, advanced ~30s. Slow sites will hit this. Increase `timeout` explicitly for known-slow domains.

### 5.4 TypeScript Example

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// Single URL
const single = await tvly.extract(
  ["https://en.wikipedia.org/wiki/Artificial_intelligence"],
  {
    extractDepth: "basic",
    format: "markdown",
    includeUsage: true,
  }
);

// Batch extraction with advanced depth
const batch = await tvly.extract(
  [
    "https://docs.example.com/api/search",
    "https://docs.example.com/api/extract",
    "https://docs.example.com/api/auth",
  ],
  {
    extractDepth: "advanced",
    format: "markdown",
    includeImages: false,
    timeout: 45,
    query: "authentication rate limits",  // reranks chunks by this intent
    chunksPerSource: 3,
    includeUsage: true,
  }
);

// Handle partial failure
for (const result of batch.results) {
  console.log("OK:", result.url, result.rawContent.length, "chars");
}
for (const failed of batch.failedResults) {
  console.warn("FAILED:", failed.url, failed.error);
}
```

---

## 6. Crawl Endpoint: Full Parameter Schema

### 6.1 Request

**POST** `https://api.tavily.com/crawl`

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `url` | string | — | Yes | Root URL to begin crawl |
| `instructions` | string | null | No | Natural language guidance for crawl direction |
| `chunks_per_source` | integer 1–5 | 3 | No | Chunks per page (used when `instructions` provided) |
| `max_depth` | integer | 1 | No | How deep from root to traverse |
| `max_breadth` | integer | 20 | No | Max links followed per level |
| `limit` | integer | 50 | No | Max total pages processed |
| `select_paths` | string[] | null | No | Regex patterns: include only matching paths |
| `select_domains` | string[] | null | No | Include only these domains |
| `exclude_paths` | string[] | null | No | Regex patterns: exclude matching paths |
| `exclude_domains` | string[] | null | No | Exclude these domains |
| `allow_external` | boolean | true | No | Follow links to external domains |
| `include_images` | boolean | false | No | Extract image URLs |
| `extract_depth` | `"basic"` \| `"advanced"` | `"basic"` | No | Extraction quality |
| `format` | `"markdown"` \| `"text"` | `"markdown"` | No | Output format |
| `include_favicon` | boolean | false | No | Include favicon per page |
| `timeout` | integer | 150 | No | Total timeout in seconds for crawl job |
| `include_usage` | boolean | false | No | Return credits consumed |

### 6.2 Response Schema

```json
{
  "base_url": "docs.tavily.com",
  "results": [
    {
      "url": "https://docs.tavily.com/welcome",
      "raw_content": "# Welcome\n\n...",
      "images": [],
      "favicon": "https://..."
    }
  ],
  "response_time": 12.4,
  "usage": {
    "credits": 15
  },
  "request_id": "123e4567-e89b-12d3-a456-426614174111"
}
```

### 6.3 Cost Calculation for Crawl

```
crawl_cost = map_cost + extract_cost

where:
  map_cost = ceil(pages_returned / 10) × (1 if no instructions, 2 if instructions)
  extract_cost = ceil(successful_extractions / 5) × (1 if basic, 2 if advanced)

Example — 50 pages, basic extract, no instructions:
  map_cost = ceil(50/10) × 1 = 5 credits
  extract_cost = ceil(50/5) × 1 = 10 credits
  total = 15 credits

Example — 50 pages, advanced extract, with instructions:
  map_cost = ceil(50/10) × 2 = 10 credits
  extract_cost = ceil(50/5) × 2 = 20 credits
  total = 30 credits
```

### 6.4 Crawl Rate Limits (Separate Bucket)

The crawl endpoint has its **own RPM limit** of 100 RPM for both development and production keys. This is the same as production elsewhere — there is no higher limit for production crawl.

### 6.5 TypeScript Example

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// Guided documentation crawl
const crawl = await tvly.crawl("https://docs.example.com", {
  instructions: "Find all pages about the JavaScript SDK and API reference",
  maxDepth: 3,
  maxBreadth: 20,
  limit: 100,
  extractDepth: "basic",
  format: "markdown",
  // Restrict to documentation paths
  selectPaths: ["^/documentation/.*", "^/sdk/.*"],
  // Don't follow external links
  allowExternal: false,
  timeout: 180,
  includeUsage: true,
});

console.log(`Crawled ${crawl.results.length} pages`);
console.log(`Credits used: ${crawl.usage?.credits}`);
```

---

## 7. Map Endpoint: Full Parameter Schema

### 7.1 Request

**POST** `https://api.tavily.com/map`

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `url` | string | — | Yes | Base URL to start mapping |
| `instructions` | string | null | No | NL guidance for discovery (doubles per-page cost) |
| `max_depth` | integer | 1 | No | Depth from root URL |
| `max_breadth` | integer | 20 | No | Max links per level |
| `limit` | integer | 50 | No | Max total pages in result |
| `select_paths` | string[] | null | No | Include only matching path patterns |
| `select_domains` | string[] | null | No | Include only these domains |
| `exclude_paths` | string[] | null | No | Exclude matching path patterns |
| `exclude_domains` | string[] | null | No | Exclude these domains |
| `allow_external` | boolean | true | No | Follow external links |
| `timeout` | integer | 150 | No | Timeout in seconds |
| `include_usage` | boolean | false | No | Return credits consumed |

### 7.2 Response Schema

```json
{
  "base_url": "docs.example.com",
  "urls": [
    "https://docs.example.com/",
    "https://docs.example.com/api",
    "https://docs.example.com/api/search",
    "https://docs.example.com/sdk/python"
  ],
  "response_time": 4.2,
  "usage": {
    "credits": 1
  },
  "request_id": "123e4567-e89b-12d3-a456-426614174111"
}
```

Map returns a flat list of discovered URLs, not content. It is significantly cheaper than crawl and should be used as a discovery step before targeted extraction.

### 7.3 TypeScript Example

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// Map documentation paths only
const map = await tvly.map("https://docs.example.com", {
  maxDepth: 2,
  maxBreadth: 30,
  limit: 100,
  selectPaths: ["^/documentation/.*", "^/sdk/.*", "^/examples/.*"],
  allowExternal: false,
  includeUsage: true,
});

console.log(`Found ${map.urls.length} URLs`);
// Then extract only the ones you need:
const targetUrls = map.urls.filter(u => u.includes("/api-reference/"));
const extracted = await tvly.extract(targetUrls.slice(0, 20), { extractDepth: "basic" });
```

---

## 8. Research Endpoint: Full Parameter Schema

### 8.1 Create Research Task (POST /research)

| Parameter | Type | Default | Required | Description |
|---|---|---|---|---|
| `input` | string | — | Yes | Research question or task |
| `model` | `"mini"` \| `"pro"` \| `"auto"` | `"auto"` | No | Research depth |
| `stream` | boolean | false | No | SSE streaming |
| `output_schema` | JSON Schema object | null | No | Enforce structured output shape |
| `citation_format` | `"numbered"` \| other | null | No | How citations are rendered |
| `include_domains` | string[] | null | No | Restrict sources |
| `exclude_domains` | string[] | null | No | Exclude sources |
| `output_length` | `"standard"` \| other | null | No | Report length |
| `files` | array of `{name, data, type}` | null | No | Base64-encoded files as context |

**Research models:**
- `mini`: Targeted, efficient. 4–110 credits. Best for narrow, well-scoped questions.
- `pro`: Comprehensive, multi-angle. 15–250 credits. Best for complex, multi-domain topics.
- `auto`: Tavily selects model based on query complexity.

### 8.2 Structured Output Schema

The `output_schema` parameter is a JSON Schema object. This is the most powerful feature of the Research endpoint — you can enforce structured output instead of free-form markdown:

```json
{
  "input": "Analyze Q3 2025 earnings for Microsoft",
  "model": "pro",
  "output_schema": {
    "properties": {
      "company": { "type": "string", "description": "Company name" },
      "revenue": { "type": "number", "description": "Total revenue in billions USD" },
      "key_metrics": {
        "type": "array",
        "description": "Key performance indicators",
        "items": { "type": "string" }
      },
      "risks": {
        "type": "array",
        "description": "Identified risk factors",
        "items": { "type": "string" }
      }
    },
    "required": ["company", "revenue"]
  },
  "citation_format": "numbered",
  "include_domains": ["sec.gov", "ir.microsoft.com"],
  "exclude_domains": ["reddit.com", "quora.com"]
}
```

### 8.3 Get Research Task Status (GET /research/{request_id})

```json
{
  "request_id": "123e4567-e89b-12d3-a456-426614174111",
  "status": "completed",
  "content": "## Research Report\n\n...",
  "sources": [
    {
      "title": "Microsoft Q3 2025 Earnings",
      "url": "https://ir.microsoft.com/...",
      "favicon": "https://microsoft.com/favicon.ico"
    }
  ],
  "created_at": "2026-08-26T11:00:00Z",
  "response_time": 45.2
}
```

Possible `status` values: `"pending"`, `"running"`, `"completed"`, `"failed"`

### 8.4 Streaming (SSE)

Set `stream: true` to receive Server-Sent Events. The SSE stream is compatible with the OpenAI chat completion chunk structure, making it easy to display incremental progress:

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

const response = await fetch("https://api.tavily.com/research", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`,
  },
  body: JSON.stringify({
    input: "Current state of edge AI inference hardware 2026",
    model: "pro",
    stream: true,
  }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const lines = chunk.split("\n").filter(l => l.startsWith("data: "));
  
  for (const line of lines) {
    const data = line.slice(6); // remove "data: "
    if (data === "[DONE]") return;
    
    const event = JSON.parse(data);
    // event types: tool_call, content_delta, sources, done
    if (event.type === "content_delta") {
      process.stdout.write(event.delta);
    }
  }
}
```

### 8.5 Rate Limits for Research

| Environment | Requests per minute |
|---|---|
| Development | 20 |
| Production | 20 |

Research RPM is the same regardless of plan tier. This is **much lower** than other endpoints. Design research features around this constraint.

---

## 9. Account Endpoints: Usage and Logs

### 9.1 GET /usage

```bash
curl --request GET \
  --url "https://api.tavily.com/usage" \
  --header "Authorization: Bearer tvly-YOUR_API_KEY"
```

Rate limited to **10 requests per 10 minutes** for both dev and production.

Response includes:
- Key-level usage (credits used this period)
- Account plan details (limit, reset date)
- Per-endpoint usage breakdown

Use this endpoint to build:
- Admin dashboards showing remaining credit budget
- Circuit breakers that disable expensive features when credits drop below threshold
- Alerts when usage spikes unexpectedly (key leak or runaway agent loop)

### 9.2 POST /logs

Allows submitting structured usage logs for tracking custom analytics. Refer to official docs for schema — this is primarily used by the MCP server and SDK telemetry.

---

## 10. JavaScript SDK: Complete Reference

### 10.1 Installation and Setup

```bash
npm install @tavily/core
```

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ 
  apiKey: "tvly-YOUR_API_KEY",
  // Optional: project tracking
  projectId: "my-project",
});
```

Environment variable: `TAVILY_API_KEY` and `TAVILY_PROJECT`

### 10.2 All SDK Methods

| Method | Status | Description |
|---|---|---|
| `search(query, options?)` | Active | Web search |
| `extract(urls, options?)` | Active | URL extraction |
| `crawl(url, options?)` | Beta | Site crawl |
| `map(url, options?)` | Beta | Site URL discovery |
| `research(input, options?)` | Active | Agentic research |
| `getResearch(requestId)` | Active | Poll research status |
| `searchQNA(query, options?)` | Deprecated | Use `search()` with `includeAnswer: true` |
| `searchContext(query, options?)` | Deprecated | Use `search()` directly |

### 10.3 Search Options Interface (TypeScript)

```typescript
interface TavilySearchOptions {
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  topic?: "general" | "news" | "finance";
  maxResults?: number;
  includeAnswer?: boolean;
  includeImages?: boolean;
  includeImageDescriptions?: boolean;
  includeRawContent?: false | "markdown" | "text";
  includeDomains?: string[];
  excludeDomains?: string[];
  maxTokens?: number;
  days?: number;
  timeRange?: "year" | "month" | "week" | "day";
  chunksPerSource?: number;
  country?: string;
  startDate?: string;   // YYYY-MM-DD
  endDate?: string;     // YYYY-MM-DD
  autoParameters?: boolean;
  timeout?: number;
  includeFavicon?: boolean;
  includeUsage?: boolean;
}
```

### 10.4 Search Response Interface (TypeScript)

```typescript
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate?: string;
  favicon?: string;
  images?: Array<{ url: string; description?: string }>;
  id: string;
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  images?: Array<{ url: string; description?: string }>;
  answer?: string;
  responseTime: number;
  requestId: string;
  autoParameters?: Partial<TavilySearchOptions>;
  usage?: { credits: number };
}
```

### 10.5 Extract Options Interface (TypeScript)

```typescript
interface TavilyExtractOptions {
  includeImages?: boolean;
  extractDepth?: "basic" | "advanced";
  format?: "markdown" | "text";
  timeout?: number;
  includeFavicon?: boolean;
  includeUsage?: boolean;
  query?: string;
  chunksPerSource?: number;
}
```

### 10.6 Extract Response Interface (TypeScript)

```typescript
interface TavilyExtractResult {
  url: string;
  rawContent: string;
  images?: string[];
  favicon?: string;
}

interface TavilyExtractFailedResult {
  url: string;
  error: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failedResults: TavilyExtractFailedResult[];
  responseTime: number;
  requestId: string;
  usage?: { credits: number };
}
```

### 10.7 Crawl Options Interface (TypeScript)

```typescript
interface TavilyCrawlOptions {
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  instructions?: string;
  extractDepth?: "basic" | "advanced";
  selectPaths?: string[];
  selectDomains?: string[];
  excludePaths?: string[];
  excludeDomains?: string[];
  allowExternal?: boolean;
  includeImages?: boolean;
  format?: "markdown" | "text";
  timeout?: number;
  includeFavicon?: boolean;
  includeUsage?: boolean;
  chunksPerSource?: number;
}
```

### 10.8 Parallel Batch Pattern (TypeScript)

```typescript
import { tavily } from "@tavily/core";

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });

// Bounded concurrency: run max 5 searches in parallel
async function batchSearch(queries: string[], concurrency = 5): Promise<TavilySearchResponse[]> {
  const results: TavilySearchResponse[] = [];
  
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(q => tvly.search(q, { searchDepth: "basic", maxResults: 5 }))
    );
    results.push(...batchResults);
  }
  
  return results;
}

// Deduplication after batch
function deduplicateResults(responses: TavilySearchResponse[]): TavilySearchResult[] {
  const seen = new Set<string>();
  const unique: TavilySearchResult[] = [];
  
  for (const response of responses) {
    for (const result of response.results) {
      if (!seen.has(result.url)) {
        seen.add(result.url);
        unique.push(result);
      }
    }
  }
  
  return unique.sort((a, b) => b.score - a.score);
}
```

---

## 11. Python SDK: Complete Reference

### 11.1 Installation

```bash
pip install tavily-python
```

### 11.2 Sync Client

```python
from tavily import TavilyClient

client = TavilyClient(api_key="tvly-YOUR_API_KEY")

# Search
response = client.search("What is MCP?", search_depth="advanced", max_results=8)

# Extract
response = client.extract("https://example.com/article")

# Crawl
response = client.crawl(
    "https://docs.example.com",
    instructions="Find all API reference pages",
    max_depth=3,
    limit=100
)

# Map
response = client.map("https://docs.example.com", max_depth=2, limit=50)

# Research
response = client.research("Latest developments in quantum computing 2026")
```

### 11.3 Async Client

```python
from tavily import AsyncTavilyClient
import asyncio

async def main():
    client = AsyncTavilyClient("tvly-YOUR_API_KEY")
    
    # Parallel searches
    results = await asyncio.gather(
        client.search("AI funding 2026", topic="news"),
        client.search("GPU shortage update", topic="news"),
        client.search("open source LLMs 2026"),
    )
    
    return results

asyncio.run(main())
```

### 11.4 Proxy Configuration

```python
from tavily import TavilyClient

client = TavilyClient(
    api_key="tvly-YOUR_API_KEY",
    proxies={"http": "http://proxy:8080", "https": "http://proxy:8080"}
)
```

---

## 12. Rate Limits and Error Handling

### 12.1 Rate Limits by Endpoint

| Endpoint | Dev RPM | Production RPM |
|---|---|---|
| `/search` | 100 | 1,000 |
| `/extract` | 100 | 1,000 |
| `/map` | 100 | 1,000 |
| `/crawl` | 100 | 100 |
| `/research` (create) | 20 | 20 |
| `/research/{id}` (poll) | 100 | 1,000 |
| `/usage` | 10/10min | 10/10min |

**Production keys require an active paid plan or PAYG enabled.**

When rate limited, Tavily returns `429` with a `retry-after` header:

```http
HTTP/2 429 Too Many Requests
retry-after: 60
Content-Type: application/json

{
  "error": "Your request has been blocked due to excessive requests. Please reduce the rate of requests."
}
```

### 12.2 Retry Pattern (TypeScript)

```typescript
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 250
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      
      // Do not retry on client errors
      if (status >= 400 && status < 500 && status !== 429) {
        throw error;
      }
      
      if (attempt === maxAttempts) throw error;
      
      // Read retry-after header if present
      const retryAfter = error?.response?.headers?.["retry-after"];
      const delay = retryAfter
        ? parseInt(retryAfter) * 1000
        : baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}

// Usage
const response = await callWithRetry(() =>
  tvly.search("query", { searchDepth: "advanced" })
);
```

### 12.3 Error Code Reference

| Code | Message (example) | Cause | Action |
|---|---|---|---|
| 400 | `"Invalid topic. Must be 'general' or 'news'."` | Bad parameter | Fix request |
| 400 | `"Max 20 URLs are allowed."` | Too many URLs in extract | Split into batches |
| 401 | `"Unauthorized: missing or invalid API key."` | Bad auth | Check key |
| 403 | `"Forbidden"` | Feature not available on plan | Upgrade |
| 429 | `"Your request has been blocked due to excessive requests."` | Rate limit | Backoff + retry |
| 432 | `"This request exceeds your plan's set usage limit."` | Monthly credit limit | Upgrade or wait for reset |
| 433 | `"This request exceeds the pay-as-you-go limit."` | PAYG cap | Raise cap in dashboard |
| 500 | `"Internal Server Error"` | Tavily infrastructure | Retry with backoff |

---

## 13. MCP Server Integration

### 13.1 Official Tavily MCP Server

Tavily provides an official MCP server at `@tavily/mcp` (npm) and a hosted remote endpoint. It exposes two tools:
- `tavily-search` — wraps `/search`
- `tavily-extract` — wraps `/extract`

(Note: as of documentation reviewed, crawl/map/research are not exposed as MCP tools in the default server.)

### 13.2 Remote MCP (No Local Install)

```
https://mcp.tavily.com/mcp/?tavilyApiKey=<your-api-key>
```

**Claude Code:**
```bash
claude mcp add tavily-remote-mcp --transport http https://mcp.tavily.com/mcp/
```

**Claude Desktop (.claude/settings.json):**
```json
{
  "mcpServers": {
    "tavily-remote-mcp": {
      "type": "http",
      "url": "https://mcp.tavily.com/mcp/"
    }
  }
}
```

**Cursor (mcp.json):**
```json
{
  "mcpServers": {
    "tavily-remote-mcp": {
      "command": "npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=<your-api-key>",
      "env": {}
    }
  }
}
```

**OpenAI Responses API:**
```python
from openai import OpenAI
import json

client = OpenAI()
resp = client.responses.create(
    model="gpt-4.1",
    tools=[{
        "type": "mcp",
        "server_label": "tavily",
        "server_url": "https://mcp.tavily.com/mcp/?tavilyApiKey=<key>",
        "require_approval": "never",
        "headers": {
            "DEFAULT_PARAMETERS": json.dumps({
                "include_favicon": True,
                "include_images": False,
                "include_raw_content": False,
            }),
        },
    }],
    input="Search for the latest AI news",
)
```

### 13.3 OAuth Authentication

The remote MCP supports OAuth. When OAuth is used, the API key used is resolved by priority:
1. Personal account key named `mcp_auth_default`
2. Team account key named `mcp_auth_default`
3. Default key on personal account
4. First available key

OAuth authentication is optional — `?tavilyApiKey=` in URL or `Authorization` header also work.

### 13.4 Local MCP Installation

```json
{
  "mcpServers": {
    "tavily": {
      "command": "npx",
      "args": ["-y", "@tavily/mcp"],
      "env": {
        "TAVILY_API_KEY": "tvly-YOUR_API_KEY"
      }
    }
  }
}
```

### 13.5 Default Parameters for MCP

You can set default parameters that apply to all MCP requests:
```json
{
  "DEFAULT_PARAMETERS": {
    "include_favicon": true,
    "include_images": false,
    "include_raw_content": false,
    "search_depth": "basic",
    "max_results": 5
  }
}
```

### 13.6 Session Tracking in MCP Context

The Tavily MCP server automatically populates `X-Session-Id` to group multi-step agent interactions. `X-Human-Id` must be set manually if needed (the MCP server cannot generate it autonomously).

### 13.7 Integration Ecosystem

Tavily has official integrations documented at docs.tavily.com for:
LangChain, LlamaIndex, OpenAI, Anthropic, Google ADK, Microsoft 365 Copilot, Vercel AI SDK, CrewAI, Mastra, n8n, Zapier, Dify, Composio, Make, Agno, Pydantic AI, FlowiseAI, Haystack, Vellum, Devin, Convex, Arcade.dev, Portkey, LibreChat, Langflow, Tines, StackAI, TrueFoundry, ElevenLabs, IBM watsonx Orchestrate, Amazon Bedrock AgentCore, Microsoft Azure, Databricks, Snowflake.

---

## 14. How Tavily Search Works Differently

### 14.1 The Core Difference from Traditional SERPs

A traditional SERP API (e.g., SerpAPI, Bing Web API) returns the raw search engine results page: title, URL, and a short snippet. To use this in an AI workflow you typically need to:
1. Fetch the page HTML
2. Clean and parse it
3. Remove navigation noise
4. Handle paywalls and JS rendering
5. Normalize encoding
6. Rerank by relevance to your specific query

Tavily collapses steps 1–6 into a single API call by returning "chunks" — short (max ~500 chars) snippets that have been extracted from pages and **reranked by relevance to your specific query**, not by generic PageRank.

### 14.2 Chunk-Based Retrieval

Tavily's search does not return page summaries (except at `ultra-fast` depth which returns NLP-based content summaries). At `basic` and `advanced` depth, it returns reranked chunks:

- Each result contains `content`: a relevance-reranked short snippet
- `chunks_per_source` controls how many chunks (1–5) are returned per source
- Chunks are drawn from the actual page content, not synthesized

This means Tavily's result `content` field is already suitable for feeding directly into a model's context without further extraction.

### 14.3 Answer Synthesis Pipeline

When `include_answer` is set, Tavily synthesises an answer from the top search results. This is not just the top snippet — it is a generated answer drawing on multiple sources. Two levels:
- `"basic"`: Quick synthesis, lower latency
- `"advanced"`: More comprehensive, higher latency

The answer synthesis happens server-side. Tavily does not disclose which models are used for synthesis. The answer is returned alongside the source results, giving you both the synthesis and the citations.

### 14.4 `auto_parameters` Mode

When `auto_parameters: true`, Tavily analyses the query and infers optimal `topic` and `search_depth`. This can improve quality for queries that would benefit from `news` topic or `advanced` depth without the caller knowing in advance. The `auto_parameters` field in the response shows what was inferred.

**Warning:** `auto_parameters` can increase credit cost unpredictably (if it upgrades a `basic` search to `advanced` automatically). Use explicit parameters in production where cost predictability matters.

### 14.5 Topic-Specific Ranking

- `topic=news`: Prioritises news sources, populates `published_date` field in results, enables time filtering
- `topic=finance`: Prioritises financial data sources
- `topic=general`: Default; broad web coverage

---

## 15. Extract Deep Dive: JS Sites, Failures, Limits

### 15.1 Basic vs Advanced Extraction

| Feature | `extract_depth=basic` | `extract_depth=advanced` |
|---|---|---|
| Static HTML pages | Yes | Yes |
| JavaScript-rendered content | Partial/no | Yes (headless browser) |
| Tables and embedded data | Basic | Full |
| Dynamic content (SPAs) | Often fails | Usually works |
| Timeout default | ~10 seconds | ~30 seconds |
| Credit cost | 1 credit/5 URLs | 2 credits/5 URLs |

**`advanced` depth implies headless browser rendering.** This is how Tavily handles JS-heavy sites. The tradeoff is higher latency (30s+ for complex pages) and double the credit cost.

### 15.2 What Extracts Successfully

Works well:
- Static HTML pages (Wikipedia, most docs sites, news articles)
- Server-rendered pages (Next.js SSR, standard CMS)
- Pages with heavy navigation but clean `<article>` or `<main>` content

Works with advanced depth:
- React/Vue/Angular SPAs that render client-side
- Sites using lazy loading
- Pages with JavaScript-gated content (when not behind auth)

Fails (goes to `failed_results`):
- Paywalled content (NYT, FT, academic journals with subscriptions)
- Login-required pages
- PDFs, binary files, images
- Pages returning 4xx/5xx from source server
- Pages where source server blocks Tavily's crawler IP
- CAPTCHA-protected pages
- Very large pages that exceed timeout

### 15.3 Content Length and Chunking

- `chunks_per_source`: Each chunk is max ~500 characters. Setting this to 5 gives you up to 2,500 chars of content per URL.
- For longer documents, chunks_per_source=5 may still truncate. Use `include_raw_content` in search or `format=markdown` in extract for full content.
- Full `raw_content` for a Wikipedia-length article can be 50,000+ chars. Consider chunking on your end before embedding.

### 15.4 Extract vs Search + Raw Content

You can get URL content two ways:
1. `/extract` with known URLs
2. `/search` with `include_raw_content: "markdown"`

Option 2 is useful when you want to search AND get content in one call. Option 1 is preferable when you already have URLs (avoids the search overhead).

### 15.5 Edge Cases and Gotchas

- **URL limit of 20:** Strictly enforced. Split larger batches.
- **Duplicate URLs in batch:** Tavily may return one result or handle duplicates quietly — de-duplicate on your end before submitting.
- **Redirects:** Tavily follows redirects. The `url` in response reflects the final URL after redirects.
- **Very fast timeout (timeout=1):** Returns `failed_results` for most real pages. Minimum useful timeout for basic depth is ~5s.
- **`format=text` slower than `format=markdown`:** Counter-intuitive — text format requires additional post-processing to strip markdown syntax, adding latency.

---

## 16. Crawl Deep Dive: Architecture and Limits

### 16.1 Traversal Model

Tavily Crawl uses breadth-first traversal:
1. Fetch root URL
2. Extract all links from root
3. Apply `select_paths`, `exclude_paths`, `select_domains`, `exclude_domains` filters
4. Queue filtered links for extraction
5. For each extracted page, discover new links
6. Continue until `limit`, `max_depth`, or `max_breadth` is hit

`max_depth`: How many link hops from root. Depth 1 = root + directly linked pages. Depth 2 = root + links + links of links.  
`max_breadth`: Max links to follow per level. Prevents exponential explosion on link-heavy pages.  
`limit`: Hard cap on total pages processed. Apply this defensively.

### 16.2 Natural Language Instructions

When `instructions` is provided:
- Tavily uses the instruction to guide which links to prioritise
- Doubles the per-page mapping cost (2 credits/10 pages instead of 1)
- Effective for focused crawls ("only Python SDK pages", "ignore blog posts")

### 16.3 `allow_external=true` Warning

This is `true` by default. A crawl starting at `docs.example.com` may follow links to `github.com`, `npmjs.com`, etc. unless you explicitly set `allow_external: false` or use `select_domains`. Always set `allow_external: false` for focused documentation crawls.

### 16.4 Crawl Failure Handling

Crawl does not return a `failed_results` array like extract does. Failed pages are silently skipped. Credits are charged only for successful pages. Monitor result count vs expected count to detect issues.

### 16.5 Scheduling and Resume Patterns

For large site ingestion:
```typescript
// Pattern: map first, then batch-extract with checkpointing
const map = await tvly.map("https://docs.example.com", { limit: 500, maxDepth: 3 });
const allUrls = map.urls;

// Filter to what needs extraction (e.g., not already in cache)
const toExtract = allUrls.filter(url => !cache.has(url));

// Extract in batches of 20 (API limit)
for (let i = 0; i < toExtract.length; i += 20) {
  const batch = toExtract.slice(i, i + 20);
  const result = await tvly.extract(batch, { extractDepth: "basic" });
  
  for (const page of result.results) {
    await cache.set(page.url, { content: page.rawContent, fetchedAt: Date.now() });
  }
  
  // Rate limit: 100 RPM on extract = 1.67 req/sec
  // 20 URLs/batch at ~3 batches/sec is within limits
  await delay(500); // conservative throttle
}
```

---

## 17. Best Practices and Cost Control Playbook

### 17.1 Query Optimisation

- **Keep queries under 1500 characters.** Treat it as an agent-style query, not a long prompt.
- **Break complex multi-topic queries into sub-queries.** Send three focused queries instead of one sprawling one.
- **Match language:** Write query in the same language you pass to `language`. Results degrade if query language mismatches target language.

### 17.2 Depth Selection Guide

```
Start with basic.
Use advanced when:
  - Niche topic with limited source coverage
  - Very recently published content
  - Query has multiple distinct facets
  - Specific data points needed (not general context)
  - Domain-restricted search where you need maximum recall

Avoid advanced:
  - High-frequency agent calls (cost doubles)
  - General-purpose chat augmentation
  - When basic latency is already acceptable
```

### 17.3 Extract Wisely: The Search-First Pattern

```
1. search() with basic depth, max_results=5, no raw content  [1 credit]
2. Score results by relevance threshold (score > 0.7)
3. extract() only top 1-3 URLs that pass threshold         [~0.4-0.6 credits]
4. Total per question: ~1.5 credits vs naive 10+ credits
```

### 17.4 Cache Aggressively

Two cache layers:
1. **Query cache (short TTL):** Same search query within 15–60 minutes returns the same results. Deduplicating 10% of queries saves 10% of budget.
2. **Content cache (long TTL):** Extracted pages change slowly. Cache by URL + content hash or URL + fetch date. Refresh only when the page signals an update (via `published_date` in search results).

```typescript
// Redis-based cache wrapper
async function cachedSearch(query: string, options?: TavilySearchOptions) {
  const cacheKey = `tavily:search:${hashQuery(query, options)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  const result = await tvly.search(query, options);
  await redis.setex(cacheKey, 300, JSON.stringify(result)); // 5min TTL
  return result;
}
```

### 17.5 Domain Filtering

Domain allowlists and denylists improve result quality AND reduce noise. Use them for:
- Trusted-source-only RAG (e.g., official docs only)
- Excluding low-quality aggregators
- Regulatory compliance (only cite from approved domains)

### 17.6 Score-Based Filtering

```typescript
// Only use results above a relevance threshold
const RELEVANCE_THRESHOLD = 0.70;

const results = response.results.filter(r => r.score >= RELEVANCE_THRESHOLD);
```

The `score` field is a float from ~0 to 1. Typical high-quality results score 0.75+. Scores below 0.5 are usually tangentially related.

### 17.7 Production Architecture

| Component | What it does | Key guardrail |
|---|---|---|
| API Gateway | Routes requests, injects auth, handles retries | Centralised rate limiting + request logging |
| Query cache | Deduplicates repeated searches, short TTL | Reduces cost by 10–30% in typical apps |
| Content cache | Stores extracted pages by URL + date | Prevents re-extracting unchanged pages |
| Budget monitor | Polls `/usage` hourly; triggers alerts | Disable expensive features near credit limit |
| Circuit breaker | Stops requests when error rate > threshold | Prevents cascading failures from bad agent loops |

### 17.8 Research Cost Management

```
Default rule: model=mini
Upgrade to model=pro only when:
  - User explicitly requests "deep research"
  - Topic spans 3+ distinct subtopics
  - Admin/paid tier feature gate

Always:
  - Store completed research + sources so it's not re-run
  - Stream (stream=true) to show progress — reduces perceived latency
  - Apply include_domains/exclude_domains to control source quality
```

---

## 18. Enterprise Options

### 18.1 What Enterprise Provides

Based on Tavily pricing page and publicly available information:
- Custom API credits (volume negotiated)
- Custom rate limits (above standard 1,000 RPM production limit)
- Enterprise-grade SLAs (uptime commitments)
- Enterprise-grade security and privacy (data handling agreements, SOC 2 / compliance documentation available at trust.tavily.com)
- Dedicated infrastructure options (not confirmed publicly — contact sales)
- Priority support

### 18.2 Access Pattern

Enterprise is **contact sales only** (`https://tavily.com/contact`). No public pricing. AWS Marketplace listing provides a 90-day trial of up to 1,000 credits/month for teams evaluating Enterprise.

### 18.3 Enterprise API Endpoints

Enterprise accounts get additional endpoints:
- `GET /enterprise/keys` — API key generator (create/manage keys programmatically)
- `POST /enterprise/usage` — Organisation-level usage (aggregate across all keys in org)

### 18.4 Relevant for markdown-for-agents-mcp

For enterprise deployments of our MCP server:
- Customers with Enterprise Tavily accounts can supply their own TAVILY_API_KEY with higher rate limits
- Per-user key routing (using `X-Project-ID`) lets us segment usage by customer
- The `/enterprise/usage` endpoint could power an admin billing dashboard

---

## 19. Competitive Comparison: Tavily vs Exa vs Jina vs Brave

### 19.1 Feature Matrix

| Feature | Tavily | Exa | Jina Reader | Brave Search API |
|---|---|---|---|---|
| Web search | Yes | Yes | No (URL only) | Yes |
| URL extraction | Yes | Yes | Yes | No |
| Site crawl | Yes | No | No | No |
| Site map | Yes | No | No | No |
| Agentic research | Yes (Research endpoint) | No | No | No |
| Semantic/neural search | Chunks + reranking | Neural similarity | No | No |
| Answer synthesis | Yes | Yes (`answer`) | No | Yes (`summary`) |
| Structured output | Yes (Research `output_schema`) | No | No | No |
| Streaming | Yes (Research SSE) | No | No | No |
| MCP server | Yes (official) | Yes (official) | No | No |
| Free tier | 1,000 credits/month | 1,000 requests/month | Limited | 2,000 req/month |
| Python SDK | Yes | Yes | No (HTTP only) | No |
| JS SDK | Yes | Yes | No | No |

### 19.2 Pricing Comparison

| Provider | Basic operation cost | Notes |
|---|---|---|
| Tavily | $0.008–$0.005 per credit | 1 credit = 1 basic search |
| Exa | ~$0.005–$0.01 per request | Semantic search pricing varies |
| Brave Search API | Free up to 2,000/month, then $5/1,000 | Lower quality for AI use cases |
| Perplexity Sonar | $5–$8 per 1,000 requests | Includes AI answer generation |
| Firecrawl | Free 500 credits, $16–$83/month | Focused on extraction/crawl |

### 19.3 When to Choose Each

**Choose Tavily when:**
- You need the full pipeline: search + extract + crawl + map in one provider
- Predictable credit-based budgeting matters
- You need MCP integration + broad agent framework support
- News, finance topic specialisation adds value
- You want research synthesis with structured output

**Choose Exa when:**
- Semantic/neural similarity search is the core need (find pages *similar* to an example)
- Content monitor / alerting for topic changes
- High-quality similar-document retrieval

**Choose Jina Reader when:**
- You already have URLs and need clean markdown extraction
- Cost is paramount and you want free-tier with no search
- Building a simple "fetch and convert" pipeline

**Choose Brave Search API when:**
- Simple web search with no extraction
- Budget is the #1 constraint (free tier is generous)
- Result quality for general web is acceptable (Brave is independent of Google/Bing)

### 19.4 For markdown-for-agents-mcp

Tavily is the **reference implementation** for our web layer. It defines the feature set we need to match:
- Search with relevance reranking + domain filtering
- URL extraction with basic/advanced depth
- MCP tool exposure of search and extract

We do not need to replicate crawl/map/research in Phase 1 — those are advanced features. But we should design our API schema to be forward-compatible with adding them.

---

## 20. Implementation Patterns for markdown-for-agents-mcp

### 20.1 Tavily-Compatible Search Tool (TypeScript)

This is what a Tavily-compatible MCP search tool looks like in Node.js. Our MCP server should expose equivalent tool definitions:

```typescript
// Tool definition for MCP (Zod schema)
import { z } from "zod";

const SearchToolSchema = z.object({
  query: z.string().describe("Web search query (max 1500 chars)"),
  search_depth: z
    .enum(["basic", "advanced"])
    .optional()
    .default("basic")
    .describe("Search quality. basic=fast+cheap, advanced=thorough+2x cost"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Number of results to return"),
  topic: z
    .enum(["general", "news", "finance"])
    .optional()
    .default("general")
    .describe("Topic specialisation"),
  time_range: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Recency filter"),
  include_domains: z
    .array(z.string())
    .optional()
    .describe("Restrict results to these domains"),
  exclude_domains: z
    .array(z.string())
    .optional()
    .describe("Exclude these domains from results"),
  include_answer: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return AI-synthesised answer alongside results"),
});

// Implementation
async function search(params: z.infer<typeof SearchToolSchema>) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query: params.query,
      search_depth: params.search_depth,
      max_results: params.max_results,
      topic: params.topic,
      time_range: params.time_range,
      include_domains: params.include_domains ?? [],
      exclude_domains: params.exclude_domains ?? [],
      include_answer: params.include_answer,
      include_usage: true,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Tavily search failed: ${err.detail?.error ?? response.statusText}`);
  }

  return response.json();
}
```

### 20.2 Tavily-Compatible Extract Tool (TypeScript)

```typescript
const ExtractToolSchema = z.object({
  urls: z
    .union([z.string(), z.array(z.string())])
    .describe("URL or list of URLs to extract (max 20)"),
  extract_depth: z
    .enum(["basic", "advanced"])
    .optional()
    .default("basic")
    .describe("basic=standard HTML, advanced=JS-rendered pages"),
  format: z
    .enum(["markdown", "text"])
    .optional()
    .default("markdown")
    .describe("Output format"),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe("Seconds to wait per URL"),
});

async function extract(params: z.infer<typeof ExtractToolSchema>) {
  const urls = Array.isArray(params.urls) ? params.urls : [params.urls];
  
  if (urls.length > 20) {
    throw new Error("Maximum 20 URLs per extract request");
  }
  
  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      urls,
      extract_depth: params.extract_depth,
      format: params.format,
      timeout: params.timeout,
      include_usage: true,
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Tavily extract failed: ${err.detail?.error ?? response.statusText}`);
  }

  const data = await response.json();
  
  // Return structured result including partial failures
  return {
    results: data.results,
    failed: data.failed_results,
    credits_used: data.usage?.credits ?? null,
  };
}
```

### 20.3 Building a Tavily-Parity Search+Extract in Node.js

For our self-hosted implementation (without Tavily key), we need to replicate:
1. Web search (ranking + snippet generation)
2. URL extraction with HTML cleaning
3. Markdown conversion
4. Relevance scoring

```typescript
// Rough parity implementation sketch
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import Searcher from "./search-backend"; // e.g. DuckDuckGo scraper or Brave API

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function searchParity(query: string, maxResults = 5) {
  // 1. Fetch SERP results
  const serpResults = await Searcher.search(query, { count: maxResults * 2 });
  
  // 2. For each result, fetch and clean content
  const withContent = await Promise.allSettled(
    serpResults.slice(0, maxResults).map(async (r) => {
      const html = await fetchWithTimeout(r.url, 8000);
      const $ = cheerio.load(html);
      
      // Remove navigation, headers, footers, ads
      $("nav, header, footer, script, style, [role=banner], [role=navigation]").remove();
      
      // Extract main content
      const main = $("main, article, [role=main]").first().html() 
        ?? $("body").html() 
        ?? "";
      
      const markdown = td.turndown(main);
      
      // Approximate relevance score (simple BM25 or keyword overlap)
      const score = computeRelevanceScore(query, markdown);
      
      return { ...r, content: extractChunk(query, markdown, 500), score };
    })
  );
  
  return withContent
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);
}

async function extractParity(url: string, options: { format: "markdown" | "text" }) {
  const html = await fetchWithTimeout(url, 15000);
  const $ = cheerio.load(html);
  
  $("nav, header, footer, script, style, noscript, iframe").remove();
  
  const mainContent = $("main, article, [role=main]").first().html() 
    ?? $("body").html() 
    ?? "";
  
  const markdown = td.turndown(mainContent);
  
  return {
    url,
    raw_content: options.format === "markdown" ? markdown : markdownToText(markdown),
    images: extractImageUrls($),
    favicon: extractFavicon($, url),
  };
}
```

**Honest assessment of parity complexity:**
- Basic HTML extraction: achievable with Cheerio + Turndown (~200 LOC)
- JavaScript-rendered content: requires Playwright/Puppeteer (~heavy dependency)
- Relevance ranking/reranking: requires embedding model or BM25 implementation
- Answer synthesis: requires LLM call
- Domain filtering, time filtering: straightforward query params to pass through

The gap between our implementation and Tavily's is primarily:
1. **Scale of their web index** (we can't replicate this without crawling the web)
2. **JS rendering** (Playwright is possible but expensive operationally)
3. **Chunk reranking** (we'd need an embedding model)

Our self-hosted solution is more appropriate for **known URL extraction** (Enterprise knowledge index) than for general web search.

### 20.4 Search Result Format for MCP Tool Response

Tavily returns a detailed JSON object. For MCP tool responses, we should normalise to a clean text format that agents can consume:

```typescript
function formatSearchResultsForMCP(response: TavilySearchResponse): string {
  const lines: string[] = [];
  
  if (response.answer) {
    lines.push(`**Answer:** ${response.answer}\n`);
  }
  
  lines.push(`**Search results for:** ${response.query}\n`);
  
  for (const [i, result] of response.results.entries()) {
    lines.push(`### ${i + 1}. ${result.title}`);
    lines.push(`URL: ${result.url}`);
    lines.push(`Relevance: ${(result.score * 100).toFixed(0)}%`);
    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    lines.push(`\n${result.content}\n`);
  }
  
  if (response.usage) {
    lines.push(`*Credits used: ${response.usage.credits}*`);
  }
  
  return lines.join("\n");
}
```

---

## 21. What to Build and What to Skip

### 21.1 Build Now (Phase 1)

**Search tool** with:
- Tavily as primary backend (API key in env)
- Parameters: `query`, `max_results`, `search_depth`, `topic`, `time_range`, `include_domains`, `exclude_domains`
- Response: normalised markdown with source list
- Retry with exponential backoff
- Credit tracking via `include_usage: true`

**Extract tool** with:
- Tavily as primary backend
- Parameters: `urls` (array, max 20), `extract_depth`, `format`
- Separate `results` and `failed_results` in response
- Graceful partial failure handling

**Caching layer:**
- Redis or in-memory cache for search results (TTL: 5–15 min)
- Content cache for extracted pages (TTL: 1–24 hours depending on content type)

### 21.2 Build in Phase 2 (Enterprise Knowledge Index)

**Crawl integration:**
- Expose as an admin-only tool, not end-user callable
- Use for initial knowledge base population (SharePoint, Confluence content via Tavily can supplement)
- Schedule nightly refresh with change detection

**Map-based discovery:**
- For auto-discovering internal documentation sites
- Pre-crawl scoping before full ingestion

**Research endpoint:**
- Gated feature, `model=mini` only for regular users
- `model=pro` gated to Enterprise tier or explicit admin enablement

### 21.3 Skip (Not Worth It)

**Full Tavily parity without API key:**
- General web search parity is infeasible at reasonable quality without either Tavily, Brave, SerpAPI, or equivalent
- Recommendation: always require one of these API keys for web search
- Self-hosted extraction (for known URLs) is viable and recommended for Enterprise knowledge index

**Answer synthesis from scratch:**
- Let Tavily do it (`include_answer: true`) or let the calling LLM do it
- Building our own synthesis layer adds cost without value

**Crawl from scratch:**
- Playwright-based crawling is operationally heavy (memory, timeout, anti-bot evasion)
- Use Tavily Crawl API or Firecrawl for this

### 21.4 Decision Table: Tavily vs Build vs Skip

| Feature | Decision | Rationale |
|---|---|---|
| Web search (general) | Use Tavily API | Quality gap too large to close self-hosted |
| Web search (domain-specific) | Use Tavily with `include_domains` | Clean, cheap, reliable |
| URL extraction (public web) | Use Tavily Extract | JS rendering + reliability |
| URL extraction (internal, auth-gated) | Build self-hosted | Tavily can't auth to SharePoint/Confluence |
| Site crawl (public) | Use Tavily Crawl | Cheaper than maintaining Playwright fleet |
| Site crawl (internal) | Build self-hosted | Same as extraction |
| Answer synthesis | Tavily `include_answer` or LLM | Not our value-add |
| Relevance reranking | Tavily's built-in | Requires embedding infra to DIY |
| Structured research | Tavily Research API | Way too complex to DIY |
| MCP tool exposure | Build (wraps Tavily) | Our entire value proposition |

---

## Sources

- [docs.tavily.com](https://docs.tavily.com) — Official documentation (accessed 2026-08-26)
- [docs.tavily.com/documentation/api-credits](https://docs.tavily.com/documentation/api-credits) — Credits and pricing
- [docs.tavily.com/documentation/rate-limits](https://docs.tavily.com/documentation/rate-limits) — Rate limits
- [docs.tavily.com/documentation/api-reference/endpoint/search](https://docs.tavily.com/documentation/api-reference/endpoint/search) — Search endpoint reference
- [docs.tavily.com/documentation/api-reference/endpoint/extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract) — Extract endpoint reference
- [docs.tavily.com/documentation/api-reference/endpoint/crawl](https://docs.tavily.com/documentation/api-reference/endpoint/crawl) — Crawl endpoint reference
- [docs.tavily.com/documentation/mcp](https://docs.tavily.com/documentation/mcp) — MCP server documentation
- [tavily.com/pricing](https://tavily.com/pricing) — Pricing page
- [agentsapis.com/tavily-api/](https://agentsapis.com/tavily-api/) — Comprehensive developer guide
- [coldiq.com/blog/tavily-pricing](https://coldiq.com/blog/tavily-pricing) — Pricing analysis (verified July 5, 2026)
- [deepwiki.com/tavily-ai/tavily-js/3-api-operations](https://deepwiki.com/tavily-ai/tavily-js/3-api-operations) — JS SDK type system reference
- [aipedia.wiki/tools/tavily/](https://aipedia.wiki/tools/tavily/) — Editorial review (verified June 28, 2026)
- [docs.tavily.com/documentation/best-practices/best-practices-search](https://docs.tavily.com/documentation/best-practices/best-practices-search) — Search best practices
