# Airweave: Open-Source Context Retrieval Layer — Deep Research

> Status: August 2026
> Sources: docs.airweave.ai, github.com/airweave-ai/airweave, airweave.ai/academy, deepwiki.com/airweave-ai/airweave, mcp.airweave.ai

---

## TL;DR for Implementation

Airweave is the most directly relevant prior art for markdown-for-agents-mcp Phase 2. It solved the same problem we are solving — a self-hosted, MIT-licensed MCP server that gives AI agents unified search across 50+ enterprise data sources — and their architecture reveals both the right patterns to follow and the hard tradeoffs we will face.

**What to implement from Airweave:**

1. The three-tier search model (instant vector / classic LLM-planned / agentic iterative) is brilliant — implement all three
2. The stateless Streamable HTTP MCP transport is the correct architecture for a hosted MCP endpoint
3. Collections as the primary abstraction (multi-source namespaces) maps perfectly to our planned knowledge index
4. The filter system (AND-within-group, OR-across-groups, filterable system metadata) should be copied almost verbatim
5. The SSE streaming for agentic search is table stakes for any deep-search capability

**What to skip or do differently:**

1. Airweave has NO per-user ACL enforcement — all collection data is accessible to any API key holder. This is our competitive gap to exploit. We implement Entra ID `transitiveMemberOf` enforcement at query time; they do not.
2. Temporal for workflow orchestration is heavy — only justify if sync volume warrants it. Start with simple cron + async queues.
3. Vespa is a sophisticated choice but hard to self-host. Evaluate Qdrant or Weaviate for simpler operational story.

---

## 1. Product Overview

**Repository:** https://github.com/airweave-ai/airweave
**License:** MIT
**GitHub Stars:** ~6,400 (July 2026)
**Last Indexed:** 3 July 2026 (commit 1ebe1a per DeepWiki)

Airweave describes itself as an "open-source context retrieval layer for AI agents." It sits between AI systems and data sources, continuously syncing content from 50+ connectors, embedding and indexing it, and exposing a unified search API that any agent or RAG pipeline can query.

The core value proposition: instead of each AI application building its own per-source integration and keeping its own stale embeddings, Airweave acts as shared retrieval infrastructure. Connect once, search everywhere, stay current.

**Deployment options:**

| Mode | URL | Notes |
|---|---|---|
| Cloud (hosted) | app.airweave.ai | Managed, metered by plan |
| Self-hosted | localhost via Docker Compose | Full MIT, no usage limits |

---

## 2. Pricing (Cloud)

Source: airweave.ai homepage (August 2026)

| Plan | Monthly | Source Connections | Queries/mo | Entities Synced/mo | Team Members |
|---|---|---|---|---|---|
| Developer | Free | 10 | 50 | 50,000 | 1 |
| Pro | $16 | 50 | 500 | 100,000 | 2 |
| Startup | $239 | Unlimited | Higher | Higher | — |
| Enterprise | Custom | Unlimited | Unlimited | Unlimited | Unlimited |

Note: Annual billing saves 20%.

Self-hosted is completely free with no usage limits — this is the path for privacy-sensitive enterprise deployments and for our own use case. There is no feature differentiation between cloud and self-hosted at the product layer (OAuth for the hosted MCP server is the one exception, as noted in section 5).

---

## 3. Core Architecture

Source: docs.airweave.ai/concepts, deepwiki.com/airweave-ai/airweave/2-architecture-overview

### 3.1 Conceptual Model

Airweave has five primary concepts:

**Source** — An external application or database (Slack, GitHub, SharePoint, etc.). Global templates defining the connector type's capabilities, auth requirements, and output schema. Registered in `ALL_SOURCES`.

**Connector** — The implementation code for a source. Handles auth, data extraction, entity mapping, and incremental sync. Abstracts pagination, rate limits, and API quirks.

**Source Connection** — A configured, authenticated instance of a connector linked to a specific account/workspace. When you create a source connection you select a connector, authenticate, and assign it to a collection. Multiple source connections of the same type are supported (e.g., two Slack workspaces).

**Entity** — A single searchable item extracted from a source. Atomic units: a Slack message, a Notion page, a GitHub PR, a SharePoint document. Each entity is extracted, transformed to standardised format, chunked if long, embedded, and indexed.

**Collection** — A searchable knowledge base composed of entities from one or more source connections. The primary query target. A single collection can aggregate GitHub, Slack, Notion, Salesforce, and anything else simultaneously.

### 3.2 System Components

The full self-hosted stack requires:

```
Backend (FastAPI / Python)    - REST API + sync engine
Frontend (React)              - Dashboard UI
Vespa                         - Vector + keyword search index
PostgreSQL                    - Metadata, sync state, auth
Temporal                      - Workflow orchestration for sync jobs
Redis                         - MCP server session management + auth caching
```

The MCP server is a separate Node.js process. The backend is Python (FastAPI). The frontend is React with Zustand for state.

### 3.3 Data Flow (End-to-End)

```
1. User creates a Collection via dashboard or API
2. User creates a Source Connection (selects connector, authenticates)
3. Airweave schedules initial full sync via Temporal workflow
4. SyncFactory builds the orchestrator (resolves config, credentials, source instance, destinations, entity tracker, dispatcher, pipeline, worker pool, source stream)
5. AsyncSourceStream runs producer task: source.generate_entities() → asyncio.Queue (maxsize 10,000)
6. SyncOrchestrator pulls from queue, groups into micro-batches (default 64), submits to AsyncWorkerPool
7. Worker pool applies AsyncSemaphore for concurrency control
8. EntityPipeline processes each entity: track state changes, resolve actions (upsert/delete), dispatch to Vespa
9. Vespa stores dense vectors + BM25 term index per document chunk
10. Temporal triggers subsequent incremental syncs on schedule
11. Agent calls search API → Vespa query → ranked results returned
```

### 3.4 Sync Types

| Type | Description | How Tracked |
|---|---|---|
| Full sync | Re-fetch all entities | Runs on initial connection |
| Incremental sync | Only new/modified entities | Cursor-based per connector |

Connectors that implement cursor tracking persist their sync state (cursors) between runs. The `EntityTracker` records which entities were seen, enabling detection of deletions.

Temporal handles scheduling. Syncs can also be triggered manually via `POST /source-connections/{id}/run`.

---

## 4. Connector Catalog

Source: docs.airweave.ai/connectors/overview (August 2026)

Total connectors: **50** (homepage says "over 50")

### 4.1 Complete Connector List by Category

