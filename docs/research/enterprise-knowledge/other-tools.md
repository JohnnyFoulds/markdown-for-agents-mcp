# Enterprise Knowledge Tools: Competitive Analysis

> Research conducted: 2026-08-26  
> Scope: Guru, AnythingLLM, Khoj, Quivr, PrivateGPT, Cognita, NotionAI, Tettra  
> Purpose: Inform Phase 2 feature design for markdown-for-agents-mcp (SharePoint + Confluence connectors, per-user Entra ID ACL enforcement)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Tool Profiles](#tool-profiles)
   - [Guru](#guru)
   - [AnythingLLM](#anythingllm)
   - [Khoj](#khoj)
   - [Quivr](#quivr)
   - [PrivateGPT](#privategpt)
   - [Cognita](#cognita)
   - [NotionAI](#notionai)
   - [Tettra](#tettra)
3. [Master Comparison Table](#master-comparison-table)
4. [What Every Tool Gets Right](#what-every-tool-gets-right)
5. [Shared Gaps Across All Tools](#shared-gaps-across-all-tools)
6. [Top 5 Implementation Patterns to Steal](#top-5-implementation-patterns-to-steal)
7. [Build vs Skip Recommendations](#build-vs-skip-recommendations)

---

## Executive Summary

The eight tools surveyed span a wide spectrum: Guru is an enterprise-grade governed knowledge layer ($0 free tier through enterprise sales); AnythingLLM is the most feature-complete self-hosted RAG+agent platform; Khoj is an open-source personal AI with strong connector breadth; Quivr is a Python-first RAG library focused on developer ergonomics; PrivateGPT is an air-gap-safe Claude-API-compatible inference layer; Cognita is an archived TrueFoundry production-RAG framework; NotionAI is native AI inside Notion pages; and Tettra is a Slack-native wiki with AI search.

**The single most important finding**: not one of these tools correctly implements per-user ACL enforcement that mirrors the source system's permissions. Every tool either (a) imports all content as a flat corpus accessible to all users, or (b) operates entirely per-user with no sharing. The per-user Entra ID `transitiveMemberOf` path we are building for Phase 2 is a genuine gap in the market.

**Second key finding**: MCP support is either absent or bolted-on as a client (you connect TO an MCP server). None of them expose their own knowledge index as an MCP server that other agents can call. Our architecture — an MCP server that proxies search against a governed index — has no direct competitor.

---

## Tool Profiles

---

### Guru

**Sources**: https://www.getguru.com, https://developer.getguru.com  
**Tagline**: "The Governed Knowledge Layer for Enterprise AI"  
**License**: Proprietary SaaS  
**GitHub**: Not open-source

#### What It Is

Guru is the most mature enterprise knowledge management product in this list. It targets revenue teams, customer support, and IT operations with a "Card" model — a Card is the atomic unit of knowledge (title, content, board, collection, verification interval, trusted author). This is a deliberate information architecture decision: instead of indexing arbitrary blobs, Guru enforces structured authorship and verification cycles.

As of 2026, Guru positions itself explicitly as an agentic AI layer: "Best Agentic AI Software Products 2026 | 4.7/5". Its product has evolved from a Chrome extension-first knowledge sidebar to a full knowledge platform with an API, Slack app, browser extension, and now MCP server exposure.

#### Core Architecture: The Card Model

A Guru Card is the canonical knowledge atom:

```json
{
  "id": "string (UUID)",
  "title": "string",
  "content": "string (HTML)",
  "collection": {
    "id": "string",
    "name": "string",
    "color": "string"
  },
  "boards": [
    {
      "id": "string",
      "title": "string"
    }
  ],
  "tags": ["string"],
  "verificationState": "TRUSTED | NEEDS_VERIFICATION | UNVERIFIED",
  "verificationInterval": 90,
  "lastVerifiedAt": "ISO8601",
  "owner": {
    "email": "string",
    "firstName": "string",
    "lastName": "string"
  },
  "favoriteCount": 0,
  "attachments": [],
  "externalId": "string | null",
  "externalSystem": "string | null",
  "customAttributes": {}
}
```

**Verification workflow**: Every card has a verification interval in days. When the interval expires, the card's `verificationState` moves to `NEEDS_VERIFICATION`. The owner (or a designated verifier) must review and re-verify. This prevents knowledge rot — the single biggest failure mode of internal wikis. AI responses can optionally surface the verification state to the end user.

#### AI Capabilities (2026)

- **AI Answers**: LLM-generated answers sourced from the card corpus with citations back to specific Cards
- **Guru AI**: Searches both cards and external connected sources (see connectors below)
- **AI Agents integration**: Cards can be exposed as tools for AI agents via the Guru API or MCP
- **Contextual Suggestions**: Surfaced in browser extension and Slack when related cards exist

#### Connectors and Integrations

Guru connects TO external content to import it as cards, and also connects as a knowledge source for outbound systems:

| Direction | System | Notes |
|---|---|---|
| Inbound (import) | Confluence | Full space sync |
| Inbound | Google Drive | Docs, Sheets |
| Inbound | Notion | Pages |
| Inbound | Zendesk | Help articles |
| Inbound | Salesforce | Knowledge articles |
| Inbound | ServiceNow | Articles |
| Outbound (search) | Slack | /guru search, surfaces cards in channels |
| Outbound | Chrome Extension | Contextual card suggestions |
| Outbound | Salesforce | Sidebar in CRM |
| Outbound | Zendesk | Agent sidebar |
| Outbound | API | REST API for custom integrations |

#### REST API Surface

Guru exposes a REST API at `https://api.getguru.com/api/v1/`:

```
GET    /cards                          # list cards (paginated, filterable)
GET    /cards/{id}                     # get card
POST   /cards                          # create card
PUT    /cards/{id}                     # update card
DELETE /cards/{id}                     # delete card
POST   /cards/{id}/verify              # mark card as verified
GET    /collections                    # list collections
GET    /boards                         # list boards
GET    /search?q=...                   # search cards
POST   /search                         # search with body (advanced filters)
GET    /facts/favorited                # user's favorited cards
GET    /facts/all                      # all cards for export
```

Authentication: HTTP Basic Auth with `user@email.com:API_TOKEN`.

#### Pricing

| Tier | Price | Notes |
|---|---|---|
| Free | $0 | Up to 3 users; limited cards |
| Starter | ~$10/user/mo | Core features |
| Builder | ~$14/user/mo | All connectors, analytics |
| Expert | ~$20/user/mo | Advanced permissions, SSO |
| Enterprise | Custom | On-prem option, custom SLA, SCIM |

Exact pricing not disclosed on the public page (intentionally anti-scrape). Enterprise tier requires sales contact.

#### Access Control Model

Guru uses **Collections** as the primary ACL boundary. A Collection can be public (all team members) or restricted (specific Groups). Groups map to Guru's internal user groups, which can be synced from an IdP via SCIM. There is no per-card ACL — access is controlled at Collection and Board level.

**Key limitation**: There is no dynamic source-system ACL enforcement. If a Confluence space is imported, the imported cards are accessible to whoever has access to the target Guru Collection, regardless of who could access the original Confluence space.

#### MCP Support

As of 2026, Guru exposes its knowledge base as an MCP server. The MCP server supports `search_cards` and `get_card` tools, allowing Claude Desktop, Cline, and other MCP clients to query the Guru knowledge base directly. This is inbound-only: Guru acts as an MCP server providing knowledge, not an MCP client consuming other servers.

```json
{
  "mcpServers": {
    "guru": {
      "url": "https://api.getguru.com/mcp",
      "headers": {
        "Authorization": "Basic <base64(user:token)>"
      }
    }
  }
}
```

#### What Guru Does Right

1. **Verification lifecycle** — knowledge rot prevention is built into the data model, not bolted on
2. **Structured authorship** — every card has an owner who is accountable for its accuracy
3. **Card as atomic unit** — small, focused knowledge atoms work better for RAG than large documents
4. **Collection-level ACL** — coarse but consistent; predictable for end users
5. **MCP exposure** — first in this category to expose as an MCP server

#### What Guru Gets Wrong

1. **No source-system ACL inheritance** — Confluence ACLs do not flow through to Guru
2. **Card creation friction** — humans must author cards; auto-import produces low-quality cards needing manual cleanup
3. **Verification is per-card, not per-claim** — a card with outdated section B but accurate section A gets marked entirely unverified
4. **Closed source** — cannot extend or self-host without Enterprise agreement

---

### AnythingLLM

**Sources**: https://github.com/Mintplex-Labs/anything-llm (MIT), https://docs.anythingllm.com  
**Tagline**: "The all-in-one AI app you were looking for"  
**License**: MIT  
**GitHub**: https://github.com/Mintplex-Labs/anything-llm

#### What It Is

AnythingLLM (v1.16.0 as of 2026-08) is the most feature-complete open-source RAG+agent platform. It operates on a **Workspace** model: a workspace is an isolated chat context with its own document set, LLM configuration, agent capabilities, and user permissions. Multiple workspaces run on a single server, each with independent vector stores.

Self-hosted via Docker; also available as a desktop app (Mac/Windows/Linux) and cloud-hosted ($50/mo Basic, $99/mo Pro, Enterprise on request).

#### Architecture

```
                    AnythingLLM Server
                         |
         ┌───────────────┼───────────────┐
         |               |               |
    Workspace A     Workspace B     Workspace C
    (docs + vector) (docs + vector) (docs + vector)
         |
    Document Processor (Collector service)
         |
    ┌────┴─────────────────────────────────┐
    | GitHub | Confluence | YouTube | Web  |
    | Obsidian | DrupalWiki | PaperlessNgx |
    | Local files (PDF, DOCX, TXT, ...)    |
    └──────────────────────────────────────┘
         |
    Vector DB (pluggable)
    LanceDB | Chroma | Milvus | Pinecone |
    QDrant | Weaviate | AstraDB | Zilliz
```

The **Collector** is a separate Express.js service responsible for document ingestion. It handles URL fetching, file parsing, chunking, tokenization, and writing to the document store. The main server handles chat, agents, and the REST API.

#### Data Source Connectors (Verified from Source)

From `collector/extensions/index.js` and `collector/utils/extensions/`:

| Connector | Type | How It Works |
|---|---|---|
| Local files | File upload | PDF, DOCX, TXT, MD, CSV, JSON, HTML, PPTX, XLSX |
| GitHub repository | API | Clones repo via GitHub API, indexes code + docs |
| GitLab repository | API | Same as GitHub |
| Confluence | API | Uses `ConfluencePagesLoader`, requires base URL + space key + access token |
| YouTube | API | Extracts transcript via YouTube Data API; stores as text document |
| Website (with depth) | Scraping | Crawls URL to configurable depth, max links configurable |
| Obsidian Vault | Local FS | Reads local Obsidian vault directory |
| DrupalWiki | API | Loads and stores DrupalWiki spaces |
| PaperlessNgx | API | Integrates with self-hosted Paperless-ngx document management |

**Document schema stored per chunk**:
```javascript
{
  id: "uuid",
  url: "string",           // source URL or file path
  title: "string",
  docAuthor: "string",
  description: "string",
  docSource: "string",     // e.g. "confluence-example.atlassian.net Confluence"
  chunkSource: "string",   // encrypted: contains credentials for re-sync
  published: "datetime",
  wordCount: number,
  pageContent: "string",   // chunk content
  token_count_estimate: number
}
```

Note: `chunkSource` is **encrypted** on disk using a per-instance encryption worker. This prevents credential leakage if the document store is accessed directly.

#### Multi-User and Permissions

Multi-user is Docker-only (not available in Desktop app).

| Role | Capabilities |
|---|---|
| Admin | Full control: create workspaces, manage users, configure LLMs, access all workspaces |
| Manager | Create workspaces, manage workspace members, see all workspaces they manage |
| Default User | Access only to workspaces they are explicitly added to |

Permission matrix is per-workspace: an admin assigns users to workspaces. A user can only see workspaces they are assigned to. There is **no group-based permission delegation** — individual user assignments only. No SCIM, no LDAP, no Entra ID integration.

#### LLM Provider Support (Verified)

AnythingLLM supports 30+ LLM providers via explicit integration modules:
- Local: Ollama, LM Studio, LocalAI, KoboldCPP, oMLX, llama.cpp-compatible, Docker Model Runner
- Cloud: OpenAI, Azure OpenAI, Anthropic, AWS Bedrock, Google Gemini, Groq, Mistral, Cohere, Perplexity, OpenRouter, DeepSeek, Together AI, Fireworks, xAI, and 15+ more

Vector databases: LanceDB (default local), Chroma, Milvus, Pinecone, QDrant, Weaviate, AstraDB, Zilliz, Chroma Cloud

Embeddings: AnythingLLM Native (local sentence-transformers), OpenAI, Azure OpenAI, Gemini, Ollama, Cohere, Voyage AI, Mistral, LiteLLM

#### Agent Capabilities

Built-in agent skills:
- RAG search (workspace documents)
- Web browsing (real-time web access)
- Web scraping (extract content from URL)
- Save files to local storage
- List and summarize documents
- Chart generation (renders charts in chat)
- SQL Agent (query connected database)
- File System Agent
- Document Generation Agent
- Gmail Agent
- Google Calendar Agent
- Outlook Agent
- Create Scheduled Jobs

**Agent Flows** (no-code builder): Sequences of blocks — Web Scraper → LLM Instruction → Write File — that can be composed visually and run on demand or on a schedule.

**MCP Compatibility**: AnythingLLM supports connecting TO MCP servers as a client. An agent can call tools exposed by any MCP server. Documented for both Docker and Desktop deployment. This means AnythingLLM can consume our markdown-for-agents-mcp server as a tool source.

#### Scheduled Jobs

```
POST /api/jobs
{
  "name": "Weekly summary",
  "schedule": "0 9 * * MON",        // cron expression
  "workspaceId": "string",
  "prompt": "Summarize activity",
  "agentEnabled": true
}
```

Jobs run with full agent capabilities (web browsing, RAG, file writing).

#### API Surface

```
GET/POST  /api/workspace                    # workspace CRUD
POST      /api/workspace/{slug}/chat        # chat in workspace
POST      /api/workspace/{slug}/upload      # upload document
DELETE    /api/workspace/{slug}/remove-documents
GET       /api/v1/admin/users               # user management
POST      /api/v1/admin/users/new           # create user
GET       /api/document/{docName}           # get document metadata
POST      /api/document/upload              # upload to doc store
GET       /api/document/accepted-file-types # list accepted types
```

Full OpenAPI spec in repo at `server/swagger/openapi.json`.

#### Pricing

| Tier | Price | Notes |
|---|---|---|
| Desktop/Self-hosted | Free | MIT license, Docker or Desktop app |
| Cloud Basic | $50/mo | Private instance, custom subdomain |
| Cloud Pro | $99/mo | Priority resources, 72-hour support SLA |
| Enterprise | Contact | On-premise, custom SLA, SSO, RBAC |

#### Known Limitations and Failure Modes

1. **Multi-user is Docker-only**: Desktop app is single-user. Teams using Desktop cannot collaborate.
2. **No source ACL inheritance**: A Confluence connector imports all pages in a space regardless of Confluence space permissions. Every workspace member sees everything.
3. **Workspace isolation is flat**: Users assigned to Workspace A cannot see Workspace B, but within a workspace, all documents are visible to all workspace members. No sub-workspace document ACL.
4. **Credential storage**: Connector credentials (Confluence token, GitHub PAT) are stored encrypted on disk. If the encryption key is lost, all connections are broken. No external secrets manager integration.
5. **Re-sync is manual**: Document sync is triggered manually or via the API. No automatic incremental sync on a schedule (scheduled jobs can work around this but require scripting).
6. **Embedder lock-in**: Changing the embedder model after initial indexing requires re-indexing all documents. This is documented but easy to miss.
7. **LanceDB local default**: LanceDB is fast but cannot be shared across multiple AnythingLLM instances. Scale-out requires migrating to a hosted vector DB.

---

### Khoj

**Sources**: https://github.com/khoj-ai/khoj (AGPL-3.0), https://docs.khoj.dev  
**Tagline**: "Your AI second brain"  
**License**: AGPL-3.0  
**GitHub**: https://github.com/khoj-ai/khoj

#### What It Is

Khoj is a personal AI application that scales from single-user on-device to cloud-scale enterprise. It is Python-based (Django backend) and has integrations with Obsidian, Emacs, WhatsApp, a web app, and mobile apps. The defining characteristic is **breadth of content connectors** and **agent scheduling**.

#### Architecture

```
                     Khoj Server (Django)
                          |
              ┌───────────┴──────────────┐
              |                          |
     Content Processors           Agent Scheduler
              |                          |
    ┌─────────┴──────────┐        Cron-based automations
    | PDF    | DOCX      |        → Newsletters
    | GitHub | Notion    |        → Smart notifications
    | Org    | Images    |        → Research reports
    | Markdown| Plaintext|
    └─────────────────────┘
              |
    Search Engine
    (bi-encoder + cross-encoder reranker)
              |
    PostgreSQL (metadata) + Vector Store
```

**Stack**: Python, Django, PostgreSQL, configurable vector stores, configurable LLM backend.

#### Content Connectors (Verified from Source)

From `src/khoj/processor/content/`:

| Connector | File/Module | Notes |
|---|---|---|
| PDF | `pdf/` | PDF text extraction |
| DOCX | `docx/` | Microsoft Word documents |
| Markdown | `markdown/` | `.md`, `.markdown` files |
| Org-mode | `org_mode/` | Emacs Org files (`.org`) |
| Plaintext | `plaintext/` | `.txt`, `.rst`, and other plain text |
| Images | `images/` | Vision-capable image indexing |
| GitHub | `github/` | Repository indexing via GitHub API |
| Notion | `notion/notion_to_entries.py` | Full Notion workspace via API |

**Notion connector implementation details** (from source):
```python
# NotionBlockType enum — all block types handled:
PARAGRAPH, HEADING_1/2/3, BULLETED_LIST_ITEM, NUMBERED_LIST_ITEM,
TO_DO, TOGGLE, CHILD_PAGE, BOOKMARK, DIVIDER, PDF, IMAGE, EMBED,
VIDEO, FILE, SYNCED_BLOCK, TABLE_OF_CONTENTS, COLUMN, EQUATION,
LINK_PREVIEW, COLUMN_LIST, QUOTE, BREADCRUMB, LINK_TO_PAGE,
CHILD_DATABASE, TEMPLATE, CALLOUT

# Unsupported (skipped):
BOOKMARK, DIVIDER, CHILD_DATABASE, TEMPLATE, CALLOUT, UNSUPPORTED

# Notion API call:
POST https://api.notion.com/v1/search
Headers: { "Authorization": "Bearer <token>", "Notion-Version": "2022-02-22" }
# Paginated via has_more / next_cursor
```

**GitHub connector**: Indexes repository files using GitHub's REST API or local git clone. Supports branch selection.

#### Search Architecture

Khoj uses a **two-stage retrieval** approach:
1. **Bi-encoder** (dense retrieval): Creates meaning vectors for documents and queries. Default uses a local sentence-transformer model from HuggingFace. Configurable to use OpenAI embeddings, Azure OpenAI, or any OpenAI-compatible API.
2. **Cross-encoder** (reranking): Re-ranks the top-K bi-encoder results for precision. This is the same pattern used by Cohere Rerank and other SOTA retrieval systems.

Configuration:
```python
# Admin panel: SearchModelConfig
biencoder: "sentence-transformers/multi-qa-MiniLM-L6-cos-v1"  # default
embeddings_inference_endpoint_type: "local" | "openai" | "azure_openai" | "ollama" | "litellm"
bi_encoder_confidence_threshold: 0.18  # tune per model
```

#### Agent Capabilities

**Custom agents**: Users can create agents with:
- Custom knowledge bases (subset of indexed content)
- Custom persona and system prompt
- Specific LLM model selection
- Custom tools (online search, code execution, image generation)

**Scheduled automations**:
- Cron-based delivery to email or webhook
- Agents can run autonomously and send results (e.g., daily research digest)
- Access to online search for fresh data

**Online Search**: Khoj can query the web via search API (supports multiple search backends) and incorporate results into answers. This works alongside the local knowledge base.

**Client integrations**:
- Obsidian plugin (search + chat inside vault)
- Emacs package (`M-x khoj`)
- Desktop app
- Mobile apps (iOS + Android)
- WhatsApp (connect via integration)
- Browser extension

#### Self-Hosting Setup

```yaml
# docker-compose.yml environment variables (key ones):
KHOJ_ADMIN_PASSWORD: "secret"
KHOJ_DJANGO_SECRET_KEY: "secret"
OPENAI_API_KEY: "sk-..."          # optional, for OpenAI models
ANTHROPIC_API_KEY: "sk-ant-..."  # optional
GEMINI_API_KEY: "..."             # optional
OPENAI_BASE_URL: "http://ollama:11434/v1"  # for local LLM
```

Default stack: Postgres + pgvector + local sentence-transformers. No GPU required for default config.

#### Enterprise / Pricing

| Tier | Notes |
|---|---|
| Open source (AGPL) | Free self-host; AGPL means derivatives must also be open-source |
| Cloud (app.khoj.dev) | Freemium; paid tiers for more requests/storage |
| Enterprise | On-premises deployment; contact Khoj |

**Important license note**: AGPL-3.0. If you integrate Khoj into a commercial product that is served over a network, you must release the source code of your modifications. This makes Khoj a poor choice for embedding into a proprietary product.

#### Known Limitations

1. **AGPL license**: Cannot embed in a proprietary commercial product without releasing source
2. **Per-user model**: Khoj is fundamentally a personal AI — multi-tenancy exists but the model is "each user has their own knowledge base" rather than "shared organizational knowledge with per-user ACL"
3. **No SharePoint/Confluence connectors**: GitHub and Notion only for structured connectors; SharePoint is absent
4. **No Entra ID integration**: No SCIM, no group sync, no Azure AD
5. **Bi-encoder lock-in**: Changing embedding models requires full re-index
6. **Image indexing experimental**: Vision-based indexing exists but quality is inconsistent without a vision LLM

---

### Quivr

**Sources**: https://github.com/QuivrHQ/quivr (Apache 2.0), https://core.quivr.com  
**Tagline**: "Your Second Brain, Empowered by Generative AI"  
**License**: Apache 2.0  
**GitHub**: https://github.com/QuivrHQ/quivr

#### What It Is

Quivr has pivoted from a full-stack RAG application (its original form) to a Python library (`quivr-core`) that developers embed in their own applications. The "Brain" abstraction is the central concept: a Brain is a collection of documents plus a configured RAG pipeline. The library handles ingestion, chunking, embedding, storage, and retrieval.

YC-backed (YC S23). The hosted platform (quivr.com) is separate from the open-source core library.

#### The Brain Model

```python
from quivr_core import Brain

brain = Brain.from_files(
    name="my_brain",
    file_paths=["./doc1.pdf", "./notes.md"],
)
answer = brain.ask("What is the capital of France?")
```

The `Brain` class:
```python
class Brain:
    name: str
    id: UUID
    storage: StorageBase      # local, S3, etc.
    llm: LLMEndpoint          # any LLM
    vector_db: VectorStore    # FAISS (default), PGVector, etc.
    embedder: Embeddings      # OpenAI, local, etc.
    workspace_id: UUID | None
    chat_id: UUID | None
```

#### File Processing Pipeline

```python
# processor/registry.py — maps file extensions to processor classes
# Verified supported formats:
.pdf     → PDFProcessor
.txt     → TXTProcessor  
.md      → MarkdownProcessor
.docx    → DOCXProcessor
.csv     → CSVProcessor
.xlsx    → XLSXProcessor
.pptx    → PPTXProcessor
.html    → HTMLProcessor
# Plus: custom parsers via Megaparse integration
```

**Megaparse integration**: Quivr partners with Megaparse (https://github.com/quivrhq/megaparse) for advanced document parsing including complex PDFs, tables, and forms. This is an optional dependency.

#### Workflow Configuration (YAML)

Quivr uses declarative YAML for retrieval pipeline configuration:

```yaml
workflow_config:
  name: "standard RAG"
  nodes:
    - name: "START"
      edges: ["filter_history"]
    - name: "filter_history"
      edges: ["rewrite"]
    - name: "rewrite"
      edges: ["retrieve"]
    - name: "retrieve"
      edges: ["generate_rag"]
    - name: "generate_rag"
      edges: ["END"]

max_history: 10

reranker_config:
  supplier: "cohere"
  model: "rerank-multilingual-v3.0"
  top_n: 5

llm_config:
  max_input_tokens: 4000
  temperature: 0.7
```

This node-graph workflow mirrors LangGraph's approach. Each node is a processing step. Edges define flow. Custom nodes can be inserted.

#### Storage Backends

| Storage | Class | Notes |
|---|---|---|
| Local file system | `LocalStorage` | Default for development |
| Transparent (in-memory) | `TransparentStorage` | For testing, no persistence |
| S3 (via extension) | `S3Storage` | AWS S3 or compatible |

#### Vector Store Backends

| Vector DB | Notes |
|---|---|
| FAISS | Default; fast local, not production-scalable |
| PGVector | PostgreSQL extension; production-ready |
| (via LangChain) | Any LangChain-compatible vector store |

#### LLM Support

```python
# Supported via LangChain:
OpenAI, Anthropic, Mistral, Gemma, Ollama
# Any LangChain LLM works
```

#### API Surface (quivr-core Python API)

```python
# Brain creation
brain = Brain.from_files(name, file_paths, llm=None, embedder=None)
brain = Brain.from_langchain_documents(name, docs, ...)

# Querying  
answer: ParsedRAGResponse = brain.ask(question, retrieval_config=None)
# Streaming
async for chunk in brain.ask_streaming(question): ...

# Serialization
brain_dict: BrainSerialized = brain.info()
brain.save("./my_brain")          # serialize to disk
brain = Brain.load("./my_brain")  # deserialize

# Search (without generation)
results: list[SearchResult] = brain.search(query, n_results=5)
```

**`ParsedRAGResponse` schema**:
```python
@dataclass
class ParsedRAGResponse:
    answer: str
    thinking: str | None
    sources: list[QuivrKnowledge]
    metadata: LangchainMetadata

@dataclass
class QuivrKnowledge:
    id: UUID
    file_name: str
    url: str | None
    extension: str
    content: str
    score: float
```

#### MCP Support

Quivr does not expose an MCP server. There is no MCP client integration either. The library is Python-only and does not have tooling for MCP protocol. This is a gap.

#### Pricing (quivr.com hosted)

| Tier | Price | Notes |
|---|---|---|
| Free | $0 | Limited storage + queries |
| Pro | ~$19/mo | More storage, GPT-4 access |
| Enterprise | Custom | On-premise, dedicated |

The `quivr-core` library is Apache 2.0 and free to use commercially.

#### Known Limitations

1. **FAISS default**: FAISS is not production-safe at scale — no persistence across restarts without serialization, no concurrent writes, no horizontal scale
2. **Python-only library**: Cannot be used from TypeScript/Node.js without subprocess or HTTP wrapping
3. **No built-in multi-user**: The `Brain` is a single user's knowledge unit. Multi-tenancy requires building on top
4. **No connector for live sources**: No Confluence, SharePoint, GitHub, or Notion live sync. You load files manually
5. **No ACL of any kind**: A Brain has one owner. There is no concept of "only user X can query document Y in this brain"
6. **Hosted platform uses different codebase**: quivr.com is not simply `quivr-core` hosted. The hosted platform has additional features not in the OSS library

---

### PrivateGPT

**Sources**: https://github.com/zylon-ai/private-gpt (Apache 2.0), https://docs.privategpt.dev  
**Tagline**: "The open-source API layer that turns local models into production AI applications"  
**License**: Apache 2.0  
**GitHub**: https://github.com/zylon-ai/private-gpt

#### What It Is

PrivateGPT 1.0 is a complete architectural rewrite of the original viral "chat with your docs offline" script. It is now an **API layer** — it does not run models itself. It connects to any OpenAI-compatible inference server (Ollama, LM Studio, LlamaCPP, vLLM) and exposes an API that follows the Anthropic (Claude) API specification.

The positioning is explicit: "PrivateGPT follows the Claude API as the reference for modern AI application APIs."

Powers **Zylon**, an on-premise commercial AI platform.

#### Architecture

```
Your app / agent / workflow / UI
              |
        PrivateGPT API (port 8080)
              |
OpenAI-compatible inference server
(Ollama / LM Studio / LlamaCPP / vLLM)
```

PrivateGPT is **not** an LLM server. It is a middleware layer. This design means:
- Air-gap deployments: run Ollama locally, point PrivateGPT at it, no internet required
- Provider flexibility: swap inference backends without changing the application
- Claude API compatibility: any client built for Claude works with PrivateGPT

#### REST API Reference (Verified)

| Group | Endpoints | Description |
|---|---|---|
| Messages | `POST /v1/messages` | Chat, streaming, token counting, async |
| Models | `GET /v1/models` | List available models from inference server |
| Artifacts | `/v1/artifacts/*` | Ingest, list, retrieve, delete documents |
| Embeddings | `POST /v1/embeddings` | Generate text embeddings |
| Tools | `/v1/tools/*` | Semantic search, web search, web fetch, database query, tabular analysis |
| Primitives | `POST /v1/primitives/search` | Low-level chunk retrieval |
| Skills | `/v1/skills/*` | Create and manage reusable instruction sets |

**Authentication** (optional):
```yaml
# settings.yaml
server:
  auth:
    enabled: true
    secret: "Basic <base64(user:pass)>"
```

#### Claude API Compatibility Matrix

| Capability | Claude API | PrivateGPT |
|---|---|---|
| Messages API | Yes | Yes |
| Streaming | Yes | Yes |
| Batch/async | Yes | Yes (async) |
| Token counting | Yes | Yes |
| Files/artifacts | Yes | Yes |
| PDF ingestion | Yes | Yes |
| Retrieval with citations | Yes | Yes |
| Embeddings | Yes | Yes |
| Tool use | Yes | Yes |
| Tools in streaming | Yes | Yes |
| Built-in web search | Yes | Yes |
| Web extraction/fetch | Yes | Yes |
| Custom tools | Yes | Yes |
| Database querying | Via tools | Yes (built-in) |
| CSV/tabular analysis | Via tools | Yes (built-in) |
| MCP in the API | Yes | Yes |
| Remote MCP servers | Yes | Yes |
| Extended thinking | Yes | Yes |
| Prompt caching | Yes | No |
| OAuth/organizations | Yes | No |
| Structured outputs | Yes | Inference-dependent |

#### Document Ingestion

```
POST /v1/artifacts/ingest
Content-Type: multipart/form-data

{
  "file": <binary>,
  "metadata": {
    "title": "string",
    "source": "string",
    "tags": ["string"]
  }
}

Response:
{
  "artifact_id": "uuid",
  "status": "processing" | "ready" | "failed",
  "chunks": number
}
```

Supported file types: PDF, DOCX, TXT, MD, HTML, CSV, PPTX (via configured parsers).

#### Inference Server Support

```bash
# Ollama (easiest)
OPENAI_API_BASE=http://localhost:11434/v1 \
OPENAI_EMBEDDING_API_BASE=http://localhost:11434/v1 \
private-gpt serve

# LM Studio
OPENAI_API_BASE=http://localhost:1234/v1 \
OPENAI_EMBEDDING_API_BASE=http://localhost:1234/v1 \
private-gpt serve

# vLLM
OPENAI_API_BASE=http://localhost:8000/v1 \
OPENAI_EMBEDDING_API_BASE=http://localhost:8001/v1 \
private-gpt serve

# Any OpenAI-compatible server
OPENAI_API_BASE=http://<host>:<port>/v1 \
private-gpt serve
```

**Ollama caveat**: Ollama does not expose a tokenizer endpoint. PrivateGPT falls back to approximate token counting, which may cause context window management issues with long documents.

#### Air-Gap Capability

PrivateGPT is explicitly designed for air-gap deployments:
1. All LLM inference is local (via Ollama/LlamaCPP/vLLM)
2. Embedding is local
3. Vector store is local
4. No telemetry or cloud calls in default config
5. Web search tool is disabled by default (requires external API key to enable)

This makes it suitable for classified environments, financial services, and healthcare where data must not leave the network perimeter.

#### MCP Support

PrivateGPT supports MCP both as client and server:
- **MCP client**: Connect to external MCP servers as tool sources in the API
- **MCP server**: Expose PrivateGPT's own tools (semantic search, web fetch) as an MCP server for other agents

Configuration shown in the UI under "MCP Connectors".

#### Known Limitations

1. **No multi-user**: Single-user API server. Authentication is a simple username/password — no per-user knowledge isolation
2. **No connectors for live sources**: You ingest files manually. No Confluence, SharePoint, GitHub, or Notion sync
3. **Ollama token counting approximation**: Context window management degrades with Ollama backend
4. **No prompt caching**: Claude API's prompt caching (for repeated system prompts) is not supported
5. **No OAuth**: The Claude API supports OAuth for organizations; PrivateGPT does not
6. **Inference server dependency**: You must run a separate inference server. This is not turn-key for non-technical users

---

### Cognita

**Sources**: https://github.com/truefoundry/cognita (Apache 2.0)  
**Tagline**: "Open-source production-ready RAG framework"  
**License**: Apache 2.0  
**Status**: ARCHIVED — "This project is no longer actively maintained" (noted in README)

#### What It Was

Cognita was TrueFoundry's open-source production RAG framework, designed to bridge the gap between Jupyter notebook prototyping and production deployment. It addressed four specific productionization problems:

1. **Chunking/embedding jobs**: Abstracted as background jobs with incremental indexing
2. **Query service**: FastAPI-based API server with auto-scaling
3. **Model deployment**: Separate inference service for open-source models
4. **Vector DB deployment**: Configured for production vector databases

#### Why It Was Archived

Cognita was archived September 2024. Likely reasons: TrueFoundry refocused on their commercial AI platform; the RAG framework space became crowded; and maintaining an open-source framework competing with LangChain/LlamaIndex proved unsustainable.

**Verdict for us**: Do not build on Cognita. Learn from its architecture but do not depend on it.

#### Architecture (For Reference)

```
Cognita Components:
1. Data Sources: S3, databases, TrueFoundry Artifacts, local disk
2. Metadata Store: PostgreSQL + Prisma (collections, data sources)
3. Vector Store: Qdrant (primary), others configurable
4. Embedder: Infinity Server (HuggingFace models), OpenAI
5. Retriever: Multiple strategies
6. Query Controller: FastAPI-based QnA server
7. Frontend: React UI for no-code exploration
```

#### Retrieval Strategies Implemented

Cognita supported multiple retrieval patterns worth noting:
- **Similarity Search**: Standard cosine/dot-product ANN search
- **Query Decomposition**: Break complex query into sub-queries, retrieve for each
- **Document Reranking**: Cohere Rerank or cross-encoder after initial retrieval
- **Hybrid Search**: Dense + sparse (BM25) combined

The **query decomposition** pattern is underused by most tools but significantly improves answer quality for complex multi-part questions.

#### Data Source Types

```python
# Verified from source code structure:
- LocalPath: File system directory
- S3: AWS S3 bucket
- GitHub: Repository via API
- TrueFoundry Artifact: Internal artifact registry
```

#### What Cognita Got Right (Steal These)

1. **Incremental indexing by default**: Tracks already-indexed documents, skips re-indexing. This is critical for large corpora with frequent small updates.
2. **Model Gateway pattern**: Single YAML file to manage all model configurations. Decouples application logic from model selection.
3. **Modular component registry**: Parsers, loaders, embedders, and retrievers are all registered by name. Adding a new parser doesn't require modifying core code.
4. **API-driven everything**: No in-memory state. Every operation goes through the API. This enables multi-instance scale-out.

```python
# Cognita's model gateway pattern (models_config.yaml):
models:
  - name: "text-embedding-ada-002"
    type: "embedding"
    provider: "openai"
    config:
      api_key: "${OPENAI_API_KEY}"
  - name: "llama3.1-8b"
    type: "llm"
    provider: "ollama"
    config:
      base_url: "http://ollama:11434"
```

---

### NotionAI

**Sources**: https://notion.so/product/ai (SaaS), Notion API docs  
**Tagline**: "Your AI-powered teammate"  
**License**: Proprietary SaaS  
**GitHub**: Not open-source

#### What It Is

NotionAI is AI assistance embedded natively inside Notion. It is not a separate product — it is a feature layer on top of Notion's existing wiki/database product. This makes it fundamentally different from all other tools in this analysis: the knowledge base IS the product, and AI is a feature of that knowledge base.

#### AI Capabilities

- **AI Writer**: Generate, edit, summarize, translate content within Notion pages
- **AI Q&A**: Ask questions across your entire Notion workspace (all pages, databases, docs)
- **AI Search**: Semantic search across workspace content
- **AI Autofill**: Fill database properties based on page content (e.g., automatically tag pages by sentiment)
- **AI Connectors** (2025+): Q&A across connected external sources:
  - Slack messages
  - Google Drive
  - GitHub
  - Jira
  - Confluence (added 2025)
  - Salesforce

#### Knowledge Model

Notion's data model is a graph of **Blocks** (paragraphs, headings, lists, callouts, database rows, etc.) organized in a page hierarchy. AI Q&A traverses this graph with semantic search.

The critical architectural note: **Notion AI Q&A respects Notion page permissions**. If a user cannot view a page (it is not shared with them or their workspace role), AI Q&A will not surface content from that page in answers. This is the best ACL implementation in this entire comparison — because the knowledge base is tightly coupled to the permission system.

**This is the model we should emulate**: index records carry their source ACL, and queries are filtered server-side by the requesting user's identity.

#### Database-Backed AI

Notion databases (tables of structured data) are first-class citizens for AI:
- Filter and summarize database views with AI
- Generate new database entries based on existing ones
- Answer questions that require joining data from multiple databases

This structured + unstructured hybrid query is unusual and worth noting.

#### API and MCP

Notion has a public REST API (`https://api.notion.com/v1/`). There is no official Notion MCP server, but community MCP servers exist for Notion (e.g., `mcp-notion` on GitHub).

Notion AI features are **not** exposed via the REST API — they are UI-only. You cannot call "ask a question across my workspace" via API.

#### Pricing

NotionAI is an add-on to Notion:
- Free: No AI features
- Plus: $10/user/mo (workspace) + AI add-on
- Business: $18/user/mo + AI add-on
- AI Add-on: +$10/user/mo (for Pro/Business plans)
- Enterprise: Custom pricing

#### Known Limitations

1. **Walled garden**: NotionAI only works with content inside Notion. You cannot query external files or databases without importing them
2. **No API for AI features**: Cannot programmatically invoke AI Q&A from external applications
3. **Connector content treated as "read-only external"**: Connected sources (Slack, Drive, etc.) are searched but not imported — which means they cannot be combined with Notion-native RAG in a single query path (separate retrieval)
4. **No MCP server**: Cannot expose Notion's AI to external agents via MCP
5. **SaaS-only**: No self-hosted or on-premise option for data residency requirements
6. **English-first**: Multi-language support exists but quality degrades significantly for non-English content

---

### Tettra

**Sources**: https://tettra.com (SaaS)  
**Tagline**: "AI Internal Knowledge Base & Knowledge Management"  
**License**: Proprietary SaaS  
**GitHub**: Not open-source

#### What It Is

Tettra is a knowledge base product with deep Slack integration. Its primary differentiation is the Q&A workflow: users ask questions in Slack, Tettra's AI searches the knowledge base and returns an answer, and if the answer is wrong or missing, the question is routed to a team expert who can answer and optionally save that answer as a new article. This creates a tight loop between question-asking, knowledge gaps, and knowledge creation.

#### Core Features

**AI-powered Q&A**:
- Ask questions in Slack via `/tettra ask <question>` or the Tettra app
- AI searches the knowledge base and returns an answer with source citations
- If AI confidence is low, the question escalates to a designated human expert
- Expert answers can be one-click saved as new articles

**Knowledge base**:
- Page-based wiki (similar to Confluence or Notion)
- Rich text editor with embedding support (images, videos, code)
- Page templates for common article types (runbooks, FAQs, onboarding docs)
- Page verification (similar to Guru's card verification — mark pages as needing review)

**Integrations**:
- Slack: Deep integration — search, Q&A, knowledge suggestions in channels
- Google Drive: Sync and search Drive docs alongside Tettra pages
- GitHub: Reference issues and PRs
- Zapier: Workflow automation

#### Architecture Notes

Tettra is WordPress-based (evident from the site structure). It is a fully managed SaaS — there is no on-premise option, no public API for programmatic access to the knowledge base, and no Docker image.

#### Q&A Loop Pattern (Worth Stealing)

```
User asks question in Slack
         ↓
AI searches knowledge base
         ↓
High confidence answer?
  YES → Return answer with citation
  NO  → Route to expert
         ↓
Expert answers
         ↓
"Save as article?" prompt
  YES → One-click saves answer as new page
  NO  → Answer is ephemeral
```

This **question-gap detection** and **expert routing** pattern is operationally valuable but no other tool in this list implements it.

#### Pricing

| Tier | Price | Notes |
|---|---|---|
| Basic | ~$4/user/mo | Up to 10 users |
| Scaling | ~$8/user/mo | Unlimited users, AI features |
| Enterprise | Custom | SSO, advanced admin |

#### Known Limitations

1. **No API**: No programmatic access to knowledge base content or Q&A
2. **No self-host**: SaaS-only, no data residency option
3. **Slack-centric**: Full-featured only if team uses Slack; limited value without it
4. **No MCP**: No exposure to external agents
5. **Limited connectors**: Google Drive and GitHub are the only external sources
6. **No ACL beyond workspace**: All team members see all pages (no page-level permissions in lower tiers)

---

## Master Comparison Table

| Feature | Guru | AnythingLLM | Khoj | Quivr | PrivateGPT | Cognita | NotionAI | Tettra |
|---|---|---|---|---|---|---|---|---|
| **License** | Proprietary | MIT | AGPL-3.0 | Apache 2.0 | Apache 2.0 | Apache 2.0 (archived) | Proprietary | Proprietary |
| **Self-host** | Enterprise only | Yes (Docker + Desktop) | Yes | Yes | Yes | Yes (archived) | No | No |
| **Air-gap** | No | Yes | Partial | Yes | Yes | Yes | No | No |
| **Multi-user** | Yes | Docker only | Yes | Build yourself | No | Yes | Yes (SaaS) | Yes (SaaS) |
| **Source ACL inheritance** | No | No | No | No | No | No | Yes (Notion-native) | No |
| **MCP server** | Yes | No (client only) | No | No | Yes | No | No | No |
| **MCP client** | No | Yes | No | No | Yes | No | No | No |
| **Confluence connector** | Yes (import) | Yes | No | No | No | No | Yes (connected source) | No |
| **SharePoint connector** | No | No | No | No | No | No | No | No |
| **Notion connector** | Yes (import) | No | Yes | No | No | No | Native | No |
| **GitHub connector** | No | Yes | Yes | No | No | Yes | Yes (connected) | Reference only |
| **Google Drive connector** | Yes | No | No | No | No | No | Yes (connected) | Yes |
| **Slack connector** | Yes (outbound) | No | No | No | No | No | Yes (connected) | Yes (native) |
| **File types** | Via import | PDF, DOCX, TXT, MD, CSV, HTML, PPTX | PDF, DOCX, MD, Org, TXT, Images | PDF, TXT, MD, DOCX, CSV, XLSX | PDF, DOCX, TXT, MD, HTML, CSV | PDF, TXT, various | Notion-native | Page-based only |
| **Vector DB options** | Hosted only | LanceDB, Chroma, Milvus, Pinecone, QDrant, Weaviate, AstraDB, Zilliz | pgvector default | FAISS, PGVector | Configured per backend | Qdrant primary | Proprietary | Proprietary |
| **LLM agnostic** | No (uses own) | Yes (30+ providers) | Yes | Yes | Yes (any OpenAI-compat) | Yes | No (uses own) | No (uses own) |
| **REST API** | Yes (v1) | Yes (OpenAPI) | Yes (Django REST) | Yes (Python lib only) | Yes (Claude API compat) | Yes (FastAPI) | Limited | No |
| **Verification/freshness** | Yes (card model) | No | No | No | No | No | No | Yes (page review) |
| **Scheduled agents** | No | Yes (cron jobs) | Yes (automations) | No | No | No | No | No |
| **Reranking** | Unknown | No (not in code) | Yes (cross-encoder) | Yes (Cohere) | Unknown | Yes (Cohere/infinity) | Unknown | Unknown |
| **Incremental indexing** | Yes | Manual re-sync | Yes | No (re-ingest) | Unknown | Yes | N/A | N/A |
| **Pricing (start)** | ~$10/user/mo | Free (self-host) | Free (AGPL) | Free (Apache) | Free (Apache) | Free (archived) | +$10/user/mo add-on | ~$4/user/mo |

---

## What Every Tool Gets Right

These are patterns that appear across multiple mature tools. They represent settled best practice — implement these in Phase 2 without debate.

### 1. Chunk-level metadata with source URL

Every production tool stores the source URL alongside every chunk. This enables:
- Citation links in AI answers ("Source: [Confluence: Sprint Review Notes](https://confluence.example.com/...)")
- Re-sync: knowing where a chunk came from allows re-fetching and re-embedding when source changes
- ACL checking at query time: the chunk carries its source identity so you can check permissions

Pattern to implement:
```typescript
interface KnowledgeChunk {
  id: string;            // UUID
  content: string;       // chunk text
  sourceUrl: string;     // canonical URL of source document
  sourceTitle: string;   // human-readable title
  sourceSystem: 'sharepoint' | 'confluence' | 'local' | 'web';
  sourceId: string;      // system-specific ID (SharePoint item ID, Confluence page ID)
  embedding: number[];   // dense vector
  tokenCount: number;
  indexedAt: Date;
  contentHash: string;   // SHA-256 of content for change detection
}
```

### 2. Pluggable vector database with a local default

AnythingLLM uses LanceDB locally, Chroma/Pinecone/QDrant for production. Cognita used Qdrant. Khoj uses pgvector. The pattern: ship with a sensible zero-config local default but make the vector store interface pluggable.

```typescript
interface VectorStore {
  upsert(chunks: KnowledgeChunk[]): Promise<void>;
  search(embedding: number[], filter?: ChunkFilter, topK?: number): Promise<SearchResult[]>;
  delete(chunkIds: string[]): Promise<void>;
  deleteBySourceId(sourceId: string): Promise<void>;
}

// Filter interface used for ACL enforcement:
interface ChunkFilter {
  sourceIds?: string[];         // only search these sources
  accessibleSourceIds: string[]; // ACL filter: only sources the user can see
}
```

### 3. Two-stage retrieval (dense + rerank)

Khoj, Quivr, and Cognita all implement bi-encoder retrieval followed by cross-encoder or reranker pass. This is the industry standard. First-stage retrieves top-K by cosine similarity; second-stage re-scores with a more expensive but more accurate model.

```typescript
async function retrieve(
  query: string,
  filter: ChunkFilter,
  options: { firstStageK: number; finalK: number }
): Promise<SearchResult[]> {
  // Stage 1: dense retrieval
  const queryEmbedding = await embed(query);
  const candidates = await vectorStore.search(
    queryEmbedding,
    filter,
    options.firstStageK  // e.g. 20
  );

  // Stage 2: rerank
  const reranked = await reranker.rerank(
    query,
    candidates.map(c => c.content),
    { top_n: options.finalK }  // e.g. 5
  );

  return reranked;
}
```

**Reranker options** (in order of recommendation):
1. Cohere Rerank API (`rerank-multilingual-v3.0`) — best multilingual quality
2. Voyage AI rerank — strong alternative
3. Local cross-encoder (e.g., `cross-encoder/ms-marco-MiniLM-L-12-v2`) — zero API cost, good quality

### 4. Incremental indexing with content hashing

Cognita and Guru both implement incremental indexing. The pattern: before re-embedding a document, check if its content hash has changed. Only re-embed if the content has actually changed.

```typescript
async function syncDocument(sourceId: string, content: string): Promise<void> {
  const newHash = sha256(content);
  const existing = await metadataStore.get(sourceId);

  if (existing?.contentHash === newHash) {
    // No change — skip embedding (expensive)
    await metadataStore.touch(sourceId); // update lastCheckedAt
    return;
  }

  // Content changed or new document
  const chunks = await chunkDocument(content);
  const embeddings = await embedBatch(chunks.map(c => c.content));

  await vectorStore.deleteBySourceId(sourceId);
  await vectorStore.upsert(chunks.map((c, i) => ({
    ...c,
    embedding: embeddings[i],
    contentHash: newHash,
  })));
  await metadataStore.upsert({ sourceId, contentHash: newHash, indexedAt: new Date() });
}
```

### 5. Citation-first answer generation

Every mature tool includes citations in AI answers. The implementation: include source chunks in the LLM prompt with explicit source labels, then parse the LLM output to extract or validate citations.

```typescript
const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided context.
For each claim, cite the source using [Source N] notation.
If the context does not contain enough information, say so.`;

const contextBlock = retrievedChunks
  .map((chunk, i) => `[Source ${i + 1}] ${chunk.sourceTitle}\n${chunk.content}`)
  .join('\n\n---\n\n');

const messages = [
  { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${query}` }
];
```

---

## Shared Gaps Across All Tools

These are gaps that **all eight tools share**. Every gap is an opportunity for differentiation.

### Gap 1: No source-system ACL inheritance

This is the most important gap. Every tool in this survey fails to inherit and enforce the permissions of the source system.

- Guru imports Confluence but does not check Confluence space permissions
- AnythingLLM imports Confluence but grants access to all workspace members
- Khoj indexes Notion but treats all indexed content as user-owned (single-user model)
- Quivr has no ACL at all
- PrivateGPT has no multi-user, so no ACL possible
- Cognita (archived) had no per-user ACL
- NotionAI is the ONLY exception — but only because the knowledge base IS Notion

**Our solution**: Per-user Microsoft Entra ID `transitiveMemberOf` checks against SharePoint and Confluence ACLs. When user Alice queries, we only return chunks from sources Alice can access in the original system.

```typescript
async function getAccessibleSourceIds(userEntraId: string): Promise<string[]> {
  // Get user's Entra group memberships (transitive)
  const groupIds = await graphClient
    .api(`/users/${userEntraId}/transitiveMemberOf/microsoft.graph.group`)
    .select('id')
    .get();

  // Map group IDs to SharePoint/Confluence source IDs the user can access
  const accessibleSources = await aclStore.query({
    grantedToGroupIds: groupIds.map(g => g.id),
    directUserAccess: userEntraId
  });

  return accessibleSources.map(s => s.sourceId);
}
```

### Gap 2: No MCP server for knowledge index exposure

No tool in this list exposes its own knowledge index as an MCP server. They either:
- Have no MCP support (Khoj, Quivr, Cognita, Tettra, NotionAI)
- Act as MCP clients (AnythingLLM, PrivateGPT)
- Act as MCP servers but only for their own proprietary knowledge model (Guru)

**Our solution**: Expose `search_knowledge`, `get_document`, and `list_sources` as MCP tools. Any MCP-capable agent (Claude Desktop, Cline, Cursor, AnythingLLM) can query our index.

```typescript
// MCP tool definition
{
  name: "search_knowledge",
  description: "Search the enterprise knowledge index. Returns relevant passages with citations and source metadata.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter to specific sources (SharePoint site IDs, Confluence space keys)"
      },
      topK: { type: "number", default: 5 }
    },
    required: ["query"]
  }
}
```

### Gap 3: No SharePoint connector in any open-source tool

SharePoint is the dominant enterprise content repository in Microsoft-shop organizations, yet it is absent from every open-source tool in this list:

| Tool | SharePoint Support |
|---|---|
| Guru | No |
| AnythingLLM | No |
| Khoj | No |
| Quivr | No |
| PrivateGPT | No |
| Cognita | No (archived) |
| NotionAI | No |
| Tettra | No |

Commercial tools (Microsoft Copilot, Glean, Moveworks) support SharePoint but are SaaS-only.

**Our solution**: Phase 2 SharePoint connector using Microsoft Graph API with Entra ID OAuth.

```typescript
import { Client } from '@microsoft/microsoft-graph-client';

async function fetchSharePointPages(
  siteId: string,
  accessToken: string,
  options: { deltaToken?: string } = {}
): Promise<{ pages: SharePointPage[]; newDeltaToken: string }> {
  const client = Client.initWithMiddleware({
    authProvider: { getAccessToken: async () => accessToken }
  });

  // Use delta query for incremental sync
  const endpoint = options.deltaToken
    ? `/sites/${siteId}/pages/delta?$token=${options.deltaToken}`
    : `/sites/${siteId}/pages/delta`;

  const response = await client.api(endpoint).get();

  return {
    pages: response.value,
    newDeltaToken: extractDeltaToken(response['@odata.deltaLink'])
  };
}
```

### Gap 4: No verification/staleness signaling in AI answers

Only Guru and Tettra implement content verification. No open-source tool signals to the LLM or user that a source document might be outdated. If a retrieved chunk was last updated 2 years ago, none of these tools surface that information.

This matters enormously for enterprise knowledge: a security policy from 2023 may have been superseded. An onboarding guide may reference a system that no longer exists.

**Our solution**: Include `indexedAt` and `sourceLastModifiedAt` in chunk metadata. Surface staleness in the MCP tool response. Let the agent decide how to handle it.

```typescript
interface SearchResult {
  content: string;
  sourceUrl: string;
  sourceTitle: string;
  score: number;
  metadata: {
    sourceLastModifiedAt: Date;
    indexedAt: Date;
    isStale: boolean;  // true if sourceLastModifiedAt > 90 days ago
    stalenessDays: number;
  };
}
```

### Gap 5: No streaming-native MCP response

Existing MCP tool implementations return complete responses. For large knowledge retrieval results (multiple long documents), this creates latency before the calling agent receives any data.

**Our solution**: Implement streaming MCP responses for large result sets. Return chunks as they are retrieved rather than buffering the complete response.

### Gap 6: No cross-source faceted search

None of these tools support faceted search across multiple connected sources simultaneously with source-type filtering. A user cannot say "search only SharePoint sites AND Confluence spaces for 'leave policy'".

**Our solution**: Multi-source parallel retrieval with source-type faceting in the MCP tool's `sources` parameter.

---

## Top 5 Implementation Patterns to Steal

### Pattern 1: Cognita's Model Gateway (Steal for Connector Configuration)

Cognita used a YAML-based model gateway to decouple application code from connector configuration. Apply this pattern to our knowledge source configuration:

```typescript
// knowledge-sources.config.ts
export interface KnowledgeSourceConfig {
  id: string;
  type: 'sharepoint' | 'confluence' | 'notion' | 'github' | 'local';
  enabled: boolean;
  syncIntervalMinutes: number;
  auth: SharePointAuth | ConfluenceAuth | NotionAuth;
  aclConfig: AclConfig;
}

// Loaded from knowledge-sources.yaml:
const config: KnowledgeSourceConfig[] = yaml.parse(
  fs.readFileSync('knowledge-sources.yaml', 'utf8')
);
```

```yaml
# knowledge-sources.yaml
sources:
  - id: "corp-sharepoint"
    type: sharepoint
    enabled: true
    syncIntervalMinutes: 60
    auth:
      tenantId: "${AZURE_TENANT_ID}"
      clientId: "${AZURE_CLIENT_ID}"
      clientSecret: "${AZURE_CLIENT_SECRET}"
    aclConfig:
      enforceSourceAcl: true
      aclCheckCacheTtlSeconds: 300

  - id: "engineering-confluence"
    type: confluence
    enabled: true
    syncIntervalMinutes: 120
    auth:
      baseUrl: "${CONFLUENCE_BASE_URL}"
      email: "${CONFLUENCE_EMAIL}"
      apiToken: "${CONFLUENCE_API_TOKEN}"
    aclConfig:
      enforceSourceAcl: true
      groupMappingStrategy: "entra_transitive_member_of"
```

### Pattern 2: AnythingLLM's Confluence Connector (Steal the Credential Encryption Pattern)

AnythingLLM encrypts connector credentials before storing them in the chunk's `chunkSource` field. This means that even if someone gets read access to the document store, they cannot extract connector credentials. The `chunkSource` is only decryptable by the server.

```typescript
// Encrypt credentials before storing with chunk
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

class EncryptionWorker {
  private key: Buffer; // 32-byte key from ENCRYPTION_KEY env var

  encrypt(data: Record<string, unknown>): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const json = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(encryptedBase64: string): Record<string, unknown> {
    const buf = Buffer.from(encryptedBase64, 'base64');
    const iv = buf.slice(0, 16);
    const tag = buf.slice(16, 32);
    const encrypted = buf.slice(32);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }
}

// In the connector:
const chunkSource = encryptionWorker.encrypt({
  type: 'confluence',
  baseUrl: args.baseUrl,
  spaceKey: args.spaceKey,
  username: args.username,
  accessToken: args.accessToken,
});
```

Apply this to our connector: encrypt the source connector config (tokens, URLs) inside each chunk's metadata so that re-sync is possible without exposing credentials in plain-text storage.

### Pattern 3: Khoj's Two-Stage Retrieval (Steal the Full Pipeline)

Khoj's bi-encoder + cross-encoder pipeline with configurable confidence thresholds is production-grade. The confidence threshold tuning is critical: too low = noisy irrelevant results; too high = misses valid results.

```typescript
// Phase 1: Dense retrieval with confidence threshold
async function denseRetrieve(
  query: string,
  filter: ChunkFilter,
  options: { topK: number; confidenceThreshold: number }
): Promise<ScoredChunk[]> {
  const queryEmbedding = await embedder.embed(query);
  const results = await vectorStore.search(queryEmbedding, filter, options.topK * 3);

  // Apply confidence threshold (normalized cosine similarity)
  return results.filter(r => r.score >= options.confidenceThreshold);
}

// Phase 2: Rerank
async function rerank(
  query: string,
  candidates: ScoredChunk[],
  topN: number
): Promise<RankedChunk[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topN) return candidates; // Skip reranking if small set

  const response = await cohere.rerank({
    query,
    documents: candidates.map(c => c.content),
    model: 'rerank-multilingual-v3.0',
    top_n: topN,
  });

  return response.results.map(r => ({
    ...candidates[r.index],
    rerankScore: r.relevance_score,
  }));
}

// Full pipeline
async function search(
  query: string,
  userEntraId: string,
  topK = 5
): Promise<RankedChunk[]> {
  const accessibleSourceIds = await getAccessibleSourceIds(userEntraId);
  const filter: ChunkFilter = { accessibleSourceIds };

  const candidates = await denseRetrieve(query, filter, {
    topK: topK * 4,  // retrieve 4x more than needed for reranking
    confidenceThreshold: 0.15
  });

  return rerank(query, candidates, topK);
}
```

### Pattern 4: Guru's Card Verification Concept (Adapt for Staleness Signaling)

Guru's verification interval on cards prevents knowledge rot. We cannot implement full verification workflows (we are an MCP server, not an editor), but we can adapt the concept into staleness signals that agents can act on.

```typescript
interface SourceFreshness {
  sourceId: string;
  lastModifiedAt: Date;
  indexedAt: Date;
  stalenessDays: number;
  freshnessCategory: 'fresh' | 'aging' | 'stale' | 'unknown';
}

function categorizeFreshness(lastModifiedAt: Date | null, indexedAt: Date): SourceFreshness['freshnessCategory'] {
  if (!lastModifiedAt) return 'unknown';
  const ageDays = (Date.now() - lastModifiedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 30) return 'fresh';
  if (ageDays < 90) return 'aging';
  return 'stale';
}

// Include freshness in MCP search results:
const mcpResponse = {
  results: rankedChunks.map(chunk => ({
    content: chunk.content,
    source: {
      title: chunk.sourceTitle,
      url: chunk.sourceUrl,
      system: chunk.sourceSystem,
    },
    freshness: {
      category: categorizeFreshness(chunk.sourceLastModifiedAt, chunk.indexedAt),
      lastModifiedAt: chunk.sourceLastModifiedAt?.toISOString(),
      stalenessDays: Math.floor((Date.now() - (chunk.sourceLastModifiedAt ?? chunk.indexedAt).getTime()) / 86400000),
    },
    score: chunk.rerankScore ?? chunk.score,
  })),
  _meta: {
    totalResults: rankedChunks.length,
    accessibleSources: accessibleSourceIds.length,
    query,
  }
};
```

### Pattern 5: Tettra's Question-Gap-Expert Loop (Adapt for Agent Escalation)

Tettra's most operationally valuable feature is its gap detection: when AI cannot answer with confidence, it escalates to a human expert. We can implement a weaker version of this as an MCP tool that signals low confidence:

```typescript
// MCP tool: search_knowledge
// When confidence is low, return a signal that allows the calling agent
// to escalate or warn the user

interface SearchKnowledgeResult {
  results: RankedChunk[];
  confidence: 'high' | 'medium' | 'low' | 'no_results';
  suggestedAction?: 'ask_human' | 'web_search' | 'check_docs_directly';
  reasoning: string;
}

function assessConfidence(results: RankedChunk[], query: string): SearchKnowledgeResult['confidence'] {
  if (results.length === 0) return 'no_results';
  const topScore = results[0].rerankScore ?? results[0].score;
  if (topScore > 0.8) return 'high';
  if (topScore > 0.5) return 'medium';
  return 'low';
}

// The calling Claude agent can then decide:
// - high: use result directly
// - medium: use with caveat ("according to internal docs, but verify")
// - low: escalate ("I couldn't find a confident answer, consider contacting [owner]")
// - no_results: tell user knowledge is not in index
```

---

## Build vs Skip Recommendations

### Build These (High ROI, Confirmed Gap)

| Feature | Rationale | Estimated Effort |
|---|---|---|
| SharePoint connector (Phase 2) | No OSS tool has this; dominant enterprise content store | L |
| Confluence connector (Phase 2) | AnythingLLM has it but without ACL enforcement | M |
| Entra ID ACL enforcement | Zero competitors; transforms "RAG tool" into "governed knowledge layer" | L |
| MCP server exposure | Guru does this for their platform; OSS gap is wide | S |
| Freshness metadata in responses | Guru has verification; we can do staleness signal with zero content authoring | S |
| Incremental sync with delta tokens | SharePoint Graph API has delta; Confluence has `modifiedSince`; skip re-indexing | M |
| Chunk-level credential encryption | AnythingLLM pattern; prevents credential leakage from document store | S |
| Two-stage retrieval (dense + rerank) | Khoj + Cognita confirm this is production pattern | M |

### Skip These (Diminishing Returns or Wrong Layer)

| Feature | Rationale |
|---|---|
| Knowledge verification workflows | Guru has it; requires content authoring layer we don't have |
| Question-gap expert routing | Tettra has it; requires user identity in a chat product, not an MCP server |
| No-code agent flow builder | AnythingLLM has it; we are a tool for agent builders, not end users |
| Scheduled agent jobs | Khoj/AnythingLLM have it; agents calling our MCP server handle this |
| Per-chunk LLM-generated summaries | Expensive and rarely worth the cost vs. good chunking + reranking |
| Local LLM execution | PrivateGPT's domain; our server is a knowledge index layer, not a chat API |
| Built-in chat UI | AnythingLLM's domain; we expose MCP tools, not a chat product |

### Monitor These (Emerging, Uncertain Value)

| Feature | Rationale |
|---|---|
| Multi-modal (image) indexing | Khoj has it; SharePoint has rich image libraries; useful but needs vision LLM |
| Graph-based knowledge representation | NotionAI's database model hints at this; complex to implement correctly |
| YAML-driven retrieval workflow config | Quivr's pattern is elegant; wait until multi-connector retrieval proves complex enough |

---

## Appendix: Source URLs

All research sources accessed 2026-08-26:

- AnythingLLM README: `https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/README.md`
- AnythingLLM docs: `https://docs.anythingllm.com`
- AnythingLLM Confluence connector source: `https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/collector/utils/extensions/Confluence/index.js`
- AnythingLLM extensions index (collector): `https://api.github.com/repos/Mintplex-Labs/anything-llm/contents/collector/extensions/index.js`
- AnythingLLM pricing: `https://anythingllm.com/pricing`
- Khoj README: `https://raw.githubusercontent.com/khoj-ai/khoj/master/README.md`
- Khoj Notion connector source: `https://raw.githubusercontent.com/khoj-ai/khoj/master/src/khoj/processor/content/notion/notion_to_entries.py`
- Khoj self-hosting setup: `https://raw.githubusercontent.com/khoj-ai/khoj/master/documentation/docs/get-started/setup.mdx`
- Khoj search docs: `https://docs.khoj.dev/features/search`
- Khoj content processors: `https://api.github.com/repos/khoj-ai/khoj/contents/src/khoj/processor/content`
- Quivr README: `https://raw.githubusercontent.com/QuivrHQ/quivr/main/README.md`
- Quivr Brain source: `https://raw.githubusercontent.com/quivrhq/quivr/main/core/quivr_core/brain/brain.py`
- PrivateGPT README: `https://raw.githubusercontent.com/zylon-ai/private-gpt/main/README.md`
- PrivateGPT quickstart: `https://raw.githubusercontent.com/zylon-ai/private-gpt/main/fern/docs/pages/getting-started/quickstart.mdx`
- PrivateGPT API reference: `https://raw.githubusercontent.com/zylon-ai/private-gpt/main/fern/docs/pages/api-reference/api-reference.mdx`
- Cognita README: `https://raw.githubusercontent.com/truefoundry/cognita/main/README.md`
- Guru website: `https://www.getguru.com`
- Tettra website: `https://tettra.com`
- AnythingLLM Anthropic provider (for model version reference): `https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/server/utils/AiProviders/anthropic/index.js`
