# Perplexity API — Deep Research & Competitive Intelligence

**Last updated:** 2026-08-26
**Sources:** https://docs.perplexity.ai, https://docs.perplexity.ai/llms.txt, per-model docs, pricing page, rate limits page, MCP server docs

---

## Table of Contents

1. [Platform Overview — What Perplexity Is Now](#1-platform-overview)
2. [The API Family](#2-the-api-family)
3. [Sonar API (Legacy) — All Models, Full Pricing](#3-sonar-api-legacy)
4. [Agent API — The Replacement](#4-agent-api)
5. [Search API — Raw Results](#5-search-api)
6. [Citations: Exact Format and Extraction](#6-citations-format)
7. [Search Filters: Domain, Recency, Date, Language](#7-search-filters)
8. [Streaming in Node.js/TypeScript](#8-streaming)
9. [Rate Limits and Usage Tiers](#9-rate-limits)
10. [MCP Server — Tools Exposed, Architecture](#10-mcp-server)
11. [Deep Research — How Multi-Step Works](#11-deep-research)
12. [Perplexity vs Tavily vs Exa vs Brave](#12-competitor-comparison)
13. [How Perplexity Builds Grounded Answers](#13-answer-synthesis-pipeline)
14. [Implementation Patterns for Our MCP Server](#14-implementation-patterns)
15. [Limitations, Failure Modes, Gotchas](#15-limitations)
16. [What to Build vs What to Skip](#16-build-recommendations)

---

## 1. Platform Overview

As of mid-2026, Perplexity has undergone a significant architectural shift. What started as a single "Sonar API" offering AI-grounded web search has expanded into a multi-product platform:

**The Sonar API is now classified as a "Legacy API"** with an explicit deprecation date of **September 27, 2026**. Perplexity recommends migrating all existing Sonar usage to the new Agent API.

What Perplexity has become: a multi-provider AI gateway that competes with LiteLLM and Portkey, but with Perplexity's proprietary real-time web search wired in as a first-class built-in tool. They host and route requests to OpenAI, Anthropic, Google, xAI, DeepSeek, NVIDIA, and others — all through one endpoint with one API key.

This is important context: the research question "should we implement Perplexity-style grounded search?" has shifted. You're no longer just evaluating Sonar models — you're evaluating whether to use Perplexity as:

- A gateway for frontier models (Router/Agent API)
- A search tool for your own agents (Search API or web_search tool)
- A grounded Q&A endpoint (Sonar models, now legacy, or Agent API presets)

Source: https://docs.perplexity.ai

---

## 2. The API Family

Four distinct products with different pricing models:

| API | Endpoint | What It Does | Pricing Unit |
|-----|----------|--------------|--------------|
| **Agent API** | `POST /v1/agent` | LLM + optional web search + tools | Per token + per tool call |
| **Search API** | `POST /search` | Raw ranked web results | $5 per 1K requests |
| **Router API** | `POST /v1/...` (OpenAI-compatible) | Route to hosted open-source models | Per token (no search) |
| **Embeddings API** | Embeddings endpoint | Dense/contextualized embeddings | Per token |
| **Sonar API** (legacy) | `POST /v1/sonar` | Grounded chat completions | Per token + per request |

### Which to use for what

- **You want an AI answer with citations from the web:** Sonar API (until Sep 2026) or Agent API with a preset
- **You want raw search results to feed your own LLM:** Search API
- **You want to route to Claude/GPT/Gemini through one key:** Router or Agent API
- **You want Perplexity as a tool inside Claude or GPT:** MCP server or Search API as a function tool

Source: https://docs.perplexity.ai/docs/getting-started/overview.md

---

## 3. Sonar API (Legacy)

> **Deprecation notice:** Sonar Chat Completions will be supported until **September 27, 2026**. Migration guide at https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview

The Sonar API uses the OpenAI Chat Completions format with Perplexity-specific extensions. Endpoint: `https://api.perplexity.ai/v1/sonar`.

### 3.1 All Models

#### sonar

| Property | Value |
|----------|-------|
| Model ID | `sonar` |
| Type | Non-reasoning search model |
| Context Length | 128K tokens |
| Best For | Quick factual queries, topic summaries, product comparisons, current events |
| NOT For | Multi-step analyses, exhaustive research, complex reasoning |
| Input Price | $1 / 1M tokens |
| Output Price | $1 / 1M tokens |
| Request Fee (Low context) | $5 / 1K requests |
| Request Fee (Medium context) | $8 / 1K requests |
| Request Fee (High context) | $12 / 1K requests |

"Lightweight, cost-effective search model optimized for quick, grounded answers with real-time web search."

#### sonar-pro

| Property | Value |
|----------|-------|
| Model ID | `sonar-pro` |
| Type | Non-reasoning advanced search model |
| Context Length | 200K tokens |
| Best For | Complex queries, multi-step Q&A, follow-ups, deeper content understanding |
| NOT For | Exhaustive research across hundreds of sources |
| Input Price | $3 / 1M tokens |
| Output Price | $15 / 1M tokens |
| Request Fee (Low context) | $6 / 1K requests |
| Request Fee (Medium context) | $10 / 1K requests |
| Request Fee (High context) | $14 / 1K requests |

Key differentiator: "2x more search results than standard Sonar." 200K context is notably larger than base Sonar.

#### sonar-reasoning-pro

| Property | Value |
|----------|-------|
| Model ID | `sonar-reasoning-pro` |
| Type | Advanced reasoning with Chain-of-Thought (CoT) |
| Context Length | 128K tokens |
| Best For | Complex analyses requiring step-by-step thinking, strict instruction following, logical problem-solving |
| NOT For | Simple factual queries, basic retrieval, exhaustive research (use sonar-deep-research instead) |
| Input Price | $2 / 1M tokens |
| Output Price | $8 / 1M tokens |
| Request Fee (Low context) | $6 / 1K requests |
| Request Fee (Medium context) | $10 / 1K requests |
| Request Fee (High context) | $14 / 1K requests |

**Important:** `sonar-reasoning` (the non-pro variant) was **deprecated on December 15, 2025**. Use `sonar-reasoning-pro` only.

**Gotcha:** Using image input with structured outputs is not supported in thinking models (including `sonar-reasoning-pro`).

#### sonar-deep-research

| Property | Value |
|----------|-------|
| Model ID | `sonar-deep-research` |
| Type | Deep research / reasoning model |
| Context Length | 128K tokens |
| Best For | Academic reports, market analysis, competitive intelligence, due diligence, literature reviews |
| NOT For | Quick queries, latency-sensitive tasks |
| Input Price | $2 / 1M tokens |
| Output Price | $8 / 1M tokens |
| Citation Tokens | $2 / 1M tokens |
| Reasoning Tokens | $3 / 1M tokens |
| Search Queries | $5 / 1K searches |

**Real-world cost example** from a complex quantum computing industry analysis request:

```json
"usage": {
  "prompt_tokens": 33,
  "completion_tokens": 11395,
  "total_tokens": 11428,
  "citation_tokens": 19028,
  "num_search_queries": 21,
  "reasoning_tokens": 193947,
  "cost": {
    "input_tokens_cost": 0.0,
    "output_tokens_cost": 0.091,
    "citation_tokens_cost": 0.038,
    "reasoning_tokens_cost": 0.582,
    "search_queries_cost": 0.105,
    "total_cost": 0.816
  }
}
```

A single deep research query on a broad topic cost $0.82 and issued 21 sub-searches with 193K reasoning tokens. Budget $0.50–$2.00 per deep research call depending on query breadth.

### 3.2 Sonar API Request Format

The Sonar API uses the OpenAI Chat Completions format with extensions:

```typescript
// TypeScript with OpenAI SDK (compatible)
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});

const response = await client.chat.completions.create({
  model: "sonar-pro",
  messages: [
    { role: "user", content: "What are the latest AI agent frameworks in 2026?" }
  ],
  // Perplexity-specific extensions:
  // @ts-ignore - not in OpenAI types
  search_domain_filter: ["github.com", "arxiv.org"],
  search_recency_filter: "month",
  return_images: false,
  return_related_questions: false,
  search_context_size: "medium",   // "low" | "medium" | "high"
  web_search_options: {
    search_context_size: "medium"
  }
});

console.log(response.choices[0].message.content);
// Citations are in response.citations (array of URLs)
// Full search results in response.search_results
```

### 3.3 Sonar API Extensions to OpenAI Format

Parameters beyond standard OpenAI Chat Completions:

| Parameter | Type | Description |
|-----------|------|-------------|
| `search_domain_filter` | `string[]` | Allowlist/denylist domains (max 20) |
| `search_recency_filter` | `"hour" \| "day" \| "week" \| "month" \| "year"` | Freshness filter |
| `search_context_size` | `"low" \| "medium" \| "high"` | How much web content to retrieve (affects cost/quality) |
| `return_images` | `boolean` | Include image results (default false) |
| `return_related_questions` | `boolean` | Include follow-up questions (default false) |
| `web_search_options` | `object` | Nested object with search configuration |

The `search_context_size` parameter is the key cost lever: "low" is cheapest, "high" retrieves more context but costs more per request (see the tiered request fees above).

### 3.4 Async Sonar API

For deep research and long-running queries:

```
POST   /v1/async/sonar         # Submit async job
GET    /v1/async/sonar         # List jobs
GET    /v1/async/sonar/{id}    # Poll job status
```

Rate limits differ: deep-research async is 5 RPM (Tier 0) to 100 RPM (Tier 5), while the GET polling endpoint allows 6,000 RPM.

Source: https://docs.perplexity.ai/docs/sonar/models.md, individual model pages

---

## 4. Agent API

The Agent API is Perplexity's successor to Sonar, now the recommended product. It's built on the OpenAI Responses API format (not Chat Completions).

**Endpoint:** `POST https://api.perplexity.ai/v1/agent`
**Alias:** `POST https://api.perplexity.ai/v1/responses` (OpenAI Responses compatibility)

### 4.1 What Makes It Different from Sonar

The Agent API takes an `input` string and returns a typed `output` array, not a `choices` array. This reflects its agentic nature — the model may take multiple steps, calling tools in between.

```typescript
// Sonar API response shape
{
  "choices": [
    { "message": { "content": "...", "role": "assistant" } }
  ],
  "citations": ["https://...", "https://..."],
  "search_results": [...]
}

// Agent API response shape
{
  "output": [
    {
      "type": "search_results",
      "results": [{ "title": "...", "url": "...", "snippet": "..." }]
    },
    {
      "type": "message",
      "content": [{ "type": "output_text", "text": "...", "annotations": [] }],
      "role": "assistant"
    }
  ],
  "usage": { "input_tokens": ..., "output_tokens": ..., "cost": {...} }
}
```

### 4.2 Agent API Presets

Presets are pre-baked configurations (model + tools + system prompt). They update over time — using a preset by name means you automatically pick up Perplexity's latest quality improvements.

| Preset | Underlying Model | Web Searches | URL Fetches | Sandbox | Best For |
|--------|-----------------|--------------|-------------|---------|----------|
| `fast` | gpt-5.6-luna | 1 | 0 | No | Single-fact lookups, definitions, quick summaries |
| `low` | gpt-5.6-luna | 1 | 1 | No | Everyday research, light multi-step |
| `medium` | gpt-5.6-luna | 2 | 2 | No | Multi-hop browsing, wide aggregation |
| `high` | gpt-5.6-sol | 3 | 3 | No | Expert-level reasoning, exhaustive coverage |
| `xhigh` | gpt-5.6-sol | 4 | 4 | Yes (1 session, 2 searches) | Open-ended agentic work, code execution |
| `wide-research` | gpt-5.6-sol | many | many | Yes | Building large evidence-backed collections |

**Sonar-to-Preset migration mapping:**

| Legacy Sonar Model | Agent API Preset |
|-------------------|-----------------|
| `sonar` | `fast` |
| `sonar-pro` | `low` |
| `sonar-reasoning-pro` | `medium` |
| `sonar-deep-research` | `high` or `xhigh` |

### 4.3 Agent API Tools

The `tools` array controls what the model can call:

```typescript
// web_search tool
{
  type: "web_search",
  search_context_size: "medium",       // "low" | "medium" | "high"
  search_domain_filter: ["github.com"], // optional
  search_recency_filter: "week"         // optional
}

// fetch_url tool
{ type: "fetch_url" }

// sandbox (code execution)
{ type: "sandbox" }

// finance search
{ type: "finance_search" }

// people search
{ type: "people_search" }

// MCP server
{
  type: "mcp",
  url: "https://your-mcp-server.example.com/mcp",
  headers: { "Authorization": "Bearer ..." }
}

// custom function
{
  type: "function",
  name: "get_document",
  description: "Retrieve a document by ID",
  parameters: { /* JSON Schema */ }
}
```

**Tool pricing (Agent API):**

| Tool | Price |
|------|-------|
| `web_search` | $0.0025 per call |
| `fetch_url` | $0.0005 per call |
| `people_search` | $0.005 per call |
| `finance_search` | $0.005 per call |
| Sandbox session | $0.03 per session (<=20 min) |
| Sandbox search | $0.0025 per search |

### 4.4 Agent API TypeScript Example

```typescript
import Perplexity from '@perplexity-ai/perplexity_ai';

const client = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY,
});

// Simple preset usage
const response = await client.responses.create({
  preset: "low",
  input: "What MCP server implementations are available for enterprise search in 2026?",
});

console.log(response.output_text);  // convenience property

// Advanced: explicit model + tools
const response2 = await client.responses.create({
  model: "anthropic/claude-sonnet-4-6",
  input: "Analyze the top 5 competitors in the enterprise knowledge management space",
  tools: [
    {
      type: "web_search",
      search_context_size: "high",
      search_recency_filter: "month"
    },
    { type: "fetch_url" }
  ],
  instructions: "You are an expert market analyst. Cite all sources."
});

// Extract citations from Agent API responses
for (const item of response2.output) {
  if (item.type === "search_results") {
    for (const result of item.results) {
      console.log(`[${result.title}](${result.url})`);
    }
  }
}
```

Source: https://docs.perplexity.ai/docs/agent-api/quickstart.md

---

## 5. Search API

The Search API returns raw ranked web results — no synthesis, no LLM answer, just structured search results you can feed to your own pipeline.

**Endpoint:** `POST https://api.perplexity.ai/search`
**Price:** $5.00 per 1K requests (flat rate, all tiers)

### 5.1 Request Schema

```typescript
interface SearchRequest {
  query: string;                           // required
  max_results?: number;                    // 1-20, default 10
  search_context_size?: "low" | "medium" | "high";  // content extraction depth
  search_domain_filter?: string[];         // max 20 domains
  search_recency_filter?: "hour" | "day" | "week" | "month" | "year";
  search_after_date_filter?: string;       // MM/DD/YYYY
  search_before_date_filter?: string;      // MM/DD/YYYY
  last_updated_after_filter?: string;      // MM/DD/YYYY
  last_updated_before_filter?: string;     // MM/DD/YYYY
  search_language_filter?: string;         // e.g. "en"
  // Multi-query: pass array of queries in a single request
  queries?: string[];                      // up to N queries, billed as N rate-limit units
}
```

### 5.2 Response Schema

```typescript
interface SearchResponse {
  id: string;
  results: SearchResult[];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;    // extracted content from the page
  date: string | null;         // original publication date
  last_updated: string | null; // when the page was last crawled/updated
  source: "web";               // currently always "web"
}
```

### 5.3 TypeScript Example

```typescript
import Perplexity from '@perplexity-ai/perplexity_ai';

const client = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY,
});

async function searchAndSynthesize(query: string): Promise<{
  results: SearchResult[];
  answer: string;
}> {
  // Step 1: Get raw search results
  const search = await client.search.create({
    query,
    max_results: 10,
    search_context_size: "high",
    search_recency_filter: "month",
  });

  // Step 2: Feed to your own LLM for synthesis
  // This is the "bring your own LLM" pattern
  const context = search.results
    .map(r => `[${r.title}](${r.url})\n${r.snippet}`)
    .join('\n\n');

  return { results: search.results, context };
}
```

### 5.4 Search API with Agent Frameworks

The Search API is designed to be registered as a tool in other agent frameworks:

```typescript
// Register as a tool in Anthropic Claude
// Source: docs.perplexity.ai/docs/search/agent-sdks/anthropic.md
const tool = {
  name: "perplexity_search",
  description: "Search the web for current information",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" }
    },
    required: ["query"]
  }
};

// When Claude calls this tool, forward to Perplexity Search API
async function handleToolCall(toolInput: { query: string }) {
  const results = await perplexityClient.search.create({
    query: toolInput.query,
    max_results: 5,
    search_context_size: "medium"
  });
  return results.results;
}
```

Source: https://docs.perplexity.ai/docs/search/quickstart.md

---

## 6. Citations Format

### 6.1 Sonar API Citations

The Sonar API returns two citation-related fields:

```typescript
// Sonar API response
{
  "citations": [
    "https://humanloop.com/blog/rag-architectures",
    "https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview",
    "https://aws.amazon.com/what-is/retrieval-augmented-generation/"
    // ... typically 8-15 URLs for sonar-pro
  ],
  "search_results": [
    {
      "title": "RAG Architectures - Humanloop",
      "url": "https://humanloop.com/blog/rag-architectures",
      "date": "2024-03-15",
      "last_updated": "2026-05-16",
      "snippet": "...",
      "source": "web"
    }
  ]
}
```

The `citations` array is a flat list of URLs in the order they were referenced. The model uses inline citation markers like `[1]`, `[2]` in the text that correspond to the position in this array.

The `search_results` array provides the full metadata including title, dates, and snippet — use this for UI rendering.

**Number of sources typically returned:**
- `sonar`: typically 5-8 sources
- `sonar-pro`: typically 10-15 sources (2x more than base sonar)
- `sonar-deep-research`: 20-50+ sources (example query returned 28 citations)

### 6.2 Agent API Citations

In the Agent API, citations are embedded differently — they appear as `search_results` output items:

```typescript
// Agent API output array
[
  {
    "type": "search_results",
    "results": [
      {
        "id": 1,
        "title": "...",
        "url": "https://...",
        "date": "2026-01-15",
        "last_updated": "2026-05-20",
        "snippet": "...",
        "source": "web"
      }
    ],
    "queries": ["query that produced these results"]  // what was searched for
  },
  {
    "type": "message",
    "content": [
      {
        "type": "output_text",
        "text": "...[1][2]...",  // inline citation markers
        "annotations": []       // structured annotation objects
      }
    ]
  }
]
```

### 6.3 Extracting Citations in TypeScript

```typescript
function extractCitations(sonarResponse: SonarResponse): CitationSet {
  return {
    urls: sonarResponse.citations,
    results: sonarResponse.search_results.map(r => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      publishedAt: r.date,
      crawledAt: r.last_updated,
    }))
  };
}

function extractAgentCitations(agentResponse: AgentResponse): CitationSet {
  const searchItems = agentResponse.output.filter(
    item => item.type === 'search_results'
  );
  return {
    urls: searchItems.flatMap(item => item.results.map(r => r.url)),
    results: searchItems.flatMap(item =>
      item.results.map(r => ({
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        publishedAt: r.date,
        crawledAt: r.last_updated,
      }))
    )
  };
}
```

---

## 7. Search Filters

### 7.1 Domain Filter

**Parameter name:** `search_domain_filter` (Sonar API and Search API)

```typescript
// Allowlist — only return results from these domains
search_domain_filter: ["github.com", "arxiv.org", "docs.microsoft.com"]

// Denylist — exclude these domains (prefix with -)
search_domain_filter: ["-reddit.com", "-pinterest.com", "-quora.com"]

// Important: cannot mix allowlist and denylist in the same request
// Maximum 20 domains per request
```

**Filtering capabilities:**

| Pattern | What It Matches | Example |
|---------|----------------|---------|
| Root domain | Domain and all subdomains | `"wikipedia.org"` matches en.wikipedia.org, fr.wikipedia.org |
| TLD | All domains with that TLD | `".gov"` matches nasa.gov, cdc.gov, irs.gov |
| Path | Domain + specific path section | `"nature.com/articles"` matches nature.com/articles/* |
| Subdomain path | Path on any subdomain | `"nature.com/articles"` also matches blog.nature.com/articles |
| Domain part | Any domain containing this string | Flexible matching |

**Path filtering details:**
- Path matching is on path-segment boundaries
- `"example.com/docs"` matches `/docs` and `/docs/intro` but NOT `/documentation`
- Works in both allowlist and denylist modes
- Can pin or exclude a section of a domain:
  ```
  ["reddit.com/r/MachineLearning"]     // only ML subreddit
  ["-reddit.com/r/all"]                // exclude r/all but allow rest of reddit
  ```

Source: https://docs.perplexity.ai/docs/search/filters/domain-filter.md

### 7.2 Recency Filter

**Parameter name:** `search_recency_filter`

| Value | Time Window | Best For |
|-------|-------------|----------|
| `"hour"` | Past 60 minutes | Breaking news, live events, real-time data |
| `"day"` | Past 24 hours | Daily news, rapidly evolving situations |
| `"week"` | Past 7 days | Recent developments, weekly news cycles |
| `"month"` | Past 30 days | Monthly updates, recent releases |
| `"year"` | Past 365 days | Annual context, recent research |

This filter applies to the **publication date** of content.

**Gotcha:** Setting `search_recency_filter: "hour"` may return very few or zero results for non-breaking topics. The filter is absolute, not preferential — it excludes results outside the window entirely.

### 7.3 Date Filters (Search API)

For precise date ranges:

```typescript
// Publication date range
{
  search_after_date_filter: "3/1/2025",   // MM/DD/YYYY
  search_before_date_filter: "3/5/2025"
}

// Last updated date range  
{
  last_updated_after_filter: "07/01/2025",
  last_updated_before_filter: "12/30/2025"
}
```

The distinction matters:
- `search_after/before_date_filter` — when the content was originally published
- `last_updated_after/before_filter` — when the page was last crawled/modified

For monitoring content freshness (e.g., "find pages updated in the last 30 days"), use `last_updated_after_filter`.

Source: https://docs.perplexity.ai/docs/search/filters/date-time-filters.md

### 7.4 Search Context Size

**Parameter name:** `search_context_size`
**Available in:** Sonar API (via `web_search_options`), Agent API (via tool config), Search API

| Value | Content Retrieved | Cost Impact |
|-------|-----------------|-------------|
| `"low"` | Minimal context | Cheapest (request fee lower tier) |
| `"medium"` | Standard context | Mid-tier request fee |
| `"high"` | Maximum context | Highest request fee |

This is the cost lever for Sonar API request fees. The actual per-token pricing stays the same — but "high" context size means more web content is injected into the prompt, increasing total token count AND the per-request surcharge.

**Example from actual usage data** (sonar-pro, low context query):
```json
"cost": {
  "input_tokens_cost": 0.000060,
  "output_tokens_cost": 0.018090,
  "total_cost": 0.024150,
  "request_cost": 0.006
}
```

The `request_cost` of $0.006 = low context tier ($6/1K requests). Total cost was $0.024 for a detailed technical answer.

---

## 8. Streaming

Streaming is supported across all Sonar models.

### 8.1 How Sonar Streaming Works

Key behavior: **search results and metadata are delivered in the final chunk(s), not progressively**.

The stream delivers:
1. Content chunks arrive progressively in real-time
2. Search results, usage stats, citations — in the final chunk(s)

This means you can stream the generated text to the user immediately, but you must wait for the stream to complete before you have the citation list.

### 8.2 TypeScript Streaming with Sonar

```typescript
import Perplexity from '@perplexity-ai/perplexity_ai';

const client = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY,
});

async function streamSonarResponse(query: string): Promise<{
  content: string;
  citations: string[];
  searchResults: SearchResult[];
  usage: UsageInfo;
}> {
  const stream = await client.chat.completions.create({
    model: "sonar-pro",
    messages: [{ role: "user", content: query }],
    stream: true,
    search_context_size: "medium",
  });

  let content = "";
  let citations: string[] = [];
  let searchResults: SearchResult[] = [];
  let usage: UsageInfo | null = null;

  for await (const chunk of stream) {
    // Content arrives progressively
    if (chunk.choices[0]?.delta?.content) {
      content += chunk.choices[0].delta.content;
      process.stdout.write(chunk.choices[0].delta.content);
    }

    // Metadata arrives in final chunks
    if (chunk.search_results?.length) {
      searchResults = chunk.search_results;
    }
    if (chunk.citations?.length) {
      citations = chunk.citations;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  return { content, citations, searchResults, usage };
}
```

### 8.3 Streaming with OpenAI SDK (Compatible)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});

// Stream with OpenAI SDK — works but you lose type safety on Perplexity extensions
const stream = await client.chat.completions.create({
  model: "sonar-pro",
  messages: [{ role: "user", content: "Explain MCP protocol architecture" }],
  stream: true,
});

for await (const chunk of stream) {
  const text = chunk.choices[0]?.delta?.content ?? '';
  process.stdout.write(text);

  // Perplexity-specific fields are not typed in OpenAI SDK
  // Cast to any or use Perplexity's native SDK instead
  const pplxChunk = chunk as any;
  if (pplxChunk.citations) {
    console.log('\nCitations:', pplxChunk.citations);
  }
}
```

**Recommendation:** Use Perplexity's native TypeScript SDK (`@perplexity-ai/perplexity_ai`) for new code. The OpenAI SDK works for migration compatibility but loses type safety on Perplexity-specific fields.

### 8.4 Agent API Streaming

The Agent API also supports streaming via SSE. The `output_text` property aggregates all text automatically.

```typescript
// Agent API streaming
const stream = await client.responses.stream({
  preset: "low",
  input: "What's the current state of MCP server adoption?",
});

for await (const event of stream) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta);
  }
}

const finalResponse = await stream.finalResponse();
```

---

## 9. Rate Limits and Usage Tiers

### 9.1 Tier Progression

| Tier | Cumulative Credits Purchased | Status |
|------|----------------------------|--------|
| Tier 0 | $0 | New accounts, limited access |
| Tier 1 | $50+ | Light usage |
| Tier 2 | $250+ | Regular usage |
| Tier 3 | $500+ | Heavy usage |
| Tier 4 | $1,000+ | Production usage |
| Tier 5 | $5,000+ | Enterprise usage |

Tiers are based on **cumulative lifetime purchases**, not current balance. Once you reach a tier, you keep it.

### 9.2 Sonar API Rate Limits by Tier

| Model | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|--------|
| `sonar-deep-research` (sync) | 5 RPM | 10 RPM | 20 RPM | 40 RPM | 60 RPM | 100 RPM |
| `sonar-reasoning-pro` | 50 RPM | 150 RPM | 500 RPM | 1,000 RPM | 4,000 RPM | 4,000 RPM |
| `sonar-pro` | 50 RPM | 150 RPM | 500 RPM | 1,000 RPM | 4,000 RPM | 4,000 RPM |
| `sonar` | 50 RPM | 150 RPM | 500 RPM | 1,000 RPM | 4,000 RPM | 4,000 RPM |
| `POST /v1/async/sonar` | 5 RPM | 10 RPM | 20 RPM | 40 RPM | 60 RPM | 100 RPM |
| `GET /v1/async/sonar` (list) | 3,000 RPM | 3,000 RPM | 3,000 RPM | 3,000 RPM | 3,000 RPM | 3,000 RPM |
| `GET /v1/async/sonar/{id}` (poll) | 6,000 RPM | 6,000 RPM | 6,000 RPM | 6,000 RPM | 6,000 RPM | 6,000 RPM |

**Key observation:** Deep research is severely rate-limited even at Tier 5 (100 RPM). For a production system doing bulk deep research, you will hit limits.

### 9.3 Agent API Rate Limits

| Tier | QPS | Requests per Minute |
|------|-----|---------------------|
| Tier 0 | 1 | 50/min |
| Tier 1 | 3 | 150/min |
| Tier 2 | 8 | 500/min |
| Tier 3 | 17 | 1,000/min |
| Tier 4 | 33 | 4,000/min |
| Tier 5 | 33 | 8,000/min |

Two independent limits apply: QPS AND RPM. A request must satisfy both.

### 9.4 Search API Rate Limits

All tiers: **50 query units per second** (burst capacity also 50 units).

- Single-query request = 1 unit
- Multi-query request = 1 unit per query in the array
- Burst: 50 units instantly, then refills at 50/second

Search API rate limits are independent of usage tier — they apply equally to all accounts.

### 9.5 Rate Limiting Algorithm

Perplexity uses a **leaky bucket** algorithm:
- Bucket capacity = burst limit
- Leak rate = sustained rate limit
- On 429: retry after the `Retry-After` header value
- Requests rejected with 429 are not billed

**Retry pattern for Node.js:**

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (err.status === 429) {
        const retryAfter = parseInt(err.headers?.['retry-after'] ?? '1') * 1000;
        const jitter = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, retryAfter + jitter));
        continue;
      }
      throw err;
    }
  }
  throw lastError!;
}
```

### 9.6 Enterprise Plans

For custom rate limits beyond Tier 5: fill out https://perplexity.typeform.com/to/yctmfyVT

AWS Marketplace subscription available for consolidated enterprise billing.

Source: https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.md

---

## 10. MCP Server

Perplexity provides an official MCP server in two deployment modes.

### 10.1 Remote MCP Server (Recommended)

**URL:** `https://api.perplexity.ai/mcp`
**Transport:** Streamable HTTP
**Auth:** Bearer token (your Perplexity API key)

```bash
# Claude Code
claude mcp add --transport http perplexity https://api.perplexity.ai/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

```json
// mcp.json (Cursor, Claude Desktop, etc.)
{
  "mcpServers": {
    "perplexity": {
      "url": "https://api.perplexity.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 10.2 Local MCP Server

**Package:** `@perplexity-ai/mcp-server` (npm)
**Transport:** stdio

```bash
# Claude Code
claude mcp add perplexity \
  --env PERPLEXITY_API_KEY="your_key" \
  -- npx -y @perplexity-ai/mcp-server
```

```json
// Manual config
{
  "mcpServers": {
    "perplexity": {
      "command": "npx",
      "args": ["-y", "@perplexity-ai/mcp-server"],
      "env": {
        "PERPLEXITY_API_KEY": "your_key_here"
      }
    }
  }
}
```

### 10.3 Tools Exposed

The Perplexity MCP server exposes exactly 4 tools:

| Tool | Backed By | What It Does | Best For |
|------|-----------|--------------|----------|
| `perplexity_search` | Search API | Raw ranked web results with titles, URLs, snippets | Finding current info, news, specific web content |
| `perplexity_ask` | Agent API `fast` preset | Conversational Q&A with real-time web grounding | Quick questions, everyday searches |
| `perplexity_research` | Agent API `high` preset | Deep research with comprehensive citations | Complex topics, detailed investigation |
| `perplexity_reason` | Agent API `medium` preset | Advanced step-by-step reasoning | Logical problems, multi-step analysis |

The tool split is sensible: `perplexity_search` gives you raw results (good for pipelines), while the other three give you synthesized answers at different quality/cost tiers.

### 10.4 Using Perplexity MCP from the Anthropic API

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "What is the latest on MCP protocol adoption?"}],
    "mcp_servers": [{
      "type": "url",
      "url": "https://api.perplexity.ai/mcp",
      "name": "perplexity",
      "authorization_token": "YOUR_PERPLEXITY_API_KEY"
    }],
    "tools": [{
      "type": "mcp_toolset",
      "mcp_server_name": "perplexity"
    }]
  }'
```

To restrict which tools Claude can call:

```json
"tools": [{
  "type": "mcp_toolset",
  "mcp_server_name": "perplexity",
  "default_config": {"enabled": false},
  "configs": {
    "perplexity_search": {"enabled": true}
  }
}]
```

Tool calls are billed to your Perplexity API key at standard API pricing. Your key's existing rate limits apply.

Source: https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server.md

---

## 11. Deep Research

### 11.1 How sonar-deep-research Works

`sonar-deep-research` is a multi-step research agent, not a single-shot LLM call. Based on observed behavior and pricing structure:

1. **Query decomposition:** The model receives your research question and decomposes it into sub-queries (the example showed 21 search queries for a broad quantum computing topic)
2. **Iterative search:** It issues multiple sequential search queries, each building on previous findings
3. **Evidence synthesis:** It reads and synthesizes content from hundreds of sources
4. **Reasoning trace:** It maintains an internal reasoning chain (193K reasoning tokens in the example)
5. **Report generation:** It produces a comprehensive report with inline citations

The `reasoning_tokens` in the usage object reflect internal CoT thinking that isn't shown in the output. The `citation_tokens` reflect the volume of web content actually read and incorporated.

**Observable metrics from a real "comprehensive quantum computing industry analysis" request:**
- 33 prompt tokens (just the question)
- 11,395 completion tokens (the report)
- 19,028 citation tokens (web content processed)
- 21 search queries issued
- 193,947 reasoning tokens (internal thinking)
- $0.82 total cost
- 28 unique sources in the final citations list

### 11.2 Deep Research Latency

Because of the multi-step search and reasoning loop, `sonar-deep-research` takes minutes, not seconds. For production use:

```typescript
// Use the async API for deep research
async function deepResearch(query: string): Promise<ResearchResult> {
  // Submit async job
  const response = await fetch('https://api.perplexity.ai/v1/async/sonar', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-deep-research',
      messages: [{ role: 'user', content: query }]
    })
  });

  const { id } = await response.json();

  // Poll until complete
  while (true) {
    const status = await fetch(
      `https://api.perplexity.ai/v1/async/sonar/${id}`,
      { headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}` } }
    );
    const result = await status.json();

    if (result.status === 'completed') {
      return result;
    }
    if (['failed', 'cancelled'].includes(result.status)) {
      throw new Error(`Research job ${result.status}: ${result.error}`);
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
```

### 11.3 Wide Research (Agent API)

The Agent API's `wide-research` preset is optimized for a different task shape: building large collections of evidence-backed items. Think "find 70 companies that meet criteria X and cite a source for each."

```typescript
import Perplexity from '@perplexity-ai/perplexity_ai';

const client = new Perplexity();

// Submit background job
let response = await client.responses.create({
  preset: "wide-research",
  background: true,
  input: `Find 50 MCP server implementations published between Jan-Aug 2026.
For each: name, GitHub URL, primary use case, license.
Write results to mcp-servers.jsonl, one JSON record per line.`
});

// Poll
while (!['completed', 'failed', 'cancelled', 'incomplete'].includes(response.status)) {
  await new Promise(r => setTimeout(r, 5000));
  response = await client.responses.retrieve(response.id);
}

// Download output files
const files = await client.responses.files.list(response.id);
for (const file of files.data) {
  // file.id, file.filename, file.bytes
  const content = await client.responses.files.content({
    file_id: file.id,
    response_id: response.id
  });
}
```

Based on the WANDR benchmark (Wide ANd Deep Research), Perplexity claims their search-orchestration leads this benchmark.

Source: https://docs.perplexity.ai/docs/agent-api/wide-research.md

---

## 12. Competitor Comparison

### 12.1 Perplexity vs Tavily vs Exa vs Brave Search

| Dimension | Perplexity Sonar/Agent | Tavily | Exa | Brave Search API |
|-----------|----------------------|--------|-----|-----------------|
| **Product type** | AI-grounded answers + raw search | Raw search results | Semantic search (neural retrieval) | Raw search results |
| **Synthesis** | Built-in (Sonar models or Agent API) | None — you synthesize | None — you synthesize | None — you synthesize |
| **Search quality** | Excellent for current events | Good for general web | Best for academic/technical content | Good general coverage |
| **Citations** | First-class: structured array + inline markers | URLs returned | URLs returned | URLs returned |
| **Domain filtering** | Up to 20 domains, allowlist/denylist, TLD, path | Domain includes/excludes | Domains, include/exclude | Limited |
| **Recency filtering** | hour/day/week/month/year | Number of days | Crawl date filters | Limited |
| **Deep research** | sonar-deep-research ($0.50-$2/query) | Not offered | Not offered | Not offered |
| **MCP server** | Official, 4 tools, remote + local | Official | Official | Community only |
| **Streaming** | Yes, SSE | Yes | Yes | No (REST) |
| **Free tier** | No | No | No | No |
| **Price per search** | $5/1K (Search API) | ~$4-20/1K (varies by plan) | ~$5-25/1K (varies by tier) | $3-5/1K |
| **Agent framework integration** | Anthropic, OpenAI, Gemini, LangChain, AG2 | LangChain, LlamaIndex | LangChain, LlamaIndex, CrewAI | Mostly DIY |

### 12.2 When to Use Each

**Use Perplexity when:**
- You want a grounded answer with citations, not raw results
- You're using the Agent API and want web search as a built-in tool
- You need deep research synthesis on complex topics
- You're already using Anthropic/OpenAI models and want search added transparently

**Use Tavily when:**
- You want simple, cheap web search results to feed your own LLM
- You're in LangChain/LlamaIndex ecosystem (native integration)
- You need predictable pricing without the Perplexity request surcharge

**Use Exa when:**
- You need semantic/neural search over academic or technical content
- You want better recall for specific domain queries vs keyword search
- You need to search across a specific corpus by semantic similarity

**Use Brave Search API when:**
- You want the cheapest raw search option
- You need your own independent search index (not Google-derived)
- You care about privacy as a product feature

### 12.3 Competitive Dynamics

The market split as of mid-2026:

- **Perplexity** has moved upmarket into a full agent platform, making it harder to use as a pure search primitive. Their Agent API positions them as a competitor to LiteLLM and OpenRouter, not just a search API.
- **Tavily** remains the cleanest "search as a function" API for agent pipelines.
- **Exa** has carved out a niche for neural/semantic search, particularly technical and academic content.
- **Brave** remains the lowest-cost option with an independent index.

For our markdown-for-agents-mcp use case (web fetch + search capabilities), **Perplexity and Tavily are the two primary options to evaluate**, with Exa as a secondary source for technical content queries.

---

## 13. How Perplexity Builds Grounded Answers

### 13.1 The Synthesis Pipeline (Inferred)

Based on the API behavior, pricing structure, and published information:

```
User Query
    │
    ▼
Query Understanding & Decomposition
    │
    ▼
Search Execution (multiple queries in parallel or sequence)
    │ ── hits Perplexity's proprietary search index
    │ ── real-time web crawl for fresh content
    ▼
Web Content Retrieval (search_context_size controls depth)
    │ ── title, URL, publication date, content snippets
    │ ── "citation tokens" reflect content processed
    ▼
Context Assembly
    │ ── web snippets injected into LLM context window
    │ ── the Sonar model sees: user query + retrieved context
    ▼
LLM Synthesis (Sonar model)
    │ ── trained/fine-tuned to cite [1][2] markers
    │ ── trained to ground claims in retrieved content
    │ ── reasoning models add CoT before final answer
    ▼
Response with Citations
    │ ── citations[] array of URLs in reference order
    │ ── search_results[] array with full metadata
    ▼
API Response
```

### 13.2 What Makes Perplexity Different from "LLM + Google Search"

1. **Proprietary search index:** Perplexity crawls and indexes the web independently (the "Perplexity Crawlers" page documents their crawl agents). They're not just querying Google/Bing.

2. **Search-grounded fine-tuning:** The Sonar models are specifically trained to produce citation-grounded answers. They don't just get search results jammed into context — they've been fine-tuned to use web content faithfully.

3. **Multi-query orchestration:** For sonar-pro, the 2x search results suggest they're running multiple search angles and merging results. For sonar-deep-research, they're running 20+ sequential queries with reasoning between steps.

4. **recency as a first-class feature:** The search index is designed for freshness. They don't have the "knowledge cutoff" problem that plagues base LLMs because they always consult the web.

### 13.3 Implications for Our Stack

We can build a Perplexity-like grounded answer flow using our own fetch + LLM:

```
1. Receive query from agent
2. Generate 3-5 search queries (query expansion with our LLM)
3. Execute searches (Brave/Tavily/Perplexity Search API)
4. Fetch top N URLs (our fetch tool)
5. Extract relevant content (markdown extraction)
6. Assemble context with source attribution
7. Synthesize answer with LLM (Claude/GPT) citing sources
8. Return structured response: answer + citation list
```

This is essentially what Perplexity does internally — but we control each step and can add our enterprise knowledge index at step 3 (SharePoint/Confluence results interleaved with web results).

---

## 14. Implementation Patterns

### 14.1 Drop-in Sonar Replacement

If you're currently using OpenAI Chat Completions and want to add web grounding:

```typescript
// Before: standard OpenAI
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const response = await client.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: query }]
});

// After: Perplexity Sonar (same SDK, different base URL + model)
const client = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});
const response = await client.chat.completions.create({
  model: "sonar-pro",  // or "sonar" for cheaper
  messages: [{ role: "user", content: query }]
});
// response.citations contains source URLs
```

### 14.2 MCP Tool Adapter Pattern

How to expose Perplexity as a tool in our MCP server:

```typescript
// In our MCP server's tool registry
import Perplexity from '@perplexity-ai/perplexity_ai';

const perplexityClient = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY,
});

export const webSearchTool: MCPTool = {
  name: "web_search",
  description: "Search the web for current information and return grounded results with citations",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query"
      },
      recency: {
        type: "string",
        enum: ["hour", "day", "week", "month", "year"],
        description: "How recent the results should be"
      },
      domains: {
        type: "array",
        items: { type: "string" },
        description: "Specific domains to search (allowlist) or exclude (prefix with -)"
      }
    },
    required: ["query"]
  },
  handler: async (input) => {
    // Option A: Search API (raw results, synthesize with our LLM)
    const results = await perplexityClient.search.create({
      query: input.query,
      max_results: 10,
      search_context_size: "medium",
      ...(input.recency && { search_recency_filter: input.recency }),
      ...(input.domains && { search_domain_filter: input.domains }),
    });

    // Return structured markdown that the agent can reason over
    const formatted = results.results.map((r, i) =>
      `[${i+1}] **${r.title}**\nURL: ${r.url}\nDate: ${r.date ?? 'unknown'}\n${r.snippet}`
    ).join('\n\n');

    return {
      content: [{ type: "text", text: formatted }]
    };
  }
};

export const groundedAnswerTool: MCPTool = {
  name: "ask_web",
  description: "Ask a question that requires current web information. Returns an AI-synthesized answer with citations.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" }
    },
    required: ["question"]
  },
  handler: async (input) => {
    // Option B: Sonar API (synthesized answer with citations)
    const completion = await perplexityClient.chat.completions.create({
      model: "sonar",  // cheapest for simple Q&A
      messages: [{ role: "user", content: input.question }],
      search_context_size: "low",  // minimize cost for simple questions
    });

    const answer = completion.choices[0].message.content;
    const citations = completion.citations ?? [];
    const sources = completion.search_results ?? [];

    const citationsList = sources
      .map((s, i) => `[${i+1}] [${s.title}](${s.url})`)
      .join('\n');

    return {
      content: [{
        type: "text",
        text: `${answer}\n\n**Sources:**\n${citationsList}`
      }]
    };
  }
};
```

### 14.3 Cost-Optimized Routing Pattern

Route to the appropriate Perplexity model based on query complexity:

```typescript
type QueryComplexity = 'simple' | 'research' | 'deep';

function classifyQuery(query: string): QueryComplexity {
  const deepSignals = [
    'comprehensive', 'analysis', 'compare all', 'exhaustive',
    'market analysis', 'competitive landscape', 'research report'
  ];
  const researchSignals = [
    'explain', 'how does', 'what is', 'list all', 'compare',
    'pros and cons', 'best practices'
  ];

  const lower = query.toLowerCase();
  if (deepSignals.some(s => lower.includes(s))) return 'deep';
  if (researchSignals.some(s => lower.includes(s))) return 'research';
  return 'simple';
}

async function grounded_search(query: string): Promise<GroundedAnswer> {
  const complexity = classifyQuery(query);

  switch (complexity) {
    case 'simple':
      // $0.001-0.01 per query
      return callSonar(query, 'sonar', 'low');

    case 'research':
      // $0.01-0.05 per query
      return callSonar(query, 'sonar-pro', 'medium');

    case 'deep':
      // $0.50-2.00 per query — only when needed
      return callDeepResearch(query);
  }
}
```

### 14.4 Hybrid Web + Enterprise Knowledge Pattern

This is the key pattern for Phase 2 (SharePoint + Confluence):

```typescript
async function hybridSearch(
  query: string,
  userId: string,
  context: AgentContext
): Promise<HybridSearchResult> {
  // Run web search and enterprise search in parallel
  const [webResults, enterpriseResults] = await Promise.all([
    // Web: Perplexity Search API
    perplexityClient.search.create({
      query,
      max_results: 5,
      search_context_size: "medium",
    }),

    // Enterprise: SharePoint/Confluence via Entra ID ACL enforcement
    enterpriseKnowledgeIndex.search({
      query,
      userId,  // ACL filter via transitiveMemberOf
      sources: ['sharepoint', 'confluence'],
      maxResults: 5,
    })
  ]);

  // Merge and rank results by relevance
  const allResults = [
    ...webResults.results.map(r => ({ ...r, source: 'web' as const })),
    ...enterpriseResults.map(r => ({ ...r, source: 'enterprise' as const })),
  ].sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Synthesize with our LLM, giving context about sources
  const synthesis = await synthesizeWithLLM({
    query,
    sources: allResults,
    instructions: `
      When answering, cite both web sources ([W1], [W2]...) and 
      internal enterprise sources ([E1], [E2]...) separately.
      Prioritize internal enterprise knowledge when it exists and is recent.
    `
  });

  return {
    answer: synthesis.text,
    citations: allResults,
    webSourceCount: webResults.results.length,
    enterpriseSourceCount: enterpriseResults.length,
  };
}
```

### 14.5 Implementing Inline Citation Rendering

```typescript
function renderWithCitations(
  text: string,
  sources: SearchResult[]
): string {
  // Replace [1], [2] etc. with clickable markdown links
  return text.replace(/\[(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    const source = sources[num - 1];
    if (!source) return match;
    return `[[${num}]](${source.url})`;
  });
}

// Usage
const rendered = renderWithCitations(
  completion.choices[0].message.content,
  completion.search_results ?? []
);
```

---

## 15. Limitations, Failure Modes, Gotchas

### 15.1 Search Quality Limitations

**Recency filter is hard-cutoff, not soft-preference:**
Setting `search_recency_filter: "hour"` will return zero results for most queries. This is an absolute exclusion, not a "prefer fresh" ranking signal. For freshness with fallback, implement two-pass: try with recency filter, fall back without if zero results.

```typescript
async function searchWithFreshnessFallback(query: string): Promise<SearchResult[]> {
  const fresh = await client.search.create({
    query,
    search_recency_filter: "week",
    max_results: 10,
  });

  if (fresh.results.length >= 3) return fresh.results;

  // Fallback: no recency filter
  const general = await client.search.create({ query, max_results: 10 });
  return general.results;
}
```

**Domain filter overrides quality ranking:**
If you allowlist domains that don't have relevant content for your query, you'll get poor results — Perplexity won't go outside your list even if no matching content exists within it. Use denylist mode when you know what to exclude; use allowlist only when you know your sources have the content.

**Mixed allowlist/denylist not supported:**
You can't do "search everything except reddit.com, but only from github.com and docs pages." It's one mode or the other.

### 15.2 Deep Research Limitations

**Rate limits are a production bottleneck:**
At Tier 5 ($5,000+ spent), `sonar-deep-research` caps at 100 RPM. For bulk research tasks, this means ~1.67 concurrent deep research jobs per second maximum. For batch processing, you need async mode and a queue.

**Cost variance is high:**
The $0.82 example was a broad industry analysis. Simple deep research queries cost less; very broad ones can cost more. No way to set a cost cap per query — implement your own token budgeting by estimating query complexity.

**sonar-reasoning deprecated:**
The non-pro reasoning model was deprecated December 15, 2025. If your code still references `sonar-reasoning`, it will fail. Update to `sonar-reasoning-pro`.

### 15.3 Platform Transition Risk

**Sonar API deprecation is real:**
September 27, 2026 is a hard deadline. Any production code using the Sonar API at `/v1/sonar` needs migration before then. The Agent API endpoint changes significantly (responses format, not chat completions format).

**Agent API model IDs use vendor prefix:**
The Agent API uses `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-4-6` etc. — not bare model IDs. The `perplexity/sonar` model is available in the Agent API context but with the prefix.

**Preset configurations are mutable:**
Perplexity reserves the right to update what model and configuration a preset name resolves to. If you need deterministic behavior, copy the current preset values into a frozen configuration.

### 15.4 OpenAI SDK Compatibility Gotchas

**Citations and search_results are not in OpenAI types:**
When using the OpenAI SDK with Perplexity's endpoint, TypeScript will not know about `response.citations` or `response.search_results`. You'll need to cast to `any` or use Perplexity's native SDK.

**streaming final chunk order:**
In streaming mode, the final chunk contains the search results and usage stats. If your stream handling code only processes `chunk.choices[0].delta.content` and returns early, you'll miss the citations. Always process the full stream.

**system prompt handling:**
Perplexity's documentation has specific guidance on system prompt usage (see the Prompt Guide). Some behaviors differ from bare OpenAI models — in particular, system prompts interact with the search grounding in ways that can suppress citations if the system prompt is structured in certain ways.

### 15.5 Search API Specific Issues

**$5/1K pricing is flat but rate limits bite:**
The Search API is cheap ($0.005 per search) but has a hard 50 QPS limit across all accounts, not per-tier. For applications that need bursts beyond 50 QPS, there's no path to increase this.

**Multi-query billing vs rate limiting asymmetry:**
A request with 5 queries in the `queries` array counts as 1 billable request but consumes 5 rate-limit units. This is documented but counterintuitive — parallel queries are cheaper to bill but rate-limit faster.

**Snippets are not full page content:**
The `snippet` field in search results is a short excerpt, not a full page extraction. For our use case (feeding content to an LLM), you need to `fetch_url` for the full content, or use `search_context_size: "high"` to get richer snippets.

### 15.6 Enterprise & Data Privacy

From Perplexity's privacy policy (https://docs.perplexity.ai/docs/resources/privacy-security):
- **No training on customer data:** API queries are not used to train Sonar models
- SOC 2 Type II certified
- Data retention policies apply to logs, not model training

For enterprise deployments with sensitive queries (legal, HR, confidential projects), using `search_domain_filter` to restrict to internal domains only is not supported — the domain filter only affects public web search. For purely internal knowledge, use the enterprise knowledge index path without web search.

---

## 16. Build Recommendations

### What to Build

#### Tier 1: Core (Phase 1 of markdown-for-agents-mcp)

**Build:** A `web_search` MCP tool backed by Perplexity Search API or Tavily (our choice), plus a `fetch_url` tool.

**Why Perplexity Search over Tavily:**
- Better freshness handling with granular recency filters
- Path-level domain filtering (e.g., `"reddit.com/r/MachineLearning"`)
- Official MCP server as reference implementation
- TLD filtering (`.gov`, `.edu`) is unique and useful

**Why Tavily over Perplexity Search:**
- Simpler pricing, no request surcharge tiers
- LangChain/LlamaIndex native integration if we need it
- Slightly cheaper for high-volume applications

**Our recommendation:** Start with Perplexity Search API for its filter capabilities; make the backend pluggable so we can swap in Tavily or Brave.

#### Tier 2: Grounded Answers (when direct synthesis is needed)

**Build:** A `ask_web` tool that calls Sonar/Agent API for synthesized answers with citations.

**But:** Sunset Sonar API usage by Sep 2026. Wire directly to Agent API `fast` preset.

**Use case for our server:** When an agent explicitly needs a synthesized answer rather than raw search results — e.g., "what does the documentation say about X" rather than "search for X."

#### Tier 3: Deep Research Integration (Phase 2+)

**Build:** A `deep_research` tool backed by `sonar-deep-research` or Agent API `high` preset.

Route through async API, return a job ID, surface completion as a callback or polling endpoint. Budget $1-2 per call and rate-limit usage.

### What to Skip

**Do not build:** A full replacement for Perplexity's synthesis pipeline. The value of Sonar is their proprietary search-grounded fine-tuning — replicating it with "LLM + raw search" will produce lower-quality citations and more hallucinations. If you need citation quality that approaches Sonar, use Sonar.

**Do not embed the Perplexity MCP server directly.** The official `@perplexity-ai/mcp-server` is good for personal/developer use, but for our MCP server we should expose our own tools that make decisions about which backend to call (Perplexity, Brave, internal index) based on query type, user context, and ACL.

**Do not use the Router API.** That's a commodity model gateway competing with LiteLLM. We have no need for Perplexity to proxy our Claude calls — just call Anthropic directly.

**Do not build domain filtering into our server as Perplexity-specific.** Abstract it as a general `source_filter` parameter that our tool translates to whichever search backend is active.

### Architecture Decision

For markdown-for-agents-mcp Phase 1:

```
Agent (Claude/GPT/any)
    │
    ▼ MCP
Our Server
    ├── web_search  ──────► Perplexity Search API (or Tavily)
    ├── fetch_url   ──────► Direct HTTP fetch + markdown extraction
    └── (Phase 2)
        └── knowledge_search ► Enterprise index (SharePoint + Confluence)
                               + Perplexity web fallback
```

The key insight from this research: Perplexity's value is highest when:
1. You want pre-synthesized answers with citations (Sonar/Agent API)
2. You want multi-step deep research without building the loop yourself (sonar-deep-research)

Their Search API is a solid option for raw results but is not dramatically superior to Tavily or Brave for simple retrieval use cases. The differentiation is in the synthesis layer.

---

## Sources

All information sourced from Perplexity's official documentation as of 2026-08-26:

- https://docs.perplexity.ai — Platform overview
- https://docs.perplexity.ai/docs/getting-started/pricing.md — Pricing data (PRICING JSON object)
- https://docs.perplexity.ai/docs/sonar/models.md — Sonar model comparison
- https://docs.perplexity.ai/docs/sonar/models/sonar.md — Sonar base model
- https://docs.perplexity.ai/docs/sonar/models/sonar-pro.md — Sonar Pro model
- https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro.md — Sonar Reasoning Pro
- https://docs.perplexity.ai/docs/sonar/models/sonar-deep-research.md — Sonar Deep Research
- https://docs.perplexity.ai/docs/sonar/features.md — Streaming, structured outputs
- https://docs.perplexity.ai/docs/sonar/filters.md — Domain and date filters
- https://docs.perplexity.ai/docs/sonar/quickstart.md — Sonar API quickstart with response examples
- https://docs.perplexity.ai/docs/agent-api/quickstart.md — Agent API
- https://docs.perplexity.ai/docs/agent-api/presets.md — Preset definitions and cost tables
- https://docs.perplexity.ai/docs/agent-api/tools/web-search.md — Web search tool
- https://docs.perplexity.ai/docs/agent-api/wide-research.md — Wide research preset
- https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview.md — Migration guide + Sonar vs Agent API table
- https://docs.perplexity.ai/docs/search/quickstart.md — Search API
- https://docs.perplexity.ai/docs/search/filters/domain-filter.md — Domain filter details
- https://docs.perplexity.ai/docs/search/filters/date-time-filters.md — Date/time filters
- https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server.md — MCP server docs
- https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.md — Rate limits by tier
- https://docs.perplexity.ai/llms.txt — Full documentation index