#### Productivity and Collaboration

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Notion | OAuth 2.0 | Pages, databases, blocks, database rows |
| Slack | OAuth 2.0 | Messages, threads, channels, users |
| Asana | OAuth 2.0 | Tasks, projects, teams, users |
| Monday | OAuth 2.0 | Boards, items, groups, columns |
| Linear | API Key | Issues, projects, teams, cycles, labels |
| Trello | OAuth 2.0 | Boards, cards, lists, checklists |
| ClickUp | OAuth 2.0 | Tasks, lists, spaces, folders, docs |
| Todoist | OAuth 2.0 | Tasks, projects, sections, labels |
| Airtable | API Key/OAuth | Tables, records, views, fields |
| Coda | API Key | Docs, tables, pages, rows |
| Slab | OAuth 2.0 | Posts, topics, series |
| Slite | OAuth 2.0 | Notes, channels, collections |

#### Cloud Storage and Documents

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Google Drive | OAuth 2.0 | Files, folders, metadata |
| Google Docs | OAuth 2.0 | Document content, revisions |
| Google Slides | OAuth 2.0 | Presentation content, slides |
| Dropbox | OAuth 2.0 | Files, folders, shared links |
| OneDrive | OAuth 2.0 | Files, folders (Microsoft Graph) |
| Box | OAuth 2.0 | Files, folders, collaborations |
| SharePoint | OAuth 2.0 | Sites, drives, files, lists, pages, users, groups |
| Word | OAuth 2.0 | Document content (via Microsoft Graph) |
| OneNote | OAuth 2.0 | Notebooks, sections, pages |
| PowerPoint | OAuth 2.0 | Presentation content (via Microsoft Graph) |
| Document360 | API Key | Knowledge base articles, categories |

#### Developer Tools

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| GitHub | API Key (PAT) | Repos, issues, PRs, commits, code, releases |
| GitLab | OAuth 2.0 / API Key | Projects, issues, MRs, commits |
| Bitbucket | OAuth 2.0 | Repos, issues, PRs, commits |
| Jira | OAuth 2.0 | Issues, epics, sprints, projects, users |
| Confluence | OAuth 2.0 | Spaces, pages, blog posts, attachments |

#### CRM and Sales

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Salesforce | OAuth 2.0 | Accounts, contacts, leads, opportunities, cases |
| HubSpot | OAuth 2.0 | Contacts, companies, deals, tickets, notes |
| Pipedrive | OAuth 2.0 / API Key | Persons, deals, organisations, activities |
| Attio | API Key | People, companies, workspaces, records |
| Zoho CRM | OAuth 2.0 | Leads, contacts, accounts, deals |
| Apollo | API Key | Contacts, accounts, sequences |

#### Communication and Email

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Gmail | OAuth 2.0 | Messages, threads, labels, attachments |
| Outlook Mail | OAuth 2.0 | Messages, folders, attachments (Microsoft Graph) |
| Outlook Calendar | OAuth 2.0 | Events, calendars, attendees |
| Google Calendar | OAuth 2.0 | Events, calendars, attendees |
| Microsoft Teams | OAuth 2.0 | Channels, messages, teams, meetings |
| Zoom | OAuth 2.0 | Meetings, recordings, transcripts |
| Fireflies | API Key | Meeting transcripts, summaries, action items |

#### Support and Service

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Zendesk | OAuth 2.0 | Tickets, comments, users, organisations, articles |
| Freshdesk | API Key | Tickets, contacts, companies, articles |
| Intercom | OAuth 2.0 | Conversations, contacts, companies, articles |
| ServiceNow | OAuth 2.0 / Credentials | Incidents, changes, problems, CMDB items |

#### E-commerce and Payments

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Shopify | OAuth 2.0 | Products, orders, customers, collections |
| Stripe | API Key | Charges, customers, invoices, subscriptions, refunds |

#### Other

| Connector | Auth Method | Key Entities Surfaced |
|---|---|---|
| Ctti | — | (specialised; category unclear from docs) |
| Cal.com | API Key | Bookings, event types, users |

### 4.2 Authentication Method Summary

| Method | How It Works | Typical Sources |
|---|---|---|
| OAuth 2.0 | Browser redirect flow; Airweave stores refresh token, handles refresh automatically | Slack, Notion, Google, Salesforce, Microsoft 365 |
| API Key | User provides static token from source dashboard | GitHub, Stripe, Linear, Apollo, Freshdesk |
| Credentials | Host + port + username + password | Database sources |
| Auth Provider (Composio/Pipedream) | Reuse existing authenticated connections from third-party platforms | Any source supported by those platforms |

For enterprise setups, Airweave supports "Bring Your Own Credentials" (BYOC) OAuth — users provide their own `client_id` and `client_secret` via the `OAuth2BYOCAuthConfig` class.

### 4.3 How Connectors Work Internally

Source: deepwiki.com/airweave-ai/airweave/3.1-source-connector-architecture

Each connector is a Python class that:
1. Inherits from `BaseSource`
2. Declares its `AuthConfig` type (determines UI form + credential storage)
3. Implements `generate_entities()` as an async generator
4. Optionally implements cursor tracking for incremental sync
5. Maps source-specific data structures to typed `Entity` Pydantic models

The `@source` decorator registers a connector in `ALL_SOURCES` and accepts:
- `short_name`: URL-safe identifier (e.g., `"sharepoint"`)
- `name`: Display name
- `auth_config_class`: Auth configuration class
- `federated_search`: Boolean — if True, the connector supports direct search without syncing first (not yet used by most connectors)

Entity models use a breadcrumb system to encode hierarchy — e.g., a SharePoint page entity carries `site_id` and `drive_id` in breadcrumbs, allowing the agentic search to navigate `get_parent`, `get_children`, `get_siblings`.

---

## 5. MCP Server (v0.5.7)

Source: mcp.airweave.ai (live JSON), docs.airweave.ai/mcp-server, raw.githubusercontent.com/mcqua007/airweave/refs/heads/main/mcp/README.md

### 5.1 Specification

```json
{
  "name": "Airweave MCP Search Server",
  "version": "0.5.7",
  "transport": "Streamable HTTP",
  "protocol": "MCP 2025-03-26",
  "mode": "stateless",
  "endpoints": {
    "health": "/health",
    "mcp": "/mcp"
  },
  "authentication": {
    "required": true,
    "methods": [
      "X-API-Key: <your-api-key> (recommended)",
      "Authorization: Bearer <your-api-key-or-oauth-token>"
    ]
  }
}
```

### 5.2 Deployment Modes

**Local mode (stdio)** — standard for desktop AI clients (Cursor, Claude Desktop, VS Code):

```json
{
  "mcpServers": {
    "airweave-search": {
      "command": "npx",
      "args": ["-y", "airweave-mcp-search"],
      "env": {
        "AIRWEAVE_API_KEY": "your-api-key",
        "AIRWEAVE_COLLECTION": "your-collection-id",
        "AIRWEAVE_BASE_URL": "https://api.airweave.ai"
      }
    }
  }
}
```

Required environment variables:
- `AIRWEAVE_API_KEY` — authenticates with the Airweave API
- `AIRWEAVE_COLLECTION` — readable_id of the collection to search
- `AIRWEAVE_BASE_URL` (optional) — override for self-hosted instances

