# Onyx (formerly Danswer) — Complete Architecture Analysis

**Status:** Research complete  
**Date:** 2026-08-26  
**Relevance:** Primary reference architecture for markdown-for-agents-mcp Phase 2 enterprise knowledge index  
**Source repo:** https://github.com/onyx-dot-app/onyx  
**Docs:** https://docs.onyx.app  
**DeepWiki:** https://deepwiki.com/onyx-dot-app/onyx  

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Docker Compose Services](#3-docker-compose-services)
4. [Complete Connector Catalog](#4-complete-connector-catalog)
5. [Permission Architecture — ACL Mirroring](#5-permission-architecture--acl-mirroring)
6. [MCP Server — Full Reference](#6-mcp-server--full-reference)
7. [Hybrid Search — BM25 + Vector](#7-hybrid-search--bm25--vector)
8. [Custom Connector Interface](#8-custom-connector-interface)
9. [Agentic RAG and Deep Research](#9-agentic-rag-and-deep-research)
10. [LLM Configuration](#10-llm-configuration)
11. [Community vs Enterprise Edition](#11-community-vs-enterprise-edition)
12. [Database Schema](#12-database-schema)
13. [Background Processing Architecture](#13-background-processing-architecture)
14. [Authentication Architecture](#14-authentication-architecture)
15. [10 Architectural Decisions to Adopt](#15-10-architectural-decisions-to-adopt)
16. [Known Limitations and Gotchas](#16-known-limitations-and-gotchas)
17. [Implementation Recommendations](#17-implementation-recommendations)

---

## 1. Project Overview

Onyx (rebranded from Danswer in 2024) is a self-hosted, MIT-licensed open-source enterprise AI platform. It is the most directly comparable open-source project to what markdown-for-agents-mcp Phase 2 aims to build.

**What it is:** A complete enterprise knowledge platform — not just an MCP server. It ships a full chat UI, a RAG indexing pipeline, 60+ source connectors, ACL mirroring from source systems, a native MCP server, agentic deep research, and a Craft code-execution sandbox.

**Why study it:** Onyx has solved, in production code, every hard problem we will face:
- Incremental sync with checkpoint resumption across 60+ connectors
- Per-user ACL enforcement at query time without re-querying source APIs
- Hybrid BM25 + vector search with cross-encoder reranking
- Multi-agent deep research loops
- Running an MCP server that sits in front of an enterprise knowledge index

**Licensing:** MIT for Community Edition. Enterprise Edition features live in `backend/ee/` and require a license key, but the source code is public.

**Repo stats (August 2026):** ~50k GitHub stars, actively maintained with weekly releases.

---

## 2. System Architecture

### Core Stack

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend: Next.js web client (TypeScript)                   │
├─────────────────────────────────────────────────────────────┤
│  API Server: Python FastAPI                                  │
│  MCP Server: Python (port 8090, Streamable HTTP)             │
├─────────────────────────────────────────────────────────────┤
│  Background Workers: Celery (8 specialised worker pools)     │
│  Task Scheduler: Celery Beat (DynamicTenantScheduler)        │
├─────────────────────────────────────────────────────────────┤
│  Inference Model Server: embedding + reranking (query time)  │
│  Indexing Model Server:  embedding during indexing (isolated)│
├─────────────────────────────────────────────────────────────┤
│  OpenSearch: BM25 keyword + vector store                     │
│  PostgreSQL: application state, users, sessions, ACL cache   │
│  Redis:      task broker, fencing, coordination              │
│  MinIO:      blob store for user files and connector docs    │
├─────────────────────────────────────────────────────────────┤
│  Nginx: reverse proxy / request router                       │
└─────────────────────────────────────────────────────────────┘
```

Source: https://docs.onyx.app/security/architecture/system_description

### Deployment Modes

**Onyx Lite** — Lightweight chat UI. Under 1 GB RAM. No vector DB, no background workers, no model inference servers. Chat + Agents + file uploads only.

**Onyx Standard** — Full platform. Vector + keyword index, background Celery workers, two model inference servers, Redis, MinIO. Required for connectors and RAG.

### Component Replaceability

| Component | Replaceability | Notes |
|-----------|---------------|-------|
| MinIO | Easy | Replace with S3 or any object store; interface is abstracted |
| Redis | Easy | Replace with AWS ElastiCache or any managed Redis |
| PostgreSQL | Moderate | Replace with AWS RDS; switching DB engines is not advised |
| OpenSearch | Hard | Tightly integrated with retrieval; switching engines requires significant effort |
| Nginx | Easy | Can be removed and replaced with any proxy |

**Important for us:** The OpenSearch coupling is deep. If you substitute it you rewrite the entire retrieval layer. OpenSearch replaced Vespa as the default in recent versions (migration tooling included).

---

## 3. Docker Compose Services

Based on the Kubernetes Helm chart definitions and supervisord config:
https://deepwiki.com/onyx-dot-app/onyx/6.1-celery-worker-architecture

### Service Map

| Service | Container | Purpose | Typical RAM |
|---------|-----------|---------|-------------|
| `web_server` | Next.js | Frontend UI | 512 MB |
| `api_server` | FastAPI | REST API + auth | 1 GB |
| `mcp_server` | Python | MCP endpoint (port 8090) | 512 MB |
| `celery_beat` | Celery Beat | DynamicTenantScheduler | 256 MB |
| `celery_worker_primary` | Celery | High-level coordination, singleton cleanup | 512 MB |
| `celery_worker_light` | Celery | Fast metadata sync, doc set updates, deletions | 512 MB |
| `celery_worker_heavy` | Celery | Permission sync, connector pruning, group sync | 1 GB |
| `celery_worker_docfetching` | Celery | I/O-bound external API fetching | 1 GB |
| `celery_worker_docprocessing` | Celery | CPU-bound parsing, chunking, embedding | 2 GB |
| `celery_worker_userfile` | Celery | User-uploaded file processing | 512 MB |
| `celery_worker_scheduled` | Celery | Craft scheduled tasks | 512 MB |
| `celery_worker_monitoring` | Celery | Health checks, metrics | 256 MB |
| `indexing_model_server` | Python | Embedding model for indexing (isolated) | 2–4 GB |
| `inference_model_server` | Python | Embedding + reranking for queries | 2–4 GB |
| `opensearch` | OpenSearch | BM25 + vector index | 4–8 GB |
| `postgres` | PostgreSQL 15 | Application DB | 2 GB |
| `redis` | Redis | Broker + cache + coordination | 1 GB |
| `minio` | MinIO | Blob store | 512 MB |
| `nginx` | Nginx | Reverse proxy | 128 MB |

### Minimum Recommended for Standard Deployment

- **Dev/evaluation:** 8 vCPU, 16 GB RAM (tight)
- **Small team (< 20 users):** 8 vCPU, 32 GB RAM
- **Production (100+ users):** 16 vCPU, 64 GB RAM, separate OpenSearch cluster

The indexing model servers are the biggest resource consumers. They can be pointed at an external provider (Azure OpenAI, Bedrock, etc.) to eliminate local GPU requirements entirely.

---

## 4. Complete Connector Catalog

Source: https://docs.onyx.app/admins/connectors/overview

Onyx ships **60+ connectors** as of August 2026. The connector overview page organises them into seven categories. The `SHOW_EXTRA_CONNECTORS=true` env var exposes additional community-maintained connectors not shown by default.

### 4.1 Knowledge Base & Wikis

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Confluence** | OAuth2 or API token | Poll (30 min default) | Yes (EE) | Pages, blog posts, comments, attachments |
| **SharePoint** | Certificate-based auth (required for perm sync), Client secret, or OAuth | Poll | Yes (EE) | Site pages, files, list items |
| **Notion** | OAuth2 integration token | Poll | No | Pages, databases, blocks (recursive) |
| **BookStack** | API token | Poll | No | Books, chapters, pages |
| **Document360** | API token | Poll | No | Articles, categories |
| **Discourse** | API token | Poll | No | Topics, posts |
| **GitBook** | API token | Poll | No | Spaces, pages |
| **Slab** | API token | Poll | No | Posts, topics |
| **Outline** | API token | Poll | No | Documents, collections |
| **Google Sites** | Service account or OAuth | Load | No | Published site pages |
| **Guru** | API token | Poll | No | Cards |
| **Axero** | API token | Poll | No | Spaces, articles |

### 4.2 Cloud Storage

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Google Drive** | Service account or OAuth (workspace admin required for perm sync) | Poll | Yes (EE) | Docs, Sheets, Slides, PDFs, Office files |
| **Dropbox** | OAuth2 | Poll | No | Files |
| **Box** | OAuth2 | Poll | Yes (EE) | Files, folders |
| **AWS S3** | IAM role or access key | Poll | No | Files (PDF, DOCX, TXT, etc.) |
| **Google Cloud Storage** | Service account | Poll | No | Files |
| **Egnyte** | OAuth2 | Poll | No | Files |
| **Oracle Storage (OCI)** | API key | Poll | No | Files |
| **Cloudflare R2** | API token | Poll | No | Files |

### 4.3 Ticketing & Task Management

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Jira** | OAuth2 or API token | Poll with checkpoint | Yes (EE) | Issues, comments, attachments |
| **Zendesk** | API token | Poll | No | Tickets, articles (Help Center) |
| **Airtable** | Personal access token | Load | No | Base records |
| **Linear** | OAuth2 | Poll | No | Issues, comments |
| **Freshdesk** | API key | Poll | No | Tickets, articles |
| **Asana** | OAuth2 or PAT | Poll | No | Tasks, projects |
| **ClickUp** | API token | Poll | No | Tasks, docs |
| **ProductBoard** | API token | Poll | No | Features, notes |
| **TestRail** | API key | Load | No | Test cases, runs |

### 4.4 Messaging

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Slack** | OAuth2 Bot token | Poll / Federated | Yes (EE, federated mode) | Messages, threads, files (channels you invite the bot to) |
| **Microsoft Teams** | Azure app registration | Poll | Yes (EE) | Channel messages, meeting notes |
| **Gmail** | Service account (workspace admin required) | Poll | Yes (EE) | Emails, attachments |
| **Discord** | Bot token | Poll | No | Server messages |
| **XenForo** | API token | Load | No | Threads, posts |
| **Zulip** | API key | Poll | No | Streams, messages |

### 4.5 Sales & CRM

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Salesforce** | OAuth2 (connected app) | Poll with checkpoint | Yes (EE, post-query filtering) | Accounts, contacts, opportunities, cases, custom objects |
| **HubSpot** | Private app token | Poll | No | Contacts, companies, deals, tickets |
| **Gong** | API key | Poll | No | Call transcripts |
| **Fireflies** | API key | Poll | No | Meeting transcripts |
| **Highspot** | OAuth2 | Poll | No | Content items |

### 4.6 Code Repository

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **GitHub** | Personal access token or GitHub App | Poll with checkpoint | Yes (EE) | Code files, README, issues, PRs, discussions |
| **GitLab** | Personal access token | Poll | No | Code files, issues, merge requests, wikis |
| **Bitbucket** | App password (Cloud only) | Poll | No | Repos, issues, pull requests |

### 4.7 Other / Generic

| Connector | Auth Method | Sync Type | Permission Sync | Content Indexed |
|-----------|------------|-----------|----------------|----------------|
| **Web Scraper** | None (or HTTP auth) | Load or Poll | No | Web pages (recursive, single page, or sitemap) |
| **File Upload** | N/A (admin upload) | Load (manual) | No | PDF, DOCX, TXT, CSV, PPTX, MD, etc. |

### 4.8 Connector Input Types (Technical)

Onyx defines four ingestion patterns at the interface level:

```python
# backend/onyx/connectors/interfaces.py

class InputType(str, Enum):
    LOAD_STATE    = "load_state"    # One-time bulk import; static sources
    POLL          = "poll"          # Incremental; uses timestamps or checkpoints
    EVENT         = "event"         # Webhook-driven real-time updates
    SLIM_RETRIEVAL = "slim_retrieval"  # ID-only sync for permission reconciliation
```

**Poll connectors** are the most common. They implement either `PollConnector` (start_time / end_time window) or `CheckpointedConnector` (opaque checkpoint object for resumable, large-corpus syncs like GitHub or SharePoint). Checkpointed connectors are more resilient because they survive process restarts mid-sync.

---

## 5. Permission Architecture — ACL Mirroring

Source: https://docs.onyx.app/security/architecture/access_controls  
Source: https://deepwiki.com/onyx-dot-app/onyx/3.4-supported-data-sources

### 5.1 Overview

Permission mirroring is an **Enterprise Edition only** feature. It mirrors the ACLs from the source system into Onyx's document index, so that when a user searches, they only see documents they have access to in the source system.

Three access modes exist per connector:

| Mode | Description | Use case |
|------|-------------|----------|
| `public` | All Onyx users see all indexed data from this connector | Public wikis, open knowledge bases |
| `private` | Only the connector creator + explicitly assigned users/groups see data | Sensitive connectors |
| `sync` | ACLs are continuously mirrored from the source system | Enterprise deployments |

### 5.2 Connectors with Permission Sync Support

Only these nine connectors support auto-sync permissions:

1. **Confluence** — Space-level and page-level permissions, group membership
2. **Jira** — Project-level permissions, issue-level visibility
3. **Google Drive** — File/folder ACLs, Google Groups membership (requires service account or workspace admin OAuth)
4. **Gmail** — Per-email access (requires service account)
5. **Slack** — Channel membership (federated mode); uses Slack's API to resolve user-channel access
6. **Salesforce** — Object-level visibility rules (uses post-query censoring rather than pre-query filter)
7. **GitHub** — Repository visibility + team membership
8. **Box** — File/folder permissions, collaborations
9. **SharePoint** — Site/library/item permissions (requires certificate-based authentication)

### 5.3 Two-Stage Permission Resolution

Onyx uses a **two-stage model**:

**Stage 1 — Group Sync (background, periodic):**  
A background Celery task (`celery_worker_heavy`, `connector_external_group_sync` queue) fetches all external groups/teams from the source. These are stored in PostgreSQL as `ExternalUserGroup` records, mapping external group IDs to Onyx users by email.

```
Source system groups → ExternalUserGroup table in Postgres
(runs on connector_external_group_sync queue, every ~1 hour)
```

**Stage 2 — Document Permission Sync (background, periodic):**  
A separate task (`connector_doc_permissions_sync` queue) fetches slim document IDs from the source and resolves their ACLs. For each document, it builds an `access_control_list` which is a list of:
- Individual user emails
- External group IDs

This ACL is written to the document record in OpenSearch.

```python
# Simplified representation of a document's ACL in the index
{
    "document_id": "confluence__page__12345",
    "content": "...",
    "access_control_list": [
        "user:alice@company.com",
        "group:confluence__space__ENG",
        "group:confluence__space__PUBLIC"
    ]
}
```

**At query time:** The API server resolves the requesting user's group memberships (from the cached `ExternalUserGroup` table in Postgres) and passes them as a filter to OpenSearch. This is a pre-query filter — documents the user cannot access are excluded before scoring.

### 5.4 Salesforce Exception — Post-Query Censoring

Salesforce's sharing model is too complex to represent as a static ACL (it uses sharing rules, role hierarchies, and owner-based visibility). Onyx handles it differently:

Instead of a pre-query ACL filter, it indexes all Salesforce documents and applies **post-query censoring** — after retrieving candidate chunks, it calls the Salesforce API to verify each document is accessible to the current user. Only verified documents are returned.

Source: `backend/ee/onyx/external_permissions/salesforce/postprocessing.py`

**This is the right approach for sources with complex sharing models. We should adopt it for any connector where ACL cannot be represented as a flat list.**

### 5.5 SharePoint Certificate Authentication Requirement

SharePoint permission sync specifically requires **certificate-based authentication** (not client secret or OAuth). This is because reading SharePoint site collection permissions requires elevated Graph API scopes that Microsoft only grants to certificate-authenticated apps. This is a non-obvious gotcha that has tripped up many Onyx users.

**Implication for us:** Our SharePoint connector must support certificate auth from day one if we want ACL mirroring to work.

### 5.6 Group Sync Cache Refresh

Group membership changes in the source system propagate to Onyx with a delay equal to the group sync interval (default ~1 hour). There is no webhook-based invalidation. If a user is removed from a Google Group, they will continue to see those documents in Onyx for up to 1 hour.

This is a known and accepted limitation. In practice it's acceptable for most enterprise deployments because immediate de-provisioning requirements are met at the IdP (SSO) level — if a user's account is suspended, they can't log in at all.

---

## 6. MCP Server — Full Reference

Source: https://docs.onyx.app/deployment/configuration/mcp_server

### 6.1 Overview

The Onyx MCP server exposes a Streamable HTTP endpoint at port 8090. It is disabled by default and enabled via `MCP_SERVER_ENABLED=true`.

It gives any MCP-compatible client (Claude Desktop, Claude Code, Cursor, Windsurf) three capabilities:
1. Search the private enterprise knowledge base indexed in Onyx
2. Search the public web
3. Fetch the full text of any URL

All existing Onyx RBAC permissions are enforced automatically — users connecting via MCP only see documents they would see in the Onyx UI.

### 6.2 Connection Configuration

```json
{
  "mcpServers": {
    "onyx": {
      "type": "http",
      "url": "https://your-onyx-instance/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ONYX_PAT_OR_API_KEY"
      }
    }
  }
}
```

For Claude Code CLI:
```bash
claude mcp add --transport http onyx https://your-onyx-instance/mcp \
  --header "Authorization: Bearer ${ONYX_TOKEN}"
```

For self-hosted on default port:
```
http://YOUR_DOMAIN:8090/
```

### 6.3 Available Tools

#### Tool 1: `search_indexed_documents`

Search the private enterprise knowledge base.

**Input schema:**
```typescript
{
  query: string;          // required — natural language search query
  source_types?: string[]; // optional — filter by connector type
                           // e.g. ["confluence", "github", "jira"]
  time_cutoff?: string;   // optional — ISO 8601 datetime, only docs updated after this
  limit?: number;         // optional — max results, default 10
}
```

**Example call:**
```json
{
  "query": "What is the deployment process for the payments service?",
  "source_types": ["confluence", "github"],
  "time_cutoff": "2025-01-01T00:00:00Z",
  "limit": 5
}
```

**Response schema:**
```typescript
{
  documents: Array<{
    semantic_identifier: string;  // human-readable document name
    content: string;              // relevant text snippet
    source_type: string;          // e.g. "confluence"
    link: string;                 // URL to original document
    score: number;                // relevance score
  }>;
  total_results: number;
  query: string;
  executed_queries: string[];   // may include query expansions
}
```

#### Tool 2: `search_web`

Search the public internet.

**Input schema:**
```typescript
{
  query: string;    // required
  limit?: number;   // optional, default 5
}
```

**Response schema:**
```typescript
{
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  query: string;
}
```

Note: Returns snippets only, not full content. Use `open_urls` to fetch full text.

#### Tool 3: `open_urls`

Fetch complete text content from one or more URLs.

**Input schema:**
```typescript
{
  urls: string[];  // required — list of URLs to fetch
}
```

**Response schema:**
```typescript
{
  results: Array<{
    title: string;
    url: string;
    content: string;  // full extracted text
  }>;
}
```

### 6.4 Available Resources

#### Resource: `indexed_sources`

URI: `resource://indexed_sources`

Lists all document connector types currently indexed in the Onyx instance. Use this to discover valid values for `source_types` in `search_indexed_documents`.

**Example response:**
```json
{
  "indexed_sources": ["confluence", "github", "google_drive", "jira", "slack"]
}
```

### 6.5 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SERVER_ENABLED` | `false` | Set to `"true"` to enable the MCP server |
| `MCP_SERVER_HOST` | `0.0.0.0` | Bind host |
| `MCP_SERVER_PORT` | `8090` | Port |
| `MCP_SERVER_CORS_ORIGINS` | (empty) | Comma-separated allowed CORS origins |
| `API_SERVER_PROTOCOL` | `http` | Protocol for internal API server connection |
| `API_SERVER_HOST` | `127.0.0.1` | Hostname for internal API server |
| `API_SERVER_URL_OVERRIDE_FOR_HTTP_REQUESTS` | (unset) | Full URL override — use when MCP is deployed against Onyx Cloud |

### 6.6 Health Check

```bash
curl http://localhost:8090/health
# Expected: {"status":"healthy","service":"mcp_server"}
```

### 6.7 Debugging with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```
Then in the Inspector UI:
1. Open the Authentication tab
2. Select Bearer Token authentication
3. Paste your Onyx PAT or API key
4. Click Connect

### 6.8 How We Implement Something Similar

Our `markdown-for-agents-mcp` already exposes web fetch and web search. The critical missing piece that Onyx solves is the private knowledge base search behind ACL enforcement.

**TypeScript equivalent of `search_indexed_documents`:**

```typescript
// src/tools/search-knowledge.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchDocuments } from '../knowledge/search.js';
import { resolveUserGroups } from '../acl/resolver.js';

const SearchInputSchema = z.object({
  query: z.string(),
  source_types: z.array(z.string()).optional(),
  time_cutoff: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

server.tool(
  'search_indexed_documents',
  'Search your private knowledge base indexed in this server.',
  SearchInputSchema.shape,
  async ({ query, source_types, time_cutoff, limit }, context) => {
    // Resolve requesting user's groups (from Entra ID transitiveMemberOf cache)
    const userGroups = await resolveUserGroups(context.authInfo?.userId);
    
    const results = await searchDocuments({
      query,
      sourceTypes: source_types,
      timeCutoff: time_cutoff ? new Date(time_cutoff) : undefined,
      limit,
      aclFilter: { userEmail: context.authInfo?.userId, groups: userGroups },
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ documents: results, query }),
      }],
    };
  }
);
```

---

## 7. Hybrid Search — BM25 + Vector

### 7.1 OpenSearch as the Search Backend

Onyx uses **OpenSearch** (formerly Vespa, migrated in 2025) as its search backend. OpenSearch runs both BM25 keyword search and vector search (approximate nearest-neighbour using HNSW) in the same index.

This is a critical architectural decision: **OpenSearch is deeply integrated and not easily swappable.**

### 7.2 Document Chunk Structure

When a document is indexed, it is:
1. Chunked into overlapping segments (typically ~500 tokens with 50-token overlap)
2. Each chunk is embedded with the configured embedding model (default: `nomic-embed-text-v1.5`)
3. Both the text and the embedding vector are stored in OpenSearch per chunk

Each OpenSearch document (chunk) stores:
- `document_id` — parent document identifier
- `content` — raw text of the chunk
- `embeddings` — dense vector for semantic search
- `access_control_list` — array of user emails and group IDs
- `source_type` — connector type (e.g. "confluence")
- `semantic_identifier` — human-readable document title
- `link` — URL to source document
- `metadata` — title, authors, last modified, etc.
- `boost` — manual relevance boost (admin-configurable)
- `hidden` — soft-delete flag

### 7.3 Hybrid Scoring Formula

At query time, Onyx runs **both** a keyword (BM25) query and a vector (kNN) query against OpenSearch, then **fuses** the ranked result lists.

The fusion strategy is **Reciprocal Rank Fusion (RRF)**:

```
RRF_score(document) = Σ 1 / (k + rank_in_list_i)
```

Where `k = 60` (standard RRF constant) and the sum is over the BM25 result list and the vector result list.

**In practice:**
- BM25 wins for exact keyword matches (product names, error codes, ticket IDs, names)
- Vector wins for semantic/paraphrase queries ("how do I deploy the service?" vs. "deployment process")
- RRF fusion consistently outperforms either alone

### 7.4 Cross-Encoder Reranking

After the initial hybrid retrieval (typically top-100 candidates), Onyx applies a **cross-encoder reranker** (the inference model server) to score each candidate against the query more precisely.

The cross-encoder is a transformer that takes (query, document) as a joint input and outputs a relevance score. It is much more accurate than bi-encoder embeddings but too slow to score all documents, hence the two-stage pipeline:
1. Recall stage: BM25 + vector → top 100 candidates (fast)
2. Precision stage: cross-encoder → reranked top N (slower, but applied to small set)

### 7.5 Contextual RAG Enhancement

The 2025 migration to OpenSearch included adoption of Anthropic's **Contextual Retrieval** technique: when indexing, each chunk is augmented with a short LLM-generated context sentence ("This chunk is from the Confluence space 'Engineering' page 'Deployment Runbook', and describes the Kubernetes rollout procedure for the payments service."). This context is prepended to the chunk text before embedding, dramatically improving retrieval for chunks that are not self-explanatory in isolation.

Source: `backend/alembic/versions/19c0ccb01687_migrate_to_contextual_rag_model.py`

### 7.6 Knowledge Graph System

Onyx introduced a Knowledge Graph system (visible in DeepWiki) for generating AI-powered graphs of relationships between concepts across indexed documents. This is a premium feature and relatively new. Not yet well-documented publicly.

### 7.7 How We Implement Hybrid Search

For `markdown-for-agents-mcp` Phase 2, the simplest approach is **PostgreSQL with pgvector + tsvector**. For teams that have OpenSearch or Elasticsearch available, a proper OpenSearch hybrid query is preferred.

**TypeScript — PostgreSQL hybrid search:**

```typescript
// src/knowledge/search.ts

interface SearchOptions {
  query: string;
  sourceTypes?: string[];
  timeCutoff?: Date;
  limit: number;
  aclFilter: { userEmail: string; groups: string[] };
}

export async function searchDocuments(opts: SearchOptions) {
  // Stage 1: Generate query embedding
  const embedding = await embedText(opts.query);
  
  // Stage 2: Hybrid query using RRF over BM25 + vector
  const sql = `
    WITH bm25 AS (
      SELECT
        chunk_id,
        ts_rank_cd(search_vector, plainto_tsquery('english', $1)) AS score,
        ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', $1)) DESC) AS rank
      FROM document_chunks
      WHERE search_vector @@ plainto_tsquery('english', $1)
        AND (acl_users @> $4::text[] OR acl_groups && $5::text[])
        AND ($6::text[] IS NULL OR source_type = ANY($6))
        AND ($7::timestamptz IS NULL OR updated_at > $7)
      ORDER BY score DESC
      LIMIT 100
    ),
    vector AS (
      SELECT
        chunk_id,
        1 - (embedding <=> $2::vector) AS score,
        ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
      FROM document_chunks
      WHERE (acl_users @> $4::text[] OR acl_groups && $5::text[])
        AND ($6::text[] IS NULL OR source_type = ANY($6))
        AND ($7::timestamptz IS NULL OR updated_at > $7)
      ORDER BY embedding <=> $2::vector
      LIMIT 100
    ),
    rrf AS (
      SELECT
        COALESCE(bm25.chunk_id, vector.chunk_id) AS chunk_id,
        COALESCE(1.0 / (60 + bm25.rank), 0) + 
        COALESCE(1.0 / (60 + vector.rank), 0) AS rrf_score
      FROM bm25 FULL OUTER JOIN vector USING (chunk_id)
    )
    SELECT dc.*, rrf.rrf_score AS score
    FROM rrf JOIN document_chunks dc USING (chunk_id)
    ORDER BY rrf_score DESC
    LIMIT $3
  `;

  return db.query(sql, [
    opts.query,
    JSON.stringify(embedding),
    opts.limit,
    [opts.aclFilter.userEmail],
    opts.aclFilter.groups,
    opts.sourceTypes ?? null,
    opts.timeCutoff ?? null,
  ]);
}
```

---

## 8. Custom Connector Interface

Source: https://deepwiki.com/onyx-dot-app/onyx/3.1-connector-framework-overview  
Source: `backend/onyx/connectors/interfaces.py`

### 8.1 Python Interface (What Onyx Implements)

Onyx connectors must implement one or more of these Python interfaces:

```python
# Simplified from backend/onyx/connectors/interfaces.py

class Document:
    """A document yielded by a connector."""
    id: str                    # unique document ID (e.g. "confluence__page__12345")
    sections: list[Section]    # list of (link, text) content sections
    source: DocumentSource     # enum value e.g. DocumentSource.CONFLUENCE
    semantic_identifier: str   # human-readable name (page title)
    metadata: dict             # title, authors, last_modified, etc.
    doc_updated_at: datetime | None
    primary_owners: list[BasicExpertInfo]  # authors/owners of document
    secondary_owners: list[BasicExpertInfo]

class SlimDocument:
    """Minimal document for permission sync — just ID + ACL, no content."""
    id: str
    perm_sync_data: dict | None  # source-specific data for ACL resolution

class LoadConnector:
    """One-time bulk load."""
    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        ...
    def load_from_state(self) -> GenerateDocumentsOutput:
        # Yields batches of Documents
        ...

class PollConnector:
    """Incremental updates via time window."""
    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        ...
    def poll_source(
        self, start: SecondsSinceUnixEpoch, end: SecondsSinceUnixEpoch
    ) -> GenerateDocumentsOutput:
        ...

class CheckpointedConnector:
    """Incremental updates via resumable checkpoint (preferred for large sources)."""
    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        ...
    def load_from_checkpoint(
        self, start: SecondsSinceUnixEpoch, end: SecondsSinceUnixEpoch,
        checkpoint: ConnectorCheckpoint,
    ) -> CheckpointOutput:
        ...

class SlimConnector:
    """Metadata-only retrieval for permission sync."""
    def retrieve_all_slim_documents(
        self, start: SecondsSinceUnixEpoch, end: SecondsSinceUnixEpoch
    ) -> GenerateSlimDocumentOutput:
        ...

class SlimConnectorWithPermSync(SlimConnector):
    """Slim connector + explicit permission sync support."""
    ...
```

### 8.2 Connector Registration

Connectors are registered via a factory pattern. `backend/onyx/connectors/factory.py` maps `(DocumentSource, InputType)` tuples to Python class paths using lazy imports (so unused connectors don't add startup cost).

### 8.3 TypeScript Equivalent for markdown-for-agents-mcp

For our Node.js/TypeScript MCP server, we implement an equivalent interface:

```typescript
// src/connectors/interfaces.ts

export interface Document {
  id: string;                    // globally unique, e.g. "sharepoint__page__site/123"
  title: string;
  content: string;               // full text
  sourceType: string;            // e.g. "sharepoint"
  url: string;
  updatedAt: Date;
  authors: string[];
  metadata: Record<string, unknown>;
  // ACL fields (only populated when connector supports permission sync)
  aclUsers?: string[];           // email addresses with explicit access
  aclGroups?: string[];          // group IDs with access
}

export interface ConnectorCredentials {
  [key: string]: string | undefined;
}

export interface ConnectorCheckpoint {
  lastModified?: string;        // ISO datetime or cursor token
  pageToken?: string;           // pagination cursor
  completedSiteIds?: string[];  // for multi-site connectors like SharePoint
}

// For full sync (small sources)
export interface LoadConnector {
  loadCredentials(credentials: ConnectorCredentials): Promise<void>;
  loadAll(): AsyncGenerator<Document[], void, unknown>;
}

// For incremental sync (most sources)
export interface PollConnector {
  loadCredentials(credentials: ConnectorCredentials): Promise<void>;
  pollSource(start: Date, end: Date): AsyncGenerator<Document[], void, unknown>;
}

// For large sources that need resumable sync (SharePoint, GitHub)
export interface CheckpointedConnector {
  loadCredentials(credentials: ConnectorCredentials): Promise<void>;
  loadFromCheckpoint(
    start: Date,
    end: Date,
    checkpoint: ConnectorCheckpoint,
  ): AsyncGenerator<
    { documents: Document[]; checkpoint: ConnectorCheckpoint; hasMore: boolean },
    void,
    unknown
  >;
}
```

### 8.4 SharePoint Connector Implementation Pattern

SharePoint is the most complex connector in our target set. Key Onyx implementation insights from the source files:

1. **Delta API**: Use SharePoint's `delta` endpoint for incremental sync. Store the `deltaToken` as the checkpoint, not a timestamp. Timestamps miss moves and renames.

2. **Hierarchy matching**: Use `test_drive_matching.py` patterns — SharePoint has both document libraries (drives) and site pages (wiki). They use different APIs and must be handled separately.

3. **Certificate auth for permission sync**: The app registration needs `Sites.FullControl.All` (or `Sites.Read.All` + `Directory.Read.All`). Client secret auth only grants delegated permissions and cannot enumerate site collection administrators.

4. **Rate limiting**: SharePoint throttles aggressively. Onyx implements exponential backoff with `Retry-After` header handling. Tests in `test_rest_client_context_caching.py` show context-level caching to reduce token refresh calls.

---

## 9. Agentic RAG and Deep Research

Source: https://deepwiki.com/onyx-dot-app/onyx/4.5-deep-research-mode  
Source: `backend/onyx/deep_research/dr_loop.py`

### 9.1 Standard RAG Loop

The standard chat uses `run_llm_loop()`:

```
User message
    ↓
construct_message_history() — truncate to token budget
    ↓
LLM call with tools: [SearchTool, WebSearchTool, OpenURLTool, CodeExecTool, ...]
    ↓
Tool calls executed → results fed back into context
    ↓
Next LLM iteration (up to max_cycles)
    ↓
Final response streamed to user
```

The loop supports multi-cycle tool calling. After each tool response, the LLM decides whether to call more tools or answer. Onyx tracks placement via `(turn_index, tab_index, sub_turn_index)` to correctly position streaming packets in the multi-step UI.

**Fallback for non-function-calling models:** If the LLM doesn't use native tool-call format, Onyx detects XML-style tool invocations (`_looks_like_xml_tool_call_payload`) and parses them manually.

### 9.2 Deep Research Mode

Deep Research is a multi-agent system built on top of the standard LLM loop:

```
User research question
    ↓
Clarification stage (optional): LLM asks for missing context
    ↓
Orchestrator Agent: breaks question into a research plan (sub-questions)
    ↓
Research Agents (parallel): each sub-agent runs its own loop with:
    - SearchTool (private knowledge base)
    - WebSearchTool (public internet)
    - OpenURLTool (fetch full content)
  Each produces an intermediate report with citations
    ↓
generate_final_report(): combines all intermediate reports into
    a long-form cited document
    ↓
Streamed to user as markdown
```

Source: `backend/onyx/deep_research/dr_loop.py:86-123`  
Source: `backend/onyx/tools/fake_tools/research_agent.py:96-106`

The orchestrator uses prompts from `backend/onyx/prompts/deep_research/` — these are worth reading as a reference for multi-agent research prompt design.

### 9.3 Citation System

Onyx has a custom `DynamicCitationProcessor` that monitors the LLM output stream for citation markers (e.g. `[[1]]`) and maps them back to the source `SearchDoc` entities. Citations are hyperlinked to the original source in the UI.

### 9.4 How We Implement Deep Research

Our MCP server exposes tools, but the agent loop runs in the client (Claude, Cursor). For Phase 1 (current), this is fine — the client orchestrates multi-tool calls.

For a future server-side deep research feature, the Onyx pattern is the reference:

```typescript
// src/deep-research/orchestrator.ts

async function runDeepResearch(question: string, userId: string): AsyncGenerator<ResearchUpdate> {
  // 1. Clarification (optional)
  const clarifications = await askForClarifications(question);
  
  // 2. Research plan
  const subQuestions = await generateResearchPlan(question, clarifications);
  
  // 3. Parallel research agents
  const agentResults = await Promise.all(
    subQuestions.map(q => runResearchAgent(q, userId))
  );
  
  // 4. Synthesis
  yield* generateFinalReport(question, agentResults);
}

async function runResearchAgent(question: string, userId: string) {
  const tools = [searchIndexedDocuments, searchWeb, fetchUrl];
  return runLlmLoop(question, tools, { userId, maxCycles: 5 });
}
```

---

## 10. LLM Configuration

Source: https://deepwiki.com/onyx-dot-app/onyx/5-llm-provider-management

### 10.1 Supported Providers

Onyx supports all major LLM providers through a unified LiteLLM-based interface:

| Provider | Config Mechanism | Notes |
|----------|-----------------|-------|
| OpenAI | API key + optional base URL | GPT-4o, o3-mini, etc. |
| Anthropic | API key | Claude Opus 4.7+, Sonnet, Haiku |
| Azure OpenAI | API key + endpoint + deployment name + API version | Enterprise favourite |
| Amazon Bedrock | IAM role or access key + region | Requires custom_config with region |
| Google Vertex AI | Service account JSON + project ID | Requires custom_config |
| Ollama | Base URL (no key needed) | For local/private model hosting |
| LM Studio | Base URL + API key | OpenAI-compatible local models |
| OpenRouter | API key | Routes to many providers |
| Bifrost | API key + endpoint | Internal routing/gateway |
| LiteLLM Proxy | API key + base URL | Catch-all for OpenAI-compatible endpoints |
| Custom (OpenAI-compat) | API key + base URL | vLLM, Mistral, etc. |

### 10.2 Database Schema for LLM Providers

```python
# Simplified from backend/onyx/db/models.py

class LLMProvider:
    id: int
    name: str                    # display name (e.g. "Azure GPT-4o")
    provider: str                # provider type (e.g. "azure")
    api_key: str | None          # encrypted
    api_base: str | None         # endpoint URL for Azure/Ollama/etc.
    api_version: str | None      # Azure API version
    is_public: bool              # visible to all users?
    custom_config: dict | None   # provider-specific JSON (region, project_id, etc.)

class ModelConfiguration:
    id: int
    llm_provider_id: int
    name: str                    # model name (e.g. "gpt-4o-2024-08-06")
    is_visible: bool
    max_input_tokens: int | None
    supports_image_input: bool
```

### 10.3 Model Selection Hierarchy

At query time, the model is selected via `get_llm_for_persona()`:

1. **LLM Override** — explicit model selection in the chat UI
2. **Persona/Agent Override** — model configured on the specific agent being used
3. **System Default** — globally configured by an admin

### 10.4 Azure OpenAI Configuration Example

```json
{
  "provider": "azure",
  "api_key": "...",
  "api_base": "https://myorg.openai.azure.com",
  "api_version": "2024-05-01-preview",
  "custom_config": {
    "deployment_name": "gpt-4o-prod"
  }
}
```

### 10.5 Ollama Configuration Example

```json
{
  "provider": "ollama",
  "api_base": "http://localhost:11434",
  "api_key": null,
  "model_name": "llama3.1:70b"
}
```

### 10.6 Reasoning Model Handling

Onyx includes special handling for reasoning models (Claude Opus 4.7+, o3, etc.):
- Sets `ANTHROPIC_ADAPTIVE_REASONING_EFFORT` for Anthropic reasoning models
- Restricts temperature sampling parameters (reasoning models typically require `temperature=1`)
- Uses `model_is_reasoning_model()` utility to detect and apply correct settings

Source: `backend/onyx/llm/multi_llm.py:94-95`

---

## 11. Community vs Enterprise Edition

Source: https://docs.onyx.app/security/architecture/access_controls  
Source: `backend/ee/` directory

The Community Edition (MIT) includes everything needed to run a functional RAG system. The Enterprise Edition (EE), gated by `backend/ee/`, adds the features that make it production-ready for large organizations.

### 11.1 Feature Comparison

| Feature | Community | Enterprise |
|---------|-----------|-----------|
| Chat UI | Yes | Yes |
| RAG search | Yes | Yes |
| All 60+ connectors | Yes | Yes |
| File upload | Yes | Yes |
| Custom agents/personas | Yes | Yes |
| Actions & MCP client | Yes | Yes |
| Web search | Yes | Yes |
| Code execution (Craft) | Yes | Yes |
| Basic auth (email+password) | Yes | Yes |
| Google OAuth SSO | Yes | Yes |
| OIDC SSO | Yes | Yes |
| SAML SSO | Yes | Yes |
| Multiple simultaneous SSO providers | No | Yes |
| SCIM provisioning | No | Yes |
| **ACL permission mirroring** | **No** | **Yes** |
| **RBAC (user groups, roles)** | **No** | **Yes** |
| Custom user roles/group managers | No | Yes |
| LLM access controls (per-group) | No | Yes |
| Agent/persona access controls | No | Yes |
| Spending limits per user | No | Yes |
| White labeling | No | Yes |
| Audit logs | No | Yes |
| Usage analytics | No | Yes |
| Query history (admin view) | No | Yes |
| Custom analytics | No | Yes |
| SIEM integration | No | Yes |
| Knowledge graph | No | Yes |
| Multi-tenant cloud | No | Yes |
| Hook extensions | No | Yes |

### 11.2 EE Feature Implementation Location

All EE-only code lives in `backend/ee/onyx/`. The directory structure mirrors the CE structure:

```
backend/ee/onyx/
├── access/              # ACL enforcement at query time
├── background/celery/   # EE-only background tasks
├── db/                  # EE-only database operations (groups, licensing)
├── external_permissions/  # Per-connector ACL sync implementations
│   ├── confluence/
│   ├── github/
│   ├── google_drive/
│   ├── jira/
│   ├── salesforce/
│   ├── sharepoint/
│   ├── slack/
│   └── teams/
└── server/              # EE-only API endpoints
```

### 11.3 Licensing Enforcement

EE features are gated by `backend/ee/onyx/db/license.py`. License keys are validated on startup and periodically. The seat limit enforcement uses PostgreSQL advisory locks to prevent race conditions when multiple users are provisioned simultaneously.

### 11.4 What This Means for Us

Our MVP target includes ACL mirroring (the most critical EE feature). We do not need a license concept — we are building a standalone MCP server, not a SaaS platform. We implement the EE features we need directly in the MIT-licensed tool.

Key EE patterns to replicate:
- `backend/ee/onyx/access/access.py` — ACL filter injection at query time
- `backend/ee/onyx/external_permissions/` — per-connector ACL sync scripts
- Group-based permission model rather than per-user

---

## 12. Database Schema

Source: `backend/onyx/db/models.py`  
Source: https://deepwiki.com/onyx-dot-app/onyx/7.1-database-models-and-schema

### 12.1 Core Tables

```sql
-- Documents and indexing state (kept in Postgres; content goes to OpenSearch)
Document (
    id              TEXT PRIMARY KEY,  -- e.g. "confluence__page__12345"
    connector_id    INTEGER,
    semantic_identifier TEXT,           -- human-readable name
    link            TEXT,
    primary_owners  JSONB,
    secondary_owners JSONB,
    from_ingestion_api BOOLEAN,
    last_modified   TIMESTAMPTZ,
    last_synced     TIMESTAMPTZ,
    is_up_to_date   BOOLEAN
)

-- Connector configuration
Connector (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    source          TEXT,               -- ValidSources enum value
    input_type      TEXT,               -- InputType enum value
    connector_specific_config JSONB,
    refresh_freq    INTEGER,            -- seconds
    prune_freq      INTEGER,            -- seconds
    indexing_start  TIMESTAMPTZ
)

-- Authentication credentials for connectors
Credential (
    id              INTEGER PRIMARY KEY,
    credential_json JSONB,              -- encrypted API keys, tokens
    user_id         UUID,               -- owner
    admin_public    BOOLEAN
)

-- Link between Connector and Credential
ConnectorCredentialPair (
    connector_id    INTEGER REFERENCES Connector,
    credential_id   INTEGER REFERENCES Credential,
    access_type     TEXT,               -- 'public' | 'private' | 'sync'
    is_active       BOOLEAN
)

-- External user groups (mirrored from source systems)
ExternalUserGroup (
    id              SERIAL PRIMARY KEY,
    user_group_id   TEXT,               -- external group ID
    user_id         UUID REFERENCES User,  -- Onyx user
    cc_pair_id      INTEGER             -- which connector synced this
)

-- LLM provider configuration
LLMProvider (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    provider        TEXT,               -- "openai" | "azure" | "ollama" | ...
    api_key         TEXT,               -- encrypted
    api_base        TEXT,
    api_version     TEXT,
    is_public       BOOLEAN,
    custom_config   JSONB
)

-- AI Agents / Personas
Persona (
    id              INTEGER PRIMARY KEY,
    name            TEXT,
    description     TEXT,
    system_prompt   TEXT,
    task_prompt     TEXT,
    is_public       BOOLEAN,
    default_model_configuration_id INTEGER
)

-- Chat sessions and messages
ChatSession (
    id              UUID PRIMARY KEY,
    user_id         UUID,
    persona_id      INTEGER,
    description     TEXT,
    current_alternate_model TEXT
)

ChatMessage (
    id              INTEGER PRIMARY KEY,
    chat_session_id UUID,
    parent_message_id INTEGER,         -- tree structure for branching
    message         TEXT,
    message_type    TEXT,              -- USER | ASSISTANT | SYSTEM | TOOL_CALL_RESPONSE
    token_count     INTEGER,
    files           JSONB
)
```

### 12.2 OpenSearch Document Schema (per chunk)

```json
{
  "document_id": "confluence__page__12345",
  "chunk_id": "confluence__page__12345__0",
  "content": "The deployment process for the payments service involves...",
  "embeddings": [0.123, -0.456, ...],  // 768 or 1536 dimensions
  "access_control_list": [
    "user:alice@company.com",
    "group:confluence__space__ENGINEERING"
  ],
  "source_type": "confluence",
  "semantic_identifier": "Payments Service Deployment Runbook",
  "link": "https://company.atlassian.net/wiki/spaces/ENG/pages/12345",
  "boost": 0.0,
  "hidden": false,
  "metadata": {
    "last_modified": "2026-07-15T09:30:00Z",
    "authors": ["alice@company.com"]
  }
}
```

### 12.3 Our Schema for markdown-for-agents-mcp

```sql
-- Document chunks stored in PostgreSQL with pgvector
CREATE TABLE document_chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     TEXT NOT NULL,          -- globally unique doc ID
  chunk_index     INTEGER NOT NULL,       -- chunk number within document
  source_type     TEXT NOT NULL,          -- "sharepoint" | "confluence" | ...
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  url             TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  embedding       VECTOR(1536),           -- OpenAI text-embedding-3-small or similar
  search_vector   TSVECTOR,               -- BM25 index
  acl_users       TEXT[] DEFAULT '{}',    -- explicit user emails
  acl_groups      TEXT[] DEFAULT '{}',    -- Entra group IDs
  metadata        JSONB DEFAULT '{}',

  CONSTRAINT uq_doc_chunk UNIQUE (document_id, chunk_index)
);

CREATE INDEX idx_chunks_embedding ON document_chunks 
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_chunks_search ON document_chunks 
  USING GIN (search_vector);

CREATE INDEX idx_chunks_source ON document_chunks (source_type);
CREATE INDEX idx_chunks_updated ON document_chunks (updated_at);

-- Trigger to keep search_vector current
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', 
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_search_vector
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Connector sync state
CREATE TABLE connector_sync_state (
  id              SERIAL PRIMARY KEY,
  connector_id    TEXT NOT NULL UNIQUE,
  source_type     TEXT NOT NULL,
  last_sync_start TIMESTAMPTZ,
  last_sync_end   TIMESTAMPTZ,
  checkpoint      JSONB DEFAULT '{}',   -- opaque checkpoint for resumable sync
  status          TEXT DEFAULT 'idle',  -- 'idle' | 'running' | 'error'
  error_message   TEXT
);

-- External group memberships (mirrored from Entra ID)
CREATE TABLE user_group_memberships (
  id              SERIAL PRIMARY KEY,
  user_email      TEXT NOT NULL,
  group_id        TEXT NOT NULL,        -- Entra object ID
  group_name      TEXT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_user_group UNIQUE (user_email, group_id)
);
CREATE INDEX idx_ugm_user ON user_group_memberships (user_email);
```

---

## 13. Background Processing Architecture

Source: https://deepwiki.com/onyx-dot-app/onyx/6-background-processing-and-coordination

### 13.1 Celery Worker Pool Architecture

Onyx runs 8 specialised Celery worker pools to prevent resource contention:

| Pool | Queues | Purpose |
|------|--------|---------|
| `primary` | `celery` | High-level coordination, singleton cleanup |
| `light` | `vespa_metadata_sync`, `connector_deletion`, `doc_permissions_upsert`, `checkpoint_cleanup`, `chat_ttl_deletion` | Fast metadata updates, DB maintenance |
| `heavy` | `connector_pruning`, `connector_doc_permissions_sync`, `connector_external_group_sync`, `csv_generation`, `connector_hierarchy_fetching` | Resource-intensive sync tasks |
| `docfetching` | `connector_doc_fetching` | I/O-bound: pulling docs from external APIs |
| `docprocessing` | `docprocessing`, `port` | CPU-bound: parsing, chunking, embedding |
| `userfile` | `user_file_processing`, `user_file_project_sync`, `user_file_delete` | User-uploaded file processing |
| `scheduled_tasks` | `scheduled_tasks` | Craft scheduled-task runs |
| `monitoring` | `monitoring` | Health checks, telemetry |

**Key design insight:** Separating doc-fetching (I/O-bound) from doc-processing (CPU-bound) allows independent scaling. In a cloud deployment, `docfetching` can scale out many cheap instances while `docprocessing` runs on fewer, larger instances.

### 13.2 Task Scheduling

The `DynamicTenantScheduler` extends Celery's `PersistentScheduler` with:
- Dynamic schedule regeneration without process restart (checks every 60 seconds)
- Per-tenant scheduling in multi-tenant mode
- Runtime-adjustable task generation rate via `beat_multiplier` in Redis

Key periodic task intervals:

| Task | Interval | Description |
|------|----------|-------------|
| `check-for-indexing` | 15s | Trigger connector indexing runs |
| `check-for-user-file-processing` | 20s | Process user-uploaded files |
| `check-for-connector-deletion` | 20s | Background connector cleanup |
| `check_for_vespa_sync_task` | 20s | Sync ACL/metadata changes to OpenSearch |
| Group sync | ~1 hour | Mirror external group memberships |
| Perm sync | ~30 min (configurable) | Mirror document-level ACLs |

### 13.3 Redis Fencing Pattern

Onyx uses a "Fence + TaskSet" pattern to prevent duplicate work:

1. Before starting a sync, acquire a `Fence` lock in Redis (per connector, per tenant)
2. Dispatch subtasks into a `TaskSet` (tracked in Redis)
3. As subtasks complete, they are removed from the `TaskSet`
4. When the `TaskSet` is empty, the fence is cleared and the entity is marked synced in Postgres

This prevents a second sync from starting while the first is still running, even across multiple worker processes.

### 13.4 What We Build (Node.js Equivalent)

For our MCP server, we do not need Celery's full complexity. A simpler approach:

```typescript
// src/sync/scheduler.ts

import { Queue, Worker } from 'bullmq';

// Separate queues for I/O vs CPU work (mirrors Onyx's pool separation)
const docFetchQueue = new Queue('doc-fetch', { connection: redis });
const docProcessQueue = new Queue('doc-process', { connection: redis });
const permSyncQueue = new Queue('perm-sync', { connection: redis });

// Periodic connector scheduling
setInterval(async () => {
  const connectors = await db.getConnectorsDueForSync();
  for (const connector of connectors) {
    await docFetchQueue.add('sync-connector', { connectorId: connector.id });
  }
}, 15_000);

// Doc fetch worker (I/O-bound, can run many)
const fetchWorker = new Worker('doc-fetch', async (job) => {
  const docs = await fetchFromSource(job.data.connectorId);
  for (const batch of chunk(docs, 50)) {
    await docProcessQueue.add('process-docs', { docs: batch });
  }
}, { connection: redis, concurrency: 10 });

// Doc process worker (CPU-bound, fewer, larger instances)
const processWorker = new Worker('doc-process', async (job) => {
  const chunks = await chunkAndEmbed(job.data.docs);
  await upsertToDatabase(chunks);
}, { connection: redis, concurrency: 2 });
```

---

## 14. Authentication Architecture

Source: https://deepwiki.com/onyx-dot-app/onyx/8.1-authentication-methods

### 14.1 Supported Auth Types

| Type | Community | Enterprise |
|------|-----------|-----------|
| Email + password | Yes | Yes |
| Google OAuth | Yes | Yes |
| OIDC (single provider) | Yes | Yes |
| SAML (single provider) | Yes | Yes |
| Multiple simultaneous SSO providers | No | Yes |
| SCIM provisioning | No | Yes |
| JWT Header Auth | No | Yes |
| Mobile PKCE SSO | No | Yes |

### 14.2 OIDC/OAuth Flow

Onyx uses FastAPI-Users with custom extensions. The key feature is **dynamic multi-provider SSO** in EE — rather than static `AUTH_TYPE` env vars, multiple OIDC/SAML providers are stored in Postgres and resolved at request time from the URL path (`/api/auth/oidc/{provider_name}/callback`).

During login, claims from the IdP are captured and stored in Redis (TTL 30 days) for enrichment of the user's directory profile.

### 14.3 Entra ID Integration Pattern

For Vodacom/enterprise deployments, the OIDC flow against Entra ID is:

1. User hits `/api/auth/oidc/azure-ad/authorize`
2. Onyx generates PKCE state, redirects to Entra ID login
3. Entra ID calls `/api/auth/oidc/azure-ad/callback` with authorization code
4. Onyx exchanges code for tokens, extracts user's UPN (email)
5. User is created or updated in Postgres
6. Session cookie issued

For our MCP server's Entra ID integration, we need the user's email as the identity principal, then resolve `transitiveMemberOf` from Microsoft Graph to get their group memberships. This is exactly what Onyx's `connector_external_group_sync` does for SharePoint and Teams.

---

## 15. Ten Architectural Decisions to Adopt

These are the ten most important decisions from Onyx's architecture that we should adopt in markdown-for-agents-mcp Phase 2.

### Decision 1: Separate Indexing and Inference Model Servers

**Onyx does:** Runs two separate model servers — one dedicated to indexing (heavy, background), one for inference (query-time). They never compete for resources.

**Why it matters:** Indexing a large SharePoint site will saturate the embedding model. If that same model is used for query-time re-ranking, search latency spikes during indexing runs.

**Adopt:** Run embedding-for-indexing as a background job separate from embedding-for-search. In practice this means: write chunks to a queue, embed asynchronously, never embed inline in the MCP tool handler.

### Decision 2: CheckpointedConnector for Large Sources

**Onyx does:** Implements `CheckpointedConnector` (opaque checkpoint stored in Postgres) instead of simple time-window polling for sources like SharePoint and GitHub.

**Why it matters:** SharePoint has tens of thousands of files. A 30-minute sync window is insufficient. If the sync process dies mid-run, a time-window connector re-indexes everything; a checkpointed connector resumes from where it left off.

**Adopt:** Our SharePoint and Confluence connectors must implement checkpointed sync. Store the SharePoint delta token as the checkpoint.

### Decision 3: ACL at Query Time, Not Just at Index Time

**Onyx does:** Stores an `access_control_list` field in every document chunk in OpenSearch. At query time, passes the user's groups as an OpenSearch filter (pre-query exclusion).

**Why it matters:** Indexing-time ACLs alone are insufficient — they go stale. By storing ACLs in the search index and filtering at query time, Onyx can update ACLs independently of document content without re-indexing.

**Adopt:** Store `acl_users[]` and `acl_groups[]` in every chunk row in our Postgres table. Apply as a WHERE clause in every search query.

### Decision 4: Slim Documents for Permission Sync

**Onyx does:** Runs a separate `SlimConnector` pass that fetches only document IDs and their ACLs (no content) to refresh permissions without re-downloading all document content.

**Why it matters:** Fetching the full content of 50,000 SharePoint pages every hour just to check if permissions changed is insane. The slim pass fetches only metadata.

**Adopt:** Implement a lightweight permission-sync pass separate from the content-sync pass for all ACL-capable connectors.

### Decision 5: Post-Query Censoring for Complex ACL Sources

**Onyx does:** For Salesforce, applies post-query censoring instead of pre-query ACL filter, because Salesforce's sharing rules cannot be represented as a flat ACL.

**Why it matters:** Some sources (Salesforce, potentially some SharePoint configurations) have dynamic ACL rules that can't be pre-computed.

**Adopt:** Design the search pipeline with a censoring stage after retrieval for connectors where pre-computed ACLs are insufficient. The censoring stage calls the source API to verify access.

### Decision 6: Reciprocal Rank Fusion for Hybrid Search

**Onyx does:** Combines BM25 and vector search results using RRF with k=60 before applying cross-encoder reranking.

**Why it matters:** Neither BM25 nor vector search alone is optimal. BM25 wins for exact matches; vector wins for semantic paraphrase. RRF is a simple, parameter-free way to combine them that consistently outperforms either alone.

**Adopt:** Use RRF for all hybrid search queries. k=60 is the standard starting point.

### Decision 7: Contextual Chunk Augmentation

**Onyx does:** During indexing, generates a short LLM-based context sentence for each chunk before embedding. The sentence positions the chunk within its parent document.

**Why it matters:** A chunk saying "The default value is 30 days" is unretrieval in isolation. With context: "From the Onyx security documentation on access controls: The default permission cache TTL is 30 days", it becomes retrievable.

**Adopt:** Use Anthropic's Contextual Retrieval technique during indexing. For cost efficiency, use a small/fast model (Claude Haiku or similar) for context generation.

### Decision 8: Connector-Credential-Pair as the Unit of Indexing

**Onyx does:** Decouples `Connector` (configuration) from `Credential` (secrets) into a `ConnectorCredentialPair` join table. This allows reusing one credential across multiple connector configurations.

**Why it matters:** A SharePoint admin credential should be reusable across multiple SharePoint connectors (different site collections) without duplicating the credential.

**Adopt:** Our data model should reflect this separation. Credentials are encrypted and stored separately; connectors reference credential IDs.

### Decision 9: Dynamic Multi-Provider LLM Configuration

**Onyx does:** Stores LLM provider configuration in Postgres, not environment variables. Admins can add/update providers at runtime without restarting.

**Why it matters:** In enterprise deployments, the LLM endpoint changes (key rotation, model upgrades, failover). Env-var configuration requires restarts.

**Adopt:** For Phase 2, support configuring the LLM provider via a settings API or config file that does not require process restart.

### Decision 10: Dedicate Separate Queues for I/O vs CPU Work

**Onyx does:** Separates `docfetching` (I/O bound) from `docprocessing` (CPU bound) into different Celery queues served by different worker pool sizes.

**Why it matters:** A connector can pull 10,000 documents from an API quickly (I/O bound, parallelisable) but embedding them is CPU-bound and should not block new fetches. Mixing them causes head-of-line blocking.

**Adopt:** Use BullMQ with at least two queues: one for fetching (high concurrency, I/O optimised) and one for processing/embedding (lower concurrency, CPU optimised).

---

## 16. Known Limitations and Gotchas

### 16.1 OpenSearch Coupling

Onyx is deeply coupled to OpenSearch. The migration from Vespa to OpenSearch was a significant undertaking and resulted in `opensearch_migration` tasks visible throughout the codebase. Switching to a different search backend (e.g., Qdrant + Elasticsearch separately) would require significant effort.

**Impact for us:** Use PostgreSQL + pgvector for our Phase 2. Less powerful than dedicated OpenSearch but much simpler to operate and sufficient for early deployments.

### 16.2 SharePoint Permission Sync Requires Certificate Auth

Certificate-based authentication for SharePoint is non-trivial to set up. Many users have filed issues about the complexity. The short version: you must:
1. Create an Azure App Registration
2. Upload a certificate (not a client secret)
3. Grant `Sites.FullControl.All` application permission
4. Have a Global Admin approve the permission grant

If the customer's IT policy prohibits `Sites.FullControl.All`, permission sync is impossible.

**Impact for us:** Document this requirement clearly. Offer a fallback: run without permission sync (all indexed SharePoint content visible to all users who can access the MCP server).

### 16.3 Slack Federated Mode vs. Indexed Mode

Onyx documents that Slack in federated mode (real-time search via Slack API) has "higher latency and lower search quality" than indexed mode. Indexed mode requires storing message content, which raises GDPR concerns in some jurisdictions.

**Impact for us:** If we add a Slack connector, start with indexed mode (better quality) but document the data retention implications.

### 16.4 Google Drive Permission Sync Admin Requirements

Google Drive permission sync requires either:
- A service account with domain-wide delegation, OR
- OAuth credentials from a Google Workspace Admin account

Regular user OAuth cannot see other users' files. This means the connector must be configured by a Google Workspace admin, not by an end user.

**Impact for us:** Same constraint applies to our Google Drive connector.

### 16.5 Connector Default Sync Frequency

The default refresh frequency is **30 minutes**. For active Slack channels or Jira projects, this means up to 30-minute staleness. For static documentation (Confluence, SharePoint pages), 30 minutes is fine.

Users have requested configurable per-connector frequencies. Onyx supports this via the "Advanced Configuration" on each connector (both `refresh_freq` and `prune_freq` are configurable).

### 16.6 Permission Cache Lag

Group membership changes propagate with up to 1-hour lag (the group sync interval). There is no webhook-based invalidation. This is documented and accepted.

**Impact for us:** Same constraint. Document explicitly: "Group membership changes from Entra ID may take up to 60 minutes to propagate."

### 16.7 Airtable Connector is Load-Only

Airtable does not support incremental updates — it's a full re-load on every sync. This means every sync downloads all rows from every configured base. For large Airtable bases (millions of rows) this is expensive.

### 16.8 TestRail Connector (Community Only)

TestRail is listed in `SHOW_EXTRA_CONNECTORS` territory — it's community-maintained and may be less stable than the officially supported connectors.

### 16.9 Memory Requirements for Local Embedding Models

Running local embedding models (the default `nomic-embed-text-v1.5`) requires approximately 2-4 GB RAM for the indexing and inference model servers combined. On constrained deployments, this is significant.

Mitigation: Configure Onyx to use an external embedding provider (Azure OpenAI embeddings, Bedrock Titan Embeddings) instead of local models.

### 16.10 GitHub Issue: OpenSearch Indexing Failures

A common issue in the Onyx GitHub issues is OpenSearch indexing failures during bulk indexing of large connectors. The root cause is typically OpenSearch rejecting requests due to:
- Payload too large (> 100 MB bulk request)
- JVM heap pressure
- Too many concurrent indexing requests

Onyx's mitigation is batching documents to keep bulk requests under 50 MB and implementing exponential backoff on 429/503 responses.

**Impact for us:** Implement batched upserts with size limits when writing to our Postgres/pgvector backend.

---

## 17. Implementation Recommendations

### 17.1 Phase 2 Target Architecture for markdown-for-agents-mcp

Based on the Onyx analysis, our Phase 2 should:

```
markdown-for-agents-mcp (Phase 2)
├── MCP Server (existing Node.js/TypeScript)
│   ├── tool: fetch_url (existing)
│   ├── tool: search_web (existing)
│   └── tool: search_knowledge_base (NEW)
│       - queries Postgres + pgvector
│       - applies Entra ID ACL filter
│       - RRF hybrid BM25 + vector scoring
│
├── Knowledge Index (NEW)
│   ├── PostgreSQL + pgvector (document chunks + ACL)
│   ├── BullMQ (job queues: doc-fetch, doc-process, perm-sync)
│   └── Redis (queue broker + group membership cache)
│
├── Connectors (NEW, Phase 2 scope)
│   ├── SharePoint (checkpointed, cert auth, ACL sync via Graph API)
│   └── Confluence (poll, API token or OAuth, ACL sync via Confluence API)
│
└── Entra ID Group Resolver (NEW)
    - caches user's transitiveMemberOf (TTL: 1 hour)
    - used by both ACL sync and query-time filter
```

### 17.2 What NOT to Build (Borrow from Onyx Instead)

Onyx is open source and well-maintained. Do not rebuild:
- The connector framework from scratch — study `backend/onyx/connectors/` and port the pattern to TypeScript
- The deep research orchestrator — run Onyx as a backend service and expose it via our MCP server
- The full web UI — Onyx's UI is mature; focus our energy on the MCP interface

### 17.3 Prioritised Build Order

1. PostgreSQL schema (document_chunks + connector_sync_state + user_group_memberships)
2. Generic connector base class in TypeScript (CheckpointedConnector interface)
3. SharePoint connector (highest priority for Vodacom)
4. Entra ID group resolver + ACL cache
5. Hybrid search (RRF over pgvector + tsvector)
6. `search_knowledge_base` MCP tool with ACL enforcement
7. Confluence connector
8. Perm-sync background jobs (BullMQ)
9. Contextual chunk augmentation during indexing

### 17.4 Operational Guidance

- **Minimum viable hardware for Phase 2 (SharePoint + Confluence, small team):** 4 vCPU, 8 GB RAM, 100 GB SSD. Use external embedding API (no local GPU needed).
- **Docker Compose for self-hosting:** 4 containers: app (Node.js MCP server), postgres, redis, bullmq-worker. Single `docker-compose.yml`.
- **Security:** Never store SharePoint certificates or Confluence API tokens in env vars in production. Use a secrets manager (Azure Key Vault, AWS Secrets Manager, or Doppler).

---

## Sources

- Onyx official documentation: https://docs.onyx.app
- Onyx MCP server documentation: https://docs.onyx.app/deployment/configuration/mcp_server
- Onyx connectors overview: https://docs.onyx.app/admins/connectors/overview
- Onyx access controls: https://docs.onyx.app/security/architecture/access_controls
- Onyx system architecture: https://docs.onyx.app/security/architecture/system_description
- DeepWiki — Onyx data sources and connectors: https://deepwiki.com/onyx-dot-app/onyx/3-data-sources-and-connectors
- DeepWiki — Onyx connector framework: https://deepwiki.com/onyx-dot-app/onyx/3.1-connector-framework-overview
- DeepWiki — Onyx supported data sources: https://deepwiki.com/onyx-dot-app/onyx/3.4-supported-data-sources
- DeepWiki — Onyx chat and conversation system: https://deepwiki.com/onyx-dot-app/onyx/4-chat-and-conversation-system
- DeepWiki — Onyx LLM provider management: https://deepwiki.com/onyx-dot-app/onyx/5-llm-provider-management
- DeepWiki — Onyx background processing: https://deepwiki.com/onyx-dot-app/onyx/6-background-processing-and-coordination
- DeepWiki — Onyx enterprise edition: https://deepwiki.com/onyx-dot-app/onyx/9.1-enterprise-edition-features
- DeepWiki — Onyx authentication methods: https://deepwiki.com/onyx-dot-app/onyx/8.1-authentication-methods
- DuckDuckGo search results for: Onyx Danswer connectors, Onyx MCP server, Onyx ACL permissions, Onyx hybrid search
