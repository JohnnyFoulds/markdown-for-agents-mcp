# Brave Search API — Research Notes

**Status:** Complete  
**Date:** 2026-08-26  
**Author:** Research agent  
**Sources:** brave.com/search/api/, deepwiki.com/brave/brave-search-skills (indexed 2026-07-01), marketingscoop.com, llmrefs.com

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Independent Index](#the-independent-index)
3. [Pricing and Plans](#pricing-and-plans)
4. [Rate Limits and Quotas](#rate-limits-and-quotas)
5. [Authentication](#authentication)
6. [Endpoint Reference](#endpoint-reference)
   - [Web Search — `/res/v1/web/search`](#web-search)
   - [Rich Data Callback — `/res/v1/web/rich`](#rich-data-callback)
   - [LLM Context — `/res/v1/llm/context`](#llm-context)
   - [Answers — `/res/v1/chat/completions`](#answers-chat-completions)
   - [Images — `/res/v1/images/search`](#images-search)
   - [News — `/res/v1/news/search`](#news-search)
   - [Videos — `/res/v1/videos/search`](#videos-search)
   - [Suggest — `/res/v1/suggest/search`](#suggest)
   - [Spellcheck — `/res/v1/spellcheck/search`](#spellcheck)
   - [Local POIs — `/res/v1/local/pois`](#local-pois)
   - [Local Descriptions — `/res/v1/local/descriptions`](#local-descriptions)
7. [Goggles: Custom Re-Ranking](#goggles-custom-re-ranking)
8. [Response Schemas](#response-schemas)
9. [Search Operators](#search-operators)
10. [Result Freshness](#result-freshness)
11. [Privacy and Data Handling](#privacy-and-data-handling)
12. [Brave vs. Competitors](#brave-vs-competitors)
13. [Implementation Patterns for markdown-for-agents-mcp](#implementation-patterns)
14. [Normalisation Schema](#normalisation-schema)
15. [TypeScript Code Examples](#typescript-code-examples)
16. [Limitations, Failure Modes, and Gotchas](#limitations-failure-modes-and-gotchas)
17. [What to Build vs. What to Skip](#what-to-build-vs-what-to-skip)

---

## Executive Summary

Brave Search API is a commercially available search API built on top of Brave's own independently crawled web index — not a thin wrapper over Google or Bing. As of mid-2026, the index contains **30+ billion pages** with **100+ million daily page updates**. It is the leading search API consumed by Claude MCP deployments and is third-party-rated as having the highest agent quality score and lowest latency among major search APIs.

**Why it matters for markdown-for-agents-mcp:**
- Only search API with a first-class MCP integration story (Brave ships their own MCP server)
- Independent index means result diversity that Google/Bing-proxied APIs cannot offer
- Goggles enable per-query source allow/block lists — ideal for our enterprise knowledge context routing
- `/res/v1/llm/context` is purpose-built for RAG: returns pre-extracted text chunks, tables, and code blocks ready to inject into prompts
- Privacy stance (no ad profiling, no cross-session tracking) aligns with enterprise requirements
- `$5/1000` requests on Search plan is competitive; free tier of $5 monthly credits means prototyping is essentially free

**Verdict:** Brave should be the **primary search provider** for the web-layer of markdown-for-agents-mcp. Implement `/res/v1/llm/context` for agent RAG and `/res/v1/web/search` with Goggles for controllable structured retrieval.

---

## The Independent Index

Sources: [brave.com/search/api/](https://brave.com/search/api/), [llmrefs.com](https://llmrefs.com/blog/brave-web-search-api), [marketingscoop.com](https://www.marketingscoop.com/developer/brave-search-api-in-2026-what-it-is-and-what-you-can-actually-build-with-it/)

### What makes it independent

Brave does not license results from Google or Bing. The index is built and maintained by Brave's own crawler, Brave Search Bot. This is a material difference in practice:

| Property | Brave | Google CSE | Bing Web Search |
|---|---|---|---|
| Index owner | Brave Software | Google | Microsoft |
| Result diversity | Independent ranking | Google ranking | Bing ranking |
| Ad bias in results | None | Possible bleed-through | Possible bleed-through |
| GDPR data processing | Brave's DPA | Google's DPA | Microsoft's DPA |
| Dependency risk | Single vendor | Google monopoly risk | Microsoft monopoly risk |

### Index scale and freshness

- **30+ billion indexed pages** (some sources cite 40+ billion for specific verticals)
- **100+ million page updates per day** — this is the recrawl throughput, not new-page additions
- Brave's Web Discovery Project (opt-in browser telemetry from Brave browser users) supplements the crawler with real-world browse signals, improving freshness signals for pages that real users actually visit
- The `page_age` field in results carries an ISO-8601 publication timestamp; `age` carries a human-readable relative string (e.g., "2 days ago")
- The `include_fetch_metadata=true` parameter adds `fetched_content_timestamp` (Unix integer) to each result so you can compute crawl staleness programmatically

### Breaking news handling

The news endpoint (`/res/v1/news/search`) with `freshness=pd` (past 24 hours) is the right tool for breaking news. Generic web search can bury recent results under evergreen authoritative pages. For real-time monitoring pipelines, always use `/news/search` with `freshness=pd` or `freshness=pw` and then merge with internal source scoring.

---

## Pricing and Plans

Source: [brave.com/search/api/](https://brave.com/search/api/) — verified 2026-08-26

### Plan Tiers

| Plan | Price | Included Free | Rate Limit | Best For |
|---|---|---|---|---|
| **Search** | **$5 / 1,000 requests** | $5 in credits/month (~1,000 free requests/month) | 50 QPS | RAG retrieval, structured search, agent tools |
| **Answers** | **$4 / 1,000 queries** + **$5 / 1M tokens** (in + out) | $5 in credits/month | 2 QPS | Chat interfaces, grounded answer generation |
| **Suggest** | Separate plan (free tier available) | Limited free quota | High | Autocomplete, query expansion |
| **Enterprise** | Custom | Custom | Custom (>50 QPS) | Full ZDR, custom agreements, invoicing |

**Notes:**
- Free credits ($5/month) are automatically applied — no coupon needed
- Search plan and Answers plan are separate subscriptions with separate keys, or you can get both under one account
- The public "Data for AI" free tier mentioned in older documentation allows 2,000 queries/month at 1 QPS — this may map to the $5 free credit allotment
- Suggest basic mode (no entity enrichment) is available under the Suggest plan; `rich=true` mode additionally requires the paid Search plan
- Enterprise plan includes **Full-funnel Zero Data Retention (ZDR)** — no query data stored

### Cost Modeling

For a typical agent-grounded query that uses `/res/v1/web/search`:
- 1 request = $0.005
- 100 agent queries/day = ~$0.50/day = ~$15/month
- Well within the $5/month free tier for prototyping; production cost is manageable

For the Answers plan research mode (multi-search):
- 1 research request might internally execute 8–20 search queries + 15,000–30,000 tokens
- Cost example from their `<usage>` tag: `$0.122` for a research query with 8 queries and 17,000 tokens
- **Avoid using research mode for simple lookups** — the cost is 10–25x higher than a single web search

### Cost Control Strategies

```typescript
// Classify query intent before routing to endpoint
type QueryComplexity = 'navigational' | 'factual' | 'research';

function classifyQuery(query: string): QueryComplexity {
  // Simple navigational: site lookup, definition, quick fact
  if (/^(what is|define|who is|when was|site:)/i.test(query)) return 'factual';
  // Research: compare, explain, analyze multi-source topics  
  if (/\b(compare|versus|vs|analyze|explain why|pros and cons)\b/i.test(query)) return 'research';
  return 'factual';
}

function routeQuery(query: string): 'web-search' | 'llm-context' | 'answers-research' {
  const complexity = classifyQuery(query);
  if (complexity === 'navigational') return 'web-search';     // $0.005/call
  if (complexity === 'factual') return 'llm-context';         // $0.005/call
  return 'answers-research';                                   // ~$0.10+/call
}
```

---

## Rate Limits and Quotas

Source: brave.com/search/api/, marketingscoop.com

### Per-Plan Rate Limits

| Plan | Requests per Second (QPS) | Notes |
|---|---|---|
| Search | **50 QPS** | Sliding window |
| Answers | **2 QPS** | Much lower; applies to the chat/completions endpoint |
| Enterprise | Custom | Can negotiate higher limits |

### Response Headers

The API returns rate limit state in response headers:

```
X-RateLimit-Remaining: 47
```

Always parse this header and implement backoff when it approaches zero. The API uses a **sliding window** model, not a fixed bucket.

### Pagination Limits

Web search pagination is tightly constrained:
- `count`: 1–20 (max 20 results per request)
- `offset`: 0–9 (max 10 pages = 200 results total)
- Images search: `count` up to 200 per request
- News search: `count` 1–50, `offset` 0–9
- Videos search: `count` 1–50, `offset` 0–9

**Gotcha:** There is no cursor-based pagination. You page through results by incrementing `offset`. `query.more_results_available: true` in the response signals whether more pages exist. Always check this flag before issuing a follow-up request.

---

## Authentication

All endpoints use a single header:

```
X-Subscription-Token: <BRAVE_SEARCH_API_KEY>
```

The Answers endpoint (`/chat/completions`) additionally accepts:

```
Authorization: Bearer <BRAVE_SEARCH_API_KEY>
```

The `Authorization: Bearer` form enables drop-in OpenAI SDK compatibility (set `api_key` to your Brave key).

**Security practices:**
- Store the key as `BRAVE_SEARCH_API_KEY` environment variable
- Backend-only — never expose in client-side code
- Treat it with the same sensitivity as your LLM provider API key — search queries reveal as much user intent as prompts
- Rotate if the key appears in logs, screenshots, or support threads
- For enterprise: use separate keys per environment (dev, staging, prod) for quota isolation

---

## Endpoint Reference

Base URL: `https://api.search.brave.com`

### Web Search

**Endpoints:**
```
GET  /res/v1/web/search
POST /res/v1/web/search
```

Use POST for long queries or when passing inline Goggles rules (which can exceed URL length limits as query strings).

#### Request Parameters

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `q` | string | Yes | — | 1–400 chars, max 50 words | Search query |
| `country` | string | No | `US` | 2-letter ISO or `ALL` | Geo-specific ranking |
| `search_lang` | string | No | `en` | 2+ char ISO language | Language preference for results |
| `ui_lang` | string | No | `en-US` | e.g., `en-US`, `fr-FR` | UI locale |
| `count` | int | No | `20` | 1–20 | Results per page |
| `offset` | int | No | `0` | 0–9 | Pagination offset (10 pages max) |
| `safesearch` | string | No | `moderate` | `off`, `moderate`, `strict` | Adult content filter |
| `freshness` | string | No | — | see Freshness Values | Time window filter |
| `text_decorations` | bool | No | `true` | — | Include `<strong>` highlight markers in snippets |
| `spellcheck` | bool | No | `true` | — | Auto-correct query before search |
| `result_filter` | string | No | — | comma-separated types | Filter result types returned |
| `goggles` | string | No | — | URL or inline rules | Custom re-ranking/filtering |
| `extra_snippets` | bool | No | — | — | Up to 5 additional excerpts per result |
| `operators` | bool | No | `true` | — | Parse search operators in query string |
| `units` | string | No | — | `metric` or `imperial` | Unit preference for distance |
| `enable_rich_callback` | bool | No | `false` | — | Emit `rich.hint` for follow-up `/web/rich` call |
| `include_fetch_metadata` | bool | No | `false` | — | Add `fetched_content_timestamp` to each result |

#### Freshness Values

| Value | Window |
|---|---|
| `pd` | Past 24 hours |
| `pw` | Past 7 days |
| `pm` | Past 31 days |
| `py` | Past 365 days |
| `YYYY-MM-DDtoYYYY-MM-DD` | Custom date range (no spaces, literal `to` separator) |

Example: `freshness=2026-01-01to2026-06-30`

#### result_filter Values

Comma-separated from: `discussions`, `faq`, `infobox`, `news`, `query`, `videos`, `web`, `locations`

Important: `result_filter=locations` is the **required first step** for the Local POI two-step flow.

#### Location Headers (for geo-personalisation)

| Header | Type | Description |
|---|---|---|
| `X-Loc-Lat` | float | Latitude (−90.0 to 90.0) |
| `X-Loc-Long` | float | Longitude (−180.0 to 180.0) |
| `X-Loc-Timezone` | string | IANA timezone (e.g., `America/Chicago`) |
| `X-Loc-City` | string | City name |
| `X-Loc-State` | string | ISO 3166-2 state/region code |
| `X-Loc-State-Name` | string | Full state/region name |
| `X-Loc-Country` | string | 2-letter country code |
| `X-Loc-Postal-Code` | string | Postal code |

**Priority rule:** `X-Loc-Lat` + `X-Loc-Long` take precedence. When coordinates are present, text-based location headers are ignored.

#### Web Search Response Schema

```typescript
interface WebSearchResponse {
  type: 'search';
  query: {
    original: string;
    altered?: string;          // spellcheck-corrected version
    cleaned?: string;          // normalised version
    spellcheck_off?: boolean;
    more_results_available: boolean;
    show_strict_warning?: boolean;
    search_operators?: {
      applied: boolean;
      cleaned_query?: string;
      sites?: string[];
    };
  };
  web?: {
    type: 'search';
    results: WebResult[];
    mutated_by_goggles: boolean;
    family_friendly: boolean;
  };
  discussions?: {
    results: DiscussionResult[];
  };
  faq?: {
    results: FAQResult[];
  };
  infobox?: {
    results: InfoboxResult[];
  };
  news?: {
    results: NewsResult[];
  };
  videos?: {
    results: VideoResult[];
  };
  locations?: {
    results: LocationResult[];
  };
  mixed: {
    main: ResultReference[];   // ordered primary result sequence
    top: ResultReference[];    // results to display above main
    side: ResultReference[];   // results to display alongside main (e.g., infobox)
  };
  rich?: {
    hint?: {
      callback_key: string;    // hex key for /res/v1/web/rich follow-up
    };
  };
}

interface WebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;                // human-readable: "2 days ago"
  page_age?: string;           // ISO datetime: "2026-04-12T14:22:41"
  language?: string;
  meta_url: {
    scheme: string;
    netloc: string;
    hostname: string;
    path: string;
    favicon?: string;
  };
  thumbnail?: {
    src: string;               // Brave CDN URL
    original: string;          // original URL
    logo: boolean;
  };
  profile?: {
    name: string;
    url: string;
    long_name: string;
    img: string;               // publisher favicon URL
  };
  extra_snippets?: string[];   // up to 5, requires extra_snippets=true
  deep_results?: {
    buttons?: { type: string; title: string; url: string }[];
    links?: { type: string; title: string; url: string }[];
  };
  schemas?: object[];          // raw schema.org structured data
  fetched_content_timestamp?: number;  // Unix int, requires include_fetch_metadata=true
  // Schema.org typed sub-objects (all optional):
  product?: ProductInfo;
  recipe?: RecipeInfo;
  article?: ArticleInfo;
  book?: BookInfo;
  software?: SoftwareInfo;
  rating?: RatingInfo;
  faq?: FAQInfo;
  movie?: MovieInfo;
  video?: VideoInfo;
  location?: LocationInfo;
  qa?: QAInfo;
  creative_work?: CreativeWorkInfo;
  music_recording?: MusicRecordingInfo;
  organization?: OrganizationInfo;
  review?: ReviewInfo;
}

interface ResultReference {
  type: 'web' | 'videos' | 'news' | 'discussions' | 'faq' | 'infobox' | 'locations';
  index: number;  // zero-based index into the corresponding result array
  all?: boolean;  // if true, include all items of that type at this position
}
```

#### Infobox / Knowledge Graph

The `infobox.results` array contains knowledge graph entries. These appear when the query matches a known entity (person, place, organisation, concept). They provide structured entity data without requiring a separate API call.

The `mixed.side` array in the response indicates where the infobox should be rendered (sidebar position). For agent use, treat the infobox as high-confidence structured context to inject directly into the prompt.

---

### Rich Data Callback

**Endpoint:**
```
GET /res/v1/web/rich?callback_key=<hex_key>
```

This is a **follow-up only** endpoint — it is not used for initial queries. To trigger it:

1. Call `/res/v1/web/search` with `enable_rich_callback=true`
2. If the response contains `rich.hint.callback_key`, call `/res/v1/web/rich?callback_key=<value>`

**Supported rich verticals:**
Calculator, Definitions, Unit Conversion, Unix Timestamp, Package Tracker, Stock, Currency, Cryptocurrency, Weather, American Football, Baseball, Basketball, Cricket, Football/Soccer, Ice Hockey, Web3, Translator

**Agent use case:** For queries like "weather in Berlin" or "USD to EUR", the rich endpoint returns real-time structured data that is far better than a web snippet. Implement the two-step flow when building agent tools that handle these query types.

---

### LLM Context

**Endpoints:**
```
GET  /res/v1/llm/context
POST /res/v1/llm/context
```

This is the **primary endpoint for RAG pipelines**. Instead of ranked links and snippets, it returns pre-extracted page content — text chunks, tables, code blocks, and structured data — already shaped for injection into an LLM prompt.

#### When to Use LLM Context vs. Web Search

| | `/llm/context` | `/web/search` |
|---|---|---|
| Output | Pre-extracted text chunks | Ranked links + snippets |
| Result types | Extracted text, tables, code | Web, news, videos, discussions, FAQ, infobox, locations, rich |
| Unique features | Token budget control, threshold modes | Goggles, schemas, rich callbacks |
| Speed | Fast (< 1s) | Fast (~0.5–1s) |
| Best for | RAG pipelines, AI agent grounding | Search UIs, data extraction, custom ranking |

**Rule of thumb:** Use `/llm/context` when you want to inject web content directly into a prompt. Use `/web/search` when your pipeline needs to make decisions about which results to use before generation.

#### Request Parameters

| Parameter | Type | Required | Default | Range | Description |
|---|---|---|---|---|---|
| `q` | string | Yes | — | 1–400 chars | Search query |
| `country` | string | No | `US` | 2-letter or `ALL` | Search country |
| `search_lang` | string | No | `en` | 2+ chars | Language preference |
| `count` | int | No | `20` | 1–50 | Max search results to consider |
| `maximum_number_of_urls` | int | No | `20` | 1–50 | Global: max URLs to extract from |
| `maximum_number_of_tokens` | int | No | `8192` | 1024–32768 | Global: max total tokens returned |
| `maximum_number_of_snippets` | int | No | `50` | 1–100 | Global: max snippet count |
| `maximum_number_of_tokens_per_url` | int | No | `4096` | 512–8192 | Per-URL: max tokens |
| `maximum_number_of_snippets_per_url` | int | No | `50` | 1–100 | Per-URL: max snippets |
| `context_threshold_mode` | string | No | `balanced` | `strict`, `balanced`, `lenient` | Relevance filtering aggressiveness |
| `enable_local` | bool/null | No | `null` | — | Local recall control (null = auto-detect from headers) |
| `goggles` | string/list | No | — | — | Goggle URL or inline rules for source control |

#### Context Size Guidelines

| Task Type | `count` | `maximum_number_of_tokens` | Example Query |
|---|---|---|---|
| Simple factual | 5 | 2048 | "What year was Python created?" |
| Standard queries | 20 | 8192 | "Best practices for React hooks" |
| Complex research | 50 | 16384 | "Compare AI frameworks for production" |

#### LLM Context Response Schema

```typescript
interface LLMContextResponse {
  grounding: {
    generic: Array<{
      url: string;
      title: string;
      snippets: string[];   // may be plain text OR JSON-serialised structured data (tables, code)
    }>;
    // Only present when local recall is triggered:
    poi?: {
      name: string | null;
      url: string | null;
      title: string | null;
      snippets: string[] | null;
    };
    map?: Array<{
      name: string | null;
      url: string | null;
      title: string | null;
      snippets: string[] | null;
    }>;
  };
  sources: {
    [url: string]: {
      title: string;
      hostname: string;
      age?: [string, string, string]; // [human-readable, ISO-8601, relative]
    };
  };
}
```

**Key detail:** Snippets may contain JSON-serialised structured data (tables rendered as JSON arrays, code blocks). LLMs handle this mixed format without pre-processing — pass it directly into the prompt.

---

### Answers (Chat Completions)

**Endpoint:**
```
POST /res/v1/chat/completions
```

OpenAI-compatible chat completions with web grounding. Brave executes search queries internally, selects sources, and returns a cited answer. This is a **separate Answers plan** (not included in the Search plan).

#### OpenAI SDK Drop-in

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.search.brave.com/res/v1',
  apiKey: process.env.BRAVE_SEARCH_API_KEY,
});
```

The only required changes from an OpenAI integration are `baseURL` and `apiKey`. The `model` field must be set to `"brave"`.

#### Two Operating Modes

| Feature | Single-Search (default) | Research (`enable_research=true`) |
|---|---|---|
| Speed | Fast | Slow (up to 300 seconds) |
| Search iterations | 1 | Multiple (iterative) |
| Stream required | Optional | **Required (`stream=true`)** |
| Citations | `enable_citations=true` (streaming only) | Built-in inside `<answer>` tag |
| Progress events | No | Yes (`<progress>` tags) |
| Blocking mode | Supported | **Not supported** |

#### Request Parameters

```typescript
interface AnswersRequest {
  messages: [{ role: 'user'; content: string }];  // exactly 1 user message
  model: 'brave';
  stream?: boolean;        // default: true
  country?: string;        // default: "US"
  language?: string;       // default: "en"
  safesearch?: 'off' | 'moderate' | 'strict';  // default: "moderate"
  max_completion_tokens?: number;
  enable_citations?: boolean;  // single-search streaming only
  web_search_options?: {
    search_context_size: 'low' | 'medium' | 'high';
  };
  // Research mode parameters:
  enable_research?: boolean;         // default: false
  research_allow_thinking?: boolean; // default: true
  research_maximum_number_of_tokens_per_query?: number;   // 1024–16384, default 8192
  research_maximum_number_of_queries?: number;            // 1–50, default 20
  research_maximum_number_of_iterations?: number;         // 1–5, default 4
  research_maximum_number_of_seconds?: number;            // 1–300, default 180
  research_maximum_number_of_results_per_query?: number;  // 1–60, default 60
}
```

#### Parameter Compatibility Constraints

These combinations return errors — do not attempt them:

| Invalid Combination | Error |
|---|---|
| `enable_research=true` + `stream=false` | "Blocking response doesn't support 'enable_research' option" |
| `enable_research=true` + `enable_citations=true` | "Research mode doesn't support 'enable_citations' option" |
| `enable_citations=true` + `stream=false` | "Blocking response doesn't support 'enable_citations' option" |

#### Streaming Tag Protocol

In streaming mode, the `delta.content` field carries both the answer text and structured XML-style metadata tags:

**Single-search tags:**

| Tag | Purpose | Action |
|---|---|---|
| `<citation>` | Inline citation references | Render or strip in UI |
| `<usage>` | JSON cost/billing data | Parse for cost monitoring |

**Research mode tags:**

| Tag | Content | Recommended Action |
|---|---|---|
| `<queries>` | Generated search queries | Debug only |
| `<analyzing>` | URL counts | Debug only |
| `<thinking>` | URL selection reasoning | Debug only |
| `<progress>` | Stats: time, iterations, queries, URLs, tokens | Monitor for progress UI |
| `<blindspots>` | Knowledge gaps identified | Surface to user |
| `<answer>` | Final synthesized answer with citations | **Primary output** |
| `<usage>` | JSON cost breakdown | Parse for cost monitoring |

#### Usage Tag Format

```json
{
  "X-Request-Requests": 1,
  "X-Request-Queries": 8,
  "X-Request-Tokens-In": 15000,
  "X-Request-Tokens-Out": 2000,
  "X-Request-Requests-Cost": 0.005,
  "X-Request-Queries-Cost": 0.032,
  "X-Request-Tokens-In-Cost": 0.075,
  "X-Request-Tokens-Out-Cost": 0.01,
  "X-Request-Total-Cost": 0.122
}
```

Always parse `<usage>` from every streaming response for cost monitoring and alerting.

**Operational notes:**
- Client timeout: ≥30s for single-search; **≥300s (5 minutes) for research mode**
- `messages` array must contain exactly 1 user message
- The final answer is emitted inside `<answer>` — intermediate drafts are dropped

---

### Images Search

**Endpoint:**
```
GET /res/v1/images/search
```

Plan: Search. Max results: 200 per request.

#### Request Parameters

| Parameter | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `q` | string | Yes | — | 1–400 chars |
| `country` | string | No | `US` | 2-letter or `ALL` |
| `search_lang` | string | No | `en` | 2+ chars |
| `count` | int | No | `50` | 1–200 |
| `safesearch` | string | No | **`strict`** | `off` or `strict` only — **no `moderate`** |
| `spellcheck` | bool | No | `true` | — |

**Gotcha:** Images safesearch only has two values (`off`/`strict`), not three like the other endpoints. The default is `strict` (more conservative than other endpoints). If strict mode suppresses relevant results, `query.show_strict_warning: true` is set.

#### Images Response Schema

```typescript
interface ImageResult {
  type: 'image_result';
  title?: string;
  url?: string;            // page URL where image was found
  source?: string;         // source domain
  page_fetched?: string;   // ISO datetime of last page crawl
  thumbnail?: {
    src: string;           // Brave-proxied CDN URL (~500px wide)
    width?: number;
    height?: number;
  };
  properties?: {
    url?: string;          // original full-size image URL
    placeholder?: string;  // low-res placeholder (Brave-proxied, not base64)
    width?: number;        // may be null — do not assume present
    height?: number;       // may be null
  };
  meta_url?: {
    scheme?: string;
    netloc?: string;
    hostname?: string;
    favicon?: string;
    path?: string;
  };
  confidence?: 'high' | 'medium' | 'low';  // nullable
}
```

**Thumbnail vs. properties:** Use `thumbnail.src` for displaying previews (Brave CDN, consistent sizing). Use `properties.url` when you need the full-resolution original. `properties.width`/`height` can be null.

---

### News Search

**Endpoints:**
```
GET  /res/v1/news/search
POST /res/v1/news/search
```

Plan: Search.

#### Request Parameters

| Parameter | Type | Required | Default | Range | Description |
|---|---|---|---|---|---|
| `q` | string | Yes | — | 1–400 chars | Query |
| `country` | string | No | `US` | — | 2-letter or `ALL` |
| `search_lang` | string | No | `en` | — | Language |
| `ui_lang` | string | No | `en-US` | — | UI locale |
| `count` | int | No | `20` | 1–50 | Results per page |
| `offset` | int | No | `0` | 0–9 | Pagination offset |
| `safesearch` | string | No | **`strict`** | `off`, `moderate`, `strict` | Adult filter |
| `freshness` | string | No | — | same as web | Time filter |
| `spellcheck` | bool | No | `true` | — | Auto-correct |
| `extra_snippets` | bool | No | — | — | Up to 5 extra excerpts |
| `goggles` | string/array | No | — | — | Custom re-ranking |
| `operators` | bool | No | `true` | — | Parse search operators |
| `include_fetch_metadata` | bool | No | `false` | — | Add `fetched_content_timestamp` |

**Note:** News default safesearch is `strict` (same as images), not `moderate` like web/videos.

#### News Result Schema

```typescript
interface NewsResult {
  type: 'news_result';
  title: string;        // article headline
  url: string;
  description?: string;
  age?: string;         // human-readable
  page_age?: string;    // ISO datetime
  breaking?: boolean;   // true for breaking news articles
  thumbnail?: { src: string; original: string };
  meta_url?: MetaUrl;
  extra_snippets?: string[];
  fetched_content_timestamp?: number;
}
```

---

### Videos Search

**Endpoints:**
```
GET  /res/v1/videos/search
POST /res/v1/videos/search
```

Plan: Search.

#### Request Parameters

Same core parameters as News Search (`q`, `country`, `search_lang`, `ui_lang`, `count` 1–50, `offset` 0–9, `safesearch` with `moderate` default, `freshness`, `spellcheck`, `operators`, `include_fetch_metadata`). No `extra_snippets` or `goggles` on the videos endpoint.

#### Video Result Schema

```typescript
interface VideoResult {
  type: 'video_result';
  url: string;                 // source URL (e.g., YouTube watch URL)
  title: string;
  description?: string;
  age?: string;
  page_age?: string;
  page_fetched?: string;
  fetched_content_timestamp?: number;
  thumbnail?: { src: string; original: string };
  meta_url?: MetaUrl;
  video?: {
    duration?: string;               // variable format: "03:45:00"
    views?: number;
    creator?: string;                // channel name
    publisher?: string;              // "YouTube", "Vimeo", etc.
    requires_subscription?: boolean;
    tags?: string[];
    author?: {
      name: string;
      url: string;
      long_name?: string;
      img?: string;
    };
    thumbnail?: {
      src: string;                   // Brave CDN thumbnail
      original: string;             // original thumbnail URL
    };
  };
}
```

---

### Suggest

**Endpoint:**
```
GET /res/v1/suggest/search
```

Plan: Suggest plan (basic mode); Search plan also required for `rich=true`.

Target latency: **< 100ms** — designed for real-time autocomplete dropdowns.

#### Request Parameters

| Parameter | Type | Required | Default | Constraints | Description |
|---|---|---|---|---|---|
| `q` | string | Yes | — | 1–400 chars | Partial query to complete |
| `lang` | string | No | `en` | 2+ chars | Language hint (not strict filter) |
| `country` | string | No | `US` | 2-letter or `ALL` | Country hint (not strict filter) |
| `count` | int | No | `5` | 1–20 | Max suggestions; actual may be fewer |
| `rich` | bool | No | `false` | Requires Search plan | Include entity enrichment fields |

#### Response Schema

```typescript
interface SuggestResponse {
  type: 'suggest';
  query: { original: string };
  results: Array<{
    query: string;          // suggested query completion
    is_entity?: boolean;    // true if maps to a known entity (rich mode only)
    title?: string;         // entity display title (rich mode only)
    description?: string;   // short entity description (rich mode only)
    img?: string;           // entity image URL (rich mode only)
  }>;
}
```

**Note on null fields:** In rich mode, fields with null values are **omitted entirely** — they are not present as null keys. Check for field presence, not null equality.

**Typo resilience:** Suggest handles common misspellings internally — you do not need a separate spellcheck call for autocomplete.

---

### Spellcheck

**Endpoint:**
```
GET /res/v1/spellcheck/search
```

Plan: Search.

Use spellcheck **before expensive retrieval** when input is noisy. Do not run it on every request — trigger it selectively when the query looks malformed (short words, phonetic spellings, excessive punctuation).

#### Request Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `q` | string | Yes | — | Query to spell-check |
| `country` | string | No | `US` | 2-letter country code |
| `lang` | string | No | `en` | Language code |

#### Response Schema

```typescript
interface SpellcheckResponse {
  type: 'spellcheck';
  query: { original: string };
  results: Array<{
    query: string;    // corrected query string
    score?: number;   // confidence score
  }>;
}
```

---

### Local POIs

**Endpoint:**
```
GET /res/v1/local/pois
```

Plan: Search. **This endpoint cannot be called in isolation** — it requires a mandatory two-step flow.

#### The Two-Step POI Flow

**Step 1:** Call `/res/v1/web/search` with `result_filter=locations`

```typescript
const searchResponse = await fetch(
  'https://api.search.brave.com/res/v1/web/search?' + new URLSearchParams({
    q: 'coffee shops near Golden Gate Park San Francisco',
    result_filter: 'locations',
  }),
  { headers: { 'X-Subscription-Token': apiKey } }
);
const poiIds = searchResponse.locations.results.map(r => r.id);
// IDs are opaque, base64-like strings, expire ~8 hours after generation
```

**Step 2:** Call `/res/v1/local/pois` with the IDs

```
GET /res/v1/local/pois?ids=<id1>&ids=<id2>&ids=<id3>
```

**POI ID constraints:**
- Format: opaque, base64-like (may contain `=` — URL-encode required)
- Lifetime: ~8 hours
- Max per request: 20
- Do not persist or reuse across sessions

#### Local POIs Request Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `ids` | string[] | Yes | — | POI IDs from step 1 (1–20) |
| `search_lang` | string | No | `en` | Language preference |
| `ui_lang` | string | No | `en-US` | UI locale |
| `units` | string | No | `null` | `metric` or `imperial` for distance |

Supply `X-Loc-Lat`/`X-Loc-Long` headers to get a `distance` field on each result.

#### LocationResult Schema

```typescript
interface LocationResult {
  type: 'location_result';
  title: string;                      // business/POI name
  url: string;                        // canonical URL
  provider_url: string;               // provider page (e.g., Yelp)
  id: string;                         // opaque identifier, ~8hr TTL
  description?: string;
  postal_address: {
    type: 'PostalAddress';
    displayAddress: string;           // formatted full address
    streetAddress?: string;
    addressLocality?: string;          // city
    addressRegion?: string;            // state/region
    postalCode?: string;
    addressCountry?: string;
  };
  coordinates?: { latitude: number; longitude: number };
  distance?: number;                   // present when location headers supplied
  phone?: string;
  hours?: { open_now?: boolean; current_day?: HoursEntry; all_week?: HoursEntry[] };
  price_range?: string;                // e.g., "$", "$$"
  rating?: { ratingValue?: number; ratingCount?: number };
  categories?: string[];
  thumbnail?: { src: string; original: string };
}
```

---

### Local Descriptions

**Endpoint:**
```
GET /res/v1/local/descriptions
```

Companion to Local POIs. Returns AI-generated textual descriptions of POIs identified in Step 1. Uses the same POI IDs from the two-step flow.

---

## Goggles: Custom Re-Ranking

Source: [deepwiki.com/brave/brave-search-skills/4.1-goggles](https://deepwiki.com/brave/brave-search-skills/4.1-goggles-custom-result-ranking)

Goggles are Brave's mechanism for applying custom re-ranking, boosting, downranking, and discarding rules to search results at request time. They work **within the ranked set** — they do not add new results from outside the index.

**Available on:** `/web/search`, `/news/search`, `/llm/context`

### Delivery Methods

| Method | Registration Required | How to Pass |
|---|---|---|
| **Hosted** (GitHub/GitLab URL) | Yes — register at `search.brave.com/goggles/create` | Pass raw file URL in `goggles=` parameter |
| **Inline rules** | No | Pass URL-encoded rules in `goggles=` parameter |

**For agentic workflows:** Use inline Goggles. No registration, no setup, dynamic per-query control.

### Rule Syntax

#### Action Tokens

| Token | Values | Effect |
|---|---|---|
| `$boost=N` | N = 1–10 | Promote matching results up the ranking |
| `$downrank=N` | N = 1–10 | Demote matching results down the ranking |
| `$discard` | (no value) | Remove matching results entirely |

#### Scope Tokens

| Token | Example | Effect |
|---|---|---|
| `site=` | `site=docs.python.org` | Apply rule to domain and subdomains |
| `/path/` | `/docs/` | Apply rule to specific URL path patterns |

#### Rule Composition

- **Comma separation:** Multiple tokens on one rule: `$boost=5,site=docs.rs`
- **Newline separation:** Multiple distinct rules: `$discard\n$site=docs.python.org`
  - URL-encode `\n` as `%0A` in GET requests

### Common Patterns

```
# Allow-list: only these domains
$discard\n$site=docs.python.org\n$site=peps.python.org

# Block-list: exclude these domains
$discard,site=pinterest.com\n$discard,site=quora.com

# Path boost: promote /docs/ on any domain
/docs/$boost=5\n/blog/$downrank=3

# RAG quality: only official docs, no paywalls
$discard\n$site=docs.rust-lang.org\n$site=doc.rust-lang.org\n$discard,site=medium.com

# Academic sources only
$discard\n$site=arxiv.org\n$site=.edu\n$site=ncbi.nlm.nih.gov
```

### Hosted Goggle File Format

```
! name: My Goggle
! description: What it does
! author: username

# Rules below
$discard,site=pinterest.com
$boost=5,site=github.com
```

### Detecting Goggle Application

The `web.mutated_by_goggles: boolean` field in the response confirms whether a Goggle modified the result order.

### Goggles for enterprise-knowledge-mcp context routing

**This is the key integration point for Phase 2 of our project:**

When an agent is working within an enterprise knowledge context (SharePoint + Confluence), we can use Goggles to:
1. Block SEO-spam and low-quality aggregators that might dilute enterprise-relevant results
2. Boost authoritative external sources for the enterprise's domain (e.g., `$boost=5,site=docs.microsoft.com` for an M365 shop)
3. Create per-tenant domain allowlists for sensitive queries

```typescript
// Generate Goggles dynamically based on enterprise context
function buildEnterpriseGoggles(
  tenant: TenantConfig,
  query: AgentQuery
): string {
  const rules: string[] = [];
  
  // Block known low-quality aggregators
  rules.push('$discard,site=pinterest.com');
  rules.push('$discard,site=quora.com');
  
  // Boost tenant's preferred vendor docs
  for (const domain of tenant.preferredDomains ?? []) {
    rules.push(`$boost=8,site=${domain}`);
  }
  
  // If query is security-sensitive, allowlist only trusted sources
  if (query.securityLevel === 'high') {
    rules.push('$discard');
    for (const domain of tenant.trustedDomains) {
      rules.push(`$site=${domain}`);
    }
  }
  
  return rules.join('\n');
}
```

---

## Response Schemas

### Common Fields Across Endpoints

Every response includes a `query` object and a `type` discriminator:

```typescript
interface CommonQueryMeta {
  original: string;
  altered?: string;            // spellcheck-corrected
  cleaned?: string;            // normalised
  spellcheck_off?: boolean;
  show_strict_warning?: boolean;
  search_operators?: {
    applied: boolean;
    cleaned_query?: string;
    sites?: string[];
  };
}
```

### Schema.org Typed Sub-Objects on Web Results

These appear on `WebResult` objects when the indexed page carries structured markup. All are optional:

| Field | Content |
|---|---|
| `product` | Product info and reviews |
| `recipe` | Ingredients, time, ratings |
| `article` | Author, publisher, date |
| `book` | Author, ISBN, rating |
| `software` | Software product info |
| `rating` | Aggregate ratings |
| `faq` | FAQ found on the page |
| `movie` | Directors, actors, genre |
| `video` | Duration, views, creator |
| `location` | Location/restaurant details |
| `qa` | Question/answer pair |
| `creative_work` | Creative work metadata |
| `music_recording` | Music/song data |
| `organization` | Organisation info |
| `review` | Review data |

---

## Search Operators

Set `operators=false` to disable all operator parsing.

| Operator | Syntax | Effect |
|---|---|---|
| Site | `site:example.com` | Limit to specific domain |
| File extension | `ext:pdf` | Match specific file extension |
| File type | `filetype:pdf` | Match specific file type |
| In title | `intitle:python` | Term must appear in page title |
| In body | `inbody:tutorial` | Term must appear in body text |
| In page | `inpage:guide` | Term must appear in title or body |
| Language | `lang:es` | Pages in specific language (ISO 639-1) |
| Location | `loc:us` | Pages from specific country (ISO 3166-1 alpha-2) |
| Include | `+term` | Force inclusion of a term |
| Exclude | `-term` | Exclude pages with the term |
| Exact match | `"exact phrase"` | Match phrase verbatim |
| AND | `term1 AND term2` | Both terms required (**must be uppercase**) |
| OR / NOT | `term1 OR term2`, `NOT term` | Logical operators (**must be uppercase**) |

**Agent use:** Operators can be injected programmatically to implement "search within" features. For example, if an agent tool receives `site:example.com` as a parameter, append it to the query string and leave `operators=true` (the default).

---

## Result Freshness

### How Brave Crawls

- Brave maintains a proprietary crawler (Brave Search Bot / Brave Bot)
- 100+ million page updates per day across the 30+ billion page index
- Web Discovery Project (opt-in from Brave browser users) supplements with real-world browse frequency signals — pages that real users actually visit get recrawled more aggressively

### Freshness in Responses

Three fields carry temporal metadata on results:

| Field | Type | Semantics |
|---|---|---|
| `age` | string | Human-readable relative: "2 days ago", "3 months ago" |
| `page_age` | string | ISO-8601 datetime: "2026-04-12T14:22:41" — publication timestamp from source |
| `fetched_content_timestamp` | int | Unix timestamp of Brave's last crawl of this page (requires `include_fetch_metadata=true`) |

Use `fetched_content_timestamp` to compute staleness:

```typescript
function isStale(result: WebResult, maxAgeHours = 24): boolean {
  if (!result.fetched_content_timestamp) return false; // unknown
  const ageMs = Date.now() - result.fetched_content_timestamp * 1000;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}
```

### Breaking News Freshness

For breaking news and real-time topics:
1. Use `/res/v1/news/search` with `freshness=pd` (past 24 hours)
2. Combine with `extra_snippets=true` for richer article context
3. Merge news results with `/res/v1/web/search` results for background context
4. The `breaking` field on `NewsResult` objects (when present) is `true` for actively developing stories

---

## Privacy and Data Handling

Sources: brave.com privacy stance, Enterprise ZDR documentation

### Core Privacy Position

Brave Search does not build user profiles for advertising. The Search API:
- Does not associate queries with individual end-users
- Does not track query history across sessions
- Does not use query data for ad targeting

### What Brave Logs per Query (Standard Plan)

Brave's standard terms do permit them to process query data for service operation, quality improvement, and abuse prevention. The exact retention period is not publicly specified in the standard plan.

### Zero Data Retention (ZDR) — Enterprise Only

The Enterprise plan includes **Full-funnel Zero Data Retention**:
- Query data is not retained after the response is returned
- Covers the entire pipeline: query ingestion, search execution, result generation
- Requires a custom agreement with Brave
- Relevant for: legal, healthcare, financial services, or any tenant whose prompts/queries contain regulated data

For the enterprise-knowledge-mcp project, **ZDR is a procurement requirement** when handling queries that might contain PII, trade secrets, or regulated information. Budget for an Enterprise plan negotiation when selling into regulated industries.

### GDPR Stance

Brave is a US company (Brave Software, Inc., San Francisco). The Search API's data processing terms are governed by US law by default. For EU enterprise customers:
- Request a Data Processing Agreement (DPA) as part of enterprise contract negotiation
- The EU GDPR Article 28 DPA requirement applies if query data might contain personal data
- Brave's privacy-first brand is a selling point in EU procurement — lean on it

### Comparison: What Google and Bing Log

| Provider | Query Logging | Ad Profiling | ZDR Available |
|---|---|---|---|
| Brave Search API | Limited (service operation) | No | Enterprise (paid) |
| Google Custom Search | Yes (Google account telemetry) | Possible | No (not offered) |
| Bing Web Search | Yes (Microsoft account telemetry) | Possible | Enterprise agreement |

---

## Brave vs. Competitors

### Brave vs. Google Custom Search API

| Dimension | Brave Search API | Google Custom Search API |
|---|---|---|
| Index | Independent (30B+ pages) | Google index |
| Price | $5 / 1,000 requests | $5 / 1,000 requests (identical) |
| Free tier | $5 credits/month | 100 queries/day (~3,000/month) |
| Rate limit | 50 QPS | 100 queries/day without paid plan |
| Result bias | None | Ad-informed ranking |
| Custom ranking | Goggles (inline, no setup) | Programmable Search Engine (setup required) |
| LLM-optimised endpoint | `/llm/context`, `/chat/completions` | None native |
| Privacy | No ad profiling | Google data processing terms |
| Structured entity data | Infobox in web search | Knowledge Graph API (separate, additional cost) |
| Local/POI data | Built-in, two-step flow | Google Maps API (separate, higher cost) |
| News endpoint | Yes | No (separate Google News feed) |
| Image search | Yes (up to 200/req) | Yes |
| Goggles/custom ranking | Yes, inline or hosted | Limited (blocked/allowed sites in engine config) |

**Verdict:** Brave is better than Google CSE for AI agent use. The LLM-specific endpoints, Goggles, and independent index make it architecturally superior for our use case. The price is identical.

### Brave vs. Bing Web Search API

| Dimension | Brave Search API | Bing Web Search API |
|---|---|---|
| Index | Independent | Microsoft's Bing index |
| Price | $5 / 1,000 requests | $7–$15 / 1,000 depending on tier |
| Rate limit | 50 QPS | 3 TPS (Transaction per Second) — much lower |
| LLM endpoint | `/llm/context`, `/chat/completions` | Bing Grounding API (Azure OpenAI integration) |
| Freshness signals | 100M+ updates/day | Comparable |
| Privacy | No ad profiling | Microsoft data processing terms |
| Search operators | Yes (full set) | Yes |
| Goggles | Yes | No equivalent |
| Local/Places | Built-in (Search plan) | Bing Local Search (separate endpoint/pricing) |

Brave is **cheaper than Bing** and has significantly better rate limits (50 QPS vs. 3 TPS). Bing's advantage is the Azure ecosystem integration for teams already on Microsoft infrastructure.

Brave was cited as "the fastest growing search engine since Bing" with 8+ billion annualized searches as of 2023 — now with 700,000+ OpenClaw users on the API alone.

### Brave vs. Tavily

| Dimension | Brave Search API | Tavily |
|---|---|---|
| Index | Own index (30B+ pages) | Crawl-on-demand + aggregated |
| Price | $5 / 1,000 requests | $5–$15 / 1,000 depending on plan |
| Agent-optimised endpoint | `/llm/context` | Native agent/RAG mode |
| Answer generation | `/chat/completions` | Built-in answer extraction |
| Freshness | 100M+ updates/day (pre-indexed) | Live crawl on demand |
| Rate limit | 50 QPS | Plan-dependent (typically lower) |
| Goggles/Custom ranking | Yes | No equivalent |
| Privacy | No profiling | Standard SaaS terms |

Tavily's crawl-on-demand model can be fresher for very recently published content (minutes old) but is slower and more expensive at scale. Brave's pre-indexed approach is faster and cheaper for the vast majority of queries. For the MCP server, implement **both** as provider options and select based on query type (Brave for general search, Tavily/fetch-direct for very fresh or private URLs).

---

## Implementation Patterns

### Pattern 1: Basic Agent Search Tool (Web Search)

The fundamental building block — a TypeScript tool definition compatible with any MCP server or LLM tool-calling interface.

```typescript
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const braveSearchTool: Tool = {
  name: 'brave_search',
  description:
    'Search the web using Brave Search. Returns up to 20 ranked results with titles, URLs, and snippets. Use for current events, factual queries, and finding web sources.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results (1-20)', default: 10 },
      freshness: {
        type: 'string',
        enum: ['pd', 'pw', 'pm', 'py'],
        description: 'Time filter: pd=24h, pw=7d, pm=31d, py=1y',
      },
      country: { type: 'string', description: 'ISO 2-letter country code', default: 'US' },
    },
    required: ['query'],
  },
};

async function braveWebSearch(
  query: string,
  options: {
    count?: number;
    freshness?: string;
    country?: string;
    extraSnippets?: boolean;
    goggles?: string;
  } = {}
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(options.count ?? 10),
    country: options.country ?? 'US',
    extra_snippets: String(options.extraSnippets ?? false),
    text_decorations: 'false', // strip <strong> tags for agent consumption
  });

  if (options.freshness) params.set('freshness', options.freshness);
  if (options.goggles) params.set('goggles', options.goggles);

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY!,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return normalizeWebResults(data.web?.results ?? []);
}
```

### Pattern 2: LLM Context for RAG

Use `/llm/context` when you want pre-extracted content ready for a prompt — not ranked links.

```typescript
interface GroundingSnippet {
  url: string;
  title: string;
  hostname: string;
  age?: string;
  snippets: string[];
}

async function braveGetGrounding(
  query: string,
  options: {
    maxTokens?: number;
    maxUrls?: number;
    thresholdMode?: 'strict' | 'balanced' | 'lenient';
    goggles?: string;
  } = {}
): Promise<GroundingSnippet[]> {
  const params = new URLSearchParams({
    q: query,
    maximum_number_of_tokens: String(options.maxTokens ?? 8192),
    maximum_number_of_urls: String(options.maxUrls ?? 10),
    context_threshold_mode: options.thresholdMode ?? 'balanced',
  });

  if (options.goggles) params.set('goggles', options.goggles);

  const response = await fetch(
    `https://api.search.brave.com/res/v1/llm/context?${params}`,
    {
      headers: {
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY!,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    throw new Error(`Brave LLM Context error: ${response.status}`);
  }

  const data = await response.json();

  return data.grounding.generic.map((item: any) => ({
    url: item.url,
    title: item.title,
    hostname: data.sources[item.url]?.hostname ?? new URL(item.url).hostname,
    age: data.sources[item.url]?.age?.[0],
    snippets: item.snippets,
  }));
}

// Build a prompt-ready context block from grounding snippets
function buildContextBlock(snippets: GroundingSnippet[]): string {
  return snippets
    .map((s, i) =>
      `[Source ${i + 1}: ${s.title}]\nURL: ${s.url}\n${s.snippets.join('\n')}`
    )
    .join('\n\n---\n\n');
}
```

### Pattern 3: Combining Search + Fetch

For the markdown-for-agents-mcp architecture, the best agent experience combines Brave search for discovery with direct page fetching for full content:

```typescript
async function searchAndFetch(
  query: string,
  fetchTopN = 3
): Promise<AgentSearchResult> {
  // Step 1: Get ranked results from Brave
  const searchResults = await braveWebSearch(query, {
    count: 10,
    extraSnippets: true,
  });

  // Step 2: For top N results, fetch full page content
  const topUrls = searchResults.slice(0, fetchTopN).map(r => r.url);
  const pageContents = await Promise.allSettled(
    topUrls.map(url => fetchMarkdown(url)) // your existing fetch pipeline
  );

  // Step 3: Merge search snippets with full page content
  return {
    searchResults: searchResults.slice(fetchTopN), // remaining as references
    groundedContent: pageContents
      .filter(r => r.status === 'fulfilled')
      .map((r, i) => ({
        url: topUrls[i],
        title: searchResults[i].title,
        fullContent: (r as PromiseFulfilledResult<string>).value,
        snippets: searchResults[i].extraSnippets,
      })),
  };
}
```

**When to prefer LLM Context over this pattern:**
- When you don't need the full page, just key excerpts
- When latency budget is tight (LLM Context is a single API call)
- When Brave's extraction quality is sufficient for the query type

**When to prefer search + fetch:**
- When you need the most recent version of a page (Brave's cache may be hours old)
- When you need content that requires JavaScript rendering
- When the page has important content not captured in Brave's extraction

### Pattern 4: News Monitoring Tool

```typescript
export const braveNewsTool: Tool = {
  name: 'brave_news',
  description: 'Search recent news articles. Best for current events, breaking news, and topics where recency matters.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      freshness: {
        type: 'string',
        enum: ['pd', 'pw', 'pm'],
        default: 'pw',
        description: 'pd=24h, pw=7d, pm=31d',
      },
      count: { type: 'number', default: 10, maximum: 50 },
    },
    required: ['query'],
  },
};

async function braveNewsSearch(
  query: string,
  freshness: string = 'pw',
  count = 10
): Promise<NewsArticle[]> {
  const params = new URLSearchParams({
    q: query,
    freshness,
    count: String(count),
    extra_snippets: 'true',
    safesearch: 'moderate',
  });

  const response = await fetch(
    `https://api.search.brave.com/res/v1/news/search?${params}`,
    {
      headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY! },
      signal: AbortSignal.timeout(10_000),
    }
  );

  const data = await response.json();
  return (data.results ?? []).map((r: any): NewsArticle => ({
    title: r.title,
    url: r.url,
    description: r.description,
    publishedAt: r.page_age,
    age: r.age,
    breaking: r.breaking ?? false,
    snippets: r.extra_snippets ?? [],
  }));
}
```

### Pattern 5: Goggles-Powered Domain Filtering

```typescript
// Inline Goggles for quality filtering in agent pipelines
const QUALITY_FILTER_GOGGLES = {
  // Block common low-value aggregators
  noAggregators: [
    '$discard,site=pinterest.com',
    '$discard,site=quora.com',
    '$discard,site=answers.yahoo.com',
    '$discard,site=ask.com',
  ].join('\n'),

  // Technical documentation only
  techDocsOnly: [
    '$discard',
    '$site=docs.python.org',
    '$site=developer.mozilla.org',
    '$site=docs.microsoft.com',
    '$site=docs.aws.amazon.com',
    '$site=docs.github.com',
    '$site=pkg.go.dev',
    '$site=docs.rs',
  ].join('\n'),

  // Academic/research sources
  academic: [
    '$discard',
    '$site=arxiv.org',
    '$site=scholar.google.com',
    '$site=pubmed.ncbi.nlm.nih.gov',
    '$site=ssrn.com',
    '$site=.edu',
  ].join('\n'),

  // News only, no content farms
  qualityNews: [
    '$discard,site=contentfarm.com',
    '$boost=5,site=reuters.com',
    '$boost=5,site=apnews.com',
    '$boost=5,site=bbc.com',
    '$boost=3,site=ft.com',
  ].join('\n'),
};

async function searchWithQualityFilter(
  query: string,
  filterType: keyof typeof QUALITY_FILTER_GOGGLES
): Promise<SearchResult[]> {
  return braveWebSearch(query, {
    goggles: QUALITY_FILTER_GOGGLES[filterType],
    extraSnippets: true,
  });
}
```

### Pattern 6: Rate Limit Handling and Retry

```typescript
class BraveSearchClient {
  private rateLimitRemaining = 50;
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  async search(query: string, options = {}): Promise<SearchResult[]> {
    return this.withRateLimit(() => this._search(query, options));
  }

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    // Parse rate limit from last response
    if (this.rateLimitRemaining < 5) {
      await new Promise(resolve => setTimeout(resolve, 200)); // back off
    }
    return fn();
  }

  private async _search(query: string, options: any): Promise<SearchResult[]> {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await fetch(/* ... */);

      // Update rate limit state
      const remaining = response.headers.get('X-RateLimit-Remaining');
      if (remaining) this.rateLimitRemaining = parseInt(remaining, 10);

      if (response.status === 429) {
        // Rate limited — exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        if (attempt === maxRetries) throw new Error(`Brave API error: ${response.status}`);
        continue;
      }

      const data = await response.json();
      return normalizeWebResults(data.web?.results ?? []);
    }

    throw new Error('Brave Search: max retries exceeded');
  }
}
```

### Pattern 7: Answers/Chat with OpenAI SDK

```typescript
import OpenAI from 'openai';

const braveAnswers = new OpenAI({
  baseURL: 'https://api.search.brave.com/res/v1',
  apiKey: process.env.BRAVE_ANSWERS_API_KEY!, // separate key for Answers plan
  timeout: 300_000, // 5 minutes for research mode
});

async function groundedAnswer(question: string): Promise<string> {
  const stream = await braveAnswers.chat.completions.create({
    model: 'brave',
    stream: true,
    messages: [{ role: 'user', content: question }],
    // @ts-expect-error - Brave extensions not in OpenAI types
    enable_citations: true,
  } as any);

  let answer = '';
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content ?? '';
    // Filter out tag markers, collect answer text
    if (!content.startsWith('<') && !content.endsWith('>')) {
      answer += content;
    }
  }
  return answer;
}

async function researchAnswer(
  question: string,
  onProgress?: (stats: object) => void
): Promise<string> {
  const stream = await braveAnswers.chat.completions.create({
    model: 'brave',
    stream: true, // REQUIRED for research mode
    messages: [{ role: 'user', content: question }],
    // @ts-expect-error
    enable_research: true,
    research_maximum_number_of_iterations: 4,
    research_maximum_number_of_seconds: 120,
  } as any);

  let answer = '';
  let inAnswer = false;
  let usageData: object | null = null;

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content ?? '';

    // Parse research mode streaming tags
    if (content.includes('<answer>')) {
      inAnswer = true;
    } else if (content.includes('</answer>')) {
      inAnswer = false;
    } else if (content.includes('<progress>')) {
      // Parse progress statistics
      const progressMatch = content.match(/<progress>(.*?)<\/progress>/s);
      if (progressMatch && onProgress) {
        try { onProgress(JSON.parse(progressMatch[1])); } catch {}
      }
    } else if (content.includes('<usage>')) {
      const usageMatch = content.match(/<usage>(.*?)<\/usage>/s);
      if (usageMatch) {
        try { usageData = JSON.parse(usageMatch[1]); } catch {}
      }
    } else if (inAnswer) {
      answer += content;
    }
  }

  if (usageData) {
    console.debug('Brave Answers cost:', usageData);
  }

  return answer;
}
```

---

## Normalisation Schema

To make Brave interchangeable with other providers in the MCP server, normalise all responses to a common schema:

```typescript
// Common search result schema used throughout markdown-for-agents-mcp
export interface NormalisedSearchResult {
  provider: 'brave' | 'tavily' | 'google' | 'bing';
  type: 'web' | 'news' | 'image' | 'video' | 'discussion' | 'faq';
  title: string;
  url: string;
  snippet: string;             // primary description/excerpt
  extraSnippets?: string[];    // additional excerpts (Brave extra_snippets)
  publishedAt?: string;        // ISO-8601 if known
  crawledAt?: number;          // Unix timestamp if known
  language?: string;
  thumbnail?: string;          // CDN-hosted preview image URL
  profile?: {                  // publisher identity
    name: string;
    domain: string;
  };
  confidence?: 'high' | 'medium' | 'low';  // for image results
  structured?: {               // schema.org data when present
    type: string;              // 'product', 'recipe', 'article', etc.
    data: Record<string, unknown>;
  };
  sourceMetadata: {
    engine: string;            // e.g., "Brave Search v1"
    queryId?: string;
    relevanceScore?: number;
  };
}

// Normalisation function for Brave web results
export function normaliseBraveWebResult(
  raw: WebResult,
  queryId?: string
): NormalisedSearchResult {
  const structured = detectStructuredType(raw);
  
  return {
    provider: 'brave',
    type: 'web',
    title: raw.title,
    url: raw.url,
    snippet: raw.description ?? '',
    extraSnippets: raw.extra_snippets,
    publishedAt: raw.page_age,
    crawledAt: raw.fetched_content_timestamp,
    language: raw.language,
    thumbnail: raw.thumbnail?.src,
    profile: raw.profile
      ? { name: raw.profile.name, domain: raw.profile.long_name }
      : undefined,
    structured,
    sourceMetadata: {
      engine: 'Brave Search v1',
      queryId,
    },
  };
}

function detectStructuredType(raw: WebResult): NormalisedSearchResult['structured'] {
  for (const schemaType of [
    'product', 'recipe', 'article', 'book', 'software',
    'movie', 'video', 'location', 'organization', 'review'
  ] as const) {
    if (raw[schemaType]) {
      return { type: schemaType, data: raw[schemaType] as Record<string, unknown> };
    }
  }
  return undefined;
}
```

---

## TypeScript Code Examples

### Complete MCP Tool Handler

```typescript
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function handleBraveSearch(
  params: { query: string; count?: number; freshness?: string; type?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  
  const { query, count = 10, freshness, type = 'web' } = params;

  try {
    let results: NormalisedSearchResult[];

    switch (type) {
      case 'news':
        const newsData = await braveNewsSearch(query, freshness ?? 'pw', count);
        results = newsData.map(n => ({
          provider: 'brave' as const,
          type: 'news' as const,
          title: n.title,
          url: n.url,
          snippet: n.description ?? '',
          extraSnippets: n.snippets,
          publishedAt: n.publishedAt,
          sourceMetadata: { engine: 'Brave News Search v1' },
        }));
        break;

      case 'web':
      default:
        const webData = await braveWebSearch(query, { count, freshness, extraSnippets: true });
        results = webData.map(r => normaliseBraveWebResult(r));
    }

    // Format for agent consumption — avoid raw JSON in the response
    const formatted = results
      .map((r, i) => [
        `[${i + 1}] ${r.title}`,
        `URL: ${r.url}`,
        r.publishedAt ? `Date: ${r.publishedAt}` : null,
        r.snippet,
        r.extraSnippets?.length
          ? `Additional context:\n${r.extraSnippets.map(s => `  - ${s}`).join('\n')}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'))
      .join('\n\n');

    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
    };
  }
}
```

### Caching Layer

Brave queries are deterministic for a given query + parameters. Cache aggressively:

```typescript
import { createHash } from 'crypto';

class BraveSearchCache {
  private cache = new Map<string, { result: any; expiresAt: number }>();
  
  // TTL by result type
  private TTL = {
    web: 30 * 60 * 1000,        // 30 minutes
    news: 5 * 60 * 1000,         // 5 minutes (news is time-sensitive)
    images: 60 * 60 * 1000,      // 1 hour
    videos: 60 * 60 * 1000,      // 1 hour
    llmContext: 30 * 60 * 1000,  // 30 minutes
  };

  cacheKey(endpoint: string, params: Record<string, string>): string {
    const canonical = JSON.stringify({
      endpoint,
      params: Object.fromEntries(Object.entries(params).sort()),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: any, type: keyof typeof this.TTL): void {
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.TTL[type],
    });
  }

  // Evict stale entries periodically
  evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) this.cache.delete(key);
    }
  }
}
```

---

## Limitations, Failure Modes, and Gotchas

### Pagination Hard Limit

**Gotcha:** Maximum 200 results total from web search (20 results × 10 pages). For topics requiring broader coverage, you must either use more specific queries or accept the limit. There is no cursor-based pagination.

### `count` Maximum is 20 for Web Search

The web search endpoint caps at `count=20` per request. Image search allows up to 200 per request — but web/news/videos are all limited to 50 per request. Always check `query.more_results_available` before assuming you have everything.

### Safesearch Inconsistencies

- `/web/search`: default `moderate`
- `/images/search`: default `strict`, **only** `off`/`strict` valid (no `moderate`)
- `/news/search`: default `strict`
- `/videos/search`: default `moderate`

Normalise safesearch across endpoints in your abstraction layer to avoid unexpected filtering differences.

### Rich Data Callback Polling Not Required

The `/res/v1/web/rich` endpoint is a **one-shot call**, not a polling endpoint. You get the `callback_key` in the initial response, make one follow-up call, and that is it. There is no polling loop.

### Research Mode Timeout Risks

Answers research mode can take up to 300 seconds. In a synchronous request handler (e.g., MCP tool call), this blocks the entire connection. Always:
- Set client timeouts to ≥300 seconds for research mode
- Stream the response and emit progress events to the client
- Implement a user-facing "thinking" indicator using `<progress>` tag data

### Goggles Do Not Add Results

Goggles work within the existing ranked set. If your allow-list is too narrow and no results survive discarding, you get an empty response — not a fallback to unfiltered results. Always test Goggles with representative queries before deploying.

### POI ID Expiry

Local POI IDs expire after approximately 8 hours. Do not:
- Store them in a database for later lookup
- Cache them across user sessions
- Use them after a long-running pipeline delay

Always fetch fresh POI IDs at the start of each local search flow.

### `=` in POI IDs

POI IDs are base64-like strings that may contain `=` characters. Always URL-encode them:

```typescript
// Wrong — will break
const url = `/res/v1/local/pois?ids=${poiId}`;

// Correct
const params = new URLSearchParams();
poiIds.forEach(id => params.append('ids', id));
const url = `/res/v1/local/pois?${params}`;
```

### Snippet Text May Contain JSON

In `/llm/context` responses, `grounding.generic[].snippets` entries may be either plain text or JSON-serialised structured data (tables as JSON arrays, code blocks). Do not assume they are always plain text — pass them to the LLM as-is.

### Image Dimensions May Be Null

`properties.width` and `properties.height` on image results can be null. Do not assume dimensions are always present — check before using them.

### The `text_decorations` Parameter

By default, Brave wraps matched terms in `<strong>` HTML tags in snippets. For agent consumption, set `text_decorations=false` to get clean plaintext:

```typescript
params.set('text_decorations', 'false');
```

### `AND`, `OR`, `NOT` Operators Must Be Uppercase

The search operators `AND`, `OR`, and `NOT` are case-sensitive. Lowercase `and`/`or`/`not` are treated as regular search terms, not logical operators. This is a common gotcha when programmatically building queries.

### Rate Limit Header Parsing

The `X-RateLimit-Remaining` header uses a sliding window. Do not interpret "remaining: 0" as "wait until the next minute" — the window is rolling, so wait a fraction of a second and the count will refresh.

### Independent Index Gaps

Brave's index is independent but smaller than Google's and Bing's combined coverage. For:
- Very niche academic papers (use Tavily or direct fetch from arXiv)
- Deep-web content that is not publicly crawlable (no solution on any search API)
- Pages published in the last few minutes (use direct fetch)

For the vast majority of agent queries, the gap is irrelevant.

### No JavaScript Rendering

Brave's crawler does not execute JavaScript. Pages that require JavaScript to render content (SPAs, dynamic dashboards) may have limited or no indexed content. Use the direct fetch pipeline (with Puppeteer/Playwright) for JS-rendered pages.

---

## What to Build vs. What to Skip

### Build These

**Priority 1 — Core agent tools:**
1. `brave_search` tool — web search with Goggles support and extra_snippets enabled by default
2. `brave_news` tool — news search with freshness parameter exposed
3. `brave_llm_context` tool — RAG-optimised context retrieval with token budget control

**Priority 2 — Enhanced retrieval:**
4. `brave_images` tool — for visual queries and product identification
5. `brave_suggest` tool (rich=true) — for query expansion and autocomplete in multi-turn agents

**Priority 3 — Advanced:**
6. Rich data callback integration — for calculators, weather, stocks, currency, sports
7. Local POI two-step flow — for location-aware queries
8. Goggles presets library — maintain a registry of quality-filtered Goggles for common use cases (tech docs, academic, news quality)

### Skip These (At Least Initially)

- **Answers/Chat Completions (`/chat/completions`)** — requires a separate Answers plan subscription. The 2 QPS rate limit makes it unsuitable for high-throughput use. Implement it only if you need one-shot grounded answers without building your own orchestration. For our use case, the combination of `/llm/context` + our own LLM is superior (cheaper, more controllable, faster).

- **Research mode** — 30–300 second latency is incompatible with synchronous tool calls. If needed, implement as an async job with polling, not a blocking tool.

- **Videos search** — low priority for the enterprise knowledge index use case. Add when there is explicit demand.

- **Spellcheck as a standalone call** — the suggest endpoint handles typos implicitly. Only add a dedicated spellcheck preprocessing step if you observe significant recall degradation from noisy queries in production.

- **Building your own Goggles file registry** — use inline Goggles for dynamic per-query rules. Only build a hosted Goggles registry if you need to share Goggles across teams or expose them as user-configurable presets.

### Feature Parity Table with Key Competitors

| Feature | Build It | How |
|---|---|---|
| Web retrieval | Yes | `/res/v1/web/search` |
| RAG-ready context | Yes | `/res/v1/llm/context` |
| Breaking news | Yes | `/res/v1/news/search` with `freshness=pd` |
| Source filtering | Yes | Inline Goggles |
| Domain allow/block | Yes | Goggles patterns (allowlist/blocklist) |
| Extra snippets | Yes | `extra_snippets=true` parameter |
| Freshness control | Yes | `freshness` parameter |
| Location-aware search | Later | Two-step POI flow |
| Image search | Later | `/res/v1/images/search` |
| Grounded answers | Skip for now | `/res/v1/chat/completions` |
| Spellcheck | Skip initially | Auto-handled by search endpoints |

---

## Sources

- [Brave Search API landing page](https://brave.com/search/api/) — pricing, plans, overview
- [DeepWiki: brave/brave-search-skills](https://deepwiki.com/brave/brave-search-skills) — indexed 2026-07-01, comprehensive API reference derived from official SKILL.md files
- [marketingscoop.com — Brave Search API in 2026](https://www.marketingscoop.com/developer/brave-search-api-in-2026-what-it-is-and-what-you-can-actually-build-with-it/) — practical guide
- [llmrefs.com — Brave Web Search API 2026 Integration Guide](https://llmrefs.com/blog/brave-web-search-api) — RAG and endpoint routing patterns
- [Brave Search API documentation dashboard](https://api-dashboard.search.brave.com/app/documentation/web-search/responses)
- [Brave Search API guides](https://brave.com/search/api/guides/) — MCP, n8n, Dify, Open WebUI integration guides