**Hosted mode (Streamable HTTP)** — for cloud AI platforms (OpenAI Agent Builder):

```
MCP Server URL: https://mcp.airweave.ai/mcp

Required Headers:
  X-API-Key: <your-airweave-api-key>
  X-Collection-Readable-ID: <your-collection-readable-id>
```

Or with OAuth 2.0 (hosted only):

```
Authorization: Bearer <oauth-access-token>
```

Each request is fully independent. No sessions or server-side state. A fresh `McpServer` instance is created per request. Results always reflect the latest synced data.

**OAuth 2.0 flow (hosted mode only):**

1. Client discovers OAuth metadata at `/.well-known/oauth-authorization-server`
2. Client registers itself at `/register` (RFC 7591 Dynamic Client Registration)
3. User redirected to Auth0 for login via `/authorize`
4. Auth0 redirects to `/oauth/callback`
5. Client exchanges code for tokens at `/token`
6. Subsequent requests use `Authorization: Bearer <access-token>`

When a Bearer token is present and OAuth enabled, server verifies as JWT. On failure, falls back to treating token as API key.

**Note:** OAuth is only available on the managed platform (mcp.airweave.ai). Self-hosted MCP uses API key only.

### 5.3 Available Tools

The MCP server exposes exactly two tools:

#### Tool 1: `search-{collection}`

The collection ID is embedded in the tool name (e.g., `search-engineering-context`), so the AI assistant knows which dataset it is searching.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | Yes | — | Natural language search query |
| `tier` | `"instant" \| "classic" \| "agentic"` | No | `"classic"` | Search depth tier |
| `limit` | `number` | No | `100` | Maximum results (1–1000) |
| `offset` | `number` | No | `0` | Pagination offset (instant/classic only) |
| `retrieval_strategy` | `"hybrid" \| "semantic" \| "keyword"` | No | `"hybrid"` | Vector strategy (instant tier only) |
| `thinking` | `boolean` | No | `false` | Enable chain-of-thought (agentic tier only) |
| `filter` | `FilterGroup[]` | No | — | Structured metadata filters |

**Search tiers:**

| Tier | Latency | How It Works | When To Use |
|---|---|---|---|
| `instant` | ~0.5 sec | Direct vector search, no LLM planning | Straightforward factual lookups |
| `classic` | ~2–5 sec | LLM analyses query, generates optimised search strategy | Default; good balance of speed and quality |
| `agentic` | Up to 2 min | Multi-step agent iterates: search, read, navigate hierarchy, collect | Complex queries where recall > speed |

#### Tool 2: `get-config`

Returns current server configuration: collection ID, base URL, API key status, available tools. No parameters.

### 5.4 Architecture

```
AI Assistant (Cursor, Claude, OpenAI, VS Code)
        |
        |-- stdio (local mode)
        |   └── npx airweave-mcp-search (Node.js process)
        |
        └── HTTP POST (hosted mode)
            └── https://mcp.airweave.ai/mcp (Node.js, stateless)
                        |
                 API key auth OR OAuth 2.0 (Auth0 + Redis)
                        |
                 Airweave REST API
                        |
         POST /collections/{id}/search/{instant|classic|agentic}
```

The MCP server is a thin Node.js wrapper. It validates parameters using `zod` schemas, calls the Airweave search tier endpoint, and formats results for the AI assistant. All intelligence lives in the backend.

**Implementation details (from source files):**
- `mcp/src/server.ts` — core MCP server setup
- `mcp/src/tools/search-tool.ts` — search tool implementation with FilterGroup/FilterCondition types
- `mcp/src/tools/config-tool.ts` — config tool
- `mcp/src/api/airweave-client.ts` — direct HTTP to V2 tiered search endpoints
- `mcp/src/auth/auth0-provider.ts` — OAuth provider
- `mcp/src/auth/redis.ts` — Redis-backed session/token caching
- `mcp/src/metrics/prometheus.ts` — Prometheus metrics tracking search duration and status
- Validation uses `zod` schemas for all tool parameters

**Self-hosting the hosted-mode MCP server (Docker):**

```bash
docker run -p 8080:8080 \
  -e AIRWEAVE_COLLECTION=your-default-collection \
  -e AIRWEAVE_BASE_URL=https://your-airweave-instance.com \
  your-registry/mcp:latest
```

Health check at `/health`. Port 8080.

---

## 6. Search System

Source: docs.airweave.ai/search

### 6.1 Search Tiers (API Endpoints)

```
POST /collections/{id}/search/instant
POST /collections/{id}/search/classic
POST /collections/{id}/search/agentic
POST /collections/{id}/search/agentic/stream   (SSE streaming)
```

### 6.2 Retrieval Strategies (Instant Tier)

| Strategy | Mechanism | Best For |
|---|---|---|
| `hybrid` (default) | Semantic + BM25 via Reciprocal Rank Fusion | Most queries |
| `semantic` | Dense vector cosine similarity | Conceptually similar content with different wording |
| `keyword` | BM25 text matching | Error codes, identifiers, exact phrases |

In `classic` and `agentic` tiers, the retrieval strategy is chosen automatically by the LLM planner.

### 6.3 Agentic Search — Internal Tools

When `tier: "agentic"` is used, Airweave runs an AI agent internally. That agent has access to these internal tools:

| Tool | Purpose |
|---|---|
| `search` | Vector search with query variations |
| `read` | Fetch full content of specific entities by ID |
| `add_to_results` | Add entities to the collected result set |
| `remove_from_results` | Remove entities from the result set |
| `count` | Count entities matching a filter |
| `get_children` | Navigate entity hierarchy downward |
| `get_siblings` | Navigate entity hierarchy laterally |
| `get_parent` | Navigate entity hierarchy upward |
| `review_results` | Review currently collected results |
| `return_results_to_user` | Signal search is complete |

The `thinking` parameter (agentic only) enables extended chain-of-thought before tool calls. Reranking uses `cohere/rerank-v4.0-pro` on the final result set.

### 6.4 Streaming SSE Events

`POST /collections/{id}/search/agentic/stream` delivers real-time events:

| Event Type | When | Key Fields |
|---|---|---|
| `started` | Once at start | `request_id`, `query`, `tier`, `thinking`, `filter`, `limit` |
| `thinking` | Per iteration | `thinking` (chain-of-thought text), `text`, `duration_ms`, `diagnostics.iteration` |
| `tool_call` | Each tool invoked | `tool_name`, `duration_ms`, `diagnostics.arguments`, `diagnostics.stats` |
| `reranking` | After agent completes | `model` (cohere), `input_count`, `output_count`, top/bottom relevance scores |
| `done` | Final event | `results[]`, `duration_ms`, full `diagnostics` (iterations, tokens, cache stats) |
| `error` | On failure | `message`, `duration_ms` |

**Streaming example (tool_call for `search`):**

