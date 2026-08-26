# Jina AI — Complete API Analysis for markdown-for-agents-mcp

**Research date:** 2026-08-26
**Sources:** jina.ai, github.com/jina-ai/reader, github.com/jina-ai/node-DeepResearch, api.jina.ai/openapi.json, direct API testing

---

## Table of Contents

1. [Overview and Strategic Position](#1-overview-and-strategic-position)
2. [Reader API — r.jina.ai](#2-reader-api--rjinaai)
3. [Search API — s.jina.ai](#3-search-api--sjinaai)
4. [Grounding / Fact-Check API — g.jina.ai](#4-grounding--fact-check-api--gjinaai)
5. [DeepSearch API](#5-deepsearch-api)
6. [Embeddings API](#6-embeddings-api)
7. [Reranking API](#7-reranking-api)
8. [Streaming](#8-streaming)
9. [Pricing and Rate Limits](#9-pricing-and-rate-limits)
10. [JS-Heavy Pages and Browser Engine](#10-js-heavy-pages-and-browser-engine)
11. [Multilingual Support](#11-multilingual-support)
12. [Self-Hosting Reader](#12-self-hosting-reader)
13. [Competitor Comparison](#13-competitor-comparison)
14. [Node.js / TypeScript Implementation Patterns](#14-nodejs--typescript-implementation-patterns)
15. [What to Build and What to Skip](#15-what-to-build-and-what-to-skip)
16. [Limitations, Failure Modes, and Gotchas](#16-limitations-failure-modes-and-gotchas)

---

## 1. Overview and Strategic Position

Jina AI is a Berlin-based ML company that has pivoted from a general-purpose neural search framework to a tightly focused "Search Foundation" product line. Their public APIs as of August 2026:

| API | Endpoint | What it does |
|-----|----------|-------------|
| Reader | `r.jina.ai` | URL → LLM-ready markdown |
| Search | `s.jina.ai` | Query → top-5 URLs each Reader'd |
| Grounding | `g.jina.ai` | Statement → fact-check via web |
| DeepSearch | `deepsearch.jina.ai` | OpenAI-compatible iterative search-reason loop |
| Embeddings | `api.jina.ai/v1/embeddings` | Text/image/audio/video → dense vectors |
| Reranker | `api.jina.ai/v1/rerank` | Query + docs → relevance-ranked list |

The company is research-backed (20 academic publications through 2026, published at NeurIPS, ICLR, SIGIR, ACL, AAAI, EMNLP). Their embedding and reranking models are state-of-the-art on MTEB and BEIR benchmarks. The Reader and Search APIs are MIT/Apache-2 licensed with a self-hosted open-source path.

**Relevance to markdown-for-agents-mcp:** Jina Reader is the most direct analogue to the web-fetch tool we implement. The patterns they've developed — caching, browser engine selection, CSS selector targeting, streaming — are exactly the patterns we need. Their pricing model (token-based, output-counted for reader) informs our own cost structure.

---

## 2. Reader API — r.jina.ai

### 2.1 Basic Usage

The simplest possible call requires no authentication:

```bash
# GET — just prepend the prefix
curl "https://r.jina.ai/https://example.com"

# POST — needed for hash-routed SPAs or local files
curl -X POST "https://r.jina.ai/" -d 'url=https://example.com/#/route'
```

Default response format:

```
Title: Example Domain

URL Source: https://example.com/

Published Time: Wed, 12 Aug 2026 20:17:18 GMT

Warning: This is a cached snapshot of the original page, consider retry with caching opt-out.

Markdown Content:
This domain is for use in documentation examples without needing permission. Avoid use in operations.

[Learn more](https://iana.org/domains/example)
```

The response has four structured fields: `Title`, `URL Source`, `Published Time` (when available), and `Markdown Content`. This is their default plain-text envelope — not JSON.

### 2.2 JSON Mode

```bash
curl -H "Accept: application/json" "https://r.jina.ai/https://example.com"
```

JSON response schema:

```typescript
interface JinaReaderResponse {
  code: number;       // HTTP status
  status: number;     // Same as code
  data: {
    title: string;
    url: string;      // Final URL after redirects
    content: string;  // Markdown content
    description?: string;
    publishedTime?: string;  // ISO 8601 when available
    images?: Record<string, string>;  // alt → url mapping
    links?: Record<string, string>;   // anchor → url mapping
  };
}
```

### 2.3 Complete Header Reference

This is the full set of request headers supported by `r.jina.ai` as of 2026-08. Headers are case-insensitive; the lowercase `x-` form is canonical.

#### Engine and Fetch Control

| Header | Values | Description |
|--------|--------|-------------|
| `X-Engine` | `auto` (default), `browser`, `curl` | `browser` = headless Chrome (Puppeteer); `curl` = lightweight curl-impersonate (no JS). `auto` picks intelligently. |
| `X-Timeout` | integer 1–180 | Max seconds to wait for page load. Setting ≥20 implies `network-idle` timing. |
| `X-Respond-Timing` | `html`, `visible-content`, `mutation-idle`, `resource-idle` (default), `media-idle`, `network-idle` | When to consider page ready. Later = more complete, slower. |
| `X-No-Cache` | `true` | Bypass the 3600s cache — forces a fresh fetch. |
| `X-Cache-Tolerance` | integer seconds | Accept cached content if younger than N seconds. `0` is equivalent to `X-No-Cache: true`. |
| `DNT` | `true` | Do Not Cache or Track — prevents caching and logging on Jina's servers. |
| `X-Proxy-Url` | URL string | Route through your proxy. Supports `http`, `https`, `socks4`, `socks5`. `http://user:pass@host:port` format for auth. |
| `X-Proxy` | country code, `auto`, `none` | Use Jina's hosted proxy pool. `auto` = optimal selection. Country codes like `us`, `de`, `gb`. Requires premium key. |
| `X-User-Agent` | UA string | Override browser User-Agent. |
| `X-Referer` | URL | Set HTTP Referer header. |
| `X-Set-Cookie` | cookie string | Forward cookies to the target site. Format: `name=value` or `name=value; domain=host`. Disables caching. |
| `X-Locale` | BCP-47 locale | Browser locale, e.g. `de-DE`, `fr-FR`. Affects `navigator.language` and `Accept-Language`. |
| `X-Robots-Txt` | bot name | Check robots.txt before fetching using this bot name. |
| `X-Base` | `final` | Resolve relative URLs using the final URL after redirects rather than the original. |

#### Content Selection

| Header | Values | Description |
|--------|--------|-------------|
| `X-Target-Selector` | CSS selector string | Extract only content matching selector. Also acts as a wait-for-selector. |
| `X-Wait-For-Selector` | CSS selector string | Wait until element appears before extracting. |
| `X-Remove-Selector` | CSS selector string | Remove matching elements before extraction. Multiple: `nav, footer, .ads` |
| `X-With-Iframe` | `true`, `quoted` | Include iframe contents. `quoted` wraps in blockquotes. Forces `network-idle` timing. |
| `X-With-Shadow-Dom` | `true` | Extract content from Shadow DOM components. Forces `network-idle` timing. |
| `X-Detach-Invisibles` | `true` | Remove `display:none` elements. Disables caching. |

#### Output Format

| Header | Values | Description |
|--------|--------|-------------|
| `X-Respond-With` | `default`, `markdown`, `html`, `text`, `screenshot`, `pageshot`, `frontmatter`, `markdown+frontmatter`, `readerlm-v2` | Output format. `readerlm-v2` uses Jina's 1.5B model for complex pages (3x token cost). |
| `X-Return-Format` | `default`, `markdown`, `html`, `text`, `screenshot` | Alias for `X-Respond-With` (older name). |
| `X-Retain-Images` | `all` (default), `none`, `alt` | Image handling. `none` = strip. `alt` = keep alt text only, drop URLs. |
| `X-Retain-Links` | `all` (default), `none`, `text`, `gpt-oss` | Link handling. `text` = anchor text only. `gpt-oss` = OpenAI citation format with numbered footer. |
| `X-Retain-Media` | `link` (default), `none`, `text`, `image`, `html` | Video/audio handling. |
| `X-With-Links-Summary` | `true`, `all`, `none` | Append a deduplicated links footer. `all` keeps duplicates. |
| `X-With-Images-Summary` | `true`, `none` | Append an images footer. |
| `X-With-Generated-Alt` | `true` | VLM-caption images that lack alt text. |
| `X-Keep-Img-Data-Url` | `true` | Keep inline base64 images instead of converting to URLs. |
| `X-Token-Budget` | integer | Reject if output exceeds this token count (hard cap, fails request). |
| `X-Max-Tokens` | integer (≥500) | Trim output to fit (soft cap, truncates rather than rejects). |
| `X-Markdown-Chunking` | `true`, `h1`–`h5`, `structured`, `s1`–`s5` | Split output into JSON array of chunks. Heading-based or block-structured. |
| `X-Preset` | `reader`, `index`, `research`, `agent`, `spider` | Bundled option sets (see section 2.4). |

#### Markdown Formatting

| Header | Values | Description |
|--------|--------|-------------|
| `X-No-Gfm` | `enabled` (default), option flags | GitHub Flavored Markdown features. |
| `X-Md-Heading-Style` | `hash-style` (default), `setext-style` | Markdown heading format. |
| `X-Md-Hr` | string | Horizontal rule format. |
| `X-Md-Bullet-List-Marker` | `*` (default), `-`, `+` | Bullet point character. |
| `X-Md-Em-Delimiter` | `_` (default), `*` | Emphasis delimiter. |
| `X-Md-Strong-Delimiter` | `**` (default), `__` | Strong emphasis delimiter. |
| `X-Md-Link-Style` | `inline` (default), `referenced` | Link format. |

#### POST-only body fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Target URL. Required if not using GET prefix pattern. |
| `html` | string | Raw HTML to convert (skips fetching). Include `url` for relative link resolution. |
| `file` | binary | PDF, Word, Excel, or PowerPoint. MIME type sniffed from bytes. |
| `page` | integer | For PDFs: extract only page N (1-indexed). |
| `viewport` | object | `{width, height, deviceScaleFactor, isMobile}` — Puppeteer viewport. |
| `injectPageScript` | string | JavaScript to run in main frame before extraction. |
| `injectFrameScript` | string | JavaScript to run in every frame (for iframe-based content). |

### 2.4 Preset Bundles

`X-Preset` applies a pre-packaged option set. Caller-set options always win.

| Preset | Best for | Key settings applied |
|--------|----------|---------------------|
| `reader` | Human-visible display | `respondWith: frontmatter`, `retainMedia: html`, `detachInvisibles` |
| `index` | Embedding / vector stores | `retainLinks: text`, `retainImages: alt`, `retainMedia: none`, `markdownChunking: s3` |
| `research` | AI research agents | `respondWith: markdown+frontmatter`, `markdownChunking: h3`, all links/images |
| `agent` | Day-to-day AI agents | `respondWith: frontmatter`, `markdownChunking: h3`, `retainImages: alt` |
| `spider` | Recursive crawling | `respondWith: markdown+frontmatter`, `markdownChunking: h3`, `withLinksSummary: all` |

### 2.5 Respond-With Values Explained

| Value | What you get | Use case |
|-------|-------------|----------|
| `default` | Readability-filtered markdown | General LLM input |
| `markdown` | Full markdown without readability filtering | When heuristics miss content |
| `html` | `documentElement.outerHTML` | DOM inspection |
| `text` | `document.body.innerText` | Plain text pipelines |
| `screenshot` | URL to viewport PNG | Visual QA |
| `pageshot` | URL to full-page PNG | Archive / multimodal models |
| `frontmatter` | YAML frontmatter + markdown | Structured doc pipelines |
| `markdown+frontmatter` | Frontmatter + full unfiltered markdown | Deep research with metadata |
| `readerlm-v2` | High-quality markdown via 1.5B model | Complex page structures (3x token cost) |

### 2.6 How Jina Handles Different Page Types

**Static HTML:** Uses curl-impersonate — fast, lightweight, no JS execution. Jina's `auto` engine prefers this path.

**JavaScript/SPA pages:** Switches to headless Chrome (Puppeteer). Reader picks `mutation-idle` timing by default for SPAs — waits for DOM mutations to settle (≥200ms quiet).

**PDFs:** Any URL ending in `.pdf` is parsed with PDF.js and returned as markdown. Can be uploaded directly via POST.

**MS Office (Word/Excel/PowerPoint):** Converted via LibreOffice then processed as HTML/PDF.

**Images:** Captioned by a vision-language model (jina-vlm) when `X-With-Generated-Alt: true`.

**Hash-routed SPAs:** The URL fragment (`#/route`) is never sent to servers by HTTP spec. Workaround: use POST with the `url` field in the body.

---

## 3. Search API — s.jina.ai

### 3.1 Basic Usage

```bash
# Simple search (URL-encode spaces as %20 or +)
curl "https://s.jina.ai/what+is+late+chunking"

# Search limited to specific sites
curl "https://s.jina.ai/when+was+jina+ai+founded?site=jina.ai&site=github.com"

# JSON output
curl -H "Accept: application/json" "https://s.jina.ai/your+query"
```

**Critical:** `s.jina.ai` returns **nothing** without an API key (`X-API-Key` or `Authorization: Bearer`). The anonymous tier blocks search entirely.

### 3.2 How It Works

Search is not a thin wrapper around a search engine's title/snippet API. The flow:

1. Run the query against Jina's search backend (Bing-powered)
2. Retrieve top 5 result URLs
3. For each URL, run the full `r.jina.ai` pipeline (fetch + convert to markdown)
4. Return the 5 results as either a list of markdown blobs (text mode) or a JSON array (JSON mode)

This is the key differentiator vs Tavily/SerpApi/raw Google: you get the **full rendered content** of each result page, not just the title and snippet.

**Latency:** Average 2.5s per call. This seems low because the 5 sub-fetches run in parallel on Jina's infrastructure.

**Token cost:** Fixed ~10,000 tokens per search request regardless of result content length. This is higher than fetching a single URL but includes 5 full pages of content.

### 3.3 Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `site` | string (repeatable) | Restrict results to specific domains. Use `?site=domain1.com&site=domain2.com`. |

All the Reader headers also apply to `s.jina.ai` — they control how each of the 5 result pages is processed:

```bash
# Get search results with links stripped (for embedding pipeline)
curl -H "X-Retain-Links: text" \
     -H "X-Retain-Images: none" \
     "https://s.jina.ai/late+chunking+explained"
```

### 3.4 JSON Response Schema

```typescript
interface JinaSearchResponse {
  code: number;
  status: number;
  data: Array<{
    title: string;
    url: string;
    content: string;        // Full page markdown
    description: string;    // Search engine snippet
    publishedTime?: string;
    images?: Record<string, string>;
    links?: Record<string, string>;
  }>;
}
```

### 3.5 Differences from Other Search APIs

| Feature | s.jina.ai | Tavily | SerpApi | Firecrawl Search |
|---------|-----------|--------|---------|-----------------|
| Returns full page content | Yes (5 pages) | Yes (optional) | No (snippets only) | Yes |
| Minimum call | 1 API call | 1 API call | 1 API call | Multiple calls |
| Anonymous tier | No | Yes (limited) | No | No |
| JS page rendering | Yes (inherited from r.jina.ai) | Yes (Playwright) | No | Yes (Playwright) |
| Site restriction | Yes | No | Yes | No |
| Price unit | ~10K tokens/call | $0.005/call | $0.001/call | Credits/call |

---

## 4. Grounding / Fact-Check API — g.jina.ai

### 4.1 Overview

The Grounding API searches the web to verify a factual statement. Unlike DeepSearch (which synthesizes an answer), Grounding returns structured evidence for or against a claim.

```bash
# GET — prepend g.jina.ai/ to a statement
curl -H "Authorization: Bearer $JINA_API_KEY" \
     "https://g.jina.ai/The%20Eiffel%20Tower%20is%20in%20Paris"

# Also accepts POST
curl -X POST "https://g.jina.ai/" \
     -H "Authorization: Bearer $JINA_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"statement": "The Eiffel Tower is in Paris"}'
```

**Without a key:** Returns `401 AuthenticationRequiredError`. No anonymous tier.

### 4.2 Response Schema

Based on Jina's documentation (API requires auth to test directly):

```typescript
interface JinaGroundingResponse {
  code: number;
  status: number;
  data: {
    factuality: number;      // 0.0–1.0 confidence the statement is true
    result: boolean;         // true = supported, false = contradicted
    reason: string;          // Explanation
    references: Array<{
      url: string;
      keyQuote: string;      // The specific passage that supports/contradicts
      isSupportive: boolean;
    }>;
  };
}
```

### 4.3 How Verification Works

The internal flow mirrors what DeepSearch does for fact verification:
1. Run the statement through `s.jina.ai` to find relevant pages
2. Extract key quotes from the retrieved pages
3. Run a cross-encoder to score each quote's support for the claim
4. Aggregate into a factuality score and boolean verdict

### 4.4 Use Cases for Our MCP

The Grounding API is useful for:
- Verifying facts retrieved via web fetch before passing to an LLM
- Post-processing LLM outputs to detect hallucinations
- Building citation-backed research pipelines

**Our implementation pattern:** Offer an optional `verify_fact` tool that calls `g.jina.ai` and returns structured evidence. This is a natural complement to `web_fetch` + `web_search` tools.

---

## 5. DeepSearch API

### 5.1 Overview and Architecture

DeepSearch is Jina's implementation of iterative search-read-reason. Unlike a simple "search then answer" pattern, it loops:

```
Query → [Search → Read → Reason] × N → Answer
```

The loop continues until:
- The model produces a satisfactory answer
- The token budget is exhausted
- `max_attempts` is reached

The model used internally is **Gemini 2.0 Flash** (per the open-source repo), though the hosted API abstracts this away. The open-source version (`node-DeepResearch` on GitHub) lets you plug in OpenAI, Gemini, or local models via Ollama/LMStudio.

### 5.2 API Endpoint

```
POST https://deepsearch.jina.ai/v1/chat/completions
```

This is **fully OpenAI Chat Completions compatible**. Drop-in replacement: swap `api.openai.com` for `deepsearch.jina.ai`.

### 5.3 Request Schema

```typescript
interface DeepSearchRequest {
  model: "jina-deepsearch-v1";
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | Array<ContentPart>;  // Supports images and files
  }>;
  stream?: boolean;           // STRONGLY RECOMMENDED (default: false)
  
  // DeepSearch-specific extensions
  reasoning_effort?: "low" | "medium" | "high";  // default: "medium"
  budget_tokens?: number;      // Max tokens for the search process (overrides reasoning_effort)
  max_attempts?: number;       // Max retry attempts (overrides reasoning_effort)
  team_size?: number;          // Parallel agents (shared budget, independent max_attempts)
  no_direct_answer?: boolean;  // Force search even for trivial queries
  
  // Search control
  good_domains?: string[];     // Boost these domains
  bad_domains?: string[];      // Exclude these domains  
  only_domains?: string[];     // Restrict to only these domains
  max_returned_urls?: number;  // Max URLs in final answer
  
  // Arxiv mode
  arxiv_search?: boolean;      // Restrict all searches to arXiv only
  
  // Language control
  search_query_language?: string;  // Force language for search queries
  answer_language?: string;        // Force language for answers
  
  // Output control
  response_format?: {
    type: "json_schema";
    json_schema: { schema: object };  // JSON Schema for structured output
  };
}
```

### 5.4 Response Schema (Streaming)

DeepSearch uses SSE (Server-Sent Events). The stream includes:

**Thinking chunks** (reasoning steps wrapped in XML):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "choices": [{
    "delta": { "content": "<think>Searching for information about X...</think>" },
    "finish_reason": null
  }]
}
```

**Final answer chunk** (last in stream):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "model": "jina-deepsearch-v1",
  "choices": [{
    "delta": {
      "content": "The answer is... [^1]\n\n[^1]: [source](url)",
      "type": "text",
      "annotations": [
        {
          "type": "url_citation",
          "url_citation": { "url": "https://...", "title": "..." }
        }
      ]
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 196526  // Can be very high for deep research
  }
}
```

Citations are in **GitHub-flavored Markdown footnote format**: `[^1]`, `[^2]`, etc.

### 5.5 Latency and Token Cost

- **Latency:** Highly variable. Simple 2-step queries: 10–30s. Complex research: 2–10 minutes.
- **Token usage:** The response above showed 196,526 tokens for a 3-step answer. Budget accordingly.
- **Rate limits:** 10–30 RPM depending on key tier.
- **Streaming is critical:** Without streaming, you'll hit Cloudflare's 524 timeout (connection timeout after 100s) on complex queries.

### 5.6 Reasoning Effort Guide

| effort | budget_tokens equiv | max_attempts | Use case |
|--------|--------------------|-----------| ---------|
| `low` | ~4K | 2 | Simple factual lookups with known answers |
| `medium` | ~8K | 5 | Standard research questions (default) |
| `high` | ~16K | 10 | Complex multi-step research, ambiguous questions |

### 5.7 Self-Hosting DeepSearch

The full open-source implementation is at `github.com/jina-ai/node-DeepResearch`. It runs as an OpenAI-compatible server:

```bash
git clone https://github.com/jina-ai/node-DeepResearch.git
cd node-DeepResearch
npm install
export GEMINI_API_KEY=...  # or OPENAI_API_KEY for openai
export JINA_API_KEY=...    # for reader/search
npm run serve
# Endpoint: http://localhost:3000/v1/chat/completions
```

For local LLMs (requires JSON schema output support):
```bash
export LLM_PROVIDER=openai
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1
export DEFAULT_MODEL_NAME=qwen2.5-7b
```

---

## 6. Embeddings API

### 6.1 Endpoint

```
POST https://api.jina.ai/v1/embeddings
Authorization: Bearer $JINA_API_KEY
Content-Type: application/json
```

### 6.2 Available Models (2026)

| Model | Parameters | Context | Dimensions | Modalities | Notes |
|-------|-----------|---------|-----------|------------|-------|
| `jina-embeddings-v5-omni-small` | 1.7B | 32K | 1024 | Text, Image, Audio, Video | SIGIR 2026 paper |
| `jina-embeddings-v5-omni-nano` | 1.0B | 8K | 768 | Text, Image, Audio, Video | Edge-optimized |
| `jina-embeddings-v5-text-small` | 677M | 32K | 1024 | Text only | SOTA multilingual, MTEB top |
| `jina-embeddings-v5-text-nano` | 239M | 8K | 768 | Text only | Sub-1B SOTA |
| `jina-embeddings-v4` | 3.8B | 32K | up to 2048 | Text, Image, PDF | Multimodal, multi-vector |
| `jina-embeddings-v3` | 570M | 8K | up to 1024 | Text only | Still widely used, task LoRA |
| `jina-clip-v2` | 865M | 8K | 1024 | Text, Image | ICLR 2025 |
| `jina-colbert-v2` | 560M | 8K | per-token | Text | Multi-vector/late interaction |
| `jina-code-embeddings-0.5b` | 494M | 32K | 896 | Code | NeurIPS 2025 |
| `jina-code-embeddings-1.5b` | 1.5B | 32K | 1536 | Code | Larger version |

**Deprecated (still available):** `jina-embeddings-v2-base-en`, `jina-embeddings-v2-base-zh`, `jina-embeddings-v2-base-de`, `jina-embeddings-v2-base-es`, `jina-embeddings-v2-base-code`.

### 6.3 v3 Request Schema (Text)

```typescript
interface EmbeddingsV3Request {
  model: "jina-embeddings-v3";
  input: string | TextDoc | Array<string | TextDoc>;
  task?: "retrieval.query" | "retrieval.passage" | "text-matching" | "classification" | "separation";
  dimensions?: number;       // 1–1024 (Matryoshka)
  normalized?: boolean;      // default: true (L2 normalization)
  embedding_type?: "float" | "base64" | "binary" | "ubinary" | Array<these>;
  late_chunking?: boolean;   // Contextual chunking (see section 6.6)
  truncate?: boolean;        // default: false — error on overlong, or truncate?
}

interface TextDoc {
  text: string;
}
```

### 6.4 v5 Request Schema (Text + Multimodal)

```typescript
interface EmbeddingsV5Request {
  model: "jina-embeddings-v5-text-nano" | "jina-embeddings-v5-text-small" 
       | "jina-embeddings-v5-omni-small" | "jina-embeddings-v5-omni-nano";
  input: string | TextDoc | ImageDoc | VideoDoc | AudioDoc | PDFDoc
       | Array<string | TextDoc | ImageDoc | VideoDoc | AudioDoc | MergedContentGroup>;
  task?: "retrieval.query" | "retrieval.passage" | "text-matching" | "clustering" | "classification";
  dimensions?: number;       // 1–1024
  normalized?: boolean;      // default: true
  embedding_type?: "float" | "base64" | "binary" | "ubinary";
  truncate?: boolean;
}

interface ImageDoc { image: string; }    // URL or base64
interface VideoDoc { video: string; }    // URL
interface AudioDoc { audio: string; }    // URL
interface PDFDoc { pdf: string; }        // URL (single input only, not in array)

// Mixed-modality fusion: multiple content items → ONE embedding
interface MergedContentGroup {
  content: Array<TextDoc | ImageDoc | VideoDoc | AudioDoc>;
}
```

### 6.5 v4 Request Schema (Multimodal, Multi-Vector)

```typescript
interface EmbeddingsV4Request {
  model: "jina-embeddings-v4";
  input: string | TextDoc | ImageDoc | PDFDoc | Array<string | TextDoc | ImageDoc>;
  task?: "text-matching" | "retrieval.query" | "retrieval.passage" | "code.query" | "code.passage";
  dimensions?: number;           // 1–2048 (higher max than v3/v5)
  embedding_type?: "float" | "base64" | "binary" | "ubinary";
  late_chunking?: boolean;
  truncate?: boolean;
  return_multivector?: boolean;  // Return one embedding per token (ColBERT-style)
  return_tokenized_input?: boolean;  // Return tokens (requires return_multivector)
}
```

### 6.6 Response Schema

```typescript
interface EmbeddingResponse {
  model: string;
  object: "list";
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];    // float32 array, length = dimensions
    // If embedding_type includes binary/ubinary:
    // embedding: string;   // base64-encoded
  }>;
}
```

### 6.7 Task-Specific LoRA Adapters

`jina-embeddings-v3` and `v5` use LoRA adapters per task. **This is important:** using the wrong task type degrades quality significantly.

```typescript
// For indexing documents:
{
  "model": "jina-embeddings-v5-text-small",
  "input": ["Document text to index..."],
  "task": "retrieval.passage"
}

// For embedding user queries:
{
  "model": "jina-embeddings-v5-text-small", 
  "input": ["What is the capital of France?"],
  "task": "retrieval.query"
}

// For similarity / deduplication:
{
  "model": "jina-embeddings-v5-text-small",
  "input": ["Text A", "Text B"],
  "task": "text-matching"
}
```

### 6.8 Matryoshka Dimensions

Matryoshka Representation Learning (MRL) allows you to truncate embeddings to smaller sizes without re-training. Jina v3/v4/v5 all support this:

```typescript
// Full 1024-d for highest quality
{ "dimensions": 1024 }

// 512-d for 2x storage savings, ~95% quality
{ "dimensions": 512 }

// 256-d for 4x storage savings, ~90% quality
{ "dimensions": 256 }
```

Use this to trade storage cost vs retrieval quality. For our Phase 2 enterprise knowledge index, 512-d is a good balance.

### 6.9 Late Chunking Explained

**Problem:** Traditional chunking destroys inter-chunk references. If a document says "Berlin was founded in..." and later "Its population is...", chunking loses the link between "Its" and "Berlin".

**Solution:** Late Chunking processes the full document through the transformer first (capturing all cross-chunk context in the attention mechanism), then applies chunking at the token-embedding level before pooling.

```
Traditional: chunk1_tokens → embed → vec1 | chunk2_tokens → embed → vec2
Late:         [all tokens together → transformer → contextualized token embeddings] 
              → split → pool per-chunk → [vec1, vec2]
```

Each resulting chunk embedding carries context from the entire document.

```typescript
// Late chunking request
const request = {
  model: "jina-embeddings-v3",
  input: [
    "Berlin was founded in 1237.",
    "Its population is approximately 3.7 million.",  // "Its" correctly refers to Berlin
    "The city is known for its vibrant culture."
  ],
  task: "retrieval.passage",
  late_chunking: true  // Process all inputs as one sequence first
};
```

**When to use:** Best for long documents split into paragraphs. Not useful for independent short strings (e.g., product descriptions that don't reference each other).

**Paper:** "Late Chunking: Contextual Chunk Embeddings Using Long-Context Embedding Models" — SIGIR 2025, arXiv:2409.04701.

---

## 7. Reranking API

### 7.1 Endpoint

```
POST https://api.jina.ai/v1/rerank
Authorization: Bearer $JINA_API_KEY
Content-Type: application/json
```

### 7.2 Available Reranker Models (2026)

| Model | Parameters | Context | Notes |
|-------|-----------|---------|-------|
| `jina-reranker-v3.5` | 0.6B | 131K | Latest. Listwise. Beats Qwen3-Reranker-4B on BEIR (arXiv 2026-07). 1.56x faster than v3. |
| `jina-reranker-v3` | 597M | 131K | AAAI 2026. Listwise with "last but not late interaction". |
| `jina-reranker-m0` | 2.4B | 10K | Multimodal — ranks visual documents (images, PDFs). |
| `jina-reranker-v2-base-multilingual` | 278M | 1K | Deprecated for text, still available. |

### 7.3 Request Schema

```typescript
interface RerankerV3Request {
  model: "jina-reranker-v3" | "jina-reranker-v3.5";
  query: string;
  documents: Array<string | { text: string }>;
  top_n?: number;              // Return only top N. Omit for all.
  return_documents?: boolean;  // Include document text. default: true
  return_embeddings?: boolean; // Include document embeddings. default: false
  max_doc_length?: number;     // 1–8192. Default: 2048 (v3) or 8192 (v3.5)
}
```

### 7.4 Response Schema

```typescript
interface RerankingResponse {
  model: string;
  object: "list";
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  results: Array<{
    index: number;          // Original position in input array
    relevance_score: number; // 0.0–1.0 (higher = more relevant)
    document?: {
      text: string;
    };
    embedding?: number[];   // If return_embeddings: true
  }>;
}
```

Results are sorted by `relevance_score` descending (most relevant first).

### 7.5 Listwise vs. Pointwise Reranking

Traditional (pointwise) rerankers score each document independently: `score(query, doc_i)`.

Jina's v3/v3.5 uses **listwise** reranking: the model sees all documents at once and scores them relative to each other. This is more accurate (the model can do comparative reasoning) but requires passing all candidates in a single call.

**Architecture:** v3.5 uses a 0.6B model with hybrid attention (combining bidirectional and causal attention patterns) and self-distillation training. This explains why it beats 4B models — the architecture is purpose-built.

### 7.6 Cross-Encoder vs. ColBERT

| Approach | Model | Cost | Quality | Use case |
|----------|-------|------|---------|----------|
| Listwise reranker | jina-reranker-v3.5 | Medium | Highest | Final-stage reranking of top-k candidates |
| Cross-encoder | jina-reranker-v2 | Lower | High | Pairwise scoring |
| ColBERT | jina-colbert-v2 | Low (precomputed) | Good | When you can afford per-token storage |
| Bi-encoder | jina-embeddings-v5 | Lowest (precomputed) | Good baseline | Initial retrieval |

Typical RAG pipeline:
1. **Bi-encoder** retrieval (ANN in vector DB) → top 100 candidates
2. **ColBERT** late interaction → top 20
3. **Listwise reranker** → top 5 for final answer

### 7.7 Code Example

```typescript
async function rerank(
  query: string,
  documents: string[],
  topN: number = 5
): Promise<Array<{ document: string; score: number; originalIndex: number }>> {
  const response = await fetch('https://api.jina.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jina-reranker-v3.5',
      query,
      documents,
      top_n: topN,
      return_documents: true,
    }),
  });

  const data = await response.json();
  return data.results.map((r: any) => ({
    document: r.document.text,
    score: r.relevance_score,
    originalIndex: r.index,
  }));
}
```

---

## 8. Streaming

### 8.1 Reader Streaming

Stream mode for `r.jina.ai` is useful for large pages. It allows more time for the page to fully render before content is extracted.

```bash
# Enable streaming with Accept header
curl -H "Accept: text/event-stream" "https://r.jina.ai/https://very-long-page.com"
```

In streaming mode, content is emitted as SSE chunks as sections of the page are processed. This is especially important for:
- Pages with lazy-loaded content
- Very long documents
- Pages with multiple async data fetches

**When to use streaming:** If standard mode returns truncated or incomplete content, try streaming mode.

### 8.2 DeepSearch Streaming

For DeepSearch, streaming is **strongly recommended** (Jina's own docs emphasize this). Without it, Cloudflare's 100s connection timeout will cut off complex queries.

```typescript
// TypeScript streaming DeepSearch
async function* streamDeepSearch(query: string) {
  const response = await fetch('https://deepsearch.jina.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jina-deepsearch-v1',
      messages: [{ role: 'user', content: query }],
      stream: true,
      reasoning_effort: 'medium',
    }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const text = decoder.decode(value);
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      
      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // Skip malformed chunks
      }
    }
  }
}

// Usage
for await (const chunk of streamDeepSearch('What is the latest Jina AI model?')) {
  process.stdout.write(chunk);
}
```

### 8.3 Reader Streaming in Node.js

```typescript
async function fetchWithStreaming(url: string): Promise<string> {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
    },
  });

  const chunks: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  return chunks.join('');
}
```

---

## 9. Pricing and Rate Limits

### 9.1 Free Tier

New API keys receive **1,000,000 free tokens** (confirmed in OpenAPI schema description). No credit card required.

Paid keys receive **10M tokens** at tier 1.

### 9.2 Rate Limits by Product and Tier

| Product | Endpoint | No key | Free key | Paid key | Premium key |
|---------|----------|--------|----------|----------|-------------|
| Reader | r.jina.ai | 20 RPM | 500 RPM | 500 RPM | 5,000 RPM |
| Search | s.jina.ai | Blocked | 100 RPM | 100 RPM | 1,000 RPM |
| Embeddings | api.jina.ai/v1/embeddings | Blocked | 100 RPM & 100K TPM | 500 RPM & 2M TPM | 5K RPM & 50M TPM |
| Reranker | api.jina.ai/v1/rerank | Blocked | 100 RPM & 100K TPM | 500 RPM & 2M TPM | 5K RPM & 50M TPM |
| DeepSearch | deepsearch.jina.ai | Blocked | 10 RPM | 20 RPM | 30 RPM |

Rate limit headers in responses: `X-RateLimit-Remaining-Requests`, `X-RateLimit-Remaining-Tokens`.

### 9.3 Token Counting by Product

| Product | What counts | Notes |
|---------|-------------|-------|
| Reader | Output tokens | Token count of the markdown response |
| Search | Fixed per call | ~10,000 tokens regardless of content length |
| Embeddings | Input tokens | Sum of tokens in all input texts/documents |
| Reranker | Input tokens | Query + all documents combined |
| DeepSearch | All tokens | Includes all intermediate search/reasoning steps (can be 100K+) |

### 9.4 API Plan Structure (from OpenAPI schema)

```
Free tier:    500 RPM / 1M TPM / 5 concurrent
Tier 1:       500 RPM / 10M TPM / 50 concurrent
Tier 2:       5,000 RPM / 100M TPM / 500 concurrent
```

### 9.5 Cloud Provider Billing

Embeddings and Reranker models can be deployed on:
- **AWS SageMaker** — bill through AWS account
- **Microsoft Azure** — Azure Marketplace
- **Google Cloud** — Vertex AI
- **Elastic Inference Service** — Run inside Elasticsearch clusters

This matters for enterprise customers with existing cloud commitments.

---

## 10. JS-Heavy Pages and Browser Engine

### 10.1 Engine Selection Logic

Jina's `auto` engine chooses between headless Chrome and curl-impersonate based on heuristics (not disclosed, but likely Content-Type, URL pattern, initial curl response analysis).

**Force browser:**
```bash
curl -H "X-Engine: browser" "https://r.jina.ai/https://spa-app.com"
```

**Force curl (faster, no JS):**
```bash
curl -H "X-Engine: curl" "https://r.jina.ai/https://static-site.com"
```

### 10.2 Anti-Bot Handling

Jina's Reader has graduated responses for blocked sites:

1. **Use API key** — anonymous traffic gets lowest-trust treatment
2. **Bypass cache** — `X-No-Cache: true` forces a fresh fetch
3. **Force browser** — `X-Engine: browser` for JS-gated content
4. **Hosted proxy** — `X-Proxy: auto` (premium key) uses Jina's residential/datacenter IP rotation
5. **BYO proxy** — `X-Proxy-Url: https://user:pass@proxy.example.com:8080`

### 10.3 SPA Patterns

```bash
# Hash-routed SPA (# fragment not sent to server)
curl -X POST "https://r.jina.ai/" -d 'url=https://app.example.com/#/dashboard'

# Preloading SPA (wait for content to load)
curl -H "X-Timeout: 10" "https://r.jina.ai/https://app.example.com"

# Wait for specific element
curl -H "X-Wait-For-Selector: #main-content" "https://r.jina.ai/https://app.example.com"

# Click-to-reveal content (transcripts, etc.)
curl -X POST "https://r.jina.ai/" \
  -F 'url=https://www.youtube.com/watch?v=VIDEO_ID' \
  -F "injectPageScript=waitForSelector('ytd-transcript-button-renderer').then(el => el.click())"
```

### 10.4 Comparison: Jina vs. Firecrawl vs. Direct Playwright

| Dimension | Jina Reader | Firecrawl | Direct Playwright |
|-----------|-------------|-----------|-------------------|
| JS rendering | Yes (Puppeteer) | Yes (Playwright) | Yes (your code) |
| Zero-config anti-bot | Yes (proxy pool) | Yes (stealth mode) | No (DIY) |
| Output format | Markdown (via Readability + Turndown) | Markdown (similar pipeline) | Raw HTML (you convert) |
| CSS selector targeting | Yes | Yes | Yes |
| Screenshot support | Yes | Yes | Yes |
| PDF parsing | Yes (PDF.js) | Yes | No (need separate lib) |
| Office doc support | Yes (LibreOffice) | No | No |
| Shadow DOM | Yes (X-With-Shadow-Dom) | Limited | Yes (full control) |
| Iframe extraction | Yes (X-With-Iframe) | Limited | Yes (full control) |
| Self-hostable | Yes (MIT/Apache-2) | Yes (AGPL-3) | N/A (library) |
| Pricing model | Token-based output | Credit-based | Infrastructure cost |
| Avg latency | ~7.9s | ~5–10s | ~3–8s |
| Afrikaans quality | Good (100+ language model) | Same as source HTML | Same as source HTML |

**Our take:** Jina Reader is the right default for our MCP. Self-hosting the open-source image removes the cost and rate-limit concerns entirely for internal enterprise use.

---

## 11. Multilingual Support

### 11.1 Reader and Search

Reader is language-agnostic — it converts HTML to markdown regardless of language. The content quality depends entirely on the source HTML. There is no automatic translation.

Locale-aware fetching:
```bash
# Fetch German version of a page
curl -H "X-Proxy: de" \
     -H "X-Locale: de-DE" \
     "https://r.jina.ai/https://example.com"
```

### 11.2 Embeddings Multilingual Quality

Jina's embedding models explicitly target multilingual performance:
- `jina-embeddings-v5-text-small`: Tested on MMTEB (Massive Multilingual Text Embedding Benchmark) with SOTA results
- `jina-embeddings-v3`: Claims 100+ languages
- All v3/v5 models use multilingual training data

**Afrikaans:** Jina's models are trained on multilingual corpora but Afrikaans is a low-resource language. Expect reasonable but not best-in-class quality. For pure Afrikaans retrieval, test against alternatives like `multilingual-e5-large`. The v5-text-small SIGIR 2026 paper would have exact Afrikaans MTEB scores if available.

### 11.3 Reranker Multilingual Quality

`jina-reranker-v3.5` and `v3` explicitly claim multilingual support. The sample request in the OpenAPI spec includes English, French, German, Chinese, and Japanese documents. Cross-lingual reranking (English query against French documents) is supported.

### 11.4 DeepSearch Language Control

```typescript
{
  "model": "jina-deepsearch-v1",
  "messages": [{ "role": "user", "content": "Wat is die nuutste nuus?" }],
  "search_query_language": "af",   // Force Afrikaans search queries
  "answer_language": "af",          // Force Afrikaans in the answer
}
```

Without these flags, DeepSearch auto-detects language from the input message.

---

## 12. Self-Hosting Reader

### 12.1 Docker Image

```bash
# Pull the OSS image
docker pull ghcr.io/jina-ai/reader:oss

# HTTP/1.1 (use this for curl/browser testing)
docker run --rm -p 3000:8081 ghcr.io/jina-ai/reader:oss
# Test: curl http://localhost:3000/https://example.com

# h2c (HTTP/2 cleartext, for production)
docker run --rm -p 3000:8080 -p 3001:8081 ghcr.io/jina-ai/reader:oss
```

The OSS image bundles:
- Headless Chrome (Puppeteer)
- LibreOffice (Office document conversion)
- CJK fonts
- GeoLite2 databases
- curl-impersonate

### 12.2 Caching with S3-Compatible Storage

```bash
docker run --rm -p 3000:8081 \
  -e GCP_STORAGE_ENDPOINT=https://s3.example.com \
  -e GCP_STORAGE_BUCKET=reader-cache \
  -e GCP_STORAGE_ACCESS_KEY=... \
  -e GCP_STORAGE_SECRET_KEY=... \
  ghcr.io/jina-ai/reader:oss
```

Supports any S3-compatible store: MinIO, Cloudflare R2, AWS S3.

Without caching, the container is fully stateless — every request hits the live URL. Caching is strongly recommended for production.

### 12.3 Docker Compose (Development)

```yaml
# docker-compose.yml
version: '3.8'
services:
  reader:
    image: ghcr.io/jina-ai/reader:oss
    ports:
      - "3000:8081"
    environment:
      GCP_STORAGE_ENDPOINT: http://minio:9000
      GCP_STORAGE_BUCKET: reader-cache
      GCP_STORAGE_ACCESS_KEY: minioadmin
      GCP_STORAGE_SECRET_KEY: minioadmin
    depends_on: [minio]
  
  minio:
    image: minio/minio
    ports:
      - "9000:9000"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data
```

### 12.4 Source Code Structure

Key files for understanding the implementation:
- `src/dto/crawler-options.ts` — complete header/parameter definitions with validation
- `src/dto/turndown-tweakable-options.ts` — markdown formatting options
- `architecture.md` — engine selection, formatting profiles, deployment topology
- `cookbooks.md` — pipeline recipes

### 12.5 Differences Between OSS and SaaS

| Feature | OSS (self-hosted) | SaaS (r.jina.ai) |
|---------|------------------|------------------|
| Rate limiting | None (your infrastructure) | Per-tier limits |
| Proxy pool | Not included | Premium tier |
| Caching | S3-compatible (your config) | Managed, 3600s TTL |
| VLM image captioning | Not included (needs external VLM) | Included |
| ReaderLM-v2 | Requires separate model | Available via API |
| Storage layer | Stateless (MongoDB layer stripped) | Full MongoDB backend |
| License | Apache-2.0 | Commercial |

---

## 13. Competitor Comparison

### 13.1 URL-to-Markdown Quality Table

| Scenario | Jina Reader | Firecrawl | Raw Playwright + Turndown | Notes |
|----------|------------|-----------|--------------------------|-------|
| Static article page | Excellent | Excellent | Excellent | All roughly equivalent |
| JavaScript SPA | Very Good | Very Good | Good (with effort) | Jina/Firecrawl handle anti-bot better |
| Paywalled content | Needs cookies | Needs cookies | Needs cookies | Same limitation across all |
| PDF at URL | Excellent (PDF.js) | Good | Needs pdf-parse | Jina wins |
| Word/Excel/PPT | Excellent (LibreOffice) | No | No | Jina wins |
| Shadow DOM components | Yes (opt-in) | Limited | Yes (full control) | Playwright wins on control |
| YouTube transcript | Yes (via injectPageScript) | Limited | Yes (manual) | Equivalent with effort |
| Anti-bot bypass | Proxy pool (premium) | Stealth mode (included) | None built-in | Firecrawl slightly easier |
| Token overhead | Output-counted | Credit-counted | Free (infrastructure) | |
| Self-hosted | Apache-2.0 | AGPL-3 | MIT (Playwright) | All viable |
| Latency (avg) | 7.9s | ~5–10s | ~3–8s | Varies by page |

### 13.2 Search API Comparison

| Feature | s.jina.ai | Tavily | SerpApi | Brave Search API |
|---------|-----------|--------|---------|-----------------|
| Returns full page markdown | Yes (top 5) | Yes (optional) | No | No |
| Anonymous tier | No | No | No | Yes (2K/month) |
| Result count | Fixed 5 | 1–10 configurable | Configurable | Configurable |
| JS page rendering | Yes (Puppeteer) | Yes (Playwright) | No | No |
| Site restriction | Yes | No | Yes | Yes |
| Price | ~10K tokens/call | $0.005/call | $0.001/result | $3/1K calls |
| Bing-powered | Yes | Yes | Google | Brave index |

### 13.3 Embeddings Comparison

| Model | Provider | Params | Dimensions | MTEB Score | Context | Price |
|-------|----------|--------|-----------|-----------|---------|-------|
| jina-embeddings-v5-text-small | Jina | 677M | 1024 | SOTA (per paper) | 32K | Jina tokens |
| text-embedding-3-large | OpenAI | Unknown | 3072 | ~65 MTEB Avg | 8K | $0.13/1M |
| text-embedding-3-small | OpenAI | Unknown | 1536 | ~62 MTEB Avg | 8K | $0.02/1M |
| embed-english-v3.0 | Cohere | Unknown | 1024 | ~64 | 512 | $0.10/1M |
| multilingual-e5-large | Microsoft | 560M | 1024 | ~61 | 512 | Self-hosted |
| voyage-3 | Voyage | Unknown | 1024 | ~67 | 32K | $0.06/1M |

Jina v5-text-small is competitive at MTEB while being open-weight and self-hostable. For multilingual use cases, it's the most compelling option — OpenAI/Cohere have mediocre multilingual MTEB scores.

### 13.4 Reranker Comparison

| Model | Provider | BEIR nDCG@10 | Context | Notes |
|-------|----------|------------|---------|-------|
| jina-reranker-v3.5 | Jina | Beats Qwen3-4B | 131K | Listwise, 0.6B |
| Cohere Rerank 3 | Cohere | ~60 BEIR | 4096 | $2/1K calls |
| bge-reranker-v2-m3 | BAAI | ~58 BEIR | 8K | Open-weight |
| ms-marco-MiniLM-L-6-v2 | Microsoft | ~53 BEIR | 512 | Tiny, fast |

Jina v3.5 is the quality leader at surprisingly small size.

---

## 14. Node.js / TypeScript Implementation Patterns

### 14.1 Jina Reader Client

```typescript
// src/tools/jina-reader.ts
interface JinaReaderOptions {
  engine?: 'auto' | 'browser' | 'curl';
  returnFormat?: 'default' | 'markdown' | 'html' | 'text' | 'frontmatter';
  targetSelector?: string;
  waitForSelector?: string;
  removeSelector?: string;
  retainImages?: 'all' | 'none' | 'alt';
  retainLinks?: 'all' | 'none' | 'text' | 'gpt-oss';
  withLinksSummary?: boolean;
  withImagesSummary?: boolean;
  timeout?: number;
  noCache?: boolean;
  cacheTolerance?: number;
  proxyCountry?: string;
  locale?: string;
  maxTokens?: number;
  preset?: 'reader' | 'index' | 'research' | 'agent' | 'spider';
  markdownChunking?: string;
  respondWith?: string;
  cookie?: string;
}

interface JinaReaderResult {
  title: string;
  url: string;
  content: string;
  publishedTime?: string;
  description?: string;
}

export async function fetchWithJinaReader(
  url: string,
  options: JinaReaderOptions = {}
): Promise<JinaReaderResult> {
  const baseUrl = process.env.JINA_READER_BASE_URL || 'https://r.jina.ai';
  const apiKey = process.env.JINA_API_KEY;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Map options to headers
  if (options.engine) headers['X-Engine'] = options.engine;
  if (options.returnFormat) headers['X-Return-Format'] = options.returnFormat;
  if (options.targetSelector) headers['X-Target-Selector'] = options.targetSelector;
  if (options.waitForSelector) headers['X-Wait-For-Selector'] = options.waitForSelector;
  if (options.removeSelector) headers['X-Remove-Selector'] = options.removeSelector;
  if (options.retainImages) headers['X-Retain-Images'] = options.retainImages;
  if (options.retainLinks) headers['X-Retain-Links'] = options.retainLinks;
  if (options.withLinksSummary) headers['X-With-Links-Summary'] = 'true';
  if (options.withImagesSummary) headers['X-With-Images-Summary'] = 'true';
  if (options.timeout) headers['X-Timeout'] = String(options.timeout);
  if (options.noCache) headers['X-No-Cache'] = 'true';
  if (options.cacheTolerance !== undefined) {
    headers['X-Cache-Tolerance'] = String(options.cacheTolerance);
  }
  if (options.proxyCountry) headers['X-Proxy'] = options.proxyCountry;
  if (options.locale) headers['X-Locale'] = options.locale;
  if (options.maxTokens) headers['X-Max-Tokens'] = String(options.maxTokens);
  if (options.preset) headers['X-Preset'] = options.preset;
  if (options.markdownChunking) headers['X-Markdown-Chunking'] = options.markdownChunking;
  if (options.respondWith) headers['X-Respond-With'] = options.respondWith;
  if (options.cookie) headers['X-Set-Cookie'] = options.cookie;

  const fetchUrl = `${baseUrl}/${url}`;
  
  const response = await fetch(fetchUrl, { headers });

  if (!response.ok) {
    throw new Error(`Jina Reader returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.data;
}
```

### 14.2 Self-Hosted Reader (Pointing to Local Docker)

```typescript
// For self-hosted deployment
const client = new JinaReaderClient({
  baseUrl: 'http://localhost:3000',
  // No API key needed for self-hosted
});

// Or via env var
// JINA_READER_BASE_URL=http://localhost:3000
```

### 14.3 Search with Jina

```typescript
interface JinaSearchResult {
  title: string;
  url: string;
  content: string;
  description: string;
  publishedTime?: string;
}

export async function searchWithJina(
  query: string,
  options: {
    sites?: string[];
    retainLinks?: 'all' | 'none' | 'text';
    retainImages?: 'all' | 'none' | 'alt';
  } = {}
): Promise<JinaSearchResult[]> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error('JINA_API_KEY required for search');

  let searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
  if (options.sites?.length) {
    const siteParams = options.sites.map(s => `site=${encodeURIComponent(s)}`).join('&');
    searchUrl += `?${siteParams}`;
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  if (options.retainLinks) headers['X-Retain-Links'] = options.retainLinks;
  if (options.retainImages) headers['X-Retain-Images'] = options.retainImages;

  const response = await fetch(searchUrl, { headers });
  if (!response.ok) throw new Error(`Jina Search failed: ${response.status}`);

  const data = await response.json();
  return data.data;
}
```

### 14.4 Embeddings with Late Chunking

```typescript
export async function embedChunks(
  chunks: string[],
  task: 'retrieval.query' | 'retrieval.passage' = 'retrieval.passage',
  useLateChunking: boolean = false
): Promise<Float32Array[]> {
  const response = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jina-embeddings-v5-text-small',
      input: chunks,
      task,
      normalized: true,
      embedding_type: 'float',
      dimensions: 512,           // Matryoshka truncation for storage efficiency
      late_chunking: useLateChunking,
    }),
  });

  const data = await response.json();
  return data.data.map((d: any) => new Float32Array(d.embedding));
}

// For RAG: embed the query with retrieval.query task
export async function embedQuery(query: string): Promise<Float32Array> {
  const results = await embedChunks([query], 'retrieval.query', false);
  return results[0];
}
```

### 14.5 Reranking Pipeline

```typescript
export async function rerankDocuments(
  query: string,
  documents: string[],
  topN: number = 5
): Promise<Array<{ text: string; score: number }>> {
  const response = await fetch('https://api.jina.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'jina-reranker-v3.5',
      query,
      documents,
      top_n: topN,
      return_documents: true,
    }),
  });

  const data = await response.json();
  return data.results.map((r: any) => ({
    text: r.document.text,
    score: r.relevance_score,
  }));
}
```

### 14.6 DeepSearch Streaming in MCP Tool

```typescript
// MCP tool that streams DeepSearch results
export const deepSearchTool = {
  name: 'deep_search',
  description: 'Iteratively search the web to answer complex questions',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question to research' },
      effort: { 
        type: 'string', 
        enum: ['low', 'medium', 'high'],
        default: 'medium'
      },
    },
    required: ['query'],
  },
  async handler({ query, effort = 'medium' }: { query: string; effort?: string }) {
    const response = await fetch('https://deepsearch.jina.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jina-deepsearch-v1',
        messages: [{ role: 'user', content: query }],
        stream: true,
        reasoning_effort: effort,
      }),
    });

    const chunks: string[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const content = chunk.choices?.[0]?.delta?.content ?? '';
          if (content) chunks.push(content);
        } catch { /* ignore */ }
      }
    }

    return { content: [{ type: 'text', text: chunks.join('') }] };
  },
};
```

### 14.7 Implementing Jina Reader Patterns in Our MCP

Our MCP already has a web_fetch tool. Here is how to upgrade it with Jina Reader patterns:

```typescript
// Enhanced web_fetch using Jina patterns (self-hosted or API)
export async function enhancedWebFetch(
  url: string,
  intent: 'rag' | 'embed' | 'research' | 'agent' = 'rag'
): Promise<string> {
  // Map intent to preset
  const presetMap: Record<string, string> = {
    rag: 'reader',
    embed: 'index',
    research: 'research',
    agent: 'agent',
  };

  // If using self-hosted reader:
  const baseUrl = process.env.JINA_READER_BASE_URL;
  if (baseUrl) {
    return fetchWithSelfHostedReader(url, { preset: presetMap[intent] });
  }

  // Fallback: implement key patterns directly
  if (intent === 'embed') {
    // Strip URLs and images for embedding pipeline
    return fetchAndProcessForEmbedding(url);
  }

  // Default: standard fetch + Turndown conversion
  return standardFetch(url);
}
```

---

## 15. What to Build and What to Skip

### 15.1 Build: Jina Reader Integration as Primary Web Fetch

**Verdict: Build this first.**

The Jina Reader OSS image is Apache-2.0, self-hostable, and directly implements everything our `web_fetch` tool does but better:
- CSS selector targeting
- JS rendering with browser engine selection
- PDF/Office document conversion
- Streaming for large pages
- Preset bundles for different use cases

For our MCP: run the Jina Reader Docker image alongside the MCP server. Point `web_fetch` at `http://jina-reader:8081`. No API key needed. No rate limits.

**Implementation effort:** 2–3 days to integrate the Docker compose and wire up the full header pass-through.

### 15.2 Build: s.jina.ai Search API Integration (SaaS)

**Verdict: Build with API key requirement.**

`s.jina.ai` is the fastest path to "search + full page content" in a single call. The fixed 10K token cost is predictable. The main downside is the mandatory API key.

For our MCP: add `web_search` as an optional tool that requires `JINA_API_KEY`. Document the free tier (1M tokens) to encourage adoption.

**Implementation effort:** 1 day.

### 15.3 Build: g.jina.ai Grounding as Optional Tool

**Verdict: Build as a premium/optional tool.**

Grounding is a compelling differentiator for enterprise knowledge index use cases. When agents retrieve from SharePoint/Confluence, they can verify claims against live web sources. The API requires a key — acceptable for enterprise tier.

**Implementation effort:** 0.5 days.

### 15.4 Skip: DeepSearch Direct Integration

**Verdict: Skip for now — focus on building better primitives.**

DeepSearch is useful but:
- Very high token cost (100K+ per complex query)
- Rate-limited to 10–30 RPM
- The value proposition is "LLM that uses our Reader and Search" — we can build this ourselves using our own web_fetch + web_search tools with any LLM

If we ever need DeepSearch capabilities in our MCP, we can wrap `deepsearch.jina.ai` as a drop-in tool since it's OpenAI-compatible. But building our own iterative search pattern (matching node-DeepResearch architecture) gives us more control and no rate limits.

### 15.5 Skip: Jina Embeddings and Reranker for Phase 1

**Verdict: Skip for Phase 1, plan for Phase 2.**

Our Phase 1 is web fetch + search. The embeddings and reranker APIs are excellent and relevant for Phase 2 (enterprise knowledge index), but:
- Phase 1 doesn't need them
- Alternative: OpenAI text-embedding-3-small is cheaper at scale and widely understood
- jina-embeddings-v5-text-small is self-hostable via HuggingFace — no API costs

For Phase 2 (SharePoint + Confluence connectors with semantic search), plan to evaluate:
1. jina-embeddings-v5-text-small (self-hosted, multilingual SOTA)
2. jina-reranker-v3.5 (self-hosted, BEIR SOTA)
3. Late chunking for long SharePoint documents with cross-paragraph references

### 15.6 Build: Implement Jina-Compatible Preset Logic

**Verdict: Build this pattern without depending on Jina API.**

The preset concept (reader/index/research/agent/spider) is excellent UX. Implement the same option bundles in our own web_fetch tool:

```typescript
// Our own preset implementation
const PRESETS = {
  reader: { retainImages: 'all', retainLinks: 'all', withFrontmatter: true },
  index: { retainImages: 'alt', retainLinks: 'text', chunking: 'semantic' },
  research: { retainImages: 'all', retainLinks: 'all', withLinksSummary: true },
  agent: { retainImages: 'alt', withFrontmatter: true },
  spider: { retainLinks: 'all', withLinksSummary: 'all' },
} as const;
```

---

## 16. Limitations, Failure Modes, and Gotchas

### 16.1 Reader API Limitations

**Caching:** By default, pages are cached for 3600 seconds. The cached version may be stale. Always use `X-No-Cache: true` for news, live prices, or any time-sensitive content.

**Anti-bot blocking:** Even with Jina's proxy pool, heavily protected sites (Cloudflare Enterprise, Kasada, DataDome) may block fetches. The OSS self-hosted version has no proxy pool — you need to bring your own proxies for blocked sites.

**Complex SPAs:** Some React/Angular apps render content deep in the component tree. `X-Wait-For-Selector` and `X-Timeout` help, but some pages require knowing the exact DOM structure. The `injectPageScript` escape hatch handles most remaining cases.

**ReaderLM-v2:** Available via `X-Respond-With: readerlm-v2`. Costs 3x tokens. Only useful for pages where the standard Readability.js extraction fails to capture the content structure correctly.

**Max timeout:** 180 seconds. Long-running JS applications may not fully load within this limit.

**PDF quality:** PDF.js handles most PDFs well, but complex layouts (multi-column academic papers, tables-heavy spreadsheet exports) may lose structure.

### 16.2 Search API Limitations

**No anonymous access:** Unlike Reader, Search requires an API key. This is a significant barrier for open demos.

**Fixed 5 results:** No option to get more or fewer results. Compared to Tavily (1–10 configurable), this is inflexible.

**Token cost floor:** The ~10K fixed token cost means that even a simple query that finds short pages uses 10K tokens. For high-volume applications, this adds up quickly.

**Bing-powered:** Result quality and freshness depend on Bing's index. Google results are not available.

### 16.3 DeepSearch Limitations

**524 timeouts:** Without streaming, Cloudflare's connection timeout (100s) kills responses to complex queries. Always use `stream: true`.

**Token runaway:** Complex questions can consume 200K+ tokens. Always set `budget_tokens` for production use cases.

**Not a long-form report generator:** Jina explicitly states DeepSearch is optimized for correct answers, not long research reports (unlike OpenAI Deep Research). Don't use it when you need a formatted 10-page report.

**Rate limit (10 RPM free):** Extremely limited. Not suitable for high-volume research pipelines.

### 16.4 Embeddings Limitations

**Task type matters:** Mixing `retrieval.query` and `retrieval.passage` in the wrong places significantly degrades quality. The query embedding and document embedding MUST use the correct task types.

**Context length vs. quality:** v3 has 8K context, v5 has 32K. For documents longer than 8K tokens with v3, use late chunking or truncation. Truncation loses the end of the document.

**Matryoshka truncation quality:** Lower dimensions = lower quality. Test your specific domain before going below 256 dimensions.

**Binary/ubinary format:** Quantized formats save storage but lose precision. Good for FAISS-style approximate search, but don't use for cosine similarity thresholding.

### 16.5 Reranker Limitations

**Max 8192 tokens per document (v3.5):** Documents longer than this are truncated. If your chunks are long, set `max_doc_length` explicitly to understand the truncation point.

**Not a zero-shot classifier:** The reranker scores relevance to a query — it can't classify documents into categories without a query framing the task.

**Listwise requires all candidates in one call:** You can't add documents to an existing ranked list without re-running the full reranking call. For online/streaming RAG, this means you must wait until all candidates are collected before reranking.

### 16.6 API Key Security

Jina API keys are long-lived bearer tokens. Rotate them if exposed. There is no scope/permission system — a key grants full access to all products.

For self-hosted Reader, there is no built-in authentication. Add your own API gateway or network-level controls.

### 16.7 EU Data Residency

Jina's EU residency option (`X-Eu-Residency: true` on Reader, similar flags elsewhere) is marked **Experimental** as of 2026-08. Do not rely on this for GDPR compliance in production until it exits experimental status. Verify with Jina's DPA before use in enterprise contexts.

### 16.8 MCP Server Availability

`mcp.jina.ai` exists as a hosted MCP endpoint (visible on their reader page). This means Jina already ships as an MCP tool — but it requires their infrastructure and API keys. Our MCP adds value by:
1. Self-hosted (no data leaves your network)
2. Works with enterprise knowledge sources (SharePoint/Confluence)
3. Entra ID ACL enforcement — Jina has none of this

### 16.9 Presets Are Additive, Not Exclusive

When using `X-Preset`, remember that preset options only apply if you haven't explicitly set that option. This is the right behavior but can surprise users who expect the preset to override everything.

```bash
# This KEEPS all links (your explicit header wins over the preset's retainLinks: text)
curl -H "X-Preset: index" \
     -H "X-Retain-Links: all" \
     "https://r.jina.ai/https://example.com"
```

---

## Summary: Jina AI for Our MCP

Jina AI's Reader is the gold-standard URL-to-markdown pipeline. Self-hosting the Apache-2.0 OSS image eliminates the cost, rate limits, and external dependency concerns that make the SaaS Reader unsuitable for an enterprise MCP server that processes sensitive internal content.

The critical patterns to adopt from Jina:
1. **Engine selection** (`auto`/`browser`/`curl`) — smart selection reduces latency
2. **CSS selector targeting** — crucial for enterprise tools with known DOM structure
3. **Preset bundles** — great UX for developers integrating with different pipelines
4. **Streaming for long pages** — prevents timeouts on large documents
5. **Late chunking** — adopt for Phase 2 enterprise knowledge index
6. **Markdown chunking response** — return chunks instead of blobs for embedding pipelines

The critical patterns to build ourselves rather than depend on Jina SaaS:
1. **DeepSearch loop** — build our own search-read-reason cycle using our own tools + any LLM
2. **Embeddings** — run jina-embeddings-v5-text-small self-hosted for Phase 2
3. **Reranker** — run jina-reranker-v3.5 self-hosted for Phase 2

The Jina SaaS APIs that make sense as optional integrations:
1. **s.jina.ai** — search with full page content, requires JINA_API_KEY
2. **g.jina.ai** — grounding/fact-check, requires JINA_API_KEY
3. **deepsearch.jina.ai** — deep research endpoint, use when self-hosted DeepSearch is overkill

---

*Sources: jina.ai/reader (2026-08-25), jina.ai/embeddings (2026-08-25), jina.ai/reranker (2026-08-25), jina.ai/deepsearch (2026-08-25), api.jina.ai/openapi.json v2026.07.27.1603, github.com/jina-ai/reader README.md (2026-04 sync), github.com/jina-ai/reader cookbooks.md, github.com/jina-ai/node-DeepResearch README.md, jina.ai/news/late-chunking-in-long-context-embedding-models, jina.ai/models (2026-08-25)*
