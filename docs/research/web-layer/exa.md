# Exa Neural Search and Content Retrieval API

**Research date:** 2026-08-26
**Sources:** docs.exa.ai, exa.ai/pricing, exa.ai/versus/tavily, exa.ai/blog/highlights-for-agents, deepwiki.com/exa-labs/exa-mcp-server, theaiagentindex.com, queryburst.com

---

## Table of Contents

1. [Company and Platform Overview](#1-company-and-platform-overview)
2. [Neural Search Architecture](#2-neural-search-architecture)
3. [Search Types and Latency Profiles](#3-search-types-and-latency-profiles)
4. [Complete Search API Reference](#4-complete-search-api-reference)
5. [Contents API: Highlights, Summaries, Full Text](#5-contents-api-highlights-summaries-full-text)
6. [Answer Endpoint](#6-answer-endpoint)
7. [Agent API (Deep Research)](#7-agent-api-deep-research)
8. [Monitors API](#8-monitors-api)
9. [Websets Product](#9-websets-product)
10. [Category Filtering](#10-category-filtering)
11. [MCP Server Implementations](#11-mcp-server-implementations)
12. [SDK Reference](#12-sdk-reference)
13. [Pricing](#13-pricing)
14. [Rate Limits and Error Handling](#14-rate-limits-and-error-handling)
15. [Data Freshness and Crawl Policies](#15-data-freshness-and-crawl-policies)
16. [Exa vs Competitors](#16-exa-vs-competitors)
17. [Implementing Exa-Style Neural Search Locally](#17-implementing-exa-style-neural-search-locally)
18. [Relevance for markdown-for-agents-mcp](#18-relevance-for-markdown-for-agents-mcp)

---

## 1. Company and Platform Overview

Exa (formerly Metaphor Systems) is an SF-based research lab building what they describe as "perfect search." Founded ~2021 by Will Bryk (CEO), Dan McArdle, and Jeffrey Wang.

**Scale as of mid-2026:**
- 1.4 trillion URLs indexed
- 80 billion pages served
- 400,000+ developers
- 5,000+ businesses
- 25 trillion tokens per week processed through the Highlights model
- $361M total funding: $250M Series C (May 2026) led by a16z at $2.2B valuation
- Investors: Andreessen Horowitz, Benchmark, Lightspeed, Y Combinator, NVIDIA

**Named customers:** Cursor (code search), Cognition/Devin (all web access), HubSpot (2.7M enrichments via agentic lead engine), OpenRouter, Monday.com.

The critical architectural distinction: Exa built its search infrastructure and retrieval models from scratch rather than reselling Google or Bing results. This enables category-specific indexes (people, companies, publications) with custom embeddings that general-purpose APIs cannot replicate.

**Source:** https://theaiagentindex.com/agents/exa-ai

---

## 2. Neural Search Architecture

### How Exa's Neural Search Works

Exa's search is not traditional BM25 keyword matching. It uses neural embeddings to match queries against semantically similar web content. The foundational insight: rather than treating queries as bags of keywords, Exa embeds queries and documents into a shared vector space where semantic proximity drives ranking.

The practical implication: Exa excels at queries phrased as descriptions ("a company that does X"), natural language questions, and conceptual lookups — all query forms that BM25 fails on because the exact keywords may not appear in the target document.

The older terminology "neural" as a search type has been deprecated in the current API. The old `type: "neural"` is now expressed through `type: "auto"` which selects the appropriate underlying model automatically.

**Source:** docs.exa.ai/reference/search-api-guide-for-coding-agents — "If you encounter older docs or responses that mention neural, treat that as legacy terminology rather than the recommended setting for new code."

### Neural vs BM25: Technical Differences

| Dimension | BM25 / Keyword | Exa Neural |
|---|---|---|
| Matching mechanism | Token frequency and rarity (IDF) against document | Embedding cosine similarity in dense vector space |
| Query style that wins | Exact product names, specific terms, known titles | Descriptions, concepts, natural language, entity characteristics |
| Vocabulary mismatch | Fails completely if query terms differ from doc terms | Handles synonyms, paraphrases, conceptual equivalents |
| Entity retrieval | Good for exact entity names | Superior for "Series B fintech companies in Singapore" style |
| Academic paper retrieval | Needs title/author match | Can find a paper from a description of its findings |
| Publication search R@1 benchmark (Aug 2026) | Tavily (general web): 31.8% | Exa: 63.3% |

BM25 still wins for: exact product version strings, code snippet matching, precise error messages, known entity names where the query IS the document term.

The correct production strategy is hybrid: BM25 for exact-match lookups, neural/semantic for conceptual queries and entity discovery.

### Autoprompt (Legacy) and Modern Query Processing

Exa previously exposed an `autoprompt` parameter that rewrote queries into the neural-search-optimized form. The current API has removed this as a discrete parameter — the auto mode handles query rewriting internally without exposing it as a user-controllable option.

The underlying idea: neural search over web content works best when queries are phrased as descriptions of the content you want to find (e.g., "a blog post about the challenges of raising seed funding in 2026") rather than as search keywords ("seed funding challenges 2026"). The old autoprompt feature converted keyword-style queries into this form. Current `auto` mode does this transparently.

---

## 3. Search Types and Latency Profiles

Exa offers six search types spanning three orders of latency magnitude:

| Type | Approx Latency | Best For | Pricing |
|---|---|---|---|
| `instant` | ~250ms (p50), 437ms (p99) | Real-time apps: chat, voice, autocomplete | Standard Search rate |
| `fast` | ~450ms | Speed with minimal quality sacrifice | Standard Search rate |
| `auto` | ~1 second | Default; balanced speed and quality | Standard Search rate |
| `deep-lite` | ~4 seconds | Lightweight synthesized output | Deep Search rate |
| `deep` | 4–15 seconds | Multi-step reasoning, structured outputs | Deep Search rate |
| `deep-reasoning` | 12–40 seconds | Maximum reasoning for hard research tasks | Deep Search rate |

**Source:** docs.exa.ai, exa.ai/pricing

### Latency Benchmark Data (July 2026)

Measured from independent AWS environments, 333 calls per provider:

| Provider | p50 | p90 | p99 |
|---|---|---|---|
| Exa Instant | 235ms | 263ms | 437ms |
| Tavily ultra-fast | 245ms | 334ms | 576ms |

Exa is **27% faster at p90 and 32% faster at p99** vs Tavily's fastest tier. For chained agent loops where tail latency sets the total budget, this gap compounds.

**Source:** exa.ai/versus/tavily

### Latency Modifiers (Stack on Top of Base Type)

- `outputSchema` present: adds synthesis latency on every search type, not just deep variants
- `contents.maxAgeHours: 0`: forces live crawl, increases latency significantly
- `contents.maxAgeHours: 720`: returns cached version, very fast

**Optimization rule:** For real-time paths, use `type: "fast"` or `"instant"`, omit `outputSchema`, and omit `maxAgeHours`. Add them back only when synthesis or freshness is required.

---

## 4. Complete Search API Reference

**Endpoint:** `POST https://api.exa.ai/search`
**Auth:** `Authorization: Bearer $EXA_API_KEY` or `x-api-key: $EXA_API_KEY`

### Request Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | **required** | Natural language search query. Supports long, semantically rich descriptions. |
| `type` | string | `"auto"` | Search method: `auto`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning` |
| `stream` | boolean | `false` | Return SSE stream with OpenAI-compatible chat completion chunks |
| `numResults` | integer | 10 | Number of results (1–100; Enterprise: up to 1000) |
| `category` | string | — | Restrict to: `company`, `people`, `publication`, `news`, `personal site`, `financial report` |
| `userLocation` | string | — | Two-letter ISO country code (e.g., `"US"`) for geo-relevance |
| `includeDomains` | string[] | — | Only return results from these domains (max 1200). Accepts full domains, path prefixes (`exa.ai/blog`), and subdomain wildcards (`*.substack.com`) |
| `excludeDomains` | string[] | — | Exclude results from these domains (max 1200) |
| `startPublishedDate` | string | — | ISO 8601. Only return links published after this date |
| `endPublishedDate` | string | — | ISO 8601. Only return links published before this date |
| `startCrawlDate` | string | — | ISO 8601. Filter by when Exa crawled the page (not publication date) |
| `endCrawlDate` | string | — | ISO 8601. Filter by crawl date end |
| `includeText` | string[] | — | Text must contain these phrases |
| `excludeText` | string[] | — | Text must not contain these phrases |
| `moderation` | boolean | `false` | Filter unsafe content from results |
| `additionalQueries` | string[] | — | Extra query variations for deep-search variants only |
| `systemPrompt` | string | — | Instructions guiding synthesized output and, for deep-search variants, search planning |
| `outputSchema` | object | — | JSON schema for synthesized `output.content`. When provided, response includes `output` field |
| `compliance` | string | — | Enterprise-only. `"hipaa"` for HIPAA mode. Requires `instant` or `fast`. Cache-only; no summaries or livecrawl |
| `contents` | object | — | See Contents Parameters below |

### Contents Parameters (nested under `contents`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `contents.text` | boolean or object | — | Return full page text as markdown. Object: `{maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections}` |
| `contents.highlights` | boolean or object | — | Return key excerpts relevant to query. `true` for best defaults. Object: `{query, maxCharacters}` |
| `contents.summary` | boolean or object | — | LLM-generated summary. Object: `{query, schema}` |
| `contents.livecrawlTimeout` | integer | 10000 | Timeout for livecrawling in ms |
| `contents.maxAgeHours` | integer | — | Max age of cached content in hours. `0` = always livecrawl. `-1` = never livecrawl. Omit = livecrawl as fallback |
| `contents.subpages` | integer | 0 | Number of subpages to crawl per result |
| `contents.subpageTarget` | string or string[] | — | Keywords to prioritize when selecting subpages |
| `contents.extras.links` | integer | 0 | Number of URLs to extract from each page |
| `contents.extras.imageLinks` | integer | 0 | Number of image URLs to extract from each page |

### Text Object Options (when `contents.text` is an object)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxCharacters` | integer | — | Character limit for returned text |
| `includeHtmlTags` | boolean | `false` | Preserve HTML tags in output |
| `verbosity` | string | `"compact"` | `compact`, `standard`, or `full` |
| `includeSections` | string[] | — | Only include: `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata`. Requires `maxAgeHours: 0` |
| `excludeSections` | string[] | — | Exclude these page sections. Same options as `includeSections` |

### Highlights Object Options

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Custom query that guides which highlights are returned (defaults to the main search query) |
| `maxCharacters` | integer | — | Cap on total highlight characters per URL. Omit unless you need a specific budget |

### Summary Object Options

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Custom query for the summary |
| `schema` | object | JSON Schema for structured summary output |

### Output Schema

For any search type, use `outputSchema` to control the shape of `output.content`:

- `{"type": "text", "description": "..."}` — returns plain text synthesis
- `{"type": "object", "properties": {...}, "required": [...]}` — returns structured JSON

The `output` field in the response contains the synthesized result. Available on all search types; deep variants produce better synthesis.

### Response Shape

```typescript
interface ExaSearchResponse {
  requestId: string;
  resolvedSearchType: string;
  results: ExaResult[];
  output?: {
    content: string | object;  // Present when outputSchema was provided
  };
  costDollars?: {
    total: number;
    search: { neural: number; keyword: number };
    contents?: { text?: number; highlights?: number; summary?: number };
  };
}

interface ExaResult {
  id: string;
  url: string;
  title: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  summary?: string;
  highlights?: string[];
  highlightScores?: number[];
  text?: string;
  image?: string;
  favicon?: string;
  extras?: {
    links?: string[];
    imageLinks?: string[];
  };
}
```

### Minimal Working Examples

```typescript
import Exa from "exa-js";

const exa = new Exa(process.env.EXA_API_KEY);

// Basic search with highlights
const result = await exa.search("latest developments in AI agents", {
  type: "auto",
  contents: { highlights: true },
});

// Domain-filtered news search
const news = await exa.search("latest product announcements", {
  includeDomains: ["techcrunch.com", "wired.com"],
  startPublishedDate: "2026-01-01",
  contents: { highlights: { maxCharacters: 4000 } },
});

// Deep search with structured output
const structured = await exa.search("top aerospace companies", {
  type: "deep",
  outputSchema: {
    type: "object",
    required: ["companies"],
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          required: ["company_name", "ceo_name"],
          properties: {
            company_name: { type: "string" },
            ceo_name: { type: "string" },
          },
        },
      },
    },
  },
});

// Force live crawl for freshness
const fresh = await exa.search("What is the current Fed interest rate?", {
  contents: {
    highlights: true,
    maxAgeHours: 0,
  },
});

// Company research
const companies = await exa.search(
  "agtech companies in the US that have raised Series A",
  {
    type: "auto",
    category: "company",
    contents: { highlights: true },
  }
);
```

### cURL Example

```bash
curl -s -X POST "https://api.exa.ai/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EXA_API_KEY" \
  -d '{
    "query": "latest developments in LLMs",
    "type": "auto",
    "contents": {
      "highlights": true,
      "maxAgeHours": 24
    }
  }' | jq
```

---

## 5. Contents API: Highlights, Summaries, Full Text

The Contents API (`POST https://api.exa.ai/contents`) retrieves content from URLs directly, separate from search. This allows fetching content for URLs you already know.

**Endpoint:** `POST https://api.exa.ai/contents`

```typescript
const contents = await exa.getContents(
  ["https://example.com/article", "https://another.com/page"],
  {
    highlights: true,
    text: { maxCharacters: 10000 },
    summary: { query: "What are the key findings?" },
  }
);
```

### Highlights: How They Work

Highlights are Exa's most important content innovation. They extract query-relevant excerpts from web pages using a custom-trained extraction model.

**Technical properties of Highlights:**
- Run per-request against the main query (not cached — different queries on the same URL return different highlights)
- Complete in under 100ms
- Process the full page content, not just a summary
- Are especially effective on long technical documents (API references, SDK docs, research papers)

**Benchmark performance (SimpleQA, April 2026):**
- 500 characters of Exa Highlights = same accuracy as first 8,000 characters of page text
- 16x fewer tokens for equivalent retrieval quality
- 4,000 characters of highlights beats 32,000 characters of full text

**On long-context coding documents:**
- At 500-character budget: Highlights 60% accuracy vs full text 6%
- The model specifically targets the relevant passage in tens of thousands of tokens of boilerplate

**Source:** exa.ai/blog/highlights-for-agents (Exa Team, Apr 22, 2026)

**What Highlights are NOT:**
- Not sub-sentence clause extraction (unlike what their early demo suggested)
- On real-world prose, they often return section-level blobs, not individual clauses
- Quality varies by page type: excellent on technical docs, weaker on some narrative prose

**Source:** queryburst.com/blog/exa-highlights/ — independent reverse-engineering analysis

### Three Content Modes Compared

| Mode | Best For | Token Efficiency | Quality |
|---|---|---|---|
| `highlights: true` | Factual questions, agent workflows, multi-step search | Highest (16x vs full text) | High for factual extraction |
| `summary: { query }` | Quick overviews, structured extraction | Medium | Good for synthesis |
| `text: { maxCharacters }` | Deep analysis, full context required | Lowest | Highest completeness |

**Decision rule for agent workflows:**
- Use `highlights` by default — it's the best tradeoff for agent loops
- Use `text` when you don't know which part of the page matters
- Use `summary` when you want Exa's LLM to synthesize, not just extract

### Highlights Processing Architecture (Inferred from Public Data)

Exa processes ~25 trillion tokens per week through the Highlights model. The model:
1. Takes the full page content and the query
2. Identifies and scores passages by relevance to the query
3. Returns the top passages within the character budget

The model runs entirely server-side on Exa's infrastructure. It is not an LLM call in the traditional sense — it is a specialized extraction model trained specifically for this task, which is why it completes in under 100ms.

Highlights also power Exa's internal agentic products (`/answer`, Deep Search, Websets). Every agent loop iteration inside Exa reads highlights, not raw page content — this is why their agentic products are competitive on both latency and cost.

### Subpage Crawling

```typescript
const withSubpages = await exa.search("company documentation", {
  includeDomains: ["docs.somecompany.com"],
  contents: {
    text: true,
    subpages: 3,
    subpageTarget: ["API reference", "getting started"],
  },
});
```

`subpageTarget` guides which links on the page Exa follows when crawling subpages. Useful for finding documentation sections without knowing exact URLs.

---

## 6. Answer Endpoint

**Endpoint:** `POST https://api.exa.ai/answer`
**Pricing:** $5 per 1,000 requests

The Answer endpoint performs the full RAG pipeline in one call: search, extract, generate answer, attach citations. Use it when you want a direct answer, not ranked results.

**When to use Answer vs Search:**
- **Answer**: Application wants one synthesized response with citations; single-turn Q&A
- **Search**: Application wants to process results itself; multi-step agent loops; custom filtering

### Request Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | **required** | Natural-language question |
| `stream` | boolean | `false` | SSE stream for progressive rendering |
| `text` | boolean | `false` | Include full page text with citations |
| `outputSchema` | object | — | JSON Schema for structured answer output |

### Response Shape

```json
{
  "answer": "$350 billion.",
  "requestId": "b5947044c4b78efa9552a7c89b306d95",
  "citations": [
    {
      "title": "SpaceX valued at $350bn...",
      "url": "https://www.theguardian.com/...",
      "publishedDate": "2024-12-11T01:36:32.547Z",
      "author": "...",
      "id": "...",
      "image": "...",
      "favicon": "...",
      "text": "..."
    }
  ],
  "costDollars": {
    "total": 0.007,
    "search": { "neural": 0.007, "keyword": 0.0025 },
    "contents": { "highlights": 0.001 }
  }
}
```

### Structured Answer with Schema

```typescript
const answer = await exa.answer("What are the top 3 AI companies by valuation?", {
  outputSchema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            valuation: { type: "string" },
            lastFundingRound: { type: "string" },
          },
          required: ["name", "valuation"],
        },
      },
    },
    required: ["companies"],
  },
});
```

### Streaming Answer

```typescript
const stream = await exa.answer("What happened at the 2026 AI Safety Summit?", {
  stream: true,
});
// Returns SSE stream with OpenAI-compatible chat completion chunks
```

**Limitation:** `/answer` cannot return 501 if it's unable to generate a response for the query with available information (tag: `UNABLE_TO_GENERATE_RESPONSE`). Build fallback handling.

---

## 7. Agent API (Deep Research)

**Endpoint:** `POST https://api.exa.ai/research/v1`
**Pricing:** Usage-based by effort level (see Pricing section)

The Agent API is an asynchronous, long-running multi-step research primitive. Unlike `/search`, it executes multiple search iterations, reasons across sources, and synthesizes structured output. Designed for tasks that require more than a single search call.

**Capabilities:**
- Multi-hop reasoning: queries build on previous search results
- List building and entity enrichment at scale
- Structured output with JSON schema constraints
- Exa Connect: access to third-party data providers (LinkedIn data, SimilarWeb, Crunchbase) from within the same agent run
- Continuation: pick up from a previous run using `previousRunId`

### Agent Effort Levels

| Effort | Pricing | Use Case |
|---|---|---|
| `minimal` | $0.012/request | Quick lookups |
| `low` | $0.025/request | Default; simple research |
| `medium` | $0.10/request | Standard multi-step tasks |
| `high` | $0.50/request | Complex synthesis |
| `xhigh` | $1.00/request | Deep exhaustive research |
| `auto` | Variable | Exa scales to task (default) |

Additional billing: $0.10/ACU (Agent Compute Unit), $0.005/search tool call, $0.02/email enrichment, $0.07/phone enrichment.

### Agent Run Lifecycle

```typescript
// Create and wait for agent run (MCP agent_run tool wraps this)
const run = await exa.agent.create({
  query: "List all Series B AI infrastructure companies in Europe in 2026",
  effort: "medium",
  outputSchema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            country: { type: "string" },
            fundingAmount: { type: "string" },
            focus: { type: "string" },
          },
        },
      },
    },
  },
});

// Poll for completion
let result;
while (true) {
  result = await exa.agent.get(run.id);
  if (result.status === "completed" || result.status === "failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}

if (result.status === "completed") {
  console.log(result.output.structured); // JSON matching schema
  console.log(result.output.grounding); // Citation sources
}
```

### Agent with Exa Connect Data Sources

```typescript
const enrichedRun = await exa.agent.create({
  query: "Enrich this list of startup names with funding and headcount data",
  input: {
    data: ["Mistral AI", "Imbue", "Cohere"],
  },
  dataSources: ["crunchbase", "similarweb"],
  effort: "medium",
  outputSchema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            totalFunding: { type: "string" },
            headcount: { type: "number" },
            monthlyWebVisitors: { type: "number" },
          },
        },
      },
    },
  },
});
```

### Long-Running Runs (>750s Timeout)

If a run exceeds the call window, the API returns `status: "running"` with the run ID instead of timing out. Retry by passing `runId`:

```typescript
// Initial call
let result = await exa.agent.create({ query: "...", effort: "xhigh" });

// If result.status === "running", the run is still executing server-side
// Keep waiting:
if (result.status === "running") {
  result = await exa.agent.get(result.id);
}
```

---

## 8. Monitors API

**Endpoint:** `https://api.exa.ai/monitors`
**Pricing:** $15 per 1,000 requests

Monitors are scheduled recurring Exa searches. They run automatically, deduplicate results against previous runs, and deliver new results via webhook.

**Use cases:** Competitive intelligence, news monitoring, lead discovery, price change tracking.

### Monitor Lifecycle

```typescript
import Exa from "exa-js";
const exa = new Exa(process.env.EXA_API_KEY);

// 1. Create monitor
const monitor = await exa.monitors.create({
  name: "AI startup funding rounds",
  search: {
    query: "AI startups that raised Series A funding",
    numResults: 10,
    category: "news",
  },
  trigger: {
    type: "interval",
    interval: "daily",
  },
  outputSchema: {
    type: "object",
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            company: { type: "string" },
            amount: { type: "string" },
            investors: { type: "string" },
          },
        },
      },
    },
  },
  webhook: {
    url: "https://your-app.com/webhook",
  },
});

// Store webhookSecret immediately — only returned once
const secret = monitor.webhookSecret;

// 2. Trigger manually (for testing)
await exa.monitors.trigger(monitor.id);

// 3. Poll for run completion
let latest;
while (true) {
  const runs = await exa.monitors.runs.list(monitor.id);
  latest = runs.data[0];
  if (latest.status === "completed" || latest.status === "failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}
```

### Monitor Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/monitors` | Create monitor (returns `webhookSecret` once) |
| GET | `/monitors` | List monitors (pagination via `cursor`) |
| GET | `/monitors/{id}` | Get single monitor |
| PATCH | `/monitors/{id}` | Update monitor (partial update) |
| DELETE | `/monitors/{id}` | Delete monitor |
| POST | `/monitors/{id}/trigger` | Trigger immediate run |
| POST | `/monitors/batch` | Batch action: delete/pause/unpause by filter |
| GET | `/monitors/{id}/runs` | List runs |
| GET | `/monitors/{id}/runs/{runId}` | Get single run |

### Webhook Signature Verification

```typescript
import { createHmac } from "crypto";

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `sha256=${expected}` === signature;
}

// In your webhook handler:
app.post("/webhook", (req, res) => {
  const sig = req.headers["x-exa-signature"] as string;
  const valid = verifyWebhookSignature(
    JSON.stringify(req.body),
    sig,
    process.env.MONITOR_WEBHOOK_SECRET!
  );
  if (!valid) return res.status(401).send("Invalid signature");
  // Process new results
  const { results, monitorId } = req.body;
  res.status(200).send("OK");
});
```

**Gotcha:** The `webhookSecret` is only returned in the create response. If you miss it, you must delete and recreate the monitor. Store it immediately in a secrets manager.

### Automatic Deduplication

Each monitor run automatically deduplicates against all previous runs. You only receive URLs that are genuinely new since the last run. This is a core monitor feature — you do not need to implement deduplication yourself.

---

## 9. Websets Product

Websets is Exa's structured data collection product built on top of the search API. Unlike raw search, Websets is designed for building verified lists of entities (companies, people, research papers) from the live web.

**Primary users:** GTM teams, researchers, data engineers building training datasets.

**How it works:**
1. Define an entity type and criteria in natural language
2. Exa's neural search finds matching entities
3. Each result is verified against user-defined criteria
4. Results returned as structured, enriched records

**Key differentiator vs raw search:** Websets applies verification logic — results that match the query but fail defined criteria are excluded. This produces cleaner lists than raw search result sets.

**Use cases:**
- Sales prospecting: "B2B SaaS companies in Germany with 50-200 employees, raised Series A in 2025"
- Recruiting: "ML engineers in London with publications in NLP"
- Investment research: "Biotech companies focused on mRNA with recent FDA approvals"
- Training data collection: "Blog posts about financial modeling with Python examples"

**Source:** revuo.ai/category/mcp-web-search/exa-labs, aitoolsatlas.ai/tools/exa-websets/review

---

## 10. Category Filtering

Exa maintains proprietary specialized indexes for specific content categories. These are not just filters on the general web index — they are separate, curated datasets with custom embeddings.

### Category Index Sizes

| Category | Index Size | Update Frequency |
|---|---|---|
| `people` | 1B+ profiles | 50M+ weekly updates |
| `company` | 50M+ company pages | Regular |
| `publication` | 350M+ scholarly works | Regular |
| `news` | Current events | Near-real-time |
| `personal site` | Blogs, personal pages | Crawl-based |
| `financial report` | SEC filings, earnings | As published |

### Category Restrictions

| Category | Restrictions |
|---|---|
| `company` | Does NOT support `startPublishedDate`, `endPublishedDate`, `excludeDomains` |
| `people` | Does NOT support `startPublishedDate`, `endPublishedDate`, `excludeDomains` |
| `publication` | No restrictions |
| `news` | No restrictions |
| `personal site` | No restrictions |
| `financial report` | No restrictions |

### Publication Search Benchmark

Measured on LitSearch (597 queries, Aug 4, 2026) — identifying a paper from a description:

| Provider | R@1 |
|---|---|
| Exa (fast search type) | 63.3% |
| Perplexity | ~50% (estimated) |
| Tavily (advanced depth) | 31.8% |

The structural reason: Exa operates a 350M+ paper-specific index with academic-domain embeddings. Tavily uses general web retrieval, which frequently surfaces secondary summaries rather than primary papers.

**Source:** exa.ai/versus/tavily

### People and Company Benchmarks

| Metric | Exa | Tavily | Perplexity |
|---|---|---|---|
| People R@1 (200 queries) | 75.5% | 40.5% | 53.5% |
| Company R@1 (200 queries) | 81.5% | 61.3% | 69.3% |
| Company R@3 (200 queries) | 88.3% | 73.0% | 83.3% |

**When to use category filters:**

```typescript
// Find research papers about a topic
const papers = await exa.search(
  "transformer architecture improvements in NLP 2025",
  {
    category: "publication",
    contents: { highlights: true },
    startPublishedDate: "2025-01-01",
  }
);

// Find people in a specific role
const people = await exa.search(
  "machine learning engineers who have worked on recommendation systems",
  {
    category: "people",
    numResults: 20,
    contents: { highlights: true },
  }
);

// Find company pages
const companies = await exa.search(
  "climate tech startups focused on carbon capture that raised Series B",
  {
    category: "company",
    numResults: 15,
    contents: { highlights: true },
  }
);

// Find news about a topic with date range
const news = await exa.search("OpenAI GPT-5 release", {
  category: "news",
  startPublishedDate: "2026-01-01",
  endPublishedDate: "2026-06-01",
  contents: { highlights: true },
});
```

---

## 11. MCP Server Implementations

### Official Exa MCP Server

**Endpoint:** `https://mcp.exa.ai/mcp`
**GitHub:** github.com/exa-labs/exa-mcp-server
**npm:** `exa-mcp-server`

The official MCP server is open-source and hosted. It is listed in the Model Context Protocol registry.

**Default tools:**
- `web_search_exa`: Search the web and get clean, ready-to-use content
- `web_fetch_exa`: Read webpage full content as clean markdown from one or more URLs

**Optional tools (enable via URL parameter):**
- `agent_run`: Multi-step research, list-building, enrichment, and structured output
- `web_search_advanced_exa`: Full Search API with category filters, domain restrictions, date ranges, highlights, summaries, and subpage crawling

### Installation Patterns

**Remote HTTP (recommended for most clients):**
```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp"
    }
  }
}
```

**With API key for production use:**
```json
{
  "exa": {
    "url": "https://mcp.exa.ai/mcp",
    "headers": {
      "x-api-key": "YOUR_EXA_API_KEY"
    }
  }
}
```

**Enabling specific tools only:**
```
https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,agent_run
```

**npm package (for clients without remote MCP support):**
```json
{
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server"],
      "env": {
        "EXA_API_KEY": "your_api_key"
      }
    }
  }
}
```

**mcp-remote bridge (for stdio-only clients):**
```json
{
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"]
    }
  }
}
```

### Client-Specific Configurations

| Client | Config location | URL key |
|---|---|---|
| Cursor | `~/.cursor/mcp.json` | `url` |
| VS Code | `.vscode/mcp.json` | `url` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` | `url` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` | `url` |
| Claude Code | `claude mcp add --transport http exa https://mcp.exa.ai/mcp` | CLI |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `serverUrl` |
| Zed | `settings.json` → `context_servers` | `url` |
| Gemini CLI | `~/.gemini/settings.json` | `httpUrl` |
| Warp | Settings → MCP Servers | `url` |

### Claude Code Plugin

Exa also ships as a Claude Code plugin that bundles the MCP server with agent skills:

```bash
claude plugin install exa@claude-plugins-official
```

Or via `/plugin` → search for Exa → install.

### Community Implementations

**waldzellai/exa-mcp-docs** (GitHub) — MCP server that provides the Exa API documentation itself to coding agents. Useful for building Exa integrations with AI assistance.

**badlogic/exa-search** — Community implementation of token-efficient search tools for agents using the Exa API.

**simonpierreboucher02/agentilab-exa** — Community integration guide and API docs (tested behavior as of 2026).

**Source:** github.com/waldzellai/exa-mcp-docs, github.com/badlogic/exa-search

---

## 12. SDK Reference

### TypeScript/JavaScript SDK

**Package:** `exa-js`
**Install:** `npm install exa-js`

```typescript
import Exa from "exa-js";

// Initialize (reads EXA_API_KEY from env by default)
const exa = new Exa(process.env.EXA_API_KEY);
const exa = new Exa(); // Uses EXA_API_KEY env var

// Core methods
exa.search(query: string, options?: SearchOptions): Promise<SearchResponse>
exa.getContents(urls: string[], options?: ContentsOptions): Promise<ContentsResponse>
exa.answer(query: string, options?: AnswerOptions): Promise<AnswerResponse>
exa.monitors.create(params): Promise<Monitor>
exa.monitors.trigger(monitorId: string): Promise<{triggered: boolean}>
exa.monitors.runs.list(monitorId: string): Promise<RunsList>
exa.agent.create(params): Promise<AgentRun>
exa.agent.get(runId: string): Promise<AgentRun>
```

### Python SDK

**Package:** `exa-py`
**Install:** `pip install exa-py`

```python
from exa_py import Exa

exa = Exa()  # Uses EXA_API_KEY env var

# Search
result = exa.search(
    "blog post about artificial intelligence",
    type="auto",
    contents={"highlights": True},
)

# Contents
contents = exa.get_contents(
    ["https://example.com"],
    highlights=True,
    text={"max_characters": 5000},
)

# Answer
answer = exa.answer("What is the current state of fusion energy?")
```

---

## 13. Pricing

Source: exa.ai/pricing (fetched Aug 2026)

### Endpoint Pricing

| Endpoint | Base (up to 10 results, per 1k requests) | Cost per additional result above 10 (per 1k requests) | AI page summaries (per 1k pages) |
|---|---|---|---|
| Search | $7 | $1 | $1 |
| Deep Search | $12 | $1 | $1 |
| Deep-Reasoning Search | $15 | $1 | $1 |
| Contents | $1 (per 1k pages) | — | $1 |
| Monitors | $15 | $1 | $1 |
| Answer | $5 | — | — |

### Agent Pricing

| Component | Price |
|---|---|
| Agent Compute Units | $0.10 per ACU |
| Search tool calls | $0.005 per search |
| Email contact enrichment | $0.02 per email |
| Phone contact enrichment | $0.07 per phone |

**Fixed effort modes:**

| Effort | Price |
|---|---|
| `minimal` | $0.012/request |
| `low` | $0.025/request |
| `medium` | $0.10/request |
| `high` | $0.50/request |
| `xhigh` | $1.00/request |

*Contact enrichment billed separately on top of these rates.*

### Tier Structure

**Starter (Free):**
- $20 credits on sign-up + $10 credits/month
- No payment method required
- MCP server access, all endpoints
- 5 Search QPS, 3 Agent concurrency

**Developer (Pay-as-you-go):**
- No commitment, per-request pricing
- 10 Search QPS, 25 Agent concurrency
- SOC 2 Type II

**Enterprise (Custom):**
- Custom MSA and DPA
- Zero data retention
- SOC 2 Type II + HIPAA
- Up to 1,000 results per search
- Custom QPS, dedicated Slack support
- Custom indexes, Exa Connect premium providers

### Cost Modeling for Agent Loops

A typical agent that does 10 searches with highlights per task:

```
10 searches × $7/1000 = $0.07
10 highlight fetches × $1/1000 = $0.01
Total: ~$0.08 per agent task
```

A deep research agent task (1 deep search + agent run at medium effort):

```
1 deep search × $12/1000 = $0.012
1 agent run at medium = $0.10
Total: ~$0.11 per deep research task
```

**At scale:** 100,000 search queries/month = $700/month at standard rates. Enterprise contracts reduce this for high-volume customers.

**Unpredictability warning:** Usage-based pricing with variable query volumes can generate surprise monthly bills. Build cost tracking into your implementation from day one. The `costDollars` field in responses helps with attribution.

---

## 14. Rate Limits and Error Handling

### Default Rate Limits

| Endpoint | Limit |
|---|---|
| `/search` | 10 QPS |
| `/contents` | 100 QPS |
| `/answer` | 10 QPS |
| `/research/v1` | 25 concurrent runs (Developer) |

Enterprise customers get custom QPS limits. Contact sales@exa.ai to increase.

### Error Codes Reference

| HTTP Status | Tag | Cause | Action |
|---|---|---|---|
| 400 | `INVALID_REQUEST_BODY` | Malformed JSON, missing fields, invalid enum values | Check request body format |
| 400 | `INVALID_REQUEST` | Conflicting parameters (e.g., `additionalQueries` with non-deep type) | Check parameter compatibility |
| 400 | `INVALID_NUM_RESULTS` | `numResults > 100` when using highlights | Reduce numResults |
| 400 | `NUM_RESULTS_EXCEEDED` | Requested results exceed plan limit | Upgrade plan |
| 400 | `NO_CONTENT_FOUND` | No contents found for given URLs | Verify URLs are accessible |
| 401 | `INVALID_API_KEY` | Missing or invalid API key | Check API key |
| 402 | `NO_MORE_CREDITS` | Account credits exhausted | Top up at dashboard.exa.ai |
| 402 | `API_KEY_BUDGET_EXCEEDED` | API key spending budget exceeded | Contact team admin |
| 402 | `TEAM_BUDGET_EXCEEDED` | Team billing period budget exceeded | Contact team admin |
| 403 | `ACCESS_DENIED` | Feature requires permission flag | Check plan features |
| 403 | `FEATURE_DISABLED` | Feature disabled for plan | Upgrade plan |
| 403 | `ROBOTS_FILTER_FAILED` | All requested URLs blocked by robots.txt | Use different URLs |
| 403 | `PROHIBITED_CONTENT` | Content safety block | Rephrase query |
| 404 | Not Found | Resource doesn't exist | Verify resource ID |
| 409 | Conflict | Resource already exists (e.g., Webset with same externalId) | Use different identifier |
| 422 | `FETCH_DOCUMENT_ERROR` | Specific URL could not be processed | Check URL accessibility |
| 429 | Rate limit exceeded | Too many requests | Exponential backoff |
| 500 | `DEFAULT_ERROR` | Server error | Retry after brief wait |
| 501 | `UNABLE_TO_GENERATE_RESPONSE` | `/answer` only: model couldn't generate response | Rephrase query |

### Error Response Structure

```json
{
  "requestId": "67207943fab9832d162b5317f4cca830",
  "error": "Invalid request body | Validation error: Invalid enum value. Expected 'auto' | 'fast' | 'instant' | 'deep-lite' | 'deep' | 'deep-reasoning', received 'slow' at \"type\"",
  "tag": "INVALID_REQUEST_BODY"
}
```

Always include `requestId` when contacting support.

### Retry Pattern

```typescript
async function searchWithRetry(
  query: string,
  options: SearchOptions,
  maxRetries = 3
): Promise<SearchResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await exa.search(query, options);
    } catch (error: any) {
      if (error.status === 429) {
        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (error.status === 402) {
        throw new Error("Exa credits exhausted — top up at dashboard.exa.ai");
      }
      if (error.status >= 500) {
        // Transient server error, retry once
        if (attempt < maxRetries - 1) continue;
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}
```

### Common Mistakes (from Official Docs)

1. **Using deprecated `type: "neural"`** — Use `type: "auto"` instead
2. **Setting `additionalQueries` with non-deep search type** — 400 error; `additionalQueries` only works with `deep-lite`, `deep`, `deep-reasoning`
3. **Using `includeDomains`/`excludeDomains` with `company` or `people` category** — These categories don't support domain filtering
4. **Using date filters with `company` or `people` category** — Not supported
5. **Setting `numResults > 100` with highlights** — 400 error `INVALID_NUM_RESULTS`
6. **Forgetting to store `webhookSecret`** — Only returned once on monitor creation
7. **Using `maxAgeHours` without expecting latency increase** — Live crawl adds significant latency
8. **Querying `includeSections`/`excludeSections` on cached content** — Requires `maxAgeHours: 0`

---

## 15. Data Freshness and Crawl Policies

Exa's index contains pages at varying levels of freshness. The `maxAgeHours` parameter controls the freshness guarantee vs. latency tradeoff.

### Freshness Control

| Setting | Behavior | Latency Impact |
|---|---|---|
| `maxAgeHours: 0` | Always livecrawl — fetch page right now | High (+seconds) |
| `maxAgeHours: 1` | Use cache if crawled within last hour, else livecrawl | Medium |
| `maxAgeHours: 24` | Use cache if crawled within 24h, else livecrawl | Low-medium |
| `maxAgeHours: 720` | Use cache if crawled within 30 days, else livecrawl | Very fast |
| `maxAgeHours: -1` | Never livecrawl — use cache only | Fastest |
| Omitted | Livecrawl as fallback (default behavior) | Varies |

**When freshness matters:**
- Financial data: `maxAgeHours: 0`
- News: `maxAgeHours: 1` to `maxAgeHours: 4`
- Technical documentation: `maxAgeHours: 168` (1 week) is usually fine
- Company/people research: default or `maxAgeHours: 720`

### Index Recrawl Frequency

Exa does not publish a fixed recrawl schedule. The index tracks 1.4T URLs. High-signal pages (news, major publications) are crawled more frequently. Niche pages may have stale cached versions.

**Practical implication:** For production agents where data freshness is business-critical, always specify `maxAgeHours: 0` and budget for the latency increase. For cost-sensitive workflows, use a moderate `maxAgeHours` (e.g., `24` or `72`) and only force live crawl on specific queries.

### Content Fetch Status Tags

When contents fail to load, the result includes a `fetchStatus` field:

- `upToDate`: Content fetched and current
- `cachedOld`: Content from cache, may be stale
- `failed`: Content could not be fetched
- `blocked`: robots.txt blocked the crawl

---

## 16. Exa vs Competitors

### Exa vs Tavily

Tavily was acquired by Nebius (Amsterdam AI cloud) for $275M in February 2026. Exa remains independent.

| Dimension | Exa | Tavily |
|---|---|---|
| Search index | Proprietary (1.4T URLs, built from scratch) | General web (resells/licenses search) |
| People search R@1 | 75.5% | 40.5% |
| Company search R@1 | 81.5% | 61.3% |
| Publication search R@1 | 63.3% | 31.8% |
| Latency p50 (fastest tier) | 235ms | 245ms |
| Latency p99 (fastest tier) | 437ms | 576ms |
| includeDomains limit | 1,200 | 300 |
| excludeDomains limit | 1,200 | 150 |
| Content extraction | Query-selected highlights (16x token efficiency) | Static page text extraction |
| Token efficiency | Highlights: 500 chars ≈ 8000 chars full text | Full page, token filtering is your problem |
| Developer base | 400K+ developers | 2M+ developers |
| Funding | $361M (a16z Series C) | $275M (Nebius acquisition) |
| SOC 2 Type II | Yes | Yes |
| HIPAA | Yes (Enterprise) | Not published |
| Pricing | $7/1k search, $1/1k contents | Credit-based, ~$0.008/basic search |

**When to choose Exa:** Entity-specific retrieval (people, companies, papers), agent loops where tail latency compounds, token-efficient content extraction, large domain allowlists.

**When to choose Tavily:** Bundled full-page text at search price, large developer ecosystem, Nebius cloud consolidation, simpler pricing model.

**Source:** exa.ai/versus/tavily (Exa's benchmark page, benchmarks open-sourced at github.com/exa-labs/benchmarks)

### Exa vs Brave Search API

Brave Search API is keyword-oriented (traditional BM25-style), independently indexed, privacy-focused. It does not have neural semantic search capabilities, category-specific indexes, or an equivalent to Highlights. Brave is better for exact-match search at high volume and lower price. Exa wins on semantic accuracy, entity retrieval, and token efficiency.

### Exa vs SerpAPI / Google Custom Search

SerpAPI wraps Google results. It has better recall for well-known entities but has no semantic neural search, no Highlights, no category-specific indexes, and is subject to Google's robots.txt restrictions and rate limits. SerpAPI is for applications that specifically need Google's ranking; Exa is for AI agent grounding.

### Exa vs Perplexity API

Perplexity's API is primarily designed for end-user answer generation, not for raw retrieval in agent pipelines. It does not expose the underlying search results with the same granularity. Exa's API is more composable for building custom agent workflows.

---

## 17. Implementing Exa-Style Neural Search Locally

For use cases where you cannot or do not want to call Exa (self-hosted enterprise knowledge index, offline operation, cost control), here is how to implement the core patterns.

### Core Neural Search with sentence-transformers

```typescript
// Using @xenova/transformers (runs in Node.js)
import { pipeline } from "@xenova/transformers";

class LocalNeuralSearch {
  private embedder: any;
  private documentEmbeddings: Float32Array[] = [];
  private documents: Array<{ url: string; title: string; content: string }> = [];

  async initialize() {
    this.embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }

  async addDocument(doc: { url: string; title: string; content: string }) {
    const embedding = await this.embed(doc.title + " " + doc.content);
    this.documentEmbeddings.push(embedding);
    this.documents.push(doc);
  }

  async search(query: string, topK = 10) {
    const queryEmbedding = await this.embed(query);

    const scores = this.documentEmbeddings.map((docEmb, idx) => ({
      idx,
      score: cosineSimilarity(queryEmbedding, docEmb),
    }));

    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map(({ idx, score }) => ({
      ...this.documents[idx],
      score,
    }));
  }

  private async embed(text: string): Promise<Float32Array> {
    const output = await this.embedder(text, {
      pooling: "mean",
      normalize: true,
    });
    return output.data;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Pre-normalized, so dot product = cosine similarity
}
```

### Hybrid BM25 + Neural (Production Pattern)

Pure neural search misses exact-match cases BM25 catches. Pure BM25 misses conceptual queries neural handles. The production pattern combines both via Reciprocal Rank Fusion:

```typescript
import { BM25 } from "wink-bm25-text-search";

class HybridSearch {
  private bm25: BM25;
  private neuralSearch: LocalNeuralSearch;

  async search(query: string, topK = 10) {
    // Run both in parallel
    const [bm25Results, neuralResults] = await Promise.all([
      this.bm25.search(query, topK * 2),
      this.neuralSearch.search(query, topK * 2),
    ]);

    // Reciprocal Rank Fusion
    const scores = new Map<string, number>();

    bm25Results.forEach((result, rank) => {
      const id = result.url;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
    });

    neuralResults.forEach((result, rank) => {
      const id = result.url;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
    });

    // Sort by RRF score
    return [...scores.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, topK)
      .map(([id]) => ({ url: id }));
  }
}
```

### Implementing Local Highlights (Exa-Style Extraction)

Based on the queryburst.com reverse-engineering analysis, here is a reasonable approximation of the Highlights extraction pattern:

```typescript
import { pipeline } from "@xenova/transformers";

class LocalHighlights {
  private embedder: any;

  async initialize() {
    this.embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }

  async extractHighlights(
    pageContent: string,
    query: string,
    maxCharacters = 4000
  ): Promise<string[]> {
    // 1. Split into sentences
    const sentences = this.splitSentences(pageContent);

    // 2. Generate HyDE (Hypothetical Document Embedding) for the query
    const hydeAnswer = await this.generateHyDE(query);

    // 3. Embed all sentences + HyDE
    const [sentenceEmbeddings, queryEmbedding] = await Promise.all([
      Promise.all(sentences.map((s) => this.embed(s))),
      this.embed(hydeAnswer),
    ]);

    // 4. Score sentences by cosine similarity to query
    const scored = sentences.map((sentence, idx) => ({
      sentence,
      score: cosineSimilarity(sentenceEmbeddings[idx], queryEmbedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    // 5. Take top sentences up to character budget
    const highlights: string[] = [];
    let charCount = 0;

    for (const { sentence, score } of scored) {
      if (score < 0.3) break; // Minimum relevance threshold
      if (charCount + sentence.length > maxCharacters) break;
      highlights.push(sentence);
      charCount += sentence.length;
    }

    return highlights;
  }

  private splitSentences(text: string): string[] {
    // Simple sentence splitter — in production, use a proper NLP library
    return text
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 50 && s.length < 1000)
      .map((s) => s.trim());
  }

  private async generateHyDE(query: string): Promise<string> {
    // Without an LLM, just use the query directly.
    // With an LLM: generate a hypothetical answer to the query,
    // embed that, and use it as the query embedding.
    // This significantly improves recall on factual queries.
    return query;
  }

  private async embed(text: string): Promise<Float32Array> {
    const output = await this.embedder(text, {
      pooling: "mean",
      normalize: true,
    });
    return output.data;
  }
}
```

**Key insight from reverse engineering:** Exa's Highlights are NOT a single neural model doing end-to-end extraction. They are likely a pipeline: page chunking + embedding lookup + ranking + extraction. The "sub-100ms" claim is plausible for this architecture (precomputed page embeddings at index time + ANN lookup at query time). The quality advantage comes from the specialized training data and embedding model, not from a fundamentally different architecture.

### Model Recommendations for Local Neural Search

| Use Case | Model | Notes |
|---|---|---|
| General semantic search | `all-MiniLM-L6-v2` | Fast, good quality, 384-dim |
| High-quality semantic search | `all-mpnet-base-v2` | Slower, better quality, 768-dim |
| Multi-lingual | `paraphrase-multilingual-MiniLM-L12-v2` | Good for enterprise with non-English content |
| Code search | `flax-sentence-embeddings/st-codesearch-distilroberta-base` | Trained on code |
| Academic papers | `allenai-specter` | Trained on scientific text |

**Source:** sbert.net/examples/semantic-search, huggingface.co sentence-transformers documentation

---

## 18. Relevance for markdown-for-agents-mcp

### What to Integrate Today (Phase 1)

**Primary recommendation: Exa as a first-class web provider.**

The `web_search` and `web_fetch` MCP tools in markdown-for-agents-mcp should offer Exa as an optional backend alongside Brave/SerpAPI. The integration is straightforward given Exa's TypeScript SDK.

**Tool design:**

```typescript
// Tool: web_search
// Params: query, type (auto|fast|instant|deep), category (optional), maxResults
// When Exa is configured as backend: call exa.search() with highlights
// Returns: array of {url, title, highlights[], publishedDate}

// Tool: web_fetch
// Params: urls[], mode (highlights|text|summary)
// When Exa is configured: call exa.getContents() 
// Returns: array of {url, content, highlights[]}
```

**Why Exa wins for the target use case (AI agents doing research):**
- 16x token reduction via Highlights is critical for multi-step agents on tight context budgets
- `category: "publication"` at 63.3% R@1 is significant for academic/technical research
- `category: "company"` at 81.5% R@1 is significant for enterprise intelligence workflows
- Sub-250ms instant search enables voice agent and real-time chat integration

**Configuration pattern:**

```typescript
interface ExaProviderConfig {
  apiKey: string;
  defaultSearchType: "auto" | "fast" | "instant";
  defaultContentsMode: "highlights" | "text";
  defaultHighlightsMaxChars: number; // 4000 recommended
  defaultMaxAgeHours?: number; // Omit for default behavior
}
```

### What Not to Build

**Skip implementing findSimilar locally.** The old Exa `findSimilar` endpoint (content-based similarity search — "find pages similar to this URL") appears to have been retired or restructured into the current API. The modern equivalent is using `search` with a description of the content. Do not build a custom URL-similarity feature — the use case is served by regular semantic search.

**Skip the Agent API for now.** At $0.012–$1.00/run it's expensive relative to doing multi-step search yourself. The Agent API makes sense for heavy enrichment workflows (GTM, lead gen), not for general agent web search. Phase 2 can add an `exa_deep_research` tool wrapping the Agent API.

**Skip Monitors.** At $15/1k this is expensive for basic use. More importantly, Monitors are a workflow automation product (scheduled push), not a retrieval primitive for AI agents. Not relevant for markdown-for-agents-mcp.

**Skip implementing Exa Highlights locally for Phase 2 enterprise knowledge index.** The local search for SharePoint/Confluence content should use a proper RAG pipeline (chunk → embed → ANN) rather than trying to replicate Exa's extraction model. Use the Highlights approach (embed query + find closest passage) but do not over-engineer it. `all-MiniLM-L6-v2` + cosine similarity is sufficient for the enterprise knowledge index use case.

### Phase 1 Integration Checklist

- [ ] Add `EXA_API_KEY` to env configuration
- [ ] Implement `ExaProvider` class wrapping `exa-js` SDK
- [ ] Map `web_search` tool to `exa.search()` with `contents.highlights: true`
- [ ] Map `web_fetch` tool to `exa.getContents()` with configurable mode
- [ ] Support `category` parameter passthrough for structured retrieval
- [ ] Support `includeDomains`/`excludeDomains` for scoped search
- [ ] Support `startPublishedDate`/`endPublishedDate` for temporal filtering
- [ ] Implement exponential backoff on 429 errors
- [ ] Track `costDollars` from responses for usage monitoring
- [ ] Set `maxAgeHours: 0` as option for freshness-critical tools

### Phase 2 Enterprise Knowledge Index

Exa's Highlights model is the clearest external proof-of-concept for the enterprise knowledge index's core value proposition: **dense, query-relevant extraction beats full-document retrieval**. The SimpleQA benchmark (500 chars highlights = 8000 chars full text accuracy) is a strong data point for pitching the enterprise index to stakeholders.

For the SharePoint/Confluence connector:
- Chunk documents at section boundaries (not fixed token windows)
- Pre-compute embeddings at index time (`all-mpnet-base-v2` for quality)
- At query time: embed query, ANN lookup, extract relevant sections
- Apply Entra ID `transitiveMemberOf` ACL check before returning results
- Surface as `enterprise_search` MCP tool alongside `web_search`

The key architectural insight from Exa: **do not give agents full documents**. Give them extracted, ranked passages. This is what makes the enterprise index 10x more useful than naive SharePoint keyword search.

### Competitive Positioning

If a prospect asks "why not just use Exa for everything?" — valid answer: Exa does not index your internal SharePoint or Confluence. Phase 2 of markdown-for-agents-mcp fills the gap between Exa's external web index and internal enterprise knowledge. The pitch is: Exa for the web, your index for your knowledge, one MCP interface for both.

---

## Appendix: Quick Reference

### All Exa API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `https://api.exa.ai/search` | POST | Neural + deep search |
| `https://api.exa.ai/contents` | POST | Content extraction from URLs |
| `https://api.exa.ai/answer` | POST | RAG answer with citations |
| `https://api.exa.ai/research/v1` | POST | Create async agent run |
| `https://api.exa.ai/research/v1/{id}` | GET | Get agent run status |
| `https://api.exa.ai/monitors` | POST/GET | Create/list monitors |
| `https://api.exa.ai/monitors/{id}` | GET/PATCH/DELETE | Manage monitor |
| `https://api.exa.ai/monitors/{id}/trigger` | POST | Trigger immediate run |
| `https://api.exa.ai/monitors/{id}/runs` | GET | List monitor runs |
| `https://mcp.exa.ai/mcp` | HTTP/SSE | Official MCP server |

### Valid Search Types

`auto` | `fast` | `instant` | `deep-lite` | `deep` | `deep-reasoning`

(Note: `neural` and `keyword` are legacy terms — do not use in new code)

### Valid Category Values

`company` | `people` | `publication` | `news` | `personal site` | `financial report`

### Authentication Headers

```
Authorization: Bearer $EXA_API_KEY
```
or
```
x-api-key: $EXA_API_KEY
```

Both work interchangeably.