```json
{
  "type": "tool_call",
  "tool_name": "search",
  "duration_ms": 156,
  "diagnostics": {
    "iteration": 0,
    "arguments": {
      "query": {
        "primary": "authentication methods",
        "variations": ["auth flow", "SSO setup"]
      },
      "retrieval_strategy": "hybrid",
      "limit": 100,
      "offset": 0,
      "filter_groups": []
    },
    "stats": {
      "result_count": 47,
      "new_results": 47
    }
  }
}
```

**Token tracking in `done` event:**

```json
{
  "type": "done",
  "diagnostics": {
    "total_iterations": 6,
    "prompt_tokens": 28450,
    "completion_tokens": 5230,
    "cache_creation_input_tokens": 12000,
    "cache_read_input_tokens": 8500,
    "max_iterations_hit": false,
    "total_llm_retries": 0,
    "stagnation_nudges_sent": 0
  }
}
```

### 6.5 Filter System

Filters work across all three tiers. In `classic` and `agentic`, the AI's internally generated filters are AND'd with your filters — user filters cannot be bypassed.

**Structure:** Conditions within a group are AND'd; multiple groups are OR'd.

```typescript
type FilterCondition = {
  field: string;
  operator: FilterOperator;
  value: string | number;
};

type FilterGroup = {
  conditions: FilterCondition[];
};

// POST body field:
filter: FilterGroup[]
```

**Filterable fields:**

| Field | Type | Description |
|---|---|---|
| `entity_id` | text | Entity identifier |
| `name` | text | Entity display name |
| `created_at` | date | Creation timestamp |
| `updated_at` | date | Last update timestamp |
| `breadcrumbs.entity_id` | text | Parent entity ID |
| `breadcrumbs.name` | text | Parent entity name |
| `breadcrumbs.entity_type` | text | Parent entity type |
| `airweave_system_metadata.entity_type` | text | Type (e.g., `SlackMessageEntity`) |
| `airweave_system_metadata.source_name` | text | Source (e.g., `slack`, `notion`) |
| `airweave_system_metadata.original_entity_id` | text | Stable ID across chunks |
| `airweave_system_metadata.chunk_index` | numeric | Chunk index |
| `airweave_system_metadata.sync_id` | text | Sync identifier |
| `airweave_system_metadata.sync_job_id` | text | Sync job identifier |

**Operators:** `equals`, `not_equals`, `contains` (text only), `greater_than`, `less_than`, `greater_than_or_equal`, `less_than_or_equal`, `in`

**Filter example — only Notion results:**

```json
{
  "filter": [
    {
      "conditions": [
        {
          "field": "airweave_system_metadata.source_name",
          "operator": "equals",
          "value": "notion"
        }
      ]
    }
  ]
}
```

**Filter example — Slack OR GitHub, created in last 7 days:**

```json
{
  "filter": [
    {
      "conditions": [
        { "field": "airweave_system_metadata.source_name", "operator": "equals", "value": "slack" },
        { "field": "created_at", "operator": "greater_than", "value": "2026-08-19T00:00:00Z" }
      ]
    },
    {
      "conditions": [
        { "field": "airweave_system_metadata.source_name", "operator": "equals", "value": "github" },
        { "field": "created_at", "operator": "greater_than", "value": "2026-08-19T00:00:00Z" }
      ]
    }
  ]
}
```

### 6.6 LLM Provider Chain

Classic and agentic search require an LLM. Airweave supports a configurable provider chain with fallback semantics.

**Default chain:** Not fully documented publicly, but the agentic search streaming reveals use of Claude (extended thinking visible in `cache_creation_input_tokens` patterns) and Cohere for reranking.

**Configuration:**
- API keys are set via environment variables or the Airweave dashboard
- The chain can be overridden to prefer specific providers
- Fallback semantics: if the primary provider fails or rate-limits, the next provider in chain is tried

---

## 7. Sync Architecture Deep Dive

Source: deepwiki.com/airweave-ai/airweave (Sync System, Sync Orchestration pages)

### 7.1 Component Graph

```
Temporal Scheduler
      |
      | triggers
      v
SyncFactory.create_orchestrator()
      |
      | builds (10 stages)
      v
SyncOrchestrator
  ├── SyncContext (frozen data: collection, sync, job IDs, config)
  ├── SyncRuntime (live services: source, destinations, trackers)
  ├── AsyncSourceStream (producer-consumer queue, maxsize 10,000)
  ├── AsyncWorkerPool (semaphore-controlled concurrency)
  └── EntityPipeline
        ├── EntityTracker (change detection, deletion tracking)
        ├── ActionResolver (upsert vs delete decision)
        └── ActionDispatcher
              └── VespaDestination (bulk write to vector index)
```

### 7.2 Micro-batching

- Default batch size: **64 entities**
- Producer pulls from `asyncio.Queue` (maxsize 10,000)
- If queue is full, producer blocks — natural backpressure
- Batches are submitted to `AsyncWorkerPool`
- Worker pool uses `asyncio.Semaphore` to limit concurrent batch processing
- Micro-batching is currently always enabled (`should_batch=True` in `SyncContext`)

### 7.3 SyncOrchestrator Lifecycle

Five phases:

1. **Initialization** — Set job status to RUNNING, init source stream
2. **Entity Processing** — Pull from `AsyncSourceStream`, submit to `AsyncWorkerPool`
3. **Deletion Phase** (optional) — Process deletions by diffing seen entities against last sync
4. **Completion** — Update sync job status, flush metrics
5. **Cleanup** — Release resources, close connections

### 7.4 Cursors and Incremental Sync

Connectors implement cursor tracking by storing a `cursor` value (typically a timestamp or pagination token) in the `SyncContext`. On incremental runs, the sync starts from the cursor position rather than the beginning.

Not all connectors implement cursors — some still do full sync on each run (less efficient, acceptable for small sources). The GitHub, Slack, and Notion connectors are known to implement incremental sync.

### 7.5 Sync Scheduling

Managed via Temporal `Schedule` resources. Each source connection has its own schedule. Schedule management API exists but is not fully documented publicly.

Sync can be triggered manually:
```http
POST /source-connections/{id}/run
```

Sync can be cancelled:
```http
DELETE /source-connections/{id}/sync
```

### 7.6 Failure Handling

- Sync job status: `CREATED → RUNNING → COMPLETED | FAILED | CANCELLED`
- Source connection status reflects last sync result
- Individual entity failures are logged but do not necessarily fail the whole sync job
- Retry logic is delegated to Temporal's activity retry policies

---

## 8. Storage Systems

Source: deepwiki.com/airweave-ai/airweave (Storage Systems section)

### 8.1 Vespa (Primary Search Index)

Airweave uses **Vespa** as its vector database and search engine — not Qdrant, Weaviate, or Pinecone. This is a significant architectural choice.

Vespa provides:
- Dense vector similarity search (semantic)
- BM25 full-text search (keyword)
- Reciprocal Rank Fusion for hybrid queries
- Native support for multi-tenancy via collection-level filtering
- Horizontal scaling without external orchestration

