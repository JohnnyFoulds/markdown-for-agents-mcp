# Dust.tt — Deep Competitive Intelligence

**Research date:** 2026-08-26
**Researcher:** AI competitive intelligence pass
**Sources:** https://docs.dust.tt, https://docs.dust.tt/llms.txt, https://docs.dust.tt/reference, and 15+ specific documentation pages fetched directly.

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Agent Builder — How Agents Are Defined](#2-agent-builder--how-agents-are-defined)
3. [Skills System — Reusable Intelligence Packages](#3-skills-system--reusable-intelligence-packages)
4. [Knowledge — Data Source Connections](#4-knowledge--data-source-connections)
5. [Knowledge Retrieval — RAG Architecture](#5-knowledge-retrieval--rag-architecture)
6. [Tool Ecosystem — What Agents Can Do](#6-tool-ecosystem--what-agents-can-do)
7. [Triggers — Scheduling and Automation](#7-triggers--scheduling-and-automation)
8. [Permission Model — Access Control Architecture](#8-permission-model--access-control-architecture)
9. [MCP Integration — Both Directions](#9-mcp-integration--both-directions)
10. [REST API Reference](#10-rest-api-reference)
11. [JavaScript SDK](#11-javascript-sdk)
12. [Pricing — Plans, Seats, Credits](#12-pricing--plans-seats-credits)
13. [Pods — Collaborative Workspaces](#13-pods--collaborative-workspaces)
14. [Frames — Interactive Outputs](#14-frames--interactive-outputs)
15. [Data Privacy and Infrastructure](#15-data-privacy-and-infrastructure)
16. [Competitive Positioning — Dust vs Alternatives](#16-competitive-positioning--dust-vs-alternatives)
17. [What to Build vs What to Skip](#17-what-to-build-vs-what-to-skip)
18. [Implementation Patterns for markdown-for-agents-mcp](#18-implementation-patterns-for-markdown-for-agents-mcp)
19. [Limitations, Failure Modes, and Gotchas](#19-limitations-failure-modes-and-gotchas)

---

## 1. Platform Overview

Dust is a **"Multiplayer AI" enterprise platform** — a workspace where humans and AI agents collaborate on company knowledge, tasks, and tools. It is designed as a replacement for standalone ChatGPT/Claude subscriptions at the team level, adding enterprise-grade data connectivity, access control, and workflow automation on top of frontier models.

**Core value proposition:**
- Connect company data sources (Notion, Confluence, Slack, Google Drive, SharePoint, etc.) to AI agents in a governed, permission-aware way
- Let any team member build specialized agents without coding by using a UI-driven agent builder
- Enforce consistent data access policy through Spaces (containers with group-based membership)
- Expose agents programmatically through an API and MCP server

**What Dust is NOT:**
- Not a self-hostable solution (SaaS only, with EU and US regional deployments)
- Not a vector database or standalone RAG API (it bundles those into the platform)
- Not a model provider (it wraps OpenAI, Anthropic Claude, Google Gemini, Mistral via an abstraction layer)

**Key differentiator vs competitors:** Dust lands between the "enterprise search" category (Glean, Coveo) and the "AI agent builder" category (Langchain, CrewAI) — it gives non-technical users a no-code builder while providing a REST API + MCP server for developers to extend.

Sources: https://docs.dust.tt/docs/user-documentation/getting-started/intro-to-dust.md, https://docs.dust.tt/docs/developer-platform/overview/developer-platform.md

---

## 2. Agent Builder — How Agents Are Defined

### 2.1 Core Agent Configuration Schema

Every agent in Dust is a persistent configuration object with the following fields:

```json
{
  "id": 12345,
  "sId": "7f3a9c2b1e",
  "version": 2,
  "versionCreatedAt": "2023-06-15T14:30:00Z",
  "versionAuthorId": "0ec9852c2f",
  "name": "Customer Support Agent",
  "description": "An AI agent designed to handle customer support inquiries",
  "instructions": "Always greet the customer politely and try to resolve their issue efficiently.",
  "pictureUrl": "https://example.com/agent-images/support-agent.png",
  "status": "active",
  "scope": "workspace",
  "userFavorite": true,
  "model": {
    "providerId": "openai",
    "modelId": "gpt-4",
    "temperature": 0.7
  },
  "actions": [],
  "maxStepsPerRun": 10,
  "templateId": "b4e2f1a9c7"
}
```

**Key fields:**
- `sId` (string ID): short stable identifier used in API calls and `@mentions`
- `scope`: `"workspace"` (visible to all), `"published"`, `"global"`, or private (editors only)
- `model.providerId`: `"openai"`, `"anthropic"`, `"google"`, `"mistral"`, `"meta"` etc.
- `instructions`: the system prompt — plain text, no DSL
- `actions`: array of tool/data-source configurations
- `maxStepsPerRun`: caps multi-step agent iterations (default appears to be 10)

### 2.2 The Build Flow

Dust uses a **Sidekick AI assistant** to help configure agents. The workflow:

1. **Create** — start from scratch or pick a template; Sidekick opens automatically
2. **Instructions** — write a system prompt; Sidekick drafts and suggests edits inline
3. **Tools & Knowledge** — pick data sources (connections, folders, websites) and tool integrations
4. **Test** — live preview pane runs the agent against sample queries
5. **Naming & Tags** — handle (becomes the `@name` in conversations), description, tags for discovery
6. **Access** — publish (workspace-wide) or keep private; add editors

### 2.3 Multi-Agent Composition

Dust supports calling multiple agents in the same conversation. Users prefix messages with `@agentname` to invoke a specific agent. Agents can also be configured with a "Run agent" tool, which allows them to delegate sub-tasks to specialized agents at runtime — effectively building agent pipelines without code.

Example invocation patterns:
- `@dust What is our refund policy?` — calls the default RAG agent
- `@salesAgent Draft an outreach for ACME Corp` — calls a specialized agent
- Both in one conversation thread without switching contexts

### 2.4 Model Support

Dust abstracts the model layer. Supported providers as of mid-2026:
- OpenAI: GPT-4, GPT-4o, and variants
- Anthropic: Claude 3.x and Claude 4.x families
- Google: Gemini models
- Mistral: Mistral Large and variants
- Meta: Llama variants (Enterprise)

Workspace admins can whitelist specific providers via `whiteListedProviders` and set a `defaultEmbeddingProvider`. An "auto model" mode lets Dust maintain the model selection dynamically.

**Model access tiers:** Admins can restrict which models and reasoning effort levels are available to specific groups or members — useful for controlling credit consumption.

Source: https://docs.dust.tt/docs/user-documentation/agents/model-selection.md

---

## 3. Skills System — Reusable Intelligence Packages

Skills are one of Dust's more sophisticated product concepts — essentially **reusable, versioned packages of instructions + tools + knowledge** that can be attached to multiple agents.

### 3.1 What a Skill Contains

- **Name and description** — for discoverability
- **Activation context** — instructions to the agent on when to enable the skill
- **Guidelines** — the actual instruction content (effectively a sub-system-prompt)
- **Tool references** — inline chips pointing to specific MCP tools or built-in tools
- **Knowledge references** — inline chips pointing to specific Notion pages, GDrive documents, Confluence pages
- **Sub-skill references** — skills can compose other skills

### 3.2 How Skills Are Used at Runtime

When an agent has skills attached, the agent's runtime:
1. Evaluates whether each skill is relevant to the current conversation context
2. **Dynamically loads** only the relevant skills into the context window (avoids bloating every request)
3. Exposes the skill's referenced tools and knowledge to the model for that turn

This is an important optimization: skills are **lazy-loaded** — they don't appear in the context unless the agent determines they're needed. This reduces token consumption and hallucination risk.

### 3.3 Global Skills (Built-in)

| Skill Name | What it does |
|---|---|
| `Discover Knowledge` | Searches all company documents/data warehouses without manual config |
| `Discover Skills` | Automatically discovers and activates relevant workspace skills |
| `Discover Tools` | Finds and enables tools on demand |
| `Go Deep` | Delegates to the `@deep-dive` agent for comprehensive research |
| `Frame sharing` | Turns insights into interactive dashboards/presentations |

### 3.4 Skill Versioning and Governance

- Skills are **versioned** — history button shows all past versions with date and author
- Changes to a skill propagate **immediately** to all agents using that skill
- Edit access is controlled separately via an `Editors` list
- Admins can view any skill (read-only) even if not an editor

### 3.5 How This Compares to What We Should Build

Dust's Skills system is essentially a **reusable prompt-and-tool bundle registry**. For markdown-for-agents-mcp, we should implement something analogous at the document layer:

```typescript
// Concept: a "prompt fragment" registry that agents can pull from our server
interface PromptFragment {
  id: string;
  name: string;
  triggerContext: string; // when to include this
  content: string;        // the actual prompt text
  knowledgeSources: string[]; // paths/URLs to documents to include
  version: number;
  updatedAt: Date;
}
```

Source: https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md

---

## 4. Knowledge — Data Source Connections

### 4.1 Native Connections (Managed Sync)

These are fully-managed integrations that sync automatically. Admins configure them per-space with granular content selection (specific channels, folders, pages, etc.).

| Connection | Content Synced | Auth Method |
|---|---|---|
| **Confluence** | Pages, spaces | OAuth (workspace or personal) |
| **Google Drive** | Folders, files, Sheets (as tables) | OAuth (workspace) |
| **GitHub** | Code, issues, PRs, discussions | OAuth (workspace) |
| **Notion** | Pages, databases (as tables) | OAuth (workspace) |
| **Slack** | Channels, threads | OAuth (workspace) |
| **Microsoft SharePoint/OneDrive** | Files, folders | OAuth (workspace, via Entra ID) |
| **Microsoft Teams** | Channels, messages | OAuth (workspace) |
| **Snowflake** | Tables, schemas (as queryable tables) | Credentials (workspace) |
| **BigQuery** | Tables with column descriptions | Service account (workspace) |
| **Zendesk** | Tickets, articles | OAuth (workspace) |
| **Intercom** | Conversations, articles | OAuth (workspace) |
| **Gong** | Call recordings/transcripts | OAuth (workspace) |
| **Salesforce** | Records (Beta/Tool) | OAuth (personal) |

**Important note on Microsoft:** Microsoft connections use Entra ID OAuth and cover SharePoint, OneDrive, and Teams in a single connection setup. This is directly relevant to our Phase 2 Entra ID ACL enforcement design.

### 4.2 Manual Data Sources

| Type | How data enters | Use case |
|---|---|---|
| **Folders** | File uploads (PDF, MD, TXT, etc.) via UI or API | Internal docs, PDFs without a cloud home |
| **Websites** | Admin provides URLs; Dust crawls them | Public docs, competitor sites, knowledge bases |
| **Conversation Files** | Users upload files in-chat | Ad-hoc document analysis |

### 4.3 Custom/Beta Connections (via Zapier or API)

- Zapier integration for any data source Zapier supports
- Direct API: upsert documents via `POST /api/v1/w/{wId}/data_sources/{dsId}/documents/{docId}`
- Beta connectors: Jira, Salesforce (data source mode), HubSpot, Guru Cards, Linear, Dropbox, Front Conversations

### 4.4 Connection Management Architecture

```
Admin configures connection at Space level:
  Confluence → Space "Engineering" → Selected pages
  Slack → Space "Customer Success" → Selected channels

Users in Space "Engineering" can query Confluence
Users in Space "Customer Success" can query Slack
Users NOT in those spaces cannot query those sources (even if they share a workspace)
```

This is the core of Dust's permission model — **space membership determines what data an agent can touch**.

Source: https://docs.dust.tt/docs/user-documentation/data-sources/connections.md, https://docs.dust.tt/docs/user-documentation/admins/connections-management/index.md

---

## 5. Knowledge Retrieval — RAG Architecture

### 5.1 Document Ingestion Pipeline

When a document is ingested (via connection sync or manual upload), Dust runs this pipeline:

```
Raw document
  → Pre-processing (remove repeated whitespace, normalize)
  → Chunking (max_chunk_size tokens per chunk)
  → Embedding (text-embedding-3-large from OpenAI by default)
  → Indexing (each embedding vector → vector search DB + metadata)
```

**Key parameters:**
- Embedding model: `text-embedding-3-large` (OpenAI) by default
- Enterprise customers can request alternative embedding models
- `document_id`: unique per data source; insertion is an **upsert** (replacing replaces all prior chunks)
- The document unit is the **upsertion unit** — you replace whole documents, not individual chunks

### 5.2 Query-Time Retrieval

When an agent performs a semantic search:

```
User query
  → Embed query (same model as data source)
  → Vector search → most semantically relevant chunks
  → Aggregate by document (group chunks back to their parent doc)
  → Sort documents by max chunk score (descending)
  → Return document objects with matched chunks inline
```

This "aggregate per document" approach is important — the agent sees documents with their relevant chunk excerpts, not disembodied text fragments. The agent then uses this structured context to generate a response.

### 5.3 Four Retrieval Modes

Dust exposes four distinct retrieval modes to agents, each suited for different query types:

| Mode | How it works | Best for |
|---|---|---|
| **Search** (semantic) | Embedding similarity → top-k chunks → aggregated per doc | Open-ended questions, concept search |
| **Table Query** (SQL) | Agent generates SQL → executes against structured tables | Quantitative analysis, counting, filtering |
| **Extract Data** | LLM runs over up to 500k tokens of data, emits structured output per a schema | Exhaustive pattern extraction from large corpora |
| **Include Data** | Chronological retrieval filling the context window up to capacity | Recent activity summaries, time-bounded digests |

**Critical limitation of semantic search:** RAG is depth-first, not breadth-first. It cannot reliably answer "how many documents mention X" or count occurrences. It retrieves what is *most relevant*, not *all instances*. Dust explicitly documents this and offers Table Query as the quantitative complement.

### 5.4 Label-Based Filtering

After selecting data sources, admins can apply label filters:

```
Must-have labels: ["status:approved"]        → only include docs with this label
Must-not-have labels: ["deprecated"]         → exclude docs with this label
In-conversation: dynamic filtering from query context (exact tag match)
```

Labels are supported on Folders and most native connections.

### 5.5 Advanced Search Mode (Filesystem Navigation)

An optional mode giving agents **filesystem-level access** to data sources:

```
Regular search: semantic query → top-k chunks
Advanced mode: list folder hierarchies + read specific files by path + semantic search
```

Trade-off: more flexible navigation but requires more tool calls and induces more latency. Enabled per-agent in the builder under "Advanced settings".

### 5.6 How This Informs Our Architecture

Dust's architecture validates our Phase 2 design but reveals a gap we should exploit:

**Dust's gap:** All data must be synced into Dust's own vector store. There is no "pass-through" mode where Dust queries the source system directly — it always queries its own copy. This means:
- Staleness risk (sync lag)
- Data leaves the source system (privacy concern for some enterprises)
- Storage costs scale with data volume

**Our opportunity:** markdown-for-agents-mcp can offer a **zero-copy architecture** — we query the source system directly (SharePoint Graph API, Confluence REST API) at query time with the user's actual identity token, enforcing ACLs without ever storing document content. This is a meaningful differentiation.

Source: https://docs.dust.tt/docs/developer-platform/core-concepts/chunks-and-documents.md, https://docs.dust.tt/docs/developer-platform/core-concepts/datasources.md, https://docs.dust.tt/docs/user-documentation/agents/llm-best-practices/understanding-rag.md

---

## 6. Tool Ecosystem — What Agents Can Do

### 6.1 Default Tools (No Configuration Required)

These are available in every Dust workspace automatically:

| Tool | What the agent does |
|---|---|
| **Web Search & Browse** | Google web search + read page content |
| **Data Visualization** | Build charts/graphs from gathered data |
| **Create Files** | Generate and convert files (PDF, DOCX, etc.) |
| **Create Images** | Image generation from text prompts |
| **Agent Memory** | Remember past conversations per user |
| **Run an Agent** | Delegate to specialized sub-agents |

### 6.2 Integrated Platform Tools (Require Admin Setup)

Tools in this tier perform **live actions** in third-party systems — not just reading indexed content, but reading/writing/updating in real time.

| Tool | Actions available | Credentials |
|---|---|---|
| **Notion** | Search, create pages, update pages | Workspace OAuth |
| **Slack** | Search, post messages | Personal OAuth |
| **GitHub** | Search, update, comment, create PRs/issues | Workspace OAuth |
| **Confluence** | Search, create, update pages | Personal or Workspace OAuth |
| **HubSpot** | Search, update, create records | Personal OAuth |
| **Salesforce** | Search, update, create records | Personal OAuth |
| **Gmail** | Search emails, create drafts | Personal OAuth |
| **Google Calendar** | Search, create, update events | Personal OAuth |
| **Microsoft Outlook** | Search emails, create drafts | Personal OAuth |
| **Zendesk** | Search tickets, view metrics, draft replies | Workspace OAuth |
| **Airtable** | Read/write bases | Workspace |
| **Asana** | Create/manage tasks | Workspace |
| **Ashby** | Recruiting data | Workspace |
| **Attio** | CRM data | OAuth |
| **Canva** | Create/edit designs | OAuth |
| **Databricks** | Query workspaces | Workspace |
| **Fathom** | Meeting recordings | OAuth |
| **Front** | Conversations, tickets | Workspace |
| **Freshservice** | ITSM tickets | Workspace |
| **Gong** | Call data | Workspace |
| **Jira** | Issues, projects | OAuth |
| **Microsoft Teams** | Post messages, read channels | OAuth |
| **Microsoft SharePoint/OneDrive** | Read/write files | OAuth |
| **Microsoft Excel** | Read/write spreadsheets | OAuth |
| **Miro** | Boards | OAuth |
| **Monday.com** | Projects, items | OAuth |
| **NetSuite** | ERP data | OAuth |
| **Power BI** | Reports, datasets | OAuth |
| **Productboard** | Features, roadmap | OAuth |
| **Salesloft** | Sales engagement | OAuth |
| **Semrush** | SEO/marketing data | API key |
| **Slab** | Knowledge base | OAuth |
| **Snowflake** | Queries | Credentials |
| **Statuspage** | Incidents, components | API key |
| **UKG Ready** | HR data | Credentials |
| **Val Town** | Run TypeScript scripts | OAuth |
| **Vanta** | Compliance data | OAuth |
| **Zendesk** | Tickets, conversations | Workspace OAuth |
| **Voice/Sound** | TTS, audio generation | — |
| **Computer** | Browser automation/computer use | Admin setup |
| **Wake-ups** | Scheduled agent wakeups | — |
| **JIT Tools** | Just-in-time tool activation | — |

**Total unique tool integrations: ~50+**

### 6.3 Remote MCP Servers as Tools

Admins can add any publicly available or self-hosted MCP server as a tool:

```
Admin → Spaces → Tools → Add Tool → Add MCP Server → enter URL
```

Authentication options:
- **Auto (OAuth DCR)**: server supports dynamic client registration — Dust discovers and registers automatically
- **Static OAuth**: admin creates OAuth app on the provider, enters Client ID + Secret into Dust
- **Bearer token**: static token (less secure, single-account limitation)

### 6.4 Tool Credential Modes: Personal vs Workspace

This is architecturally important for our Phase 2 design:

| Mode | How it works | Privacy impact |
|---|---|---|
| **Personal credentials** | Each user authenticates individually (e.g., Gmail, Slack personal) | Actions are scoped to the user's identity |
| **Workspace credentials** | Single service account for the whole workspace | All users share one identity; actions logged to service account |

Personal credential tools respect source-system ACLs because the call is made under the user's own OAuth token. Workspace credential tools do not — they use a shared service account that may have broader access than any individual user should have.

**This is Dust's biggest permission gap:** workspace-credential tools bypass source-system ACLs. The admin must manually configure which spaces have access to which workspace-credential tools to approximate per-user access control.

Source: https://docs.dust.tt/docs/user-documentation/admins/tools-management/personal-vs-shared-credentials.md

---

## 7. Triggers — Scheduling and Automation

### 7.1 Scheduled Triggers

Agents can be configured with time-based triggers via the Agent Builder → Triggers section:

```
Name: "Daily Sales Digest"
Frequency: "8:00 AM every weekday"
Timezone: "America/Los_Angeles"
Custom message: "Generate today's pipeline summary from Salesforce"
```

Under the hood, an LLM converts the natural language frequency description into a cron expression. Dust shows the computed schedule for confirmation before saving.

**Limitation (as of research date):** Triggers are personal — only the creator/editor can observe runs. Not yet team-observable.

### 7.2 Webhook Triggers

Agents can be triggered via inbound webhooks. Dust supports webhook payload filtering (route based on payload shape).

Rate limiting applies to webhook triggers — documented at https://docs.dust.tt/docs/user-documentation/agents/triggers/webhooks/rate-limiting.md

### 7.3 Integration-Based Triggers

Several platform integrations support agent triggering:
- **Slack auto-reply**: agent responds automatically when mentioned in configured channels, or auto-joins channels to provide ambient assistance without explicit `@mention`
- **Email forwarding**: forward emails to agents via a Dust email address
- **Zapier/Make.com/n8n/Power Automate**: trigger agents from any Zapier-compatible event
- **Meeting transcripts**: automatically send meeting transcripts to a configured agent

---

## 8. Permission Model — Access Control Architecture

This is the most critical section for our Phase 2 design. Dust's permission model is the reference architecture we must either match or surpass.

### 8.1 Conceptual Layers

```
Workspace
  └── Spaces (open or restricted)
        └── Data sources (connections, folders, websites)
        └── Agents
        └── Tools
        └── Skills

Users
  └── Role (Admin | Manager | Member)
  └── Group memberships (provisioned via SCIM or manual)

Permissions are granted to Groups, not individuals
A user's effective access = role + union of group permissions + space memberships
```

### 8.2 Roles

| Role | Capabilities |
|---|---|
| **Admin** | Full workspace control: billing, security, SSO, SCIM, model providers, governance config |
| **Manager** | Invite/remove members, change non-admin roles, view analytics; no billing/security by default |
| **Member** | Use Dust per seat, group memberships, and space access; no admin access |

**The Builder role is being deprecated** in favor of separate "Create agents" and "Publish agents" permissions granted to groups.

### 8.3 Permission Matrix

| Permission | Admin | Manager | Member |
|---|---|---|---|
| Create agents | Yes | When granted | When granted |
| Publish agents | Yes | When granted | When granted |
| Create skills | Yes | When granted | When granted |
| View/export audit logs | Yes | When granted | When granted |
| Manage billing | Yes (default) | When granted | When granted |
| Manage security/provisioning | Yes (default) | When granted | When granted |
| Manage model providers | Yes | No | No |
| Invite external users to Frames | Conditional | Conditional | Conditional |
| View workspace analytics | Yes | Yes | No |

### 8.4 Spaces — The Core Data Container

Spaces are the primary access control boundary. Every data source lives in exactly one space.

| Space type | Who can access | Config |
|---|---|---|
| **Company Data (open space)** | All workspace members | Data added here is available to everyone |
| **Restricted space** | Members of designated groups only | Admin assigns groups; users not in any assigned group cannot see the space or its data |

**Key rule:** An agent can only be built with data from spaces the agent's creator has access to. Users can only interact with an agent if they have access to the spaces that agent's data sources are in.

**Implication:** If a user lacks access to Space "Finance", they cannot use an agent built on Finance data, even if the agent itself is "published workspace-wide". The agent's response will degrade or fail for that user.

### 8.5 SCIM and SSO — Enterprise Identity Integration

Enterprise plan only:
- **SAML SSO**: enforce SSO for workspace login
- **SCIM 2.0**: automated user and group provisioning from any compatible IdP (Okta, Azure AD/Entra, etc.)
  - Users created/updated/deactivated automatically
  - Groups provisioned and kept in sync
  - Special group naming convention: `dust-admins`, `dust-managers` auto-assigns those roles

Configuration path: `Admin → People & Security → Domain and Members → User provisioning → Setup Directory sync`

### 8.6 What Dust's Model CANNOT Do

1. **No per-document ACL enforcement from source systems.** When Confluence data is synced into Dust, Dust does not mirror the original Confluence page-level permissions. An admin selects which pages to sync, and any user with space access can query all synced pages regardless of their Confluence access.

2. **Workspace-credential tools bypass identity.** When using workspace OAuth credentials, all agent actions are performed as the service account, not the individual user.

3. **No real-time ACL check against the source.** Because data is copied into Dust's own store, there is no live check against SharePoint/Confluence at query time.

**This is our biggest competitive advantage opportunity.** Our Phase 2 design with Entra ID `transitiveMemberOf` checks at query time gives per-user, per-document, source-system-accurate ACL enforcement that Dust fundamentally cannot provide in its SaaS sync model.

Source: https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md, https://docs.dust.tt/docs/user-documentation/admins/admin-governance/access-controls-and-permissions.md

---

## 9. MCP Integration — Both Directions

Dust is deeply committed to MCP. It supports MCP in two directions simultaneously.

### 9.1 Dust AS an MCP Server (Dust exposes itself to MCP clients)

**Server URLs:**
- Global/US: `https://dust.tt/mcp`
- EU: `https://eu.dust.tt/mcp`

**Authentication:** OAuth only (no API keys). Supports:
- Dynamic Client Registration (DCR)
- Client ID Metadata Documents (CIMD)
- Requires OAuth `resource` parameter in both authorization and token requests

**Exposed tools via the Dust MCP Server:**
- Identify current user and workspace
- List available agents
- List conversations; create conversations; create/retrieve messages
- Retrieve Pod info and Pod tasks
- List, read, create, search, and resolve files scoped to conversations or Pods
- Search across workspace Spaces

**Admin controls:**
- Admins can disable Dust MCP Server access workspace-wide
- Admins control which redirect URIs are allowed
- Per-user: the MCP client acts as the authenticated user — it can only access what that user can access in Dust (respects Spaces and group permissions)

**Gotcha:** The Dust MCP Server does NOT proxy every third-party tool configured in the workspace. It only exposes Dust's own capabilities. If an agent has a GitHub tool configured, that is not accessible via the MCP server.

### 9.2 External MCP Servers AS Tools in Dust (Dust consumes MCP servers)

Admins can register remote MCP servers as tools in a Dust space:

```
Admin → Spaces → Tools → Add Tool → Add MCP Server → enter public URL
```

The server gets added as a tool with all its exposed functions available to any agent in that space.

**Three auth modes for consuming external MCP servers:**
1. **Auto (OAuth DCR)**: Dust discovers config from URL, triggers OAuth flow automatically
2. **Static OAuth**: Admin creates OAuth app on provider (e.g., GitHub), enters Client ID + Secret
3. **Bearer token**: Static token in Authorization header on all calls

**Example — setting up GitHub MCP with Static OAuth:**
```
GitHub developer settings → Create OAuth App
  → write down client ID + client Secret
  → Redirect URI: https://dust.tt/oauth/mcp_static/finalize (US)
                  https://eu.dust.tt/oauth/mcp_static/finalize (EU)

Dust → Spaces → Tools → Add MCP Server
  → Static OAuth URL: https://api.githubcopilot.com/mcp
  → OAuth token endpoint: https://github.com/login/oauth/access_token
  → OAuth authorization endpoint: https://github.com/login/oauth/authorize
  → OAuth scopes: repo, user
```

**Whitelisting Dust as a provider** — for MCP server operators who want Dust users to connect:

| OAuth type | Callback URL | Region |
|---|---|---|
| Dynamic (DCR) | `https://dust.tt/oauth/mcp/finalize` | Global |
| Dynamic (DCR) | `https://app.dust.tt/oauth/mcp/finalize` | Global |
| Dynamic (DCR) | `https://eu.dust.tt/oauth/mcp/finalize` | EU |
| Static OAuth | `https://dust.tt/oauth/mcp_static/finalize` | Global |
| Static OAuth | `https://eu.dust.tt/oauth/mcp_static/finalize` | EU |

### 9.3 Client-Side MCP Server (Developer Feature — Preview)

This is the most technically interesting MCP integration for us. It allows a developer's application to **dynamically expose local tools to Dust conversations** at runtime.

**Architecture:**
```
Your app (browser/server)
  → registers as a client-side MCP server with Dust
  → provides tool definitions + implementations
  → Dust agents call those tools via SSE during a conversation
  → results POSTed back to Dust

Per-client isolation:
  → each browser tab / app window = its own server instance
  → bound to user's active session
  → auto-terminated when client closes
```

**Protocol (for non-TypeScript implementors):**

Step 1 — Register:
```http
POST /api/v1/w/:workspaceId/mcp/register
Content-Type: application/json

{"serverName": "your-server-name"}

→ Response: {"serverId": "abc123"}
```

Step 2 — Heartbeat (every <5 minutes):
```http
POST /api/v1/w/:workspaceId/mcp/heartbeat
Content-Type: application/json

{"serverId": "abc123"}
```

Step 3 — Listen for requests (SSE):
```http
GET /api/v1/w/:workspaceId/mcp/requests?serverId=abc123
→ Server-Sent Events stream of tool invocation requests
```

Step 4 — Send results:
```http
POST /api/v1/w/:workspaceId/mcp/results
Content-Type: application/json

{"serverId": "abc123", "result": {...}}
```

**TypeScript SDK example (full working pattern):**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DustMcpServerTransport } from "@dust-tt/client";
import { z } from "zod";

// Initialize the MCP server
const server = new McpServer({
  name: "internal-knowledge-server",
  version: "1.0.0",
});

// Register a search tool that queries your internal system
server.tool(
  "search_internal_docs",
  "Search internal documentation and knowledge base",
  {
    query: z.string().describe("Natural language search query"),
    sources: z.array(z.string()).optional().describe("Limit to specific sources"),
    limit: z.number().default(10).describe("Max results to return"),
  },
  async ({ query, sources, limit }) => {
    // Your implementation: call SharePoint, Confluence, etc.
    const results = await internalSearch(query, sources, limit);
    return { results };
  }
);

// Expose a markdown-rendering tool
server.tool(
  "fetch_page",
  "Fetch a specific page by URL and return as markdown",
  {
    url: z.string().url().describe("Page URL to fetch"),
  },
  async ({ url }) => {
    const markdown = await fetchAndConvertToMarkdown(url);
    return { content: markdown, url };
  }
);

// Connect to Dust via the SDK transport
const dustAPI = new DustAPI({ /* config */ });
const transport = new DustMcpServerTransport(dustAPI);
await server.connect(transport);

// Use serverId in conversation messages
const serverId = transport.getServerId();
const message = {
  content: "Search our docs for the API authentication guide",
  context: { clientSideMCPServerIds: [serverId] }
};
```

**Authentication constraint:** Client-side MCP requires **OAuth personal access tokens only** — API keys are not supported. This is a significant limitation for server-to-server integrations.

**What this means for us:** Our MCP server (`markdown-for-agents-mcp`) can be registered as a remote MCP tool in Dust workspaces by admins. This is the primary integration path — expose our server at a public URL with OAuth support, and Dust admins add it as a tool. Our server then handles all the markdown fetching/searching and returns results to the Dust agent.

Source: https://docs.dust.tt/docs/user-documentation/agents/integrations/dust-mcp-server.md, https://docs.dust.tt/docs/user-documentation/developers/client-side-mcp-server.md, https://docs.dust.tt/docs/user-documentation/admins/tools-management/adding-an-mcp-server.md

---

## 10. REST API Reference

### 10.1 Base URL and Authentication

```
Base URL (US): https://dust.tt/api/v1/w/{wId}/
Base URL (EU): https://eu.dust.tt/api/v1/w/{wId}/

Authentication:
  Authorization: Bearer <api-key>

wId: workspace ID (visible in workspace URL)
```

### 10.2 Private User Endpoints

```http
GET  /api/user                    → current user + workspaces
PATCH /api/user                   → update profile (name, job type, platforms, image)
```

Response schema:
```json
{
  "user": {
    "sId": "string",
    "id": 123,
    "createdAt": 123,
    "username": "string",
    "email": "string",
    "firstName": "string",
    "fullName": "string",
    "provider": "auth0",
    "workspaces": [{
      "id": 123,
      "sId": "string",
      "name": "string",
      "role": "admin",
      "regionalModelsOnly": true,
      "defaultEmbeddingProvider": "string",
      "ssoEnforced": true
    }]
  }
}
```

### 10.3 Workspace Endpoints

```http
GET  /api/v1/w/{wId}/analytics/export  → export analytics (CSV or JSON)
```

### 10.4 Agent Endpoints

```http
GET  /api/v1/w/{wId}/assistant/agent_configurations
     ?view=[all|list|published|global|favorites|all_unrestricted|workspace]
     &withAuthors=[true|false]
     → list all agents for the workspace

GET  /api/v1/w/{wId}/assistant/agent_configurations/{sId}
     → single agent config

GET  /api/v1/w/{wId}/assistant/agent_configurations/{sId}/export
     → export as YAML

PATCH /api/v1/w/{wId}/assistant/agent_configurations/{sId}
     → update agent config

DEL  /api/v1/w/{wId}/assistant/agent_configurations/{sId}
     → archive (soft delete; disables triggers and editor group memberships)

POST /api/v1/w/{wId}/assistant/agent_configurations/import
     → import agent from JSON matching agent config schema

GET  /api/v1/w/{wId}/assistant/agent_configurations/search
     ?name=string
     → search agents by name
```

Agent config response schema (key fields):
```json
{
  "agentConfigurations": [{
    "id": 12345,
    "sId": "7f3a9c2b1e",
    "version": 2,
    "name": "Customer Support Agent",
    "description": "string",
    "instructions": "string",
    "status": "active",
    "scope": "workspace",
    "model": {
      "providerId": "openai",
      "modelId": "gpt-4",
      "temperature": 0.7
    },
    "actions": [],
    "maxStepsPerRun": 10
  }]
}
```

### 10.5 Conversation Endpoints

```http
POST /api/v1/w/{wId}/assistant/conversations
     → create conversation

GET  /api/v1/w/{wId}/assistant/conversations/{cId}
     ?limit=N&lastValue=cursor
     → get conversation (paginated messages)

GET  /api/v1/w/{wId}/assistant/conversations/{cId}/events
     → SSE stream of conversation events

POST /api/v1/w/{wId}/assistant/conversations/{cId}/messages
     → post message (triggers agent response)

POST /api/v1/w/{wId}/assistant/conversations/{cId}/content_fragments
     → create content fragment (attach context/files)

POST /api/v1/w/{wId}/assistant/conversations/{cId}/cancel
     → cancel ongoing message generation

GET  /api/v1/w/{wId}/assistant/conversations/{cId}/files/{filePath}
     → download conversation-scoped file by path
```

### 10.6 Data Source / Datasource Endpoints

```http
GET  /api/v1/w/{wId}/spaces/{spaceId}/data_sources
     → list data sources in a space

POST /api/v1/w/{wId}/spaces/{spaceId}/data_sources/{dsId}/documents/{docId}
     → upsert a document (body: {document_id, text, ...})

GET  /api/v1/w/{wId}/spaces/{spaceId}/data_sources/{dsId}/documents/{docId}
     → retrieve a document

DEL  /api/v1/w/{wId}/spaces/{spaceId}/data_sources/{dsId}/documents/{docId}
     → delete a document

POST /api/v1/w/{wId}/spaces/{spaceId}/data_sources/{dsId}/search
     → search a data source (body: {query, top_k, ...})
```

### 10.7 MCP Endpoints

```http
POST /api/v1/w/{wId}/mcp/register    → register client-side MCP server
POST /api/v1/w/{wId}/mcp/heartbeat   → send heartbeat (required every <5 min)
GET  /api/v1/w/{wId}/mcp/requests    → SSE stream of tool requests
POST /api/v1/w/{wId}/mcp/results     → send tool execution results
```

### 10.8 Other API Sections

Based on the API reference index, additional endpoint groups exist:
- `Feedbacks` — conversation feedback
- `Mentions` — @mention handling
- `Search` — workspace-level search
- `Skills` — CRUD for skills
- `Apps` — legacy Dust Apps
- `DatasourceViews` — space-scoped views of data sources
- `Tools` — tool management
- `Spaces` — space management
- `Triggers` — schedule and webhook trigger management

Full OpenAPI spec and Postman collection: https://docs.dust.tt/docs/developer-platform/dust-api-documentation/openapi-and-postman.md

### 10.9 Rate Limits

| Resource | Limit |
|---|---|
| Document upserts | 120 per minute per workspace |
| Dust app runs | 10,000 requests per day per app |

Rate limits use a sliding window. No documented limits on conversation creation or agent execution via API (likely exists but not publicly documented per these research findings).

Source: https://docs.dust.tt/docs/developer-platform/core-concepts/rate-limits.md

---

## 11. JavaScript SDK

Dust provides an official TypeScript/JavaScript SDK:

```bash
npm install @dust-tt/client
```

Documentation is maintained at the npm package page (not in the docs site — a usability gap they acknowledge).

**Key SDK classes:**
- `DustAPI` — main API client (handles auth, workspace context)
- `DustMcpServerTransport` — MCP transport for client-side MCP servers

**Basic usage pattern:**
```typescript
import { DustAPI } from "@dust-tt/client";

const dust = new DustAPI({
  workspaceId: process.env.DUST_WORKSPACE_ID!,
  apiKey: process.env.DUST_API_KEY!,
});

// Create a conversation and stream an agent response
const conversation = await dust.createConversation({
  title: "Research question",
  visibility: "unlisted",
  message: {
    content: "@dust What is our leave policy?",
    mentions: [{ configurationId: "dust" }],
    context: {
      username: "user123",
      email: "user@company.com",
      timezone: "Europe/London",
      clientType: "api",
    },
  },
});

// Stream events from the conversation
for await (const event of dust.streamConversationEvents({
  conversationId: conversation.sId,
})) {
  if (event.type === "agent_message_success") {
    console.log(event.message.content);
  }
}
```

**Upsert documents to a data source:**
```typescript
await dust.upsertDocument({
  spaceId: "my-space-id",
  dataSourceId: "my-datasource",
  documentId: "doc-unique-id",
  text: "# My Document\n\nContent here...",
  metadata: {
    title: "My Document",
    source_url: "https://internal.example.com/docs/page",
    tags: ["department:engineering", "status:approved"],
  },
});
```

---

## 12. Pricing — Plans, Seats, Credits

### 12.1 Plans Overview

| Plan | Users | Connectors | Spaces | SSO | SCIM | Audit Logs |
|---|---|---|---|---|---|---|
| **Business (free)** | Up to 5 | 3 | 5 | No | No | No |
| **Business (paid)** | Up to 100 | 3 | 5 | No | No | No |
| **Enterprise (seat-based)** | Unlimited | Unlimited | Unlimited | Yes | Yes | Yes |
| **Enterprise (pooled)** | Unlimited | Unlimited | Unlimited | Yes | Yes | Yes |

**Notes:**
- Business free: no credit card required
- Business paid: mix of monthly and annual seats allowed in same workspace
- Enterprise: annual seats only; contact sales
- Exact USD per-seat prices are not published in docs — must visit `dust.tt/home/pricing`

### 12.2 Seat Types and Credit Allocations

| Seat Type | Monthly Credits | Notes |
|---|---|---|
| **Free** | 500 credits (one-time, never resets) | Lifetime allocation; once consumed, blocked unless upgraded |
| **Pro** | 8,000 credits/month | Standard usage; resets monthly on subscription anniversary |
| **Max** | 40,000 credits/month | Power users; resets monthly |
| **Workspace (Enterprise pooled)** | Drawn from shared pool | No individual allocation |

Credits are tied to the user, not the seat. Changing seat type does not revoke already-allocated credits.

### 12.3 Credit Cost by Tool Tier

Credits = token credits + action credits. The action credit tiers:

| Tier | Credits/action | Tools covered |
|---|---|---|
| **Free** | 0 | Internal utilities, memory, agent routing, most file operations, skill/pod management |
| **Basic** | 1 | Knowledge & Retrieval (Search, Table Query, Extract Data, Include Data), Web Search, Frames editing, Analytics |
| **Advanced** | 3 | File Generation, Image/Sound Generation, all 3rd-party MCP integrations (Gmail, Slack, GitHub, Notion, GDrive, Jira, HubSpot, Salesforce, Zendesk, Confluence, Gong, Monday, etc.), all external MCP servers |

**Token credits are proportional** to model complexity and context size — not quantified publicly per request.

**Key insight:** Every call to an external MCP server costs **3 action credits**, regardless of what the MCP server does. This is the pricing signal that tells us our MCP server's positioning: if we're being called from Dust agents, every tool invocation costs the Dust user 3 credits.

### 12.4 Seat Lifecycle Rules

- Free → Pro/Max: immediate, full credit allocation granted at once
- Pro → Max: immediate
- Max → Pro: deferred to next billing period (retains Max access until end of current period)
- Removing monthly seat: prorated credit on next invoice
- Removing annual seat: returned to seat stock; can be reassigned to another member

### 12.5 On Subscription Cancellation

When a paid subscription is cancelled and billing period ends:
- All users except one (earliest admin) are removed
- **All connections are deleted** along with all synced data (original source data unaffected)
- Custom agents deactivated (re-activate on resubscribe)
- Data sources >50 MB deleted after 7 days (warned by email)
- Conversations and data sources under 50 MB retained but with limitations

**Privacy implication:** Dust stores synced data on their servers. Cancelling the subscription means losing that synced data. This strengthens the zero-copy architecture argument.

Source: https://docs.dust.tt/docs/user-documentation/admins/usage-seats-and-credits/credits.md, https://docs.dust.tt/docs/user-documentation/admins/usage-seats-and-credits/seat-management.md, https://docs.dust.tt/docs/user-documentation/admins/billing/subscriptions-and-payments.md

---

## 13. Pods — Collaborative Workspaces

Pods are a newer Dust concept — **shared workspaces where humans and agents collaborate around conversations, tasks, and files**.

### 13.1 What a Pod Contains

- **Conversations** — threaded discussions with agents and humans
- **Tasks** — structured action items tracked within the Pod
- **Files** — shared file storage accessible to agents
- **Frames** — interactive dashboards and outputs scoped to the Pod

### 13.2 Pod Use Cases (from Dust docs)

- Shared asset library
- Personal second brain (individual + AI)
- Initiative/project management
- Ticket handling + support knowledge base
- One Pod per customer (client workspace)
- Content and editorial production
- Competitive intelligence (exactly our use case)

### 13.3 Pod Access Control

Pods have their own members and roles system, separate from workspace-level roles. Pod tasks can trigger agents automatically.

---

## 14. Frames — Interactive Outputs

Frames are **living interactive documents** generated by agents — essentially dashboards that can be shared, embedded, or made public.

- Created by the Frame sharing skill
- Can contain charts, tables, visualizations
- Shareable within workspace or externally (with admin policy allowing it)
- "White-labeled Frames" available — can be embedded in other applications
- Admins control external sharing policy

**For us:** Frames represent the "output artifact" pattern — not just text responses but structured, shareable deliverables. A markdown-for-agents-mcp equivalent would be generating well-structured markdown reports that can be posted to Confluence or saved to SharePoint as the "artifact" of an agent run.

---

## 15. Data Privacy and Infrastructure

### 15.1 Data Storage Model

Dust **copies all connected data** into its own infrastructure. When you connect Confluence, all selected pages are synced and stored on Dust's servers (chunked, embedded, indexed). The original data in Confluence is not modified.

### 15.2 Regional Deployments

| Region | URL |
|---|---|
| Global/US | `https://dust.tt` |
| EU | `https://eu.dust.tt` |

EU deployment is for GDPR compliance. Enterprise customers can choose their region.

### 15.3 Enterprise Plan Data Handling

- `regionalModelsOnly` flag on workspace config — constrains which models run in which region
- SSO enforcement via `ssoEnforced: true` on workspace
- Audit logs available to Admins (Enterprise only)
- SCIM provisioning for identity lifecycle management

### 15.4 Data Freshness / Sync Lag

Connections sync automatically. Dust acknowledges there is typically a few-minute delay for updates to appear — this is documented in the FAQ as a known limitation ("Why isn't my recently updated document showing in agent responses?").

### 15.5 What Happens When You Delete Data

- Deleting a document via API: removes all associated chunks from the vector store
- Deleting a data source: removes all documents and chunks — "all associated data are deleted from our systems"
- No documented SLA for data removal

---

## 16. Competitive Positioning — Dust vs Alternatives

### 16.1 Feature Comparison Matrix

| Feature | Dust.tt | Glean | Onyx | markdown-for-agents-mcp (Phase 2) |
|---|---|---|---|---|
| **Deployment** | SaaS (US + EU) | SaaS | Self-host / SaaS | Self-hosted |
| **License** | Proprietary | Proprietary | Apache 2 (core) | MIT |
| **Agent builder** | Yes, no-code | Limited | Yes | No (we're a tool, not an agent builder) |
| **Data sync model** | Copy to own store | Copy to own store | Copy to own store | Zero-copy (query-time) |
| **Source-system ACL enforcement** | No (Dust-space-level only) | Claims to mirror source ACLs | Partial | Yes (Entra ID transitiveMemberOf) |
| **MCP server** | Yes (full) | Partial | Yes | Yes (our core product) |
| **Connector count** | ~15 native + MCP | ~50+ | ~30+ | SharePoint + Confluence (Phase 2) |
| **Web fetch** | Yes (built-in tool) | No | No | Yes (Phase 1 — our core) |
| **Pricing model** | Per-seat credits | Enterprise custom | Per-seat | Self-hosted (infrastructure cost only) |
| **SSO/SCIM** | Enterprise only | Enterprise | Yes | Delegates to source systems |
| **Open source** | No | No | Yes (core) | Yes (MIT) |
| **Skills system** | Yes | No | No | Could build |
| **On-prem option** | No | Yes (some deployments) | Yes | Yes (default) |

### 16.2 Where Dust Wins

1. **Breadth of integrations**: 50+ tool integrations, 15+ native connections — no self-hosted alternative comes close
2. **No-code agent builder**: non-technical users can build sophisticated agents without writing a line
3. **Multi-agent orchestration**: first-class "run agent" tool, agent chaining in conversations
4. **Polished UX**: Sidekick AI assistant for agent building, live preview, skills library
5. **MCP ecosystem**: both consumes and exposes MCP; strong ecosystem positioning
6. **Reliability**: managed SaaS with EU/US deployments, SSO/SCIM on Enterprise

### 16.3 Where Dust Loses (Our Opportunities)

1. **Zero-copy ACL enforcement**: Dust always copies data; we can query-time-enforce source-system ACLs via Entra ID/Graph API
2. **Self-hosted / on-prem**: many enterprises cannot allow data to leave their perimeter — Dust is SaaS-only
3. **MIT license**: enterprises with procurement approval for open-source tools can deploy us without a vendor contract
4. **No SharePoint ACL mirroring**: Dust's Microsoft connection does not enforce per-document SharePoint permissions within Dust
5. **Vendor lock-in**: data sync model means your indexed knowledge depends on Dust's ongoing service
6. **Credit overhead for MCP calls**: every MCP call costs 3 credits — our server would incur this cost for Dust users
7. **Pricing opacity**: no self-service pricing on enterprise; contact sales required

### 16.4 The Ecosystem Fit

Dust and markdown-for-agents-mcp are **complementary, not directly competing** at this stage:

```
Dust workspace
  → adds markdown-for-agents-mcp as a remote MCP tool
  → Dust agents call our server's fetch/search tools
  → We handle: SharePoint Graph API, Confluence, web fetch, Entra ID ACL
  → Result: Dust agents get ACL-enforced access to content we serve as markdown

We provide the knowledge infrastructure layer
Dust provides the agent builder / collaboration layer
```

This is the commercial pitch: "Add our MCP server to your Dust workspace to get ACL-accurate SharePoint and Confluence access without copying your data to Dust's servers."

---

## 17. What to Build vs What to Skip

Based on this research, here is a direct recommendation for markdown-for-agents-mcp's roadmap:

### 17.1 Build These (High Signal from Dust's Architecture)

**1. MCP server with OAuth DCR support**
Dust's "Auto" MCP integration mode requires Dynamic Client Registration. This is the path of least friction for Dust admins adding our server. Without DCR, they must use Bearer tokens or Static OAuth — more setup friction.

**2. Document-level ACL enforcement via Entra ID**
This is the gap Dust explicitly cannot fill. Our `transitiveMemberOf` approach — checking group membership for every document access — is a genuine enterprise differentiator.

**3. Markdown-normalized output from SharePoint and Confluence**
Dust's data sync approach requires maintaining an indexed copy. Our query-time markdown conversion approach eliminates sync lag and storage costs. Agents always get the current document.

**4. Per-user token forwarding**
When an agent is configured with personal OAuth credentials, it makes calls as the user's identity. We should do the same — the OAuth token passed to our MCP tool should be the user's token, not a service account.

**5. Label/tag filtering in search**
Dust's label filtering is a heavily-used feature for "include only approved docs" or "exclude deprecated". Implement analogously using Confluence labels and SharePoint metadata columns.

**6. Semantic search with chunk-level results**
Our search must return results in the same shape as Dust's: document objects with matched chunk excerpts. This is the format agents expect from RAG tools.

### 17.2 Skip These (Dust Already Does It Better)

**1. Agent builder UI** — Dust's no-code builder is years ahead. Don't compete here. Be a great tool *inside* Dust.

**2. Multi-agent orchestration** — Dust handles this natively. Focus on being a leaf tool, not an orchestrator.

**3. Tool integrations (Slack, Gmail, etc.)** — These are Dust's bread and butter with 50+ integrations. We should reference Dust for these.

**4. Skills/templates library** — Complex to maintain; Dust has this well-covered.

**5. Credits/metering system** — SaaS platform concern; as a self-hosted tool we don't need this.

### 17.3 Patterns Worth Replicating

**Dust's "Advanced search mode"** (filesystem navigation alongside semantic search):
```typescript
// Implement in our MCP server
server.tool("list_folder", "List documents in a SharePoint folder", {
  path: z.string().describe("Folder path in SharePoint"),
  siteId: z.string().optional(),
}, async ({ path, siteId }, context) => {
  const token = await getTokenForUser(context.userId);
  return await sharePointListFolder(token, siteId, path);
});

server.tool("get_document", "Get document by URL or path", {
  url: z.string().url(),
}, async ({ url }, context) => {
  const token = await getTokenForUser(context.userId);
  return await fetchDocumentAsMarkdown(token, url);
});

// Both work alongside the semantic search tool
// Agents use filesystem navigation when they need structural context,
// semantic search when they need concept-based retrieval
```

**Dust's "Include Data" (chronological retrieval)**:
```typescript
server.tool("get_recent_changes", "Get recently modified documents", {
  siteId: z.string(),
  daysBack: z.number().default(7),
  limit: z.number().default(20),
}, async ({ siteId, daysBack, limit }, context) => {
  const token = await getTokenForUser(context.userId);
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  return await sharePointGetRecentlyModified(token, siteId, since, limit);
});
```

---

## 18. Implementation Patterns for markdown-for-agents-mcp

### 18.1 How Dust's RAG Retrieval Should Inform Our Search API

Dust returns: `{documents: [{document_id, title, chunks: [{text, score}], source_url}]}`

We should return the same shape from our `search` tool so agents that are built for Dust-style RAG work seamlessly:

```typescript
interface SearchResult {
  documentId: string;          // unique ID
  title: string;               // document title
  sourceUrl: string;           // canonical URL in source system
  score: number;               // relevance score (0–1)
  chunks: Array<{
    text: string;              // matched text excerpt
    score: number;             // chunk-level score
    charOffset?: number;       // position in document for highlighting
  }>;
  lastModified: Date;
  permissions: {
    accessChecked: boolean;    // whether ACL was enforced
    userHasAccess: boolean;    // whether current user can read this
  };
}
```

### 18.2 ACL Enforcement Pattern (The Core Differentiator)

```typescript
// Entra ID transitiveMemberOf check before returning document content
async function enforceSharePointACL(
  userToken: string,
  siteId: string,
  documentId: string
): Promise<boolean> {
  // 1. Get user's group memberships (transitive — includes nested groups)
  const memberOf = await graphClient
    .api('/me/transitiveMemberOf')
    .select(['id', 'displayName'])
    .get();

  const userGroupIds = new Set(memberOf.value.map((g: any) => g.id));

  // 2. Get the document's SharePoint permission groups
  const sitePermissions = await graphClient
    .api(`/sites/${siteId}/drive/items/${documentId}/permissions`)
    .get();

  // 3. Check if any of user's groups have read permission
  for (const permission of sitePermissions.value) {
    if (permission.grantedTo?.user) {
      // Direct user grant — handled separately by caller's OAuth token scope
      return true;
    }
    if (permission.grantedTo?.siteGroup) {
      // SharePoint site group — check if user is member
      const siteGroupId = permission.grantedTo.siteGroup.id;
      if (userGroupIds.has(siteGroupId)) return true;
    }
    if (permission.grantedToIdentitiesV2) {
      // Modern permissions — check Entra groups
      for (const identity of permission.grantedToIdentitiesV2) {
        if (identity.group && userGroupIds.has(identity.group.id)) {
          return true;
        }
      }
    }
  }
  return false;
}
```

### 18.3 MCP Tool Registration with DCR Support

For Dust's "Auto" integration mode to work, we need to support OAuth Dynamic Client Registration:

```typescript
// Expose DCR endpoint for Dust (and other MCP clients) to auto-register
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: `https://${req.hostname}`,
    authorization_endpoint: `https://${req.hostname}/oauth/authorize`,
    token_endpoint: `https://${req.hostname}/oauth/token`,
    registration_endpoint: `https://${req.hostname}/oauth/register`,
    scopes_supported: ['read:documents', 'search:documents'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  });
});

// DCR endpoint
app.post('/oauth/register', async (req, res) => {
  const { redirect_uris, client_name, client_uri } = req.body;

  // Validate that redirect URIs are from trusted domains
  const allowedDomains = ['dust.tt', 'eu.dust.tt', 'app.dust.tt'];
  const allValid = redirect_uris.every((uri: string) =>
    allowedDomains.some(domain => new URL(uri).hostname.endsWith(domain))
  );

  if (!allValid) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  const clientId = generateSecureId();
  const clientSecret = generateSecureSecret();
  
  await saveOAuthClient({ clientId, clientSecret, redirect_uris, client_name });

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris,
    client_name,
  });
});
```

### 18.4 Chunking Documents for Semantic Search (Matching Dust's Approach)

If we add a local vector index for fast search:

```typescript
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";

// Match Dust's default: text-embedding-3-large
const embeddings = new OpenAIEmbeddings({
  modelName: "text-embedding-3-large",
});

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1500,      // ~max_chunk_size tokens equivalent
  chunkOverlap: 150,    // ~10% overlap for context continuity
  separators: ["\n\n", "\n", " ", ""],
});

async function indexDocument(
  documentId: string,
  content: string,
  metadata: Record<string, unknown>
): Promise<void> {
  // Pre-process: normalize whitespace (matches Dust's documented step)
  const normalized = content.replace(/\s{2,}/g, ' ').trim();
  
  const chunks = await splitter.createDocuments([normalized]);
  
  const vectors = await embeddings.embedDocuments(
    chunks.map(c => c.pageContent)
  );
  
  // Store chunks with parent document reference
  await vectorStore.upsert(
    vectors.map((vec, i) => ({
      id: `${documentId}::chunk::${i}`,
      vector: vec,
      payload: {
        documentId,
        chunkIndex: i,
        text: chunks[i].pageContent,
        ...metadata,
      },
    }))
  );
}

// At query time, aggregate chunks back to document objects (matches Dust's retrieval)
async function searchDocuments(query: string, topK = 10) {
  const queryVector = await embeddings.embedQuery(query);
  const results = await vectorStore.search(queryVector, { limit: topK * 3 });
  
  // Aggregate chunks by document
  const docMap = new Map<string, { score: number; chunks: any[] }>();
  for (const result of results) {
    const docId = result.payload.documentId;
    if (!docMap.has(docId)) {
      docMap.set(docId, { score: result.score, chunks: [] });
    }
    const doc = docMap.get(docId)!;
    doc.score = Math.max(doc.score, result.score); // max score = document score
    doc.chunks.push({ text: result.payload.text, score: result.score });
  }
  
  // Sort by document score descending (matches Dust's sort)
  return Array.from(docMap.entries())
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, topK)
    .map(([documentId, { score, chunks }]) => ({
      documentId,
      score,
      chunks: chunks.sort((a, b) => b.score - a.score),
    }));
}
```

---

## 19. Limitations, Failure Modes, and Gotchas

### 19.1 Dust Platform Limitations

**Data staleness:** Dust syncs on a schedule (not real-time). A document updated in Confluence may take minutes to reflect in Dust. The FAQ acknowledges this: "Why isn't my recently updated document showing in agent responses?" No SLA is documented.

**RAG accuracy on quantitative questions:** Dust explicitly warns that semantic search cannot reliably count or enumerate. Questions like "how many tickets were created last month?" require Table Query, not Search. Agents configured with only Search will give wrong answers to quantitative questions.

**Context window limits:** RAG agents do not have access to all documents — only top-k retrieved chunks. If the answer requires synthesizing information from many documents, quality degrades. Dust addresses this with the "Extract Data" action (up to 500k token window) but this is slower and costs more credits.

**Workspace-credential tools — ACL bypass risk:** When an agent uses workspace OAuth credentials (e.g., a shared GitHub token), it can access anything the service account can access, regardless of whether the user asking the question should have that access. This is a significant compliance risk for some enterprises that Dust does not have a clean solution for.

**MCP rate limit at 3 credits per call:** Every call to an external MCP server costs 3 action credits. For Pro seat users (8,000 credits/month), if an agent makes 10 MCP calls per query, that's 30 credits per query — roughly 266 queries per month before running out. For intensive knowledge-work agents, this could be a blocker.

**Client-side MCP server requires OAuth tokens:** The client-side MCP pattern does not support API keys. This makes it unsuitable for server-side automation workflows where there is no interactive user to authenticate.

**Business plan limitation on connectors:** The Business plan (even paid) limits to 3 connectors and 5 spaces. For a mid-size company with Slack + Notion + Google Drive + Confluence, they immediately hit the connector limit. This pushes customers to Enterprise for relatively modest needs.

### 19.2 Gotchas for Implementors Consuming the Dust API

**Agent `scope` parameter for listing:** The `view` parameter on `GET /api/v1/w/{wId}/assistant/agent_configurations` has subtle differences:
- `all`: non-private agents (default when unauthenticated)
- `list`: active agents accessible to the calling user (default when authenticated)
- `all_unrestricted`: ALL active agents including ones the caller cannot normally access — **requires admin API key**

Using the wrong `view` in automation scripts can silently return fewer agents than expected.

**Document upsert is a full replacement:** Upserting a document with the same `document_id` replaces the entire document and all its chunks. There is no partial update — you must send the complete document text each time. For large documents with frequent small edits, this means re-embedding the entire document on every update.

**Rate limit is per workspace, not per key:** The 120 document upserts/minute limit is workspace-scoped. If multiple processes share the same workspace, they share the rate limit bucket.

**Conversation API SSE streaming:** The events endpoint (`GET .../events`) uses Server-Sent Events. Clients must handle SSE properly including reconnection logic. If the connection drops mid-stream, the agent response may be lost.

**MCP client-side heartbeat timeout is strict:** Client-side MCP servers expire after 5 minutes without a heartbeat. If the user leaves their browser idle, the server instance will be garbage-collected and any ongoing agent interactions that depend on it will fail. Application developers must implement robust heartbeat logic.

**No partial-document ACL mirroring from source systems:** Even on Enterprise, Dust's space-based permissions are its own system. If you sync all of Confluence into one space, all members of that space see all synced Confluence pages — even if in Confluence some pages were restricted to specific groups. There is no automated mapping of Confluence page restrictions → Dust space membership.

### 19.3 Gotchas for Building the MCP Integration

**OAuth resource parameter is mandatory:** MCP clients connecting to the Dust MCP server MUST include the OAuth `resource` parameter in both authorization and token requests. Clients that omit it are explicitly not supported. If building a custom MCP client that connects to `dust.tt/mcp`, implement the full MCP authorization specification including this parameter.

**EU vs US endpoint divergence:** All API calls, MCP URLs, and OAuth callback URLs have separate EU and US variants. Hard-coding `dust.tt` will fail for EU-hosted workspaces. Always make the region configurable.

**API keys cannot be used for MCP server connections:** The Dust MCP server endpoint only accepts OAuth tokens, not API keys. This is an intentional security constraint.

---

*Sources cited throughout this document. Primary source: https://docs.dust.tt and its full documentation index at https://docs.dust.tt/llms.txt. API reference: https://docs.dust.tt/reference. All information verified against Dust's official documentation as of 2026-08-26.*
