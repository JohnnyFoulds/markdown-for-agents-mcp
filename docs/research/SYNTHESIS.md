# Research Synthesis: markdown-for-agents-mcp

**Date:** 2026-08-26  
**Scope:** All research files across web-layer, enterprise-knowledge, connectors, and patterns directories  
**Purpose:** Opinionated, actionable synthesis for product decisions and Phase 2 architecture

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Competitive Position Matrix](#2-competitive-position-matrix)
3. [Web Layer: What We Win and What We Must Add](#3-web-layer-what-we-win-and-what-we-must-add)
4. [Enterprise Knowledge Phase 2: Full Feature Gap Analysis](#4-enterprise-knowledge-phase-2-full-feature-gap-analysis)
5. [Connector Implementation Roadmap](#5-connector-implementation-roadmap)
6. [Implementation Steal List](#6-implementation-steal-list)
7. [Pattern Recommendations](#7-pattern-recommendations)
8. [The White Space](#8-the-white-space)

---

## 1. Executive Summary

### Web Layer (Phase 1 — live)

**Tavily is the correct primary web search backend.** The research confirms no competitor matches Tavily's combination of AI-native indexing, chunk-based reranking, five purpose-built endpoints (search/extract/map/crawl/research), and an official MCP server. The 1,000 free credits/month baseline and `include_usage: true` cost tracking make it responsible to operate at startup scale. The key insight from `tavily.md`: "chunk-based reranking" means Tavily returns pre-extracted ranked passages, not just URLs — exactly what agents need.

**Brave Search is the right fallback, not a replacement.** The `/res/v1/llm/context` endpoint returns pre-extracted text chunks with `maximum_number_of_tokens` control (1024–32768), `context_threshold_mode`, and `extra_snippets=true`. At $0.005/query with a 30B+ independent index and Goggles for per-query re-ranking, it is the only provider that combines low cost, independence from Google/Bing, and RAG-ready output. Use as a Tavily fallback when credits run out, not as primary.

**The three-tier render ladder is the right scraping architecture.** From `web-scraping-apis.md`: HTTP with impit (Chrome JA3/JA4 TLS fingerprint) → Lightpanda (Zig headless, 9–11x faster than Chrome, 123MB vs 2GB) → Playwright (BrowserContext pool, `--disable-blink-features=AutomationControlled`). This covers ~90% of the web without commercial API cost. Tier 4 (ScrapingBee `mode=auto` or Scrapfly `asp=true`) is the optional fallback for the hardest 10%.

**Jina's embedding model and reranker are the optimal self-hosted pairing.** From `jina.md`: jina-embeddings-v5-text-small (677M params, 32K context window, MTEB SOTA multilingual, Apache-2.0) + jina-reranker-v3.5 (0.6B params, 131K context, BEIR SOTA, beats Qwen3-4B). Late chunking — running the full document through the transformer before splitting — preserves cross-paragraph context that standard chunking destroys.

**Critical deadline: Perplexity Sonar API deprecated September 27, 2026.** From `perplexity.md`: migrate to Agent API with presets (fast/low/medium/high). The `sonar-reasoning` (non-pro) was already deprecated December 15, 2025. Any code referencing old models will break in 32 days from research date.

### Enterprise Knowledge (Phase 2)

**Glean is the design reference, not the competition.** At $300M ARR and 275+ connectors, Glean's architecture reveals what the market demands: early-binding ACL enforcement at the retrieval layer (documents the user cannot see never enter the LLM context window), cross-system entity linking, and webhook-driven near-real-time permission sync. We do not need to build all of this. We need the ACL enforcement pattern and the two connectors that matter: SharePoint and Confluence.

**Airweave has NO per-user ACL.** From `airweave.md`: "All data in a collection is accessible to any holder of the collection's API key." This is our competitive moat. Airweave has 50+ connectors, a production-grade MCP server (v0.5.7, Streamable HTTP), and brilliant three-tier search (instant/classic/agentic). But they explicitly require separate collections per permission boundary, which is unmanageable at enterprise scale. We implement Entra ID `transitiveMemberOf` enforcement at query time. This combination — Airweave's MCP transport architecture plus Onyx's per-user ACL enforcement — does not exist in any open-source project today.

**Onyx (formerly Danswer) is the implementation reference.** From `onyx.md`: 50K GitHub stars, MIT licensed, production-code solutions to every hard problem we will face — incremental sync with checkpointing, per-user ACL at the retrieval layer (not display layer), BM25 + vector RRF hybrid search with cross-encoder reranking, and contextual chunk augmentation (Anthropic's Contextual Retrieval technique). The ten architectural decisions in Section 15 of `onyx.md` should be treated as mandatory, not optional.

**Microsoft Graph OBO flow is the correct auth pattern for SharePoint.** From `microsoft-graph.md`: use On-Behalf-Of (OBO) token exchange for delegated search — the user provides their Entra token, we exchange it for a Graph token, and SharePoint enforces item-level permissions automatically. Zero ACL-filter code needed for Mode A. Delta sync with `@odata.deltaLink` tokens provides incremental change tracking. The webhook endpoint must return 202 within 3 seconds and process in a background queue, or Graph will throttle then drop notifications.

---

## 2. Competitive Position Matrix

| Dimension | Glean | Onyx | Airweave | M365 Copilot | Perplexity | **Our Project** |
|---|---|---|---|---|---|---|
| **Self-hosted** | BYOC only (GCP/AWS, Glean controls code) | Yes (MIT) | Yes (MIT) | No | No | **Yes (MIT)** |
| **POPIA-clean** | BYOC path available | Yes | Yes | No (Microsoft cloud) | No | **Yes** |
| **MCP-native** | Yes (tenant-specific, OAuth) | Experimental | Yes (v0.5.7, Streamable HTTP) | No | No | **Yes (Phase 1 live)** |
| **Web fetch+extract** | Partial (Exa via MCP) | Yes (search_web + open_urls tools) | No | No | Yes (Agent API) | **Yes (core feature)** |
| **Enterprise knowledge** | Yes (275+ connectors) | Yes (60+ connectors) | Yes (50+ connectors, no ACL) | M365 only | No | **Phase 2 (SharePoint + Confluence)** |
| **Per-user ACL** | Yes (retrieval layer, early binding) | Yes (EE feature, 9 connectors) | **No** | Yes (M365 only) | N/A | **Yes (Entra transitiveMemberOf, Phase 2)** |
| **MIT licence** | No (proprietary) | MIT (CE) | Yes | No | No | **Yes** |
| **Operational simplicity** | Low (multi-week setup, 100+ seat min) | Moderate (8 Celery workers, OpenSearch) | Moderate (Temporal + Vespa) | Low (M365 admin required) | Low (cloud-only) | **High (Docker Compose, 4 containers)** |
| **Cost at 5,000 seats** | $1.5M–$3M/year est. | $0 software + infra | $0 software + infra | $21–30/user/mo (M365 E5) | Per-query | **$50K–$130K/year (infra + maintenance)** |
| **Public pricing** | No | Free | Free / $16–$239/mo cloud | $21–30/user/mo | $5–50/1K queries | **Free** |

**Reading the matrix:** Our project wins on all dimensions that matter for POPIA-sensitive South African enterprise deployments: self-hosted, POPIA-clean, MIT licensed, low cost, and MCP-native. The gap is connector breadth (275 vs 2 connectors in Phase 2). That gap is acceptable for SharePoint + Confluence shops, which describes most M365-standardised enterprises.

---

## 3. Web Layer: What We Win and What We Must Add

### Where Our Pipeline Is Ahead

**1. Three-tier render ladder is architecturally correct.** No competitor documents this pattern explicitly. The `impit` approach (Rust Node.js bindings producing exact Chrome JA3/JA4 TLS fingerprint) is the right Tier 1 — it handles the majority of bot-protected sites without JavaScript execution. The key insight from `web-scraping-apis.md`: anti-bot detection has four layers — TLS fingerprint, navigator/canvas/WebGL fingerprint, behavioral timing, and Cloudflare/DataDome/Akamai ML models. impit defeats Layer 1. Lightpanda defeats Layers 1-2 faster than Chrome. Playwright defeats Layers 1-3.

**2. Provider diversity protects against any single-provider outage.** We have: Tavily (AI-native search), Brave (independent index + RAG endpoint), SearXNG (self-hosted, 272 engines), and optional Perplexity (when deep research warranted). No competitor that uses only one provider survives Tavily rate limits or index quality drops.

**3. robots.txt compliance is built in.** The `robots-parser` npm package with per-domain token bucket rate limiting and Gaussian timing noise from `web-scraping-apis.md` is the correct pattern. Most scraping tools ignore robots.txt. Our compliance is a genuine differentiator for enterprise deployments concerned about legal risk.

**4. Exa Highlights for token efficiency.** From `exa.md`: "Do not give agents full documents — give them extracted, ranked passages." Exa's Highlights feature gives 500 chars that match 8000 chars of full-text accuracy — 16x token efficiency. This is the right model for the final context window. We should implement this principle regardless of whether we use Exa: return ranked passages, not full documents.

### Top 5 Missing Capabilities with Implementation Notes

**Missing #1: Perplexity Agent API integration (DEADLINE: September 27, 2026)**

The Sonar API hard-deprecation is 32 days away. Any production use of `sonar`, `sonar-pro`, `sonar-reasoning-pro`, or `sonar-deep-research` will break.

Implementation:
```typescript
// Migrate to Agent API (new endpoint: POST https://api.perplexity.ai/v1/agent)
// Migration mapping:
// sonar → preset: "fast" (1 search, gpt-5.6-luna)
// sonar-pro → preset: "low" (1 search, 1 fetch)
// sonar-reasoning-pro → preset: "medium" (2 searches, 2 fetches)
// sonar-deep-research → preset: "high" (3+3, gpt-5.6-sol) or "xhigh" (4+4+sandbox)
const agentResponse = await fetch('https://api.perplexity.ai/v1/agent', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
  body: JSON.stringify({
    preset: 'medium',
    messages: [{ role: 'user', content: query }],
    search_domain_filter: allowlist,  // up to 20 domains; cannot mix allow + deny
    search_recency_filter: 'month',   // hard cutoff — 'hour' returns zero results for most topics
  }),
});
```

Note from research: The Perplexity domain filter cannot mix allowlist and denylist in the same request. Agent API tool pricing: web_search=$0.0025/call, fetch_url=$0.0005/call.

**Missing #2: Brave Goggles for per-query re-ranking**

From `brave-search.md`: inline Goggles rules require no registration. URL-encoded `$boost=N`, `$downrank=N`, `$discard`, `site=domain.com` tokens can be injected per MCP tool call.

```typescript
// Goggles for domain-specific searches (e.g., boost official docs)
const googlesRule = encodeURIComponent(
  `$boost=3,site=docs.company.com\n$downrank=5,site=reddit.com`
);
const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&goggles_id=${googlesRule}`;
// Check web.mutated_by_goggles boolean in response to confirm rules applied
```

**Missing #3: Jina late chunking for enterprise knowledge indexing**

From `jina.md`: late chunking runs the full document through the transformer before splitting. Standard chunking loses cross-paragraph context. The 512-d Matryoshka truncation gives ~95% retrieval quality at 2x storage savings.

Implementation priority: when we build the Phase 2 knowledge index, embed at 1024-d during indexing and store truncated 512-d for search. This is a one-time architectural decision — changing dimensions requires re-embedding the entire corpus.

**Missing #4: SearXNG + Brave dual-provider pattern**

From `searxng.md`: SearXNG has no result cache (Valkey is bot protection only). Every query hits live engines. When an engine is rate-limited, it suspends: AccessDenied=24h, CAPTCHA=24h, TooManyRequests=1h, Cloudflare CAPTCHA=15d. The correct pattern:

```typescript
// Primary: SearXNG (free, self-hosted, 272 engines)
// Fallback: Brave Search API when enough engines are suspended
async function search(query: string): Promise<SearchResult[]> {
  const searxResults = await searxng.search(query, { format: 'json' });
  const activEngines = searxResults.results.length;
  
  // Fall back if SearXNG is returning sparse results
  if (activeEngines < 3) {
    return braveSearch(query);  // $0.005/query, reliable 30B+ index
  }
  return searxResults;
}
```

**Missing #5: Redis `allkeys-lru` caching with probabilistic early expiration**

From `web-scraping-apis.md`: cache stampede prevention via `SET NX` lock for probabilistic early expiration. The `buildCacheKey` function hashes `renderTier:normalizedUrl`. TTL inference by URL pattern: versioned content (docs with version in URL) = 24h, news = 30min, default docs = 1h. This is not implemented in most MCP servers and has a measurable impact on API cost at scale.

---

## 4. Enterprise Knowledge Phase 2: Full Feature Gap Analysis

### What Glean/Onyx/Airweave Do That Our Proposal Doesn't Cover

**Gap 1: Contextual Chunk Augmentation (Onyx → must implement)**

From `onyx.md` (migration `19c0ccb01687`): each chunk gets a short LLM-generated context sentence before embedding. A chunk "The default value is 30 days" becomes retrievable as "From the Onyx security documentation on access controls: The default permission cache TTL is 30 days." Anthropic's research shows this dramatically improves chunk-level retrieval.

**Implementation:** At index time, before embedding each 512-token chunk, call Claude Haiku with:
```
"Here is a chunk from document '{title}' in space '{space}'. 
Context: <document_excerpt>
Chunk: <chunk_text>
Write one sentence of context: "This chunk is from..."
```
Add the context sentence as a prefix to the chunk text before embedding. Cost: ~$0.0001/chunk at Haiku pricing.

**Gap 2: Slim Document Permission Sync (Onyx → must implement)**

From `onyx.md` Section 15, Decision 4: "Fetching the full content of 50,000 SharePoint pages every hour just to check if permissions changed is insane." Onyx runs a separate `SlimConnector` pass that fetches only document IDs and ACLs, not content.

Implementation: A `perm-sync` BullMQ queue that fires every 30 minutes, calls `GET /drives/{driveId}/items/{itemId}/permissions` for each indexed document, and updates only `allowed_group_ids` and `allowed_user_ids` in Postgres. Content re-embedding only on `lastModifiedDateTime` change.

**Gap 3: Post-Query Censoring for Complex ACL Sources (Onyx → must have for Salesforce)**

From `onyx.md` Section 5.4: Salesforce's sharing rules cannot be represented as a flat ACL. Onyx calls the source API to verify each result after retrieval (`backend/ee/onyx/external_permissions/salesforce/postprocessing.py`). Any connector where ACL cannot be pre-computed needs this pattern.

**Gap 4: Cross-System Identity Resolution (Glean → must implement for Confluence)**

From `glean.md` Section 5.5: Confluence user IDs must map to Entra object IDs to use `transitiveMemberOf` groups for Confluence ACL enforcement. The join key is email. At index time, build a map of `confluenceAccountId → entraObjectId` by calling both Confluence `/users` and Graph `/users` APIs.

**Gap 5: Delta Token Expiry Handling (Microsoft Graph → must implement)**

From `microsoft-graph.md` Section 7.4: delta tokens are valid for ~4 weeks. HTTP 410 Gone means full resync required. The `Location` header in a 410 response contains the new initial delta URL. Without handling 410, a connector silently stops receiving updates after the token expires.

**Gap 6: Three-Tier Search (Airweave → should implement)**

From `airweave.md` Section 6: instant (vector only, ~0.5s) / classic (LLM-planned, ~3s) / agentic (multi-step agent, up to 2min). The tier parameter lets the calling agent pick latency/quality tradeoff per query. This is superior to a single search endpoint.

**Gap 7: Subscription Lifecycle Notifications (Microsoft Graph → must implement)**

From `microsoft-graph.md` Section 8.7: `reauthorizationRequired` and `subscriptionRemoved` lifecycle events. Without a `lifecycleNotificationUrl`, expired subscriptions silently stop delivering notifications. Add a scheduled renewal job at 50% of the 29-day driveItem maximum.

### Ranked Features for KNOWLEDGE_INDEX_PROPOSAL.md

| Rank | Feature | Source | Effort | Impact |
|---|---|---|---|---|
| 1 | Early-binding ACL enforcement (Glean pattern) | glean.md §4, onyx.md §5 | M | Critical |
| 2 | SharePoint delta sync + webhook trigger | microsoft-graph.md §7–8 | M | Critical |
| 3 | Confluence OAuth connector + polling sync | onyx.md connector catalog | M | Critical |
| 4 | Entra transitiveMemberOf cache (15min TTL) | microsoft-graph.md §10 | S | Critical |
| 5 | BM25 + vector RRF hybrid search (pgvector + tsvector) | onyx.md §7 | M | High |
| 6 | Cross-encoder reranking (jina-reranker-v3.5) | jina.md | S | High |
| 7 | Contextual chunk augmentation (Claude Haiku) | onyx.md §7.7 | S | High |
| 8 | Slim document permission sync (separate pass) | onyx.md §15 Decision 4 | M | High |
| 9 | Three-tier search (instant/classic/agentic) | airweave.md §6 | L | Medium |
| 10 | Confluence → Entra identity resolution | glean.md §5.5 | M | High |
| 11 | Delta token 410 handling + full resync | microsoft-graph.md §7.4 | S | High |
| 12 | MSAL OBO flow with Redis cache plugin | microsoft-graph.md §4.2–4.3 | M | Critical |
| 13 | Citation tracking in streaming responses | glean.md §14 Pattern 5 | M | Medium |
| 14 | Webhook lifecycle notifications + renewal | microsoft-graph.md §8.7 | S | High |
| 15 | Post-query censoring for complex ACL sources | onyx.md §5.4 | M | Medium |

### Architectural Patterns to Adopt

**From Glean:** ACL check happens BEFORE similarity ranking (early binding). The `topK: 100` with post-filter is necessary because ACL filtering may reduce 100 candidates to 5. Never fetch only topK=10 and filter.

**From Onyx:** Separate indexing model server from inference model server. Embed during indexing as a background job. Never embed inline in the MCP tool handler. Use `CheckpointedConnector` for SharePoint (delta token as checkpoint, not timestamp).

**From Airweave:** Stateless Streamable HTTP MCP transport. Per-request auth, no server-side sessions. SSE for agentic search with `started/thinking/tool_call/reranking/done/error` event types.

**From Microsoft Graph:** OBO flow gives automatic SharePoint ACL enforcement for delegated queries. Reserve app-only for background indexing jobs. Use `GET /users/{id}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999` with `ConsistencyLevel: eventual` for group membership.

---

## 5. Connector Implementation Roadmap

| Priority | Connector | Auth Method | Sync Type | ACL Enforcement | Complexity | Use Case Priority |
|---|---|---|---|---|---|---|
| **P0** | SharePoint | Certificate (for ACL) or OBO (for search) | CheckpointedConnector (delta token) | Entra transitiveMemberOf + Graph permissions API | L | Reference deployment primary |
| **P0** | Confluence | OAuth2 or API token | Poll (30min) | Confluence groups → Entra email mapping | M | Reference deployment primary |
| **P1** | Microsoft Teams | Azure app registration | Poll / webhook | Entra groups (native M365) | M | M365 shops |
| **P1** | Notion | OAuth2 | Poll | None (public/private only) | S | Tech companies |
| **P2** | GitHub | PAT or GitHub App | CheckpointedConnector | Repository visibility + team membership | M | Engineering teams |
| **P2** | Jira | OAuth2 or API token | Poll with checkpoint | Project-level permissions | M | Engineering teams |
| **P3** | Slack | OAuth2 Bot token | Poll / federated | Channel membership (complex) | L | Comms-heavy orgs |
| **P3** | Google Drive | Service account (admin OAuth for ACL) | Poll | Google Groups (domain-wide delegation required) | M | G Suite shops |
| **P4** | Salesforce | OAuth2 connected app | Poll with checkpoint | Post-query censoring (not pre-filter) | L | Sales teams |
| **P4** | ServiceNow | OAuth2 / credentials | Poll | Post-query censoring | M | ITSM teams |
| **P4** | Zendesk | OAuth2 | Poll | Limited (org-level only) | S | Support teams |

**Implementation notes:**

**SharePoint:** Certificate auth is non-negotiable for full ACL mirroring. From `onyx.md` §16.2: client secret auth cannot enumerate site collection administrator permissions — `Sites.FullControl.All` requires certificate-based app registration. Many IT departments will resist. Document the fallback: run without ACL sync (all indexed content visible to all authenticated users).

**Confluence:** Lacks webhooks for permission changes. From `onyx.md` §17.3: "Polling-based sync (Confluence lacks webhooks for permission changes) — Full re-sync scheduled job (nightly)." The group sync against Entra runs hourly; Confluence content polling runs every 30 minutes.

**Slack:** From `onyx.md` §16.3: indexed mode (better quality) stores message content. This creates GDPR/POPIA data retention obligations. Start with explicit documentation of what is indexed. Federated mode (live query at search time) has higher latency and lower quality but no retention issue.

**Incremental sync priority:** CheckpointedConnector is mandatory for SharePoint (use delta token, not timestamp — timestamps miss renames and moves). Optional for Confluence (pages have stable modification timestamps). Critical insight from `onyx.md` §15 Decision 2: if the sync process dies mid-run, a checkpointed connector resumes from where it left off; a time-window connector re-indexes everything.

---

## 6. Implementation Steal List

The top 20 specific techniques to steal, with exact source citation:

| # | What to Steal | From | TypeScript Approach | Priority |
|---|---|---|---|---|
| 1 | Early-binding ACL filter before similarity ranking | glean.md §4.1, §14 Pattern 1 | `WHERE NOT (caller_user_id = ANY(denied_user_ids))` as SQL WHERE clause before ORDER BY embedding | P1 |
| 2 | topK: 100 with post-ACL filter (never topK: 10) | glean.md §14 Pattern 1 | Fetch 100 candidates from pgvector, filter by ACL, return top 10 | P1 |
| 3 | OBO token exchange for delegated SharePoint search | microsoft-graph.md §4.2 | `@azure/msal-node` `acquireTokenOnBehalfOf()` with Redis cache plugin | P1 |
| 4 | Delta token as connector checkpoint (not timestamp) | microsoft-graph.md §7, onyx.md §15 Decision 2 | Store full `@odata.deltaLink` URL in `connector_sync_state.checkpoint` JSONB | P1 |
| 5 | RRF hybrid search (BM25 + vector, k=60) | onyx.md §7.3 | PostgreSQL CTE: `1/(60+bm25_rank) + 1/(60+vector_rank)` — direct SQL | P1 |
| 6 | Contextual chunk augmentation before embedding | onyx.md §7.7 | Prepend Claude Haiku-generated context sentence to each chunk text before embedding | P1 |
| 7 | Slim permission sync (separate from content sync) | onyx.md §15 Decision 4 | Separate BullMQ `perm-sync` queue; fetch only item IDs + permissions API, no content download | P1 |
| 8 | transitiveMemberOf cache with 15min TTL | microsoft-graph.md §10.6 | `node-cache` with `stdTTL: 900`; paginate with `$top=999` + `ConsistencyLevel: eventual` | P1 |
| 9 | MSAL Redis cache plugin for OBO tokens | microsoft-graph.md §4.3 | `ICachePlugin` backed by Redis; per-user key prefix; 7200s TTL | P1 |
| 10 | BullMQ queue separation (I/O vs CPU) | onyx.md §15 Decision 10 | `doc-fetch` queue (concurrency=10) + `doc-process` queue (concurrency=2) | P1 |
| 11 | Stateless Streamable HTTP MCP transport | airweave.md §5.1 | Per-request `McpServer` instance; no sessions; `X-API-Key` + `Authorization: Bearer` both supported | P1 |
| 12 | Three-tier search (instant/classic/agentic) | airweave.md §5.3 | MCP tool `tier` parameter; instant = pgvector only; classic = RRF + LLM rerank; agentic = multi-step loop | P2 |
| 13 | FilterGroup AND/OR structure | airweave.md §6.5 | Conditions within group AND'd; multiple groups OR'd; `airweave_system_metadata.source_name` field | P2 |
| 14 | Webhook endpoint returns 202 immediately, processes async | microsoft-graph.md §8.5, §8.9 | Queue notification to BullMQ; return `res.status(202).send()` before processing; never do I/O inline | P1 |
| 15 | 410 Gone handling — full resync from Location header | microsoft-graph.md §7.4 | `if (resp.status === 410) { const newStartUrl = resp.headers.get('Location'); ... }` | P1 |
| 16 | Exponential backoff with Retry-After header | microsoft-graph.md §12.6 | Respect `Retry-After` header; jitter: `baseDelayMs * 2^attempt * (0.5 + random*0.5)` | P1 |
| 17 | Brave Goggles inline per-query re-ranking | brave-search.md | URL-encode `$boost=N,site=...` rules; check `web.mutated_by_goggles` response field | P2 |
| 18 | impit Chrome TLS fingerprint (Tier 1 scraping) | web-scraping-apis.md | `import { Impit } from 'impit'; new Impit({ browser: 'chrome' })` | P2 |
| 19 | `p-queue` concurrency cap on Graph API calls | microsoft-graph.md §12.7 | `new PQueue({ concurrency: 10, intervalCap: 50, interval: 1000 })` | P1 |
| 20 | Confluence → Entra identity resolution via email | glean.md §5.5, §14 Pattern 2 | Build `Map<confluenceAccountId, entraObjectId>` at index time using email as join key | P1 |

---

## 7. Pattern Recommendations

### Embedding Model

**Recommendation: jina-embeddings-v5-text-small with 512-d Matryoshka truncation.**

From `jina.md`:
- 677M parameters
- 32,768 token context window (handles long documents without truncation)
- MTEB SOTA on multilingual benchmarks
- Apache-2.0 licence — can embed directly in our Docker image
- Matryoshka embeddings: store at 1024-d during indexing, truncate to 512-d for storage/search
- Late chunking: run full document through transformer before splitting chunks; preserves cross-paragraph context that standard chunking destroys

Alternative for cost-sensitive deployments: OpenAI `text-embedding-3-small` at 1536-d. Less storage efficient than 512-d Matryoshka but no model hosting required.

Do NOT use 3072-d (text-embedding-3-large) by default — the storage cost and query latency increase is not justified unless retrieval quality is measurably insufficient for the specific domain.

### Search Library: pgvector vs Qdrant vs SQLite-vec

**Recommendation: PostgreSQL + pgvector for Phase 2.**

| Library | For | Against |
|---|---|---|
| **pgvector** | Already have Postgres; ACL stored in same DB; BM25 via tsvector; no extra operational overhead; HNSW index with `vector_cosine_ops` | Not a dedicated vector DB; kNN search slower than Qdrant at very high volume |
| **Qdrant** | Purpose-built; Rust; managed cloud option; payload filtering native | Separate service to operate; ACL filters must be replicated from Postgres into Qdrant payload |
| **SQLite-vec** | Zero operational overhead; embedded; works on a laptop | No production-grade ACL filter support; no BM25 hybrid search; not suitable for >100K chunks |
| **OpenSearch** | What Onyx uses; excellent hybrid search | Heavy (4–8GB RAM for OpenSearch alone); deeply integrated, hard to swap |

**Key insight from `onyx.md` §16.1:** OpenSearch coupling is deep. Switching from OpenSearch to another backend requires rewriting the entire retrieval layer. Onyx migrated FROM Vespa TO OpenSearch and it was a significant undertaking. **Choose your search backend once and commit.**

For Phase 2 at large-enterprise scale (SharePoint + Confluence, estimated 500K–2M indexed chunks): pgvector with HNSW index is adequate. HNSW at this scale has ~10ms query latency for vector search, which is acceptable.

Switch to Qdrant when: query latency is measurably problematic AND the corpus exceeds 5M chunks AND the operational team has capacity to run a second service.

### Reranking Approach

**Recommendation: jina-reranker-v3.5 as a sidecar service.**

From `jina.md`:
- 0.6B parameters
- 131K token context window (essential for long enterprise documents)
- Listwise scoring (scores all candidates jointly, not pairwise)
- BEIR SOTA as of August 2026, beats Qwen3-4B

Two-stage pipeline (from `onyx.md` §7.4):
1. Recall stage: BM25 + vector RRF → top 100 candidates (fast, ~10ms)
2. Precision stage: jina-reranker-v3.5 → top 10 reranked (slower, ~200ms, applies to small set)

Cohere `rerank-v4.0-pro` (used by Airweave in agentic search) is a cloud alternative. Do not use it for Phase 2 — it adds an external API dependency and POPIA concern. Run jina-reranker-v3.5 locally.

### ACL Enforcement Plan

**Phase 2 ACL enforcement must be at the retrieval layer (early binding), not the display layer.**

From `glean.md` §4.1: "If a user lacks direct or group-inherited read rights to a document, that document is filtered out entirely at the retrieval layer — it never enters the LLM context window." This is a security requirement, not a UX requirement. Filtering at the display layer leaks document existence through the LLM's context window.

**Implementation plan:**

```sql
-- PostgreSQL schema (from onyx.md §12.3 + glean.md §14 Pattern 1)
CREATE TABLE document_chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  source_type     TEXT NOT NULL,         -- 'sharepoint' | 'confluence'
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  url             TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  embedding       VECTOR(512),            -- Matryoshka 512-d
  search_vector   TSVECTOR,               -- BM25 via tsvector
  acl_users       TEXT[] DEFAULT '{}',    -- Entra object IDs (explicit)
  acl_groups      TEXT[] DEFAULT '{}',    -- Entra group IDs (from transitiveMemberOf)
  acl_denied_users TEXT[] DEFAULT '{}',   -- explicit denials win
  is_public       BOOLEAN DEFAULT FALSE,  -- visible to all authenticated users
  metadata        JSONB DEFAULT '{}'
);

-- ACL filter runs BEFORE ORDER BY embedding (early binding)
-- Fetches topK=100 candidates THEN applies ACL filter
-- NEVER fetch topK=10 then filter — you'll return too few results
```

**Key ACL gotchas:**
1. SharePoint certificate auth required for `Sites.FullControl.All` — client secret insufficient
2. Confluence group names must be resolved to Entra group IDs via email join key
3. Group membership changes propagate with up to 1-hour lag (group sync interval)
4. Explicit denials must override allows — check `acl_denied_users` before `acl_users`
5. transitiveMemberOf pagination: users in >999 groups require multiple API calls (`@odata.nextLink`)

---

## 8. The White Space

These are things NO competitor does today. Genuine uniqueness opportunities.

### White Space #1: Per-User ACL + MCP-Native in One Open-Source Package (UNIQUE TODAY)

Airweave has the best MCP architecture but no per-user ACL. Onyx has per-user ACL but MCP is experimental. Glean has both but is proprietary, $60K+ minimum, and BYOC still requires Glean involvement.

**The opportunity:** An MIT-licensed MCP server that combines Airweave's three-tier search architecture with Onyx's per-user Entra ACL enforcement. This does not exist. Building it is the entire Phase 2 thesis.

### White Space #2: POPIA-Compliant Enterprise Knowledge for South African Organisations

Glean stores data on GCP/AWS. Microsoft M365 Copilot stores data in Microsoft's cloud (even if in South African data centres, it is subject to US CLOUD Act). Airweave cloud is US-hosted.

**The opportunity:** A completely self-hosted, POPIA-clean enterprise knowledge index that can run in a South African data centre, on the deploying organisation's own infrastructure, with no data leaving the country. No competitor sells this as a first-class capability. We do not sell anything — we provide the MIT-licensed code and the customer runs it.

### White Space #3: Hybrid Web + Enterprise in One MCP Tool Call

Every competitor separates web search (Perplexity, Tavily, Brave) from enterprise knowledge (Glean, Onyx, Airweave). No competitor gives agents a single tool that queries both in parallel and merges results.

**The opportunity:**
```typescript
// Single MCP tool call that searches both layers simultaneously
const [webResults, enterpriseResults] = await Promise.all([
  searchWeb(query, { providers: ['tavily', 'brave'] }),
  searchEnterpriseKnowledge(query, { userId, groups }),
]);
const merged = rrfMerge([webResults, enterpriseResults]);
```

From `perplexity.md` Section (hybrid pattern): "run `perplexityClient.search.create()` and `enterpriseKnowledgeIndex.search()` in parallel." Perplexity documented the pattern but does not provide the enterprise knowledge layer. We can provide both.

### White Space #4: MCP-as-Documentation (Public, No-Auth, Documentation-Focused)

From `glean.md` §12: Glean ships a separate public MCP server at `https://developers.glean.com/mcp` that gives coding assistants access to Glean's developer documentation. This makes it trivially easy for Claude Code and Cursor users to ask questions about Glean APIs without leaving their IDE.

**The opportunity:** Ship a public, zero-auth MCP server for the markdown-for-agents-mcp documentation itself. A developer configuring the SharePoint connector can ask their coding assistant "how do I configure ACL sync for a Confluence connector?" and get instant answers from the actual research documents and implementation guides — without leaving their IDE.

This costs nothing to build (it is literally our existing web fetch tool pointed at our own docs) and provides a compelling demo of our own product using our own product.

### White Space #5: Cost-Transparent MCP Tool with Real-Time Usage Logging

No competitor publishes per-call costs in their MCP tool responses. Tavily's `include_usage: true` returns token/credit consumption. We can aggregate and surface this:

```typescript
// Every MCP tool response includes cost metadata
return {
  results: [...],
  _usage: {
    tavily_credits: 1,
    brave_queries: 0,
    embedding_tokens: 512,
    reranker_ms: 187,
    estimated_cost_usd: 0.001,
  }
};
```

Enterprise customers care intensely about LLM cost attribution. Being the only MCP server that surfaces per-call cost metadata is a differentiated capability at zero implementation cost.

### White Space #6: Connector Health Dashboard as MCP Resource

From `airweave.md` §7.6: "There is limited observability into which source caused throttling and when it will retry." SearXNG has the same problem — engines suspend silently.

**The opportunity:** Expose connector sync state as an MCP resource:
```json
{
  "connectors": [
    { "id": "sharepoint-main", "status": "healthy", "last_sync": "2026-08-26T12:00:00Z", "doc_count": 45231 },
    { "id": "confluence-eng", "status": "degraded", "error": "Rate limited, retries in 43 minutes", "last_sync": "2026-08-26T10:15:00Z" }
  ]
}
```

Agents can query this resource before deciding whether to use enterprise knowledge or fall back to web search. No competitor exposes this pattern.

### White Space #7: Zero-Config Enterprise Quick-Start

Every competitor's documentation assumes a generic enterprise. No one ships a quick-start guide pre-configured for the M365 + SharePoint + Confluence + Entra ID stack that dominates South African telecoms and financial services.

**The opportunity:** A `QUICKSTART_ENTERPRISE.md` (or any similar corporate profile) that documents exactly the app registration steps, permission grants, connector configuration, and test queries needed to get from zero to searching SharePoint and Confluence in under 2 hours. This is not technical work — it is documentation work. But for enterprise sales, it is worth more than most features.

---

## Cross-Cutting Conclusions

### Build Order (Phase 2)

Based on the full research corpus, the build order is:

1. **PostgreSQL schema** with HNSW index + tsvector + ACL arrays (Week 1)
2. **Entra ID OBO flow** + transitiveMemberOf cache (Week 1–2)
3. **SharePoint connector** with delta token checkpoint sync (Week 2–5)
4. **ACL-filtered hybrid search** (RRF BM25 + vector, topK=100 then filter) (Week 3–4)
5. **`search_enterprise_knowledge` MCP tool** with Entra OAuth (Week 4–5)
6. **Confluence connector** with email→Entra identity resolution (Week 6–9)
7. **Contextual chunk augmentation** (Claude Haiku at index time) (Week 7)
8. **Slim permission sync** (separate perm-sync BullMQ queue) (Week 8)
9. **Webhook subscription management + lifecycle notifications** (Week 9–10)
10. **Streaming responses with citation tracking** (Week 10–11)

### The Single Most Important Architectural Decision

ACL enforcement must be early binding (retrieval layer), not late binding (display layer). Every other decision follows from this. If you build the vector index first and add ACL later, you will rewrite the entire retrieval pipeline. Build ACL into the schema, the search function, and the BullMQ worker from day one.

From `glean.md` §14 Pattern 1 and `onyx.md` §15 Decision 3: both Glean (proprietary gold standard) and Onyx (open-source reference implementation) make this the foundational architectural choice. It is not optional.

### The Competitor We Most Resemble

Airweave, with the ACL gap closed. Same MIT license. Same MCP-first architecture. Same connector-based knowledge index. But with Entra `transitiveMemberOf` group membership enforcement at query time, making it suitable for POPIA-sensitive enterprise deployments that Airweave explicitly cannot serve.

---

*Sources: all findings cite specific research files in `/docs/research/`. Key files: `glean.md` (1806 lines), `onyx.md` (1656 lines), `airweave.md` (1401 lines), `microsoft-graph.md` (2060 lines), `brave-search.md` (2033 lines), `searxng.md` (1844 lines), `perplexity.md` (1692 lines), `web-scraping-apis.md` (2188 lines, truncated at 1819 in reading session), `tavily.md` (1911 lines), `firecrawl.md` (1827 lines), `jina.md` (1698 lines), `exa.md` (1576 lines).*