**Tenant isolation:** All storage operations include mandatory filtering on `airweave_collection_id` (the collection UUID). Multiple collections share the same Vespa deployment, isolated by this field. Source: `backend/airweave/platform/destinations/_base.py:105-121`

**Embedding configuration:** Each collection is associated with a `VectorDbDeploymentMetadata` record that defines:
- Embedding dimensions
- Dense embedder model

At collection creation, the `CollectionService` looks up the singleton deployment metadata and associates it with the collection. All data within a collection uses the same embedding model. **You cannot mix embedding models within a collection.**

The specific embedding model used is not disclosed in public documentation, but the architecture allows configuration.

### 8.2 PostgreSQL (Metadata Store)

PostgreSQL stores:
- Collections, source connections, sync jobs, sync state
- OAuth tokens (encrypted)
- API keys (hashed)
- Organisation, user, billing data
- Entity tracking state (what was seen in last sync)

### 8.3 Redis (Session Cache)

Redis is required by the hosted MCP server for:
- Session management (30-minute TTL, auto-expiry)
- OAuth token caching for performance
- Rate limiting state (100 sessions/hour per API key)

Not required for the backend API or sync engine — only the MCP server needs Redis.

---

## 9. Collections Model

Source: deepwiki.com/airweave-ai/airweave (Collections section)

### 9.1 Collection Identity

Collections use a dual-identifier system:

| Identifier | Type | Example | Usage |
|---|---|---|---|
| `id` | UUID | `550e8400-e29b-41d4-a716-446655440000` | Internal DB keys |
| `readable_id` | string | `finance-data-ab123` | API endpoints, user-facing URLs |

The `readable_id` is auto-generated from the collection name with a unique suffix if not provided. It is **immutable** once created — changing it would break all stable API references.

### 9.2 Collection Status

Status is computed dynamically on every fetch:

| Status | Condition |
|---|---|
| `NEEDS_SOURCE` | No source connections added yet |
| `ACTIVE` | Has connections, ready for queries |
| `ERROR` | Critical issue preventing function |

For federated sources (direct search without sync): active as soon as authenticated.
For sync-based sources: active only after last sync job completed, is running, or is cancelling.

### 9.3 Multi-Source Queries

When an agent searches a collection, the query runs across all entities from all connected sources simultaneously. The unified result set is ranked by relevance regardless of source. This is the core value — an agent does not need to know whether context lives in Slack, Notion, or GitHub.

### 9.4 Collection API

```typescript
// Create collection
POST /collections
{
  "name": "My Knowledge Base",
  "readable_id": "my-knowledge-base"  // optional, auto-generated if omitted
}

// Search collection (instant tier example)
POST /collections/{readable_id}/search/instant
{
  "query": "What are our authentication requirements?",
  "limit": 20,
  "retrieval_strategy": "hybrid",
  "filter": [...]
}

// List, get, update, delete
GET /collections
GET /collections/{readable_id}
PATCH /collections/{readable_id}
DELETE /collections/{readable_id}
```

---

## 10. Authentication Handling

Source: deepwiki.com/airweave-ai/airweave (Authentication Configuration, Token Management sections)

### 10.1 Auth Configuration Types

Airweave supports four auth patterns internally (Python `AuthConfig` hierarchy):

| Config Class | Pattern | How Credentials Stored |
|---|---|---|
| `APIKeyAuthConfig` | Static API key | Encrypted in PostgreSQL |
| `OAuth2AuthConfig` | OAuth 2.0 without refresh | Token encrypted in PostgreSQL |
| `OAuth2WithRefreshAuthConfig` | OAuth 2.0 with refresh token | Both access + refresh token encrypted |
| `OAuth2BYOCAuthConfig` | BYOC OAuth (user provides client_id/secret) | client_id + client_secret encrypted |
| `DatabaseAuthConfig` | Host/port/user/password | All fields encrypted |

### 10.2 OAuth Token Refresh

Connectors using `OAuth2WithRefreshAuthConfig` (Slack, Notion, Google, Salesforce, Microsoft) have their tokens refreshed automatically. The token refresh logic is in `backend/airweave/platform/sources/` and is triggered when a token is found to be expired during sync.

Token refresh is transparent — the sync job does not fail due to expired access tokens as long as a valid refresh token exists.

### 10.3 Auth Providers (Composio / Pipedream)

For enterprise setups, Airweave can reuse existing authenticated connections from Composio or Pipedream instead of running its own OAuth flow. This is documented at `docs.airweave.ai/auth-providers`.

The auth provider integration means organisations that already use Composio/Pipedream for their other integrations can connect Airweave without users re-authenticating each source.

### 10.4 Direct Token Injection

`docs.airweave.ai/direct-token-injection` documents the ability to create source connections or trigger syncs by supplying OAuth 2.0 tokens directly — useful for programmatic automation.

---

## 11. ACL Enforcement — The Critical Gap

**Airweave has no per-user access control.** This is the single most important architectural limitation relative to our Phase 2 requirements.

All data in a collection is accessible to any holder of the collection's API key. The collection is a flat namespace — there is no concept of "user X can see documents A, B, C but not D, E, F."

### What Airweave does:

- Collection-level isolation: separate collections for separate tenants (organisations), enforced by `airweave_collection_id` in Vespa
- API key authentication: per-organisation API keys control which collections you can access
- The Connect Widget supports per-user OAuth connections — each user can connect their own sources into a shared collection

### What Airweave does NOT do:

- No per-user document-level ACL enforcement
- No integration with Entra ID, LDAP, or any identity provider for read permissions
- No `transitiveMemberOf` or group-based access control
- No row-level security in the search layer

### Implication for markdown-for-agents-mcp Phase 2:

This is our competitive moat. Our planned architecture — enforce Entra ID `transitiveMemberOf` at query time, materialising which SharePoint sites and Confluence spaces the requesting user can access, then filtering Vespa results to only return documents the user is permitted to see — is architecturally superior for enterprise use cases.

Airweave's model requires admins to create separate collections per permission boundary. In a large enterprise with hundreds of SharePoint sites and complex group hierarchies, this becomes unmanageable. Our approach handles it dynamically.

---

## 12. Self-Hosted Deployment

Source: docs.airweave.ai/quickstart, airweave.ai/academy/mcp-server

### 12.1 Quick Start

```bash
git clone https://github.com/airweave-ai/airweave.git
cd airweave
./start.sh
```

The `start.sh` script starts the full Docker Compose stack. Dashboard opens at `http://localhost:8080`. Backend API at `http://localhost:8001`.

### 12.2 Required Services

| Service | Role | Port |
|---|---|---|
| FastAPI backend | REST API, sync engine | 8001 |
| React frontend | Dashboard UI | 8080 |
| Vespa | Vector + BM25 search | 8080 (internal) |
| PostgreSQL | Metadata, state, auth | 5432 |
| Temporal Server | Workflow orchestration | 7233 |
| Temporal UI | Workflow monitoring | 8088 |
| Redis | MCP server sessions | 6379 |

Temporal is the heaviest dependency. It requires its own PostgreSQL database and brings significant operational complexity (separate workers, server, UI).

### 12.3 MCP Server (Self-Hosted)

For local mode, set `AIRWEAVE_BASE_URL` to your instance:

```json
{
  "env": {
    "AIRWEAVE_API_KEY": "your-api-key",
    "AIRWEAVE_COLLECTION": "your-collection-id",
    "AIRWEAVE_BASE_URL": "http://localhost:8001"
  }
}
```

For hosted mode (Docker):

```bash
docker run -p 8080:8080 \
  -e AIRWEAVE_COLLECTION=default-collection \
  -e AIRWEAVE_BASE_URL=http://your-airweave-backend:8001 \
  airweave/mcp:latest
```

### 12.4 Configuration Files

Integration config lives in YAML files:
- `backend/airweave/platform/auth/yaml/dev.integrations.yaml`
- `backend/airweave/platform/auth/yaml/prd.integrations.yaml`
- `backend/airweave/platform/auth/yaml/self-hosted.integrations.yaml`

These define which OAuth clients are configured per environment — relevant for connectors that require registered OAuth apps (Slack, Google, Microsoft).

---

## 13. SDK Reference

Source: docs.airweave.ai/quickstart

### 13.1 Python SDK

```bash
pip install airweave-sdk
```

```python
from airweave import AirweaveSDK

client = AirweaveSDK(
    api_key="YOUR_API_KEY",
    base_url="https://api.airweave.ai"  # or self-hosted URL
)

# Create collection
collection = client.collections.create(name="My First Collection")
print(f"Created: {collection.readable_id}")

# Create source connection
source_connection = client.source_connections.create(
    name="Stripe Connection",
    short_name="stripe",
    readable_collection_id=collection.readable_id,
    authentication={
        "credentials": {"api_key": "sk_live_..."}
    }
)

# Instant search
response = client.collections.search.instant(
    readable_id=collection.readable_id,
    query="Find returned payments from John Doe",
)
for result in response.results:
    print(result.name, result.relevance_score)
```

### 13.2 Node.js / TypeScript SDK

```bash
npm install @airweave/sdk
```

```typescript
import { AirweaveSDK } from "@airweave/sdk";

const client = new AirweaveSDK({
  apiKey: "YOUR_API_KEY",
  baseUrl: "https://api.airweave.ai",
});

// Create collection
const collection = await client.collections.create({
  name: "Engineering Knowledge",
});

// Create source connection
const connection = await client.sourceConnections.create({
  name: "GitHub Connection",
  shortName: "github",
  readableCollectionId: collection.readableId,
  authentication: {
    credentials: { api_key: "ghp_..." },
  },
});

// Classic search (default tier)
const response = await client.collections.search.classic({
  readableId: collection.readableId,
  query: "What are the rate limiting policies for the payments API?",
  limit: 10,
});

for (const result of response.results) {
  console.log(`${result.name} (${result.relevanceScore}): ${result.url}`);
}

// Filtered search — only GitHub results from last 30 days
const filtered = await client.collections.search.instant({
  readableId: collection.readableId,
  query: "authentication bug",
  filter: [
    {
      conditions: [
        {
          field: "airweave_system_metadata.source_name",
          operator: "equals",
          value: "github",
        },
        {
          field: "created_at",
          operator: "greater_than",
          value: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
  ],
});
```

### 13.3 REST API (cURL)

All endpoints require `x-api-key` header:

```bash
# Create collection
curl -X POST https://api.airweave.ai/collections \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Collection"}'

# Instant search
curl -X POST https://api.airweave.ai/collections/my-collection/search/instant \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What authentication methods do we support?",
    "limit": 20,
    "retrieval_strategy": "hybrid"
  }'

# Trigger manual sync
curl -X POST https://api.airweave.ai/source-connections/{id}/run \
  -H "x-api-key: YOUR_API_KEY"
```

---

## 14. SharePoint Connector — Full Schema

Source: docs.airweave.ai/connectors/sharepoint

The SharePoint connector is via **Microsoft Graph API** with OAuth 2.0. This is the most relevant connector for Phase 2 planning.

### 14.1 Authentication

- **OAuth Browser Flow** (recommended for UI)
- **OAuth Token** (for programmatic access / direct token injection)
- **Auth Provider** (enterprise SSO via Composio/Pipedream)

**No Entra ID group-based permission enforcement** — the connector authenticates as a single service account, not as the end user.

### 14.2 Entities

| Entity | Key Fields | Notes |
|---|---|---|
| `SharePointUserEntity` | `id`, `display_name`, `user_principal_name`, `mail`, `job_title`, `department`, `account_enabled` | Full UPN available for permission mapping |
| `SharePointGroupEntity` | `id`, `display_name`, `group_types`, `security_enabled`, `visibility` | `group_types: ["Unified"]` = M365 group |
| `SharePointSiteEntity` | `id`, `display_name`, `site_name`, `web_url_override`, `is_personal_site` | Site metadata |
| `SharePointDriveEntity` | `id`, `name`, `drive_type`, `owner`, `quota`, `site_id` | Document library |
| `SharePointDriveItemEntity` | `id`, `name`, `file`, `folder`, `parent_reference`, `created_by`, `last_modified_by`, `site_id`, `drive_id` | Files and folders |
| `SharePointListEntity` | `id`, `display_name`, `list_info`, `site_id` | SharePoint Lists |
| `SharePointListItemEntity` | `id`, `title`, `fields`, `content_type`, `created_by`, `last_modified_by`, `list_id`, `site_id` | List items (dynamic schema via `fields`) |
| `SharePointPageEntity` | `id`, `title`, `content`, `page_layout`, `publishing_state`, `site_id` | Site pages (content extracted from webParts) |

**Critical observation:** `SharePointUserEntity` stores `user_principal_name` (UPN). `SharePointGroupEntity` captures security group membership info. However, Airweave stores these as search entities — there is no ACL enforcement mechanism that checks whether the querying user is a member of the groups that have access to a given document. This confirms the ACL gap.

### 14.3 Confluence Connector

Authenticated via OAuth 2.0. Syncs Confluence spaces, pages, blog posts, and attachments. No detailed entity schema documented in accessible pages, but the connector is listed as production-ready.

---

## 15. Framework Integrations

Source: docs.airweave.ai/llms.txt, framework integration pages

### 15.1 Supported Integrations

| Framework | Integration Type | Status |
|---|---|---|
| LlamaIndex | Official integration | Production |
| Vercel AI SDK | Native tool function | Production |
| Google Antigravity MCP Store | Listed natively | Production |
| Pipedream | Workflow block | Production |
| Sim | Native block | Production |
| Composio | Auth provider | Production |
| LangChain | Via REST API | Community |
| CrewAI | Via REST API | Community |
| AutoGen | Via REST API | Community |
| OpenAI Assistants | Via MCP | Production |

### 15.2 LlamaIndex Example

```python
from llama_index.tools.airweave import AirweaveSearchTool

tool = AirweaveSearchTool(
    api_key="YOUR_API_KEY",
    collection_id="your-collection"
)

# The tool is passed to any LlamaIndex agent
agent = ReActAgent.from_tools([tool])
```

### 15.3 Vercel AI SDK Example

```typescript
import { airweaveSearch } from "@airweave/vercel-ai-sdk";

const tools = {
  searchKnowledgeBase: airweaveSearch({
    apiKey: process.env.AIRWEAVE_API_KEY,
    collectionId: process.env.AIRWEAVE_COLLECTION,
  }),
};
```

### 15.4 Connect Widget

Airweave provides an embeddable UI component (`Connect Widget`) for letting end users connect their own data sources. This enables the "bring your own sources" pattern for multi-tenant applications.

The widget handles the entire OAuth flow UI. The parent application embeds it and receives a callback when a source connection is established.

```typescript
// NPM packages for the connect widget
@airweave/connect-react
@airweave/connect-js
```

---

## 16. Webhooks

Source: docs.airweave.ai/webhooks/overview.md

Airweave supports outgoing webhooks for real-time notifications:

**Event types:**
- Sync lifecycle events (started, completed, failed, cancelled)
- Source connection lifecycle events
- Collection lifecycle events

**Setup:** Create a subscription via `POST /webhooks/subscriptions` with endpoint URL and event types. Failed messages can be recovered via `POST /webhooks/subscriptions/{id}/recover`.

---

## 17. Rate Limits

Source: docs.airweave.ai/rate-limits

API rate limits are per-organisation, per-minute, sliding window:

| Plan | Requests/min |
|---|---|
| Developer | 10 |
| Pro | 100 |
| Team/Startup | 250 |
| Enterprise | Unlimited |

Self-hosted: no rate limits at the platform level (you are responsible for your own Vespa/Temporal capacity).

All API responses include headers:
```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1729012345
```

On 429:
```json
{
  "detail": "Rate limit exceeded. Try again in 42 seconds."
}
```

---

## 18. Airweave vs Onyx — Technical Comparison

Source: competitive analysis based on public documentation

| Dimension | Airweave | Onyx (formerly Danswer) |
|---|---|---|
| License | MIT | MIT (backend) / EE for some features |
| Primary purpose | Context retrieval layer for AI agents / RAG | Enterprise Q&A / search for humans |
| Target user | Developer building agents | End user asking questions |
| Interface | API-first, SDK, MCP | Chat UI-first |
| Connector count | ~50 | ~40+ |
| ACL enforcement | Collection-level only | Document-level per connector (stronger) |
| Per-user permissions | No | Yes — respects source system permissions |
| MCP server | Yes, v0.5.7 with Streamable HTTP | Community / less mature |
| Search tiers | Instant / Classic / Agentic | Hybrid search, AI response generation |
| Vector database | Vespa | Vespa (same) |
| Workflow orchestration | Temporal | Celery |
| Auth providers | Composio, Pipedream | Native per-connector |
| Streaming | SSE for agentic search | Chat SSE |
| Self-hosted complexity | High (Temporal overhead) | Moderate |
| Pricing | Free tier; $16/mo Pro | Self-hosted free; cloud TBD |
| GitHub stars | ~6,400 | ~10,000+ |
| Enterprise readiness | Mid-market (no ACL) | Better (has document ACL) |

**Where Airweave is stronger:**

- MCP server is production-grade, Streamable HTTP, OAuth 2.0, Prometheus metrics
- Three-tier search model (instant/classic/agentic) is architecturally superior for agents
- Framework integrations are broader (LlamaIndex, Vercel AI SDK, Composio, Pipedream natively)
- The Connect Widget for embedding auth flows
- API design is cleaner and more agent-friendly

**Where Onyx is stronger:**

- Document-level ACL enforcement — respects source system permissions per user
- More mature for enterprise human-facing search (chat UI, UI polish)
- Larger community, more GitHub activity
- Better Confluence/SharePoint permission handling

**Our position:** We can take Airweave's MCP architecture and add Onyx-style per-user ACL enforcement. That combination — strong MCP transport + document-level ACL — does not exist in either system today.

---

## 19. Failure Modes and Gotchas

### 19.1 Known Limitations

**No per-user ACL:** As documented. Any API key holder sees all collection data. For multi-user enterprise deployments, you need separate collections per permission boundary — which scales poorly.

**OAuth is hosted-only:** The Auth0 OAuth flow in the MCP server only works on `mcp.airweave.ai`. Self-hosted MCP uses API keys only. This limits SSO integration for self-hosted deployments.

**Single embedding model per collection:** All documents in a collection must use the same embedding model. If you upgrade to a better model, you must re-embed the entire collection (no partial migration).

**Temporal complexity:** Temporal is a powerful but operationally complex orchestration engine. Self-hosting Airweave means running Temporal, which requires its own database, workers, and operational expertise. Many teams may prefer simpler queue-based sync.

**Vespa operational burden:** Vespa is excellent but opinionated. Tuning Vespa for production (memory, GC, schema evolution) requires specific expertise. Alternative vector DBs (Qdrant, Weaviate) have better managed hosting options.

**No connector-level rate limit exposure:** When connectors hit source API rate limits (GitHub, Slack, etc.), error handling is internal. The sync job status eventually shows failure, but there is limited observability into which source caused throttling and when it will retry.

**Context window limits in agentic search:** The `error` event in streaming shows the actual failure message: `"Context window too full for useful work after emergency compression"`. Long-running agentic searches can exhaust the LLM's context window if many entities are read.

### 19.2 Edge Cases

**Duplicate entity IDs across syncs:** `airweave_system_metadata.original_entity_id` is the stable ID across chunked entities. The `chunk_index` field distinguishes chunks. Any filter or dedup logic should use `original_entity_id` not `entity_id`.

**Incremental sync vs full sync inconsistency:** Connectors that do not implement cursors will always full-sync, causing increased API usage against the source and higher entity volumes in Vespa on every sync run.

**Filter validation:** Filters using `contains` on non-text fields or `greater_than` on text fields will fail at the API layer. The validation is not always obvious from the SDK — test filter combinations before production use.

**Collection readable_id immutability:** Once set, `readable_id` cannot be changed. If you need to rename a collection, you must create a new one and migrate all source connections. Design your `readable_id` structure carefully upfront.

---

## 20. Implementation Recommendations for Phase 2

### 20.1 What To Build Directly (Adopt from Airweave)

**Three-tier search model** — this is non-negotiable. Instant (vector only), classic (LLM-planned), agentic (multi-step agent) covers the full range of latency/quality tradeoffs. The tier parameter exposed to MCP clients lets the calling agent pick the right trade-off per query.

TypeScript implementation pattern for the MCP tool:

```typescript
// In our MCP server — tool definition
server.addTool({
  name: `search-${collection.readableId}`,
  description: `Search the ${collection.name} knowledge base`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      tier: {
        type: "string",
        enum: ["instant", "classic", "agentic"],
        default: "classic",
        description: "Search depth: instant (<1s), classic (~3s), agentic (<2min)",
      },
      limit: { type: "number", default: 20, minimum: 1, maximum: 100 },
      filter: {
        type: "array",
        items: { $ref: "#/definitions/FilterGroup" },
        description: "Metadata filters: conditions within group are AND'd, groups are OR'd",
      },
    },
    required: ["query"],
  },
  handler: async ({ query, tier = "classic", limit = 20, filter }) => {
    const results = await searchKnowledgeIndex({
      userId: currentUser.id,  // Entra ID user — this is what Airweave lacks
      query,
      tier,
      limit,
      filter,
    });
    return formatResultsForLLM(results);
  },
});
```

**Stateless Streamable HTTP MCP transport** — Airweave's architecture proves this works at scale. Per-request authentication (no sessions) is the correct design for a hosted MCP endpoint.

**Filter system (AND/OR group structure)** — copy the filter schema almost verbatim. The `airweave_system_metadata.source_name` and `airweave_system_metadata.entity_type` fields map to our concept of source and content type.

**SSE streaming for agentic search** — implement the same event types: `started`, `thinking`, `tool_call`, `reranking`, `done`, `error`. Clients like Claude Desktop and Cursor can consume SSE natively.

**Collections as multi-source namespaces** — one collection can have many sources. Search spans all of them. This is the correct abstraction.

### 20.2 What To Build Differently

**Entra ID ACL enforcement** — at query time, call `GET /me/transitiveMemberOf` with the user's access token to get their group memberships. Build an allowlist of SharePoint sites and Confluence spaces they can access. Filter Vespa results to only return documents from permitted sources. Airweave does not do this. This is our core differentiator.

```typescript
// Pseudo-code for ACL-aware search
async function searchWithACL(
  userId: string,
  entraAccessToken: string,
  query: string,
  collectionId: string
): Promise<SearchResult[]> {
  // Step 1: Get user's group memberships from Entra ID
  const groups = await getTransitiveMemberOf(entraAccessToken);

  // Step 2: Resolve which SharePoint sites/Confluence spaces they can access
  const permittedSources = await resolvePermittedSources(userId, groups);

  // Step 3: Build Vespa filter from permitted sources
  const aclFilter = buildSourceFilter(permittedSources);

  // Step 4: Search with ACL filter AND'd in
  return await searchVespa(query, collectionId, aclFilter);
}
```

**Simpler orchestration** — skip Temporal for initial implementation. Use a simple cron-triggered async Python job queue (Celery with Redis, or just `asyncio` with a scheduler). Add Temporal only if sync complexity warrants it.

**Pluggable vector DB** — abstract the vector DB behind an interface so we can swap Vespa for Qdrant or Weaviate. Vespa is powerful but Qdrant has managed cloud offerings that reduce operational burden.

**Per-connector observable rate limiting** — surface source API rate limit status in sync job logs. When GitHub rate-limits us, the UI should show "GitHub: rate limited, retry in 43 minutes."

### 20.3 Connector Priority for Phase 2

Based on enterprise value and connection to the ACL story:

| Priority | Connector | Why |
|---|---|---|
| P0 | SharePoint | Core enterprise knowledge store; ACL story is strongest here |
| P0 | Confluence | Second core enterprise knowledge store; Jira integration is table stakes |
| P1 | Teams | Meeting transcripts and channel messages; M365 auth reuse |
| P1 | Notion | Ubiquitous in tech companies |
| P2 | GitHub | Developer context; PAT auth is simple |
| P2 | Jira | Issue context for engineering teams |
| P3 | Slack | High value but complex permissions model |
| P3 | Google Drive | Requires separate Google workspace auth |

### 20.4 MCP Server Implementation Checklist

Drawn from Airweave's v0.5.7 implementation:

- [ ] Streamable HTTP transport (MCP 2025-03-26 spec)
- [ ] Per-request stateless design — no server-side session state
- [ ] `X-API-Key` header authentication (primary)
- [ ] `Authorization: Bearer` header support (for OAuth tokens)
- [ ] `X-Collection-Readable-ID` header for collection selection
- [ ] `/.well-known/oauth-authorization-server` discovery endpoint
- [ ] `GET /health` health check
- [ ] `GET /` returns server info JSON (name, version, transport, mode, auth methods)
- [ ] Tool: `search-{collection}` with tier, limit, offset, filter params
- [ ] Tool: `get-config` for server configuration
- [ ] Zod validation on all tool inputs
- [ ] Prometheus metrics: search duration by tier, status codes
- [ ] Docker image with health check on port 8080
- [ ] `AIRWEAVE_BASE_URL` equivalent for self-hosted pointing

---

## 21. Source Index

All sources consulted for this document:

1. https://docs.airweave.ai — Airweave official documentation
2. https://docs.airweave.ai/mcp-server — MCP server documentation
3. https://docs.airweave.ai/concepts — Core concepts
4. https://docs.airweave.ai/search — Search API reference
5. https://docs.airweave.ai/connectors/overview — Connector catalog
6. https://docs.airweave.ai/connectors/sharepoint — SharePoint connector detail
7. https://docs.airweave.ai/rate-limits — Rate limits
8. https://docs.airweave.ai/llms.txt — Documentation index
9. https://docs.airweave.ai/quickstart — Quickstart guide
10. https://airweave.ai — Product homepage (pricing extracted here)
11. https://airweave.ai/academy/mcp-server — MCP academy article (February 2026)
12. https://mcp.airweave.ai — Live MCP server info endpoint (v0.5.7 JSON)
13. https://deepwiki.com/airweave-ai/airweave — DeepWiki code-indexed wiki
14. https://deepwiki.com/airweave-ai/airweave/13-mcp-server — MCP server deep dive
15. https://deepwiki.com/airweave-ai/airweave/4-storage-systems — Sync system architecture
16. https://deepwiki.com/airweave-ai/airweave/3.1-source-connector-architecture — Connector architecture
17. https://raw.githubusercontent.com/mcqua007/airweave/refs/heads/main/mcp/README.md — MCP server README
18. https://runthisai.com/en/blog/airweave-guide-context-retrieval-layer — Third-party overview (July 2026)
19. https://lite.duckduckgo.com/lite/?q=Airweave+all+connectors+documentation+2026+complete+list — DuckDuckGo search results
20. https://lite.duckduckgo.com/lite/?q=Airweave+MCP+server+v0.5+Streamable+HTTP+API+tools — DuckDuckGo search results
