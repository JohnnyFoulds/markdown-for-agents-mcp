# Glean Enterprise AI Search: Complete Competitive Intelligence

**Research date:** 2026-08-26
**Sources:** developers.glean.com, docs.glean.com, glean.com/connectors, glean.com/platform/api, workagent.ai, exploreagentic.ai, aitrendtool.com, onyx.app, workativ.com, hyperdigitalpulse.com, medium.com

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Company and Market Position](#2-company-and-market-position)
3. [Connector Catalog — Complete Breakdown](#3-connector-catalog--complete-breakdown)
4. [Permission Architecture: How ACL Enforcement Actually Works](#4-permission-architecture-how-acl-enforcement-actually-works)
5. [Enterprise Graph: People Graph and Document Graph](#5-enterprise-graph-people-graph-and-document-graph)
6. [MCP Server: Tools, Auth, Limits, Response Formats](#6-mcp-server-tools-auth-limits-response-formats)
7. [Developer APIs: Full Surface Area](#7-developer-apis-full-surface-area)
8. [Agent Builder Platform](#8-agent-builder-platform)
9. [Governance, Security, and Compliance](#9-governance-security-and-compliance)
10. [Enterprise Flex Pricing: Complete Rate Card](#10-enterprise-flex-pricing-complete-rate-card)
11. [Deployment Models: SaaS, BYOC, and Customer-Hosted](#11-deployment-models-saas-byoc-and-customer-hosted)
12. [IDE Integrations](#12-ide-integrations)
13. [Glean vs. Competitors](#13-glean-vs-competitors)
14. [Top 5 Patterns We Must Implement in Phase 2](#14-top-5-patterns-we-must-implement-in-phase-2)
15. [Glean vs. Building Ourselves: Honest Assessment for Vodacom Scale](#15-glean-vs-building-ourselves-honest-assessment-for-vodacom-scale)
16. [What to Skip](#16-what-to-skip)
17. [Implementation Roadmap](#17-implementation-roadmap)

---

## 1. Executive Summary

Glean is the enterprise AI search market leader as of mid-2026: ~$300M ARR, $7.2B valuation (Series F), SOC 2 Type II / ISO 27001 / ISO 42001 / HIPAA certified, 275+ connectors. It is not a search bolt-on — it is a full enterprise intelligence platform with search, assistant, agent builder, governance, and a published developer platform.

**What makes Glean technically interesting for us:**

- Permission enforcement happens at the retrieval layer, not the display layer — documents that a user cannot see never enter the LLM context window
- The Enterprise Graph is a cross-system entity-linking graph (people + documents + activity + infrastructure) — not just an inverted index
- The MCP server is tenant-specific, permission-aware, and OAuth-authenticated — exactly the pattern we want to implement
- The developer platform exposes REST APIs (Platform, Client, Indexing), an npm Web SDK, Python/TS/Go/Java client libraries, and an agent toolkit compatible with LangChain, CrewAI, OpenAI Agents SDK, and Google ADK
- BYOC (Bring Your Own Cloud) deployment on GCP or AWS — all data stays in the customer's single-tenant project

**What Glean cannot do:**

- No self-serve or free tier — 100+ seat enterprise minimum
- Price is completely opaque (no public dollar amounts anywhere)
- Deployment is multi-week to multi-month — no instant setup
- No open-source code — you are buying a black box

**For us:** Glean is the gold standard for Phase 2 design reference. We do not want to build Glean. We want to build the open, self-hosted, MIT-licensed equivalent that a company like Vodacom can run in their own infrastructure, paying no per-seat tax, while getting the same core patterns.

---

## 2. Company and Market Position

| Attribute | Detail |
|---|---|
| Founded | 2019, Palo Alto CA |
| Funding | Series F, $150M raised, $7.2B valuation |
| ARR (2026) | ~$300M (reported) |
| Employees | ~1,000+ |
| Certifications | SOC 2 Type II, ISO 27001, ISO 42001, HIPAA, GDPR, TX-RAMP Level 2 |
| Pricing model | Contact-sales only; per-user Enterprise Flex seats + FlexCredits pool |
| Minimum contract | ~100 seats (unverified by Glean); reported floor ~$60K/year |
| Customers | Booking.com, Zillow, TIME, Ericsson, Databricks, DBS |

Glean positions itself as a "neutral intelligence layer" — vendor-agnostic across LLMs (35+ models via Model Hub), vendor-agnostic across app ecosystems (Google Workspace, Microsoft 365, Atlassian, Salesforce, GitHub). This is the direct counter-positioning to Microsoft 365 Copilot, which only works well if you are all-in on the Microsoft stack.

---

## 3. Connector Catalog — Complete Breakdown

### 3.1 Connector Types

Glean defines four connector implementation patterns:

| Type | How It Works | When Used |
|---|---|---|
| **Native** | Glean-built, calls source APIs directly; deep data including attachments, threads, activity signals, people graph | Default for major SaaS apps |
| **Push API** | Customer or partner pushes data into Glean via Indexing API; no inbound network access required | On-prem systems, custom apps, firewalled environments |
| **Partner-built** | Third-party vendor owns and maintains the integration using the Indexing API | Niche enterprise apps where Glean has no direct connector |
| **MCP-based** | Glean routes agent actions through an MCP tool call to the source system; read and write operations at runtime | "Actions" use case — not for indexing, for acting |
| **Web history** | Glean browser extension makes page titles from users' browsing history searchable; private to individual, no org-wide access | Fallback when no native connector available or TOS prohibits crawling |

Key architectural note: for indexed connectors, Glean uses **three data access modes**:
- **Indexed** — content and permissions crawled ahead of time; low latency; permission snapshot from last crawl + incremental updates
- **Live** — Glean calls the source system at query time; fresher data but requires per-user auth; higher latency
- **Hybrid** — indexed for broad recall, live call for recent rows / long-tail objects not in index

Source: [docs.glean.com/connectors/about](https://docs.glean.com/connectors/about)

### 3.2 Full Connector List by Category (275+ total, Aug 2026)

The following is the complete catalog from [glean.com/connectors](https://glean.com/connectors) at time of research. Native = purpose-built by Glean. MCP = action-capable at runtime.

#### Documents & Knowledge Management

| Connector | Type | Notes |
|---|---|---|
| Confluence | Native + MCP | Popular — Atlassian Cloud and Server |
| Google Drive | Native | Full permission graph mirroring |
| SharePoint / OneDrive | Native | Microsoft 365 integration |
| Notion | Native | Pages, databases |
| Coda | Native | Documents and tables |
| Box | Native + MCP | File storage with version history |
| Dropbox | Native + MCP tool | File storage |
| Airtable | Native | Bases and views |
| Evernote | Web history | No API crawl |
| Docusign | Web history | No API crawl |
| Egnyte | Native | Enterprise file sync |
| Adobe Experience Manager | Push API | CMS |
| Azure File Share | Push API | On-prem / Azure files |
| Backstage | Push API | Internal developer portal |
| Benchling | Push API + MCP | Life sciences |
| Datastax | Push API | Vector database |
| File Upload | Upload | Manual file ingest |

#### Engineering & Developer Tools

| Connector | Type | Notes |
|---|---|---|
| GitHub | Native (embedded via Glean-in-GitHub) | Code, PRs, issues, wikis |
| GitLab | Native | Repos, MRs, issues |
| Bitbucket | Native | Repos, PRs |
| Jira | Native + MCP | Issues, projects, sprints |
| Azure DevOps | Native | Boards, repos |
| Databricks | Native + MCP tool | Notebooks, SQL, catalogs |
| Amplitude | MCP | Analytics |
| Datadog | Web history | Observability |
| Dynatrace | MCP | Observability |
| Coralogix | MCP | Log analytics |
| Buildkite | MCP | CI/CD |
| Cloudflare | MCP | Edge/CDN |
| DeepWiki | MCP | Code documentation |
| Backstage | Push API | Service catalog |
| Exa | MCP | Web research |
| CData Connect AI | MCP | Data connectivity |
| Coupler.io | MCP | Data pipelines |
| Amazon S3 | Native | Object storage |
| Azure | Native | Azure services (SSO, DevOps) |

#### Communication & Collaboration

| Connector | Type | Notes |
|---|---|---|
| Slack | Native (embedded via Glean-in-Slack) | Messages, threads, channels |
| Microsoft Teams | Native (embedded via Glean-in-Teams) | Chats, channels |
| Gmail | Native | Email and threads |
| Outlook | Native | Email |
| Zoom | Native (Glean-in-Zoom) | Meetings, recordings |
| Facebook Workplace | Native | Posts, groups |

#### Project Management

| Connector | Type | Notes |
|---|---|---|
| Asana | Native + MCP | Tasks, projects |
| ClickUp | MCP | Tasks |
| Monday.com | Native (inferred) | |
| Aha! | Native | Product roadmaps |
| Atlassian Rovo | MCP | AI agent layer on Atlassian |

#### CRM & Sales

| Connector | Type | Notes |
|---|---|---|
| Salesforce | Native | Accounts, opportunities, contacts |
| HubSpot | Native (inferred) | |
| Zendesk | Native (Glean-in-Zendesk) | Tickets, KB |
| ServiceNow | Native (Glean-in-ServiceNow) | ITSM tickets |
| Freshdesk | Native | Support tickets |
| Freshservice | Native | ITSM |
| Apollo | MCP | Sales prospecting |
| Clay | MCP | Sales enrichment |
| Crunchbase | MCP | Company data |
| CB Insights | MCP | Market intelligence |
| Close | MCP | CRM |
| Crossbeam | MCP | Partner intelligence |
| Clarify | MCP | AI CRM |
| Common Room | MCP | Community CRM |
| Day AI | MCP | CRM |

#### HR

| Connector | Type | Notes |
|---|---|---|
| BambooHR | Native | HRIS |
| Workday | Native (inferred) | HRIS |
| Deel | MCP | Global payroll |
| Dice | MCP | Job postings |
| 15Five | Native | Performance management |

#### Identity & SSO

| Connector | Type | Notes |
|---|---|---|
| Azure AD (Entra ID) | Native | SSO, groups, directory |
| Okta | Native | SSO, groups |
| Clerk | MCP | Auth |

#### Design

| Connector | Type | Notes |
|---|---|---|
| Canva | MCP tool + Native (partial) | Design assets |
| Figma | Native (inferred) | |
| Miro | Native (Glean-in-Miro) | Whiteboards |
| Excalidraw | MCP | Diagrams |
| BioRender | MCP | Scientific diagrams |
| Cloudinary | MCP | Media management |

#### Finance & Procurement

| Connector | Type | Notes |
|---|---|---|
| Ariba | Push API | SAP procurement |
| Coupa | Push API | Procurement |
| Factset | MCP | Financial data |
| Daloopa | MCP | Financial models |
| Chronograph | MCP | PE/VC portfolio |

#### Learning & Enablement

| Connector | Type | Notes |
|---|---|---|
| Docebo | Native | LMS |
| Lessonly (inferred) | | |

#### Support & ITSM

| Connector | Type | Notes |
|---|---|---|
| ServiceNow | Native | ITSM |
| Zendesk | Native | CS ticketing |
| Freshdesk | Native | Support |
| Freshservice | Native | IT support |
| Aura | MCP | Support |
| Enterpret | MCP | Customer feedback |

#### Miscellaneous / Partner-Built

| Connector | Type | Notes |
|---|---|---|
| Fellow | Partner-built + Push API | Meeting notes |
| eSalesManager (eSM) | Push API + Partner-built | Japanese CRM |
| Crayon | Native (limited) | Competitive intelligence |
| Affinity | MCP + Native | Relationship intelligence |

### 3.3 Connector Architecture: How Bidirectional Sync Works

Glean connectors perform **two functions** at crawl time:
1. **Content fetching** — title, body, comments, attachments, threads
2. **Permission mapping** — fetch the source app's ACL for every document and store it as a flattened user/group list in Glean's permission store

For **real-time updates**, connectors use webhooks or incremental crawling. Permission rule changes in the source app are reflected in Glean "immediately" per marketing — in practice, the sync cadence depends on the connector and the source API's rate limits.

**Important limitation:** Glean explicitly does NOT index structured data from data warehouses (Snowflake, Databricks tables, Redshift). It uses those systems' MCP/tool interface for live queries, not for indexing. This is a deliberate architectural choice: Glean is for knowledge work (unstructured and conversational data), not analytics.

---

## 4. Permission Architecture: How ACL Enforcement Actually Works

This is Glean's most important technical differentiator. Understanding it deeply is essential for our Phase 2 design.

### 4.1 The Core Principle: Early Binding via ACL Filter

Most enterprise search tools treat security as a **display-layer concern**: they index everything, then filter what users see in the UI. This creates a structural vulnerability — the underlying data is indexed without permission context, and filtering logic sits at the presentation layer where it can be misconfigured or bypassed.

Glean inverts this model. From Glean's engineering blog and the Medium architecture teardown:

> "Security is the first step in the retrieval pipeline, not the last. Every query passes through ACL verification before any document retrieval occurs. Vector embeddings and keyword matches are evaluated against the current user's live permission graph before any content chunk is passed to the LLM. If a user lacks direct or group-inherited read rights to a document, that document is filtered out entirely at the retrieval layer — it never enters the LLM context window."

Source: [hyperdigitalpulse.com/blog/glean-security-acl-byoc-architecture-2026](https://hyperdigitalpulse.com/blog/glean-security-acl-byoc-architecture-2026) and [medium.com — Inside the AI Architecture of Glean](https://medium.com/@kevinrt6911/enterprise-ai-system-design-atlassian-glean-architecture-a36d80f5bc7f)

### 4.2 ACL Synchronization Engine

From source analysis:

1. **Per-connector permission mapping**: Each connector has its own permission parser. Glean engineers reverse-engineer the permission model of each source system because documentation is often incomplete or incorrect.

2. **Unified permissions model**: All source-app permissions are translated into a common Glean ACL format — a normalized representation of "which users and groups can see this document."

3. **Incremental sync**: Permission changes are propagated as fast as the source API allows. Sub-minute updates are possible via webhook-driven connectors. API rate limits are the bottleneck.

4. **Least privilege principle**: Glean operates under the principle of least privilege — users see only what they are authorized to see in the source application. There is no "Glean admin sees everything" backdoor.

5. **Edge cases handled** (from Glean engineering blog):
   - Documents that become publicly visible only after a user has visited them (e.g., certain Google Drive permissions)
   - Temporary access permissions (time-bounded access) — Glean must sync frequently to catch expirations
   - Documents that do not provide flattened user/group lists — only specify general "allowed" and "disallowed" criteria that must be resolved manually

### 4.3 Query Execution Path

```
User Query
    │
    ▼
Tenant Query Endpoint (https://<tenant_id>-be.glean.com/api/v1/search)
    │
    ▼
Session Auth Check (SSO token validation)
    │
    ▼
ACL Filter (early binding — user's permission graph is loaded)
    │
    ▼
Hybrid Search (vector + keyword, RRF ranking)
    │  ← Only documents where user has read access pass this stage
    ▼
Reranking (personalization signals: activity, recency, relevance)
    │
    ▼
LLM Synthesis (documents that passed ACL filter enter context window)
    │
    ▼
Cited Answer (with permission-validated citations)
```

### 4.4 Real Search Request/Response Schema

From [docs.glean.com/security/architecture/data-flow](https://docs.glean.com/security/architecture/data-flow):

**Search request** to `https://<tenant_id>-be.glean.com/api/v1/search`:

```json
{
  "cursor": "<pagination_cursor>",
  "maxSnippetSize": 324,
  "pageSize": 10,
  "people": [],
  "query": "expense policy",
  "requestOptions": {
    "debugOptions": {},
    "disableQueryAutocorrect": false,
    "facetBucketSize": 0,
    "facetFilters": [],
    "timezoneOffset": -660
  },
  "sessionInfo": {
    "lastSeen": "2023-12-13T05:03:49.808Z",
    "sessionTrackingToken": "<token>",
    "lastQuery": "expense policy"
  },
  "sourceInfo": {
    "clientVersion": "fe-release-2023-12-05-86ae10d",
    "initiator": "MORE",
    "modality": "FULLPAGE"
  },
  "timeoutMillis": 10000,
  "timestamp": "2023-12-13T05:04:14.093Z",
  "trackingToken": "<token>"
}
```

**Search result document object**:

```json
{
  "trackingToken": "<token>",
  "document": {
    "id": "GDRIVE_11...Kp-P",
    "datasource": "gdrive",
    "docType": "pdf",
    "parentDocument": {
      "id": "GDRIVE_1t...qqsy",
      "datasource": "gdrive",
      "docType": "Folder",
      "title": "Company Policies",
      "url": "https://drive.google.com/drive/folders/1t...qqsy"
    },
    "title": "CompanyExpensePolicy-sept2023.pdf",
    "url": "https://drive.google.com/file/d/11...Kp-P",
    "metadata": {
      "datasource": "gdrive",
      "datasourceInstance": "gdrive",
      "objectType": "pdf",
      "container": "Insurance Policies",
      "containerId": "GDRIVE_1t...qqsy",
      "mimeType": "application/pdf",
      "documentId": "GDRIVE_11...Kp-P",
      "createTime": "2023-06-05T20:00:25Z",
      "updateTime": "2023-06-16T11:59:42Z",
      "author": { "name": "Sam Sample", "obfuscatedId": "B79...3D8" },
      "owner": { "name": "Sam Sample", "obfuscatedId": "B79...3D8" },
      "visibility": "SPECIFIC_PEOPLE_AND_GROUPS",
      "updatedBy": { "name": "Sam Sample", "obfuscatedId": "B79...3D8" },
      "datasourceId": "11...Kp-P",
      "interactions": {},
      "documentCategory": "COLLABORATIVE_CONTENT"
    }
  },
  "snippets": [
    {
      "snippet": "",
      "mimeType": "text/plain",
      "text": "You can submit them to your manager using the current expense reporting method..."
    }
  ]
}
```

### 4.5 How We Implement This in Phase 2

The Glean permission model maps directly to what we need for SharePoint + Confluence ACL enforcement. Our design should mirror this architecture:

```typescript
// Permission-aware retrieval in our MCP server
interface PermissionContext {
  userId: string;           // Entra ID object ID
  userGroups: string[];     // transitiveMemberOf groups
  tenantId: string;
}

interface IndexedDocument {
  id: string;
  sourceSystem: 'sharepoint' | 'confluence';
  content: string;
  embedding: number[];
  acl: {
    allowedUsers: string[];         // explicit user IDs
    allowedGroups: string[];        // Entra group IDs
    allowedRoles: string[];         // SharePoint roles / Confluence spaces
    deniedUsers: string[];          // explicit denials override allows
    deniedGroups: string[];
    isPublic: boolean;              // tenant-wide readable
  };
  metadata: {
    title: string;
    url: string;
    sourceId: string;
    lastModified: string;
    author: string;
  };
}

// ACL check happens BEFORE vector similarity is computed or returned
function isDocumentAccessible(
  doc: IndexedDocument,
  ctx: PermissionContext
): boolean {
  // Explicit denials win
  if (doc.acl.deniedUsers.includes(ctx.userId)) return false;
  if (doc.acl.deniedGroups.some(g => ctx.userGroups.includes(g))) return false;
  
  // Public documents
  if (doc.acl.isPublic) return true;
  
  // Explicit allows
  if (doc.acl.allowedUsers.includes(ctx.userId)) return true;
  if (doc.acl.allowedGroups.some(g => ctx.userGroups.includes(g))) return true;
  
  return false;
}

// In the search pipeline
async function permissionAwareSearch(
  query: string,
  ctx: PermissionContext,
  vectorStore: VectorStore
): Promise<IndexedDocument[]> {
  // Get candidates from vector store
  const candidates = await vectorStore.similaritySearch(query, topK: 100);
  
  // Apply ACL filter BEFORE returning to LLM
  return candidates.filter(doc => isDocumentAccessible(doc, ctx));
}
```

**Critical gotcha:** The `topK: 100` with ACL filtering is necessary because after filtering, you may have fewer than the desired number of results. Glean does this same pre-fetch-and-filter dance. If you only fetch `topK: 10` you may return 2 results after filtering.

---

## 5. Enterprise Graph: People Graph and Document Graph

### 5.1 What the Enterprise Graph Is

The Enterprise Graph is not just an inverted search index. It is a **knowledge graph** that maps relationships between:

- **People** (employees, teams, org chart, expertise areas, communication patterns)
- **Documents** (content, type, metadata, who created/edited/viewed it)
- **Infrastructure** (systems, repos, services)
- **Products** (what the company makes)
- **Customers** (accounts, contacts, relationships)
- **Processes** (workflows, approvals, recurring tasks)

Source: [glean.com/platform](https://glean.com/platform) — "Enterprise graph with nodes like Infrastructure, People, Content, Customers, and Products"

### 5.2 Personal Graph vs. Enterprise Graph

Glean distinguishes two graph layers:

**Enterprise Graph** (org-wide):
- How departments relate to each other
- Which documents belong to which product area
- Cross-system entity linking (e.g., the same "Project Alpha" in Jira, Confluence, Slack, and email)
- Company-wide expertise mapping

**Personal Graph** (per-user):
- Individual goals, tasks, work habits
- Writing style
- Response style preferences
- Communication patterns
- What the user is currently working on

The Personal Graph is what enables Glean's personalized search ranking. If you recently worked on a project, Glean boosts documents from that project in your search results.

### 5.3 How the Knowledge Graph Is Built

From connector data ingestion:

```
Source App (e.g., Confluence)
    │
    ├── Content Data: pages, spaces, attachments
    ├── People Data: authors, editors, space admins, groups
    └── Activity Data: creation time, edit time, view counts, share events
                    │
                    ▼
            Glean Indexing Pipeline
                    │
                    ├── Text extraction and parsing
                    ├── Entity recognition (people, projects, products)
                    ├── Permission mapping
                    ├── Embedding generation
                    └── Knowledge Graph Node creation
                                │
                                ▼
                    Knowledge Graph Store
                    (entities + relationships + embeddings)
```

**Key insight:** Activity signals (views, edits, shares) are used for relevance ranking. This is why a freshly-updated document ranks higher than an old one, even if keyword match is identical.

### 5.4 Cross-System Entity Linking

Glean links entities across systems. Examples:
- "Sarah Johnson" in Slack = "sjohnson@company.com" in Google Drive = "sjohnson" in Jira
- "Project Phoenix" in Confluence = "phoenix" Jira project = "#proj-phoenix" Slack channel = multiple GitHub repos

This is technically hard. Glean uses the People API (which includes identity resolution via email, username, directory) to build the canonical entity graph. The connector's "People data" (identities, roles, permissions, groups, access control information) feeds this graph.

### 5.5 How We Implement a Minimal Version in Phase 2

We do not need to build the full Glean knowledge graph. We need a functional subset:

```typescript
// Entity record in our knowledge index
interface EntityRecord {
  canonicalId: string;         // our stable ID
  type: 'person' | 'document' | 'project' | 'space';
  aliases: {
    system: string;            // 'sharepoint' | 'confluence' | 'entra'
    id: string;                // system-specific ID
    displayName: string;
  }[];
  metadata: Record<string, unknown>;
  acl: ACLRecord;              // same ACL structure as documents
}

// Cross-system person identity linking (critical for ACL enforcement)
interface PersonEntity extends EntityRecord {
  type: 'person';
  entraObjectId: string;       // authoritative ID from Entra ID
  email: string;
  groupMemberships: string[];  // Entra group IDs via transitiveMemberOf
  sharepointAlias?: string;
  confluenceAccountId?: string;
}

// When indexing a Confluence page:
async function indexConfluencePage(
  page: ConfluencePage,
  entityResolver: EntityResolver
): Promise<IndexedDocument> {
  // Resolve Confluence author to canonical PersonEntity
  const author = await entityResolver.resolveConfluenceUser(page.authorId);
  
  // Translate Confluence space permissions to Entra group IDs
  const acl = await translateConfluenceACL(page.restrictions, entityResolver);
  
  return {
    id: `confluence:${page.id}`,
    sourceSystem: 'confluence',
    content: page.content,
    acl,
    metadata: {
      title: page.title,
      url: page.url,
      sourceId: page.id,
      lastModified: page.updatedAt,
      author: author.email,
    }
  };
}
```

**The critical piece:** identity resolution between Confluence user IDs and Entra object IDs. This is what enables Entra `transitiveMemberOf` group membership to correctly gate access to Confluence content.

---

## 6. MCP Server: Tools, Auth, Limits, Response Formats

### 6.1 Two Distinct MCP Servers

Glean ships two completely different MCP servers:

| Server | Purpose | Auth | Data Source |
|---|---|---|---|
| **Remote MCP Server** | Per-tenant, permission-aware access to your org's Glean knowledge | OAuth (SSO via DCR) | Your company's indexed corpus |
| **Docs MCP Server** | Public developer documentation access | None (public) | developers.glean.com content |

Source: [developers.glean.com/guides/mcp/](https://developers.glean.com/guides/mcp/)

The Remote MCP Server is the enterprise-facing product. The Docs MCP Server is for developers building on Glean.

### 6.2 Remote MCP Server: Endpoint and Configuration

The Remote MCP Server URL format is tenant-specific but follows the pattern obtained from the MCP Configurator in Glean's admin console.

**Configuration for Claude Code:**
```bash
claude mcp add glean-developer-docs https://developers.glean.com/mcp \
  --transport http --scope user
```

**Configuration for Cursor:**
```json
{
  "mcpServers": {
    "glean": {
      "type": "http",
      "url": "https://<tenant_id>-be.glean.com/mcp"
    }
  }
}
```

**Configuration for VS Code:**
```bash
code --add-mcp '{"name":"glean","type":"http","url":"https://<tenant_id>-be.glean.com/mcp"}'
```

**Configuration for Claude Desktop (Windsurf pattern):**
```json
{
  "mcpServers": {
    "glean": {
      "serverUrl": "https://<tenant_id>-be.glean.com/mcp"
    }
  }
}
```

### 6.3 Authentication

The Remote MCP Server uses **OAuth 2.0** with **Dynamic Client Registration (DCR)** as the default path.

**DCR flow:**
1. MCP host initiates connection to Glean's OAuth Authorization Server
2. Glean auto-registers the host as an OAuth client (if DCR is enabled for the tenant)
3. User completes SSO sign-in with their organization's SSO provider
4. Host receives per-user access token scoped to that user's Glean permissions
5. All subsequent MCP tool calls use this token — results are permission-filtered for that user

**Admin controls on DCR:**
- Tenant can allow any DCR-capable application
- Restrict registration to a Glean-managed approved application list
- Turn DCR off entirely (requires static OAuth client registration)
- New tenants default to Glean-managed approved list; existing tenants keep their config

**Fallback:** Glean-issued API tokens can be used when the host cannot complete OAuth. API Token Creator role assignment is discouraged for bulk MCP rollout.

### 6.4 Tools Exposed by the Remote MCP Server

Glean's admin console includes an "MCP tools" management section. From docs, the Remote MCP Server exposes:

| Tool Name | Description | Permission Required |
|---|---|---|
| `search` | Full-text + semantic search across indexed corpus | User's existing Glean access |
| `chat` | AI assistant chat grounded in company knowledge | User's existing Glean access |
| `document_retrieval` | Fetch specific document by ID | User must have read access to that document |
| `employee_search` | People directory search | User's existing access |
| `agent_run` | Invoke a configured Glean agent | User must be in agent's allowed-user list |
| (connector-specific tools) | Actions in connected apps (e.g., create Jira ticket) | Per-tool permission set by admin |

Admins control which tools are exposed via the MCP server from the admin console. Individual users can further configure tool permissions (Always allow / Needs approval per call).

### 6.5 Docs MCP Server (Public)

The Docs MCP Server at `https://developers.glean.com/mcp` provides access to Glean's developer documentation. It is publicly accessible with no authentication — useful for coding assistants to look up Glean SDK usage, API schema, and connector implementation patterns.

This is a clever positioning move: Glean makes it easy for Claude Code, Cursor, and Codex to help developers build on Glean by giving them native documentation access.

### 6.6 Rate Limits

Glean does not publish exact rate limits in public documentation. The developer docs reference a "Rate Limits and Retries" page but the content was not accessible at research time. Known patterns from customer implementations:

- Client API: rate limited per-tenant; exact limits determined by contract tier
- Platform API (experimental preview): additional rate limits as it scales out of beta
- MCP server: rate limits inherited from the underlying API endpoint being called

**Our implementation note:** We should publish explicit rate limits in our MCP server. Glean's opacity here is a competitive disadvantage we can exploit.

### 6.7 MCP Server Response Format

The MCP server returns structured JSON tool responses. For a `search` tool call the response includes:
- `results` array: document metadata, snippets, source URLs
- `trackingToken`: for telemetry (we do not need this)
- `sessionInfo`: for multi-turn conversation continuity

---

## 7. Developer APIs: Full Surface Area

Glean exposes three distinct API layers: **Platform API**, **Client API**, and **Indexing API**. These are not the same thing.

Source: [developers.glean.com](https://developers.glean.com)

### 7.1 Platform API (Experimental Preview, 2026)

The newest and most powerful API. Designed for building external applications that use Glean as the knowledge backend.

**Base URL:** `https://<tenant_id>-be.glean.com/api/platform/v1/`

**Auth:** OAuth (per-user) for Chat, Search, Agents calls; API token for admin operations

**Endpoints:**

| Category | Endpoints |
|---|---|
| **Agents** | `POST /agents/run` — invoke an agent; `GET /agents/{id}` — get agent definition |
| **Chat** | `POST /chat` — send message, get grounded response with citations |
| **Search** | `POST /search` — full search query; `GET /search/suggest` — autocomplete |
| **Skills** | `GET /skills` — list available skills; `POST /skills/{id}/invoke` |
| **Triggers** | `POST /triggers` — create event trigger; `GET /triggers/{id}` |
| **OpenAPI Spec** | `GET /openapi.json` |

**Python example (from developers.glean.com):**
```python
from glean.api_client import Glean

with Glean(
    api_token=os.environ["GLEAN_API_TOKEN"],
    server_url=os.environ["GLEAN_SERVER_URL"],
) as client:
    response = client.client.chat.create(
        messages=[{"fragments": [{"text": "Summarize the Q3 roadmap"}]}]
    )
    answer = "".join(
        f.text or ""
        for m in response.messages or []
        for f in m.fragments or []
    )
```

**TypeScript example:**
```typescript
import { GleanClient } from "@gleanwork/api-client";

const glean = new GleanClient({
  apiToken: process.env.GLEAN_API_TOKEN!,
  serverUrl: process.env.GLEAN_SERVER_URL!,
});

// Search
const results = await glean.client.search.query({
  query: "quarterly reports",
  pageSize: 10,
});
const titles = results.results?.map(r => r.title) ?? [];

// Chat
const chatResponse = await glean.client.chat.create({
  messages: [{ fragments: [{ text: "What is our vacation policy?" }] }],
});
```

### 7.2 Client API

The legacy (but stable) API, still recommended for production use. More feature-rich than Platform API.

**Base URL:** `https://<tenant_id>-be.glean.com/rest/api/v1/`

**Categories and endpoints:**

| Category | Key Endpoints |
|---|---|
| **Activity** | Track user interactions for relevance signals |
| **Agents** | Create, run, list agents |
| **Announcements** | Manage company announcements |
| **Answers** | Curated Q&A pairs |
| **Authentication** | OAuth tokens, API keys |
| **Chat** | Chat API (same functionality as Platform API) |
| **Documents** | Fetch, summarize documents |
| **Collections** | Knowledge collections management |
| **Entities** | People and org chart data |
| **Governance** | Content controls, DLP |
| **Insights** | Usage analytics |
| **Messages** | Messaging integrations |
| **Pins** | Curated content pins |
| **Search** | Full search, faceted search |
| **Shortcuts** | Go links and shortcuts |
| **Summarize** | Document summarization endpoint |
| **Tools** | Tool management |
| **Verification** | Content verification workflows |

### 7.3 Indexing API

Used to push custom data into Glean. This is what the Indexing SDK wraps.

**Base URL:** `https://<tenant_id>-be.glean.com/api/index/v1/`

**Key endpoints:**

| Endpoint | Method | Purpose |
|---|---|---|
| `/datasource` | POST | Create or update a datasource definition |
| `/document` | POST | Index a single document |
| `/documents/bulk` | POST | Bulk document indexing |
| `/documents/delete` | POST | Delete indexed documents |
| `/permissions` | POST | Update document ACLs |
| `/people` | POST | Index people records |
| `/people/bulk` | POST | Bulk people indexing |
| `/shortcuts` | POST | Index keyboard shortcuts / go links |

**Datasource definition (creates a new connector):**
```json
{
  "name": "my-catalog",
  "displayName": "Product Catalog",
  "homeUrl": "https://catalog.internal.company.com",
  "objectDefinitions": [
    {
      "name": "ProductPage",
      "displayLabel": "Product Page",
      "propertyDefinitions": [
        { "name": "sku", "displayLabel": "SKU", "propertyType": "TEXT" },
        { "name": "category", "displayLabel": "Category", "propertyType": "TEXT" }
      ]
    }
  ]
}
```

**Document push with permissions:**
```json
{
  "document": {
    "id": "catalog-sku-12345",
    "datasource": "my-catalog",
    "objectType": "ProductPage",
    "title": "Widget Pro X3000",
    "body": {
      "mimeType": "text/plain",
      "textContent": "The Widget Pro X3000 is our flagship..."
    },
    "viewURL": "https://catalog.internal.company.com/products/widget-pro-x3000",
    "author": { "email": "alice@company.com" },
    "createdAt": "2026-01-15T10:00:00Z",
    "updatedAt": "2026-06-01T14:30:00Z",
    "permissions": {
      "allowAnonymousAccess": false,
      "allowedUsers": [
        { "email": "alice@company.com" },
        { "email": "bob@company.com" }
      ],
      "allowedGroups": [
        { "name": "product-team" },
        { "name": "sales-team" }
      ]
    }
  }
}
```

### 7.4 Client Libraries

| Language | Package | Install |
|---|---|---|
| Python | `glean-api-client` | `pip install glean-api-client` |
| TypeScript/JavaScript | `@gleanwork/api-client` | `npm install @gleanwork/api-client` |
| Java | `com.glean.api-client` | Maven/Gradle |
| Go | `github.com/gleanwork/api-client-go` | `go get github.com/gleanwork/api-client-go` |

### 7.5 Web SDK

The Web SDK lets teams embed Glean search and chat directly in their own applications.

**Install:**
```bash
npm install @gleanwork/web-sdk
```

**Usage:**
```typescript
import {
  renderSearchBox,
  renderSearchResults,
  renderChat,
} from "@gleanwork/web-sdk";

// Render a search box
renderSearchBox(searchEl, {
  backend: "https://acme-be.glean.com",
  onSearch: (query) => renderSearchResults(resultsEl, { query }),
});

// Render a chat widget
renderChat(chatEl, {
  backend: "https://acme-be.glean.com",
});
```

All results are permission-aware: the Web SDK uses the current user's OAuth session to filter results.

### 7.6 Indexing SDK (Custom Connectors)

```python
from glean.indexing.connectors import BaseDatasourceConnector

class CatalogConnector(BaseDatasourceConnector):
    def get_data(self):
        return load_catalog_pages()

connector = CatalogConnector(name="catalog")
connector.index_data(mode=IndexingMode.FULL)
```

### 7.7 Agent Toolkit

The agent toolkit exposes Glean retrieval as tools for major agent frameworks:

```python
from glean.agent_toolkit.tools import search, employee_search

# LangChain
lc_search_tool = search.as_langchain_tool()
lc_people_tool = employee_search.as_langchain_tool()

# CrewAI
crew_tool = search.as_crewai_tool()

# OpenAI Agents SDK
oai_tool = search.as_openai_tool()

# Google ADK
adk_tool = search.as_google_adk_tool()
```

```typescript
import { createGleanSearchTool } from "@gleanwork/agent-toolkit";

const searchTool = createGleanSearchTool({
  apiToken: process.env.GLEAN_API_TOKEN!,
  serverUrl: process.env.GLEAN_SERVER_URL!,
});

// Use with LangChain.js
// Use with Vercel AI SDK
// Use with any framework expecting tool definitions
```

---

## 8. Agent Builder Platform

### 8.1 Overview

Glean's agent system has five components:

| Component | Purpose |
|---|---|
| **Agent Builder** | No-code and API-driven agent creation |
| **Agent Orchestration** | Multi-step, multi-agent coordination (agent harness) |
| **Agent Governance** | Runtime controls, guardrails, human-in-the-loop |
| **Agent Library** | Discoverable, reusable agent catalog |
| **Agent Harness** | Planning and adaptation engine for complex tasks |

### 8.2 Agent Builder

Agents are defined with:
- **Trigger**: what starts the agent (user message, calendar event, webhook, schedule, API call)
- **Knowledge sources**: which connectors and tools the agent can access
- **Tools/Actions**: what the agent can do (search, create Jira ticket, send Slack message, etc.)
- **Model selection**: which LLM from the Model Hub to use
- **System prompt / instructions**: behavioral guardrails
- **Output format**: structured data, free text, or action dispatch

Example from the cookbook (RFP Answer Agent):
1. Trigger: user provides RFP + number of questions
2. Agent extracts questions from RFP
3. Loops through each question
4. For each: searches Glean knowledge base, drafts answer with citations
5. Outputs to Google Sheets

### 8.3 Headless Agent Builder via API

From the cookbook:
```python
from glean.api_client import Glean

with Glean(
    api_token=os.environ["GLEAN_API_TOKEN"],
    server_url=os.environ["GLEAN_SERVER_URL"],
) as glean:
    res = glean.client.agents.create_and_wait_run(
        agent_id="agent_123",
        input={"query": "Analyze monthly sales performance"}
    )
    print(res)
```

Agents can also be built and tested headlessly from Claude Code or Cursor by pointing at the Glean MCP server (cookbook: "Build a customer email agent with Glean Headless Agent Builder").

### 8.4 AWARE Framework (Agent Governance)

Glean introduced the "AWARE" framework for safe agent deployment:

- **A**ction guardrails: what actions agents can and cannot take
- **W**orkflow controls: human-in-the-loop approval before write operations
- **A**udit trails: complete log of every agent decision and action
- **R**ule enforcement: hard constraints the agent cannot override
- **E**scalation paths: what happens when the agent can't proceed

From [glean.com/platform/api](https://glean.com/platform/api): "Take action with enterprise controls. Set clear boundaries for what agents can and can't do, with actions that respect user permissions and human-in-the-loop controls that let you require approval before execution."

### 8.5 Agent Triggers

From the Platform API, Glean supports these trigger types:
- **User message** (conversational, one-shot)
- **Webhook** (external system calls Glean)
- **Calendar event** (meeting starts, scheduling change)
- **Schedule** (cron-style recurring triggers)
- **Document change** (when a specific document is updated)

### 8.6 How We Implement an Agent in Our MCP Server

The simplest agent pattern using our MCP server as a tool:

```typescript
// Our MCP tool definition for agents to call
const enterpriseSearchTool = {
  name: "enterprise_knowledge_search",
  description: "Search your organization's internal knowledge base. Returns permission-filtered results from SharePoint and Confluence.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query"
      },
      sources: {
        type: "array",
        items: { type: "string", enum: ["sharepoint", "confluence", "all"] },
        description: "Which knowledge sources to search",
        default: ["all"]
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return",
        default: 10
      }
    },
    required: ["query"]
  }
};

// Handler enforces permissions using caller's identity
async function handleEnterpriseSearch(
  params: { query: string; sources?: string[]; maxResults?: number },
  callerIdentity: PermissionContext
): Promise<SearchResult[]> {
  const results = await permissionAwareSearch(
    params.query,
    callerIdentity,
    vectorStore
  );
  return results.slice(0, params.maxResults ?? 10);
}
```

---

## 9. Governance, Security, and Compliance

### 9.1 Security Certifications

| Certification | Status |
|---|---|
| SOC 2 Type II | Certified |
| ISO 27001 | Certified |
| ISO 42001 (AI management) | Certified |
| HIPAA | Compliant |
| GDPR | Compliant |
| TX-RAMP Level 2 | Certified |
| FedRAMP | Not listed (BYOC/GCP path may satisfy) |

### 9.2 Glean Protect

"Glean Protect" is the governance and DLP subsystem:

| Feature | What It Does |
|---|---|
| **Sensitive findings dashboard** | Scans indexed content for PII, credentials, sensitive data patterns |
| **AI Security models** | Validates agent actions before execution — Glean calls these "AWARE" guardrails |
| **Content controls** | Admin-configurable filters on what gets indexed |
| **Agent sandbox** | Agents run in an isolated execution environment |
| **Programmatic Tool Calling (PTC)** | Controlled interface for agent tool invocations with audit trail |

From admin docs: Protect has two tiers — Protect (base) and Protect+ (extended DLP and AI security).

### 9.3 Audit Logs

Glean maintains full audit logs of:
- User queries
- Documents returned in search results
- AI assistant queries and responses
- Agent runs: every step, tool call, and action
- MCP tool invocations (tracked in "MCP insights" dashboard)
- Admin configuration changes

Logs are exportable via "Glean customer event logs" — includes `WorkflowRun` events and `Queries` events with full schema.

### 9.4 Content Governance

- **Content hiding**: admins can exclude specific documents or data sources from indexing
- **User-generated content controls**: manage what users can pin, create answers, etc.
- **Agent governance controls**: per-agent permissions, allowed tools list, human-in-the-loop checkpoints
- **Model restrictions**: admins can exclude or restrict specific LLMs from being used

### 9.5 Data Isolation

All customer data is stored in the customer's **single-tenant cloud project** (GCP or AWS — see Section 11). There is no multi-tenancy of the data store. Indexed content is encrypted at rest and in transit. Data never leaves the tenant's project.

---

## 10. Enterprise Flex Pricing: Complete Rate Card

### 10.1 Pricing Structure Overview

Glean Enterprise Flex has two billable components:

1. **Enterprise Flex Seats** — per-user, per-month license for base access
2. **FlexCredits** — pooled consumption credits for advanced AI features

Glean publishes no dollar amounts anywhere. AWS Marketplace lists the seat dimension at $100,000,000/year as a placeholder. Third-party estimates from G2, workativ.com, and exploreagentic.ai cluster around:

- **Seat cost:** ~$40–$50/user/month
- **Reported minimum contract:** ~100 seats, ~$60K/year entry floor
- **FlexCredit cost:** ~$0.25–$0.50/credit (not published; negotiated per order form)
- **Developer Tools / Client APIs:** consume FlexCredits at published rate card

Source: [docs.glean.com/glean-enterprise-flex-pricing](https://docs.glean.com/glean-enterprise-flex-pricing), [workagent.ai/glean-pricing](https://workagent.ai/glean-pricing)

### 10.2 What a Seat Includes

Each Enterprise Flex Seat includes:

| Feature | Limit | Notes |
|---|---|---|
| Fast Mode queries | Unlimited | Basic search and chat; no advanced reasoning |
| Thinking Mode (standard models) | 100/user/week included | Excess consumes FlexCredits |
| Adaptive Reasoning (standard models) | 100/user/week included | Same pool as Thinking Mode |
| Collections & Go Links | Unlimited | |
| People Directory | Unlimited | |
| Agent Creation & Testing | Unlimited | Running agents consumes FlexCredits |
| Embedded integrations | Same entitlements as seat | Slack, Teams, Zoom, etc. |

### 10.3 FlexCredit Rate Card (Glean-Published, 2026)

Glean publishes consumption ranges but not dollar amounts. From [workagent.ai/glean-pricing](https://workagent.ai/glean-pricing) which cites Glean's own FlexCredit Terms document (version 9.25.25, checked August 2026):

| Capability | 50th percentile (credits) | 90th percentile (credits) | Notes |
|---|---|---|---|
| Fast Mode Assistant query | ~3 | ~15 | Marked as "unlimited" in seat; this is informational |
| Thinking Mode, standard models | ~7 | ~26 | 100/user/week included |
| Thinking Mode, premium models | ~35 | ~120 | Always consumes FlexCredits |
| Adaptive Reasoning, standard | ~11 | ~38 | 100/user/week included |
| Adaptive Reasoning, premium | ~26 | ~83 | Always consumes FlexCredits |
| Code Writer query | ~9 | ~32 | |
| Slide generation | ~45 | ~142 | High variance; team adoption can spike run rate |
| Deep Research run | ~33 | ~144 | Widest spread; 4x between median and 90th |
| Glean Agent run | ~7 | ~114 | 16x spread; cost depends on tools called |
| Meeting Notes | ~9/min | ~18/min | Per-minute billing; 60min meeting = 540–1,080 credits |
| Image generation | ~7 | ~9 | Tightest range |
| Voice session | ~3 | ~26 | |

**Important note (August 2026):** GPT 5.6 Luna reclassified from Premium to Standard, lowering its credit cost. GPT 5.6 Sol and Terra remain Premium.

Source: [usagepricing.com/blueprint/activity/glean-2026-08-04-price-change](https://www.usagepricing.com/blueprint/activity/glean-2026-08-04-price-change)

### 10.4 Developer Tools Pricing

Client APIs (Search API, Chat API, Agents API) consume FlexCredits. The Web SDK, Authentication API, Activity API, Indexing API, Connector API, and Tools APIs are **unlimited** (not FlexCredit-metered).

This means: building a custom app that calls Glean search is metered. Indexing data into Glean is free.

### 10.5 Worked Example: 500-Seat Firm

From [exploreagentic.ai](https://www.exploreagentic.ai/insights/glean-flexcredits-explained/):

Setup: 500 seats, 12 power-user analysts, 488 light users. $50K annual FlexCredits pool at ~$0.35/credit = 142,857 credits.

Analyst usage per week (12 analysts):
- 20 standard chats × 1 credit = 20 credits
- 15 deep-research runs × 4 credits = 60 credits
- 5 code-interpreter runs × 5 credits = 25 credits
- Total: 105 credits/analyst/week × 12 analysts = 1,260 credits/week

Analyst annual burn: 1,260 × 50 weeks = **63,000 credits** from analysts alone.

Light user burn: 488 users × 1 credit/week × 50 weeks = **24,400 credits**.

Total estimated annual burn: ~87,400 credits of 142,857 available. Pool is not depleted — margin exists for organic growth.

**Key gotcha:** The 90th percentile variance (agent runs: 7–114 credits) means a poorly designed agent that makes many tool calls can consume a month's credit pool in an afternoon.

### 10.6 BYOC Discount

Enterprise Flex Seats and FlexCredits are **discounted** for customers who:
- Supply their own LLM API keys (BYOLLM)
- Self-host Glean in their private cloud (BYOC)

This compensates for the compute and model infrastructure costs the customer bears directly.

---

## 11. Deployment Models: SaaS, BYOC, and Customer-Hosted

### 11.1 Glean-Managed SaaS (Default)

The standard deployment. Customer data is stored in Glean's cloud infrastructure (GCP), in a **single-tenant project** dedicated to that customer. The tenant has its own:
- Query Endpoint (QE) at `https://<tenant_id>-be.glean.com`
- Isolated data store
- Dedicated connectors running in the tenant's project

All data is encrypted at rest and in transit. Data never crosses tenant boundaries.

### 11.2 Customer-Hosted Deployment (BYOC)

Glean supports deploying the entire data plane in the customer's own cloud:

| Cloud | Status |
|---|---|
| GCP | Supported |
| AWS | Supported |
| Azure | Not listed in docs (may be via partner arrangement) |

In BYOC mode:
- Customer runs Glean's software in their own cloud project
- Glean provides the software stack; customer operates the infrastructure
- All indexed data stays in the customer's project — never flows to Glean's cloud
- SSO, networking, and firewall rules are the customer's responsibility
- Customer may VPN-connect on-prem systems to the cloud project for ingestion

BYOC is required for FedRAMP, HIPAA, PCI-DSS, or data sovereignty mandates that prohibit third-party data hosting.

**Pricing note:** BYOC customers get a discount on Enterprise Flex Seats and FlexCredits because they bear the compute costs.

### 11.3 What "Self-Hosted" Means for Glean vs. Us

Glean's "customer-hosted" is not open-source self-hosting. The software is still Glean's proprietary code, deployed by Glean into the customer's cloud environment. The customer gets data sovereignty but not code access.

This is the key gap we fill: **markdown-for-agents-mcp is MIT-licensed, open-source, and truly self-hosted**. Vodacom (or any organization) gets:
- Full source code access
- No per-seat fees
- No FlexCredit meters
- No dependency on Glean's update model
- Data sovereignty by definition (the code runs on their servers)

---

## 12. IDE Integrations

Glean has first-class integrations with every major AI-enabled IDE and coding tool:

| Tool | Integration Type | How to Add |
|---|---|---|
| **Claude Code** | MCP, CLI install | `claude mcp add glean-developer-docs https://developers.glean.com/mcp --transport http --scope user` |
| **Cursor** | MCP, config file | JSON in `.cursor/mcp.json` |
| **VS Code** | MCP, CLI install | `code --add-mcp '{"name":"glean","type":"http","url":"..."}'` |
| **GitHub Copilot** | MCP (via VS Code) | Same as VS Code |
| **Windsurf** | MCP, config file | JSON with `serverUrl` |
| **JetBrains AI Assistant** | MCP, settings UI | Settings → Tools → AI Assistant → MCP |
| **Junie (JetBrains)** | MCP, config file | JSON config |
| **Goose** | MCP, extensions config | JSON extensions block |
| **Codex (OpenAI)** | MCP, CLI | `codex mcp add --url https://... glean-developer-docs` |
| **Antigravity** | MCP, config file | JSON `mcpServers` block |
| **OpenCode** | MCP, config file | JSON `mcp` block |
| **Gemini CLI** | MCP, CLI | `gemini mcp add --transport http ...` |

**Our implementation opportunity:** We should provide exactly this matrix for markdown-for-agents-mcp Phase 2. When the enterprise knowledge index is live, every developer in an organization should be able to connect their IDE to internal knowledge in one command.

The Glean Docs MCP Server pattern (public, no-auth, documentation-focused) is also directly applicable: we should ship a public MCP server for our own documentation so developers can ask Claude Code how to configure connectors without leaving their IDE.

---

## 13. Glean vs. Competitors

### 13.1 Feature Comparison Table

| Feature | Glean | Microsoft 365 Copilot | Guru | Onyx (open source) | Our MCP server (Phase 2) |
|---|---|---|---|---|---|
| **Connector count** | 275+ (native + MCP) | 100+ (M365-centric) | 60+ | 40+ | Planned: SharePoint, Confluence (Phase 2), extensible |
| **Permission-aware search** | Yes — retrieval layer | Yes — within M365 ecosystem | Partial | Yes (configurable) | Yes — Entra transitiveMemberOf |
| **Cross-vendor neutrality** | Yes | No — M365 only | Yes | Yes | Yes |
| **Self-hosted** | Limited (BYOC on GCP/AWS) | No | No | Yes (MIT) | Yes (MIT) |
| **Open source** | No | No | No | Yes (AGPL) | Yes (MIT) |
| **MCP server** | Yes — tenant-specific, OAuth | No (as of research) | No | No (roadmap) | Yes — tenant-specific, Entra auth |
| **Agent builder** | Yes — no-code + API | Copilot Studio | No | No | Not in scope Phase 2 |
| **Knowledge graph** | Yes — full entity graph | Partial (M365 entities) | No | No | Minimal (identity resolution) |
| **Public pricing** | No | $21–30/user/mo | $30/user/mo | Free (self-hosted) | Free (self-hosted) |
| **Min. contract** | ~100 seats, ~$60K/yr | Any size | Any size | None | None |
| **LLM flexibility** | 35+ models (Model Hub) | GPT-5 only | Limited | Any | Any |
| **Audit logs** | Yes — full | Yes (Microsoft Purview) | Partial | Yes | Planned Phase 2 |

### 13.2 Glean vs. Microsoft 365 Copilot

The battle is **ecosystem breadth vs. stack depth**.

| Dimension | Glean | M365 Copilot |
|---|---|---|
| Best at | Heterogeneous stacks (Google + Atlassian + Salesforce + Microsoft) | All-in Microsoft shops |
| LLM | Model-agnostic (GPT, Claude, Gemini, Llama, etc.) | GPT-5 only |
| Pricing | ~$40–50/seat/mo + FlexCredits | $21–30/user/mo (included in M365 E5) |
| Governance | Full Glean admin console | Microsoft Purview integration |
| Weak at | Microsoft-specific depth (Teams, Excel, Word native AI) | Non-Microsoft connectors |

**For Vodacom:** If they are standardized on Microsoft 365, Copilot is the path of least resistance for M365 content. But Vodacom likely also has Confluence (Atlassian), Jira, Salesforce, and custom systems — this is where Glean or our MCP server adds value beyond what M365 Copilot can reach.

### 13.3 Glean vs. Onyx

Onyx is the closest open-source competitor:

| Dimension | Glean | Onyx |
|---|---|---|
| License | Proprietary | AGPL (enterprise: commercial license) |
| Price | $40–50/seat/mo + credits | Free (self-hosted), enterprise license for support |
| Connectors | 275+ (many native, many MCP) | 40+ (all native, more limited) |
| Agent builder | Yes — full no-code + API | Limited |
| Knowledge graph | Full enterprise graph | Basic index |
| MCP server | Yes | On roadmap |
| Deployment | SaaS + BYOC | Self-hosted only |
| IDE integrations | All major IDEs | None (MCP in progress) |

**Our position vs. Onyx:** We are not building a Glean competitor or an Onyx clone. We are building a **focused MCP server** that gives AI agents web fetch + search today (Phase 1 is live), and adds enterprise knowledge index in Phase 2. The MIT license, sub-$60K/year cost advantage, and MCP-first architecture (vs. Onyx's chat-first architecture) are our differentiators.

---

## 14. Top 5 Patterns We Must Implement in Phase 2

### Pattern 1: Early-Binding ACL Filtering

**What Glean does:** ACL check happens at the retrieval layer before any document enters the LLM context. Documents the user cannot see never exist in the search results.

**How Glean implements it:** Each indexed document carries a normalized ACL (allowed users, allowed groups, denied users, denied groups). At query time, the user's group memberships are loaded and the ACL filter runs before similarity ranking.

**How we implement it:**

```typescript
// In our Postgres/pgvector schema:
CREATE TABLE knowledge_documents (
  id UUID PRIMARY KEY,
  source_system TEXT NOT NULL,           -- 'sharepoint' | 'confluence'
  source_id TEXT NOT NULL,               -- system-specific ID
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),                -- text-embedding-3-small
  allowed_user_ids TEXT[] DEFAULT '{}',  -- Entra object IDs
  allowed_group_ids TEXT[] DEFAULT '{}', -- Entra group IDs (from transitiveMemberOf)
  denied_user_ids TEXT[] DEFAULT '{}',
  denied_group_ids TEXT[] DEFAULT '{}',
  is_public BOOLEAN DEFAULT FALSE,       -- accessible to all tenant users
  metadata JSONB DEFAULT '{}',
  last_indexed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for ACL filtering
CREATE INDEX idx_allowed_groups ON knowledge_documents USING GIN(allowed_group_ids);
CREATE INDEX idx_allowed_users ON knowledge_documents USING GIN(allowed_user_ids);

-- Permission-aware search function
CREATE OR REPLACE FUNCTION search_with_acl(
  query_embedding vector(1536),
  caller_user_id TEXT,
  caller_group_ids TEXT[],
  result_limit INT DEFAULT 10
)
RETURNS TABLE(id UUID, title TEXT, content TEXT, similarity FLOAT)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.title,
    d.content,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM knowledge_documents d
  WHERE
    -- Not explicitly denied
    NOT (caller_user_id = ANY(d.denied_user_ids))
    AND NOT (d.denied_group_ids && caller_group_ids)
    -- And accessible
    AND (
      d.is_public
      OR caller_user_id = ANY(d.allowed_user_ids)
      OR d.allowed_group_ids && caller_group_ids
    )
  ORDER BY d.embedding <=> query_embedding
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;
```

**Why this matters:** If you implement ACL filtering at the display layer (post-retrieval), you leak document existence and content to unauthorized users via the LLM's context. This is a security vulnerability, not a UX issue.

### Pattern 2: Identity Resolution Between Source Systems and Entra ID

**What Glean does:** Resolves user identities across all connected systems into a canonical person entity, enabling group membership from one IdP (Entra) to gate access to content from another system (Confluence).

**How we implement it:**

```typescript
interface IdentityMapping {
  entraObjectId: string;      // authoritative
  email: string;              // join key across most systems
  sharepointUserId?: string;
  confluenceAccountId?: string;
  // Add other system IDs as needed
}

// Build identity map at index time, not query time
async function buildIdentityMap(
  entraClient: EntraIDClient,
  confluenceClient: ConfluenceClient
): Promise<Map<string, IdentityMapping>> {
  const identityMap = new Map<string, IdentityMapping>();
  
  // Get all users from Entra
  const entraUsers = await entraClient.listUsers();
  for (const user of entraUsers) {
    identityMap.set(user.mail.toLowerCase(), {
      entraObjectId: user.id,
      email: user.mail.toLowerCase(),
    });
  }
  
  // Resolve Confluence account IDs by email
  const confluenceUsers = await confluenceClient.listUsers();
  for (const cfUser of confluenceUsers) {
    const mapping = identityMap.get(cfUser.email.toLowerCase());
    if (mapping) {
      mapping.confluenceAccountId = cfUser.accountId;
    }
  }
  
  return identityMap;
}

// At ACL translation time for a Confluence page:
async function translateConfluenceACLToEntra(
  confluenceACL: ConfluenceRestrictions,
  identityMap: Map<string, IdentityMapping>
): Promise<ACLRecord> {
  const allowedGroupIds: string[] = [];
  const allowedUserIds: string[] = [];
  
  for (const restriction of confluenceACL.restrictions.read.restrictions.group.results) {
    // Map Confluence group name to Entra group ID
    const entraGroupId = await resolveConfluenceGroupToEntra(restriction.name);
    if (entraGroupId) allowedGroupIds.push(entraGroupId);
  }
  
  for (const restriction of confluenceACL.restrictions.read.restrictions.user.results) {
    const mapping = identityMap.get(restriction.email?.toLowerCase() ?? '');
    if (mapping) allowedUserIds.push(mapping.entraObjectId);
  }
  
  return { allowedGroupIds, allowedUserIds, deniedGroupIds: [], deniedUserIds: [], isPublic: false };
}
```

### Pattern 3: Incremental Permission Sync with Webhook Support

**What Glean does:** Connectors listen for webhook events from source systems and update the permission store within seconds of a permission change. They also run periodic full-sync jobs for drift correction.

**How we implement it:**

```typescript
// Webhook handler for SharePoint permission changes
app.post('/webhooks/sharepoint', async (req, res) => {
  const notification = req.body as SharePointChangeNotification;
  res.status(202).send(); // Acknowledge immediately
  
  // Process async
  for (const change of notification.value) {
    if (change.changeType === 'created' || change.changeType === 'updated') {
      await syncDocumentACL(change.siteUrl, change.resource);
    } else if (change.changeType === 'deleted') {
      await deleteDocument(change.resource);
    }
  }
});

// Scheduled full ACL re-sync (runs nightly)
// Catches permission changes that webhooks missed
async function fullACLSync(source: 'sharepoint' | 'confluence') {
  const allDocumentIds = await listAllIndexedDocuments(source);
  for (const docId of allDocumentIds) {
    const currentACL = await fetchCurrentACL(source, docId);
    await updateDocumentACL(docId, currentACL);
  }
}
```

### Pattern 4: Multi-Source Federated Search with Result Merging

**What Glean does:** Queries multiple backends in parallel (SharePoint, Confluence, Jira, etc.), merges results using Reciprocal Rank Fusion (RRF), and re-ranks based on personalization signals.

**How we implement it:**

```typescript
// Federated search with RRF merging
async function federatedSearch(
  query: string,
  ctx: PermissionContext,
  sources: ('sharepoint' | 'confluence')[] = ['sharepoint', 'confluence']
): Promise<SearchResult[]> {
  // Generate embedding once
  const queryEmbedding = await generateEmbedding(query);
  
  // Search all sources in parallel
  const resultSets = await Promise.all(
    sources.map(source =>
      searchWithACL(queryEmbedding, ctx, source, topK: 50)
    )
  );
  
  // Reciprocal Rank Fusion
  const scores = new Map<string, number>();
  const k = 60; // RRF constant
  
  for (const results of resultSets) {
    results.forEach((result, rank) => {
      const current = scores.get(result.id) ?? 0;
      scores.set(result.id, current + 1 / (k + rank + 1));
    });
  }
  
  // Sort by RRF score and return top results
  const merged = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => findDocument(id, resultSets));
  
  return merged;
}
```

### Pattern 5: Streaming MCP Responses with Citation Tracking

**What Glean does:** Chat responses stream to the client with citation markers embedded. Each citation links to the source document with the exact snippet used. Only citations to documents the user can access are included.

**How we implement it:**

```typescript
// Streaming MCP tool handler with citation tracking
export async function handleKnowledgeChat(
  query: string,
  ctx: PermissionContext
): AsyncGenerator<string> {
  // Get permission-filtered context
  const contextDocs = await federatedSearch(query, ctx);
  
  // Build context with citation markers
  const contextText = contextDocs
    .map((doc, i) => `[${i + 1}] ${doc.title}\n${doc.content.slice(0, 1000)}`)
    .join('\n\n');
  
  // Stream LLM response
  const stream = await llm.stream({
    messages: [
      {
        role: 'system',
        content: `You are an enterprise knowledge assistant. Answer based only on the provided context. Cite sources using [1], [2] notation.\n\nContext:\n${contextText}`
      },
      { role: 'user', content: query }
    ]
  });
  
  // Track which citations were actually used
  const usedCitations = new Set<number>();
  let buffer = '';
  
  for await (const chunk of stream) {
    buffer += chunk;
    // Extract citation markers from streamed text
    const citations = [...buffer.matchAll(/\[(\d+)\]/g)];
    citations.forEach(m => usedCitations.add(parseInt(m[1])));
    yield chunk;
  }
  
  // Append verified citations at end of stream
  if (usedCitations.size > 0) {
    const citationBlock = '\n\n**Sources:**\n' + 
      [...usedCitations]
        .sort()
        .map(i => `[${i}] [${contextDocs[i-1].title}](${contextDocs[i-1].url})`)
        .join('\n');
    yield citationBlock;
  }
}
```

---

## 15. Glean vs. Building Ourselves: Honest Assessment for Vodacom Scale

### 15.1 What Glean Costs at Vodacom Scale

Vodacom has ~5,000 internal knowledge workers (rough estimate for engineering, IT, product, finance, legal). At Glean's pricing:

| Scenario | Seats | Seat cost (est. $45/user/mo) | Annual seat spend |
|---|---|---|---|
| Pilot (IT + Engineering) | 500 | $45 | $270,000/year |
| Full knowledge-worker rollout | 5,000 | $45 | $2,700,000/year |
| Agents + premium models (heavy use) | 5,000 + FlexCredits | $45 + variable | $3,000,000–$5,000,000+/year |

These are estimates. Actual Glean contracts would be negotiated lower at Vodacom scale, but the floor for 5,000 seats is unlikely to be below $1.5M/year.

### 15.2 What We Cost at Vodacom Scale

Our MCP server (markdown-for-agents-mcp + Phase 2 enterprise knowledge):

| Component | Cost |
|---|---|
| Software license | $0 (MIT) |
| Self-hosted infrastructure (estimated) | $30,000–$80,000/year (cloud compute for indexing + serving) |
| Implementation and integration | $50,000–$150,000 (one-time) |
| Maintenance | $20,000–$50,000/year (internal team time) |
| **Total Year 1** | **$100,000–$280,000** |
| **Total Year 2+** | **$50,000–$130,000/year** |

**10-year TCO comparison (5,000 seats):**
- Glean: $15M–$30M
- Our solution: $600K–$1.5M

### 15.3 What Glean Does That We Cannot Match (Honest)

| Capability | Glean | Our solution | Gap severity |
|---|---|---|---|
| 275+ native connectors | Yes | SharePoint + Confluence (Phase 2) | HIGH for orgs with >5 data sources |
| No-code agent builder | Yes | No | MEDIUM — agents use our MCP tools via Claude/Cursor |
| Knowledge graph (cross-system entity linking) | Full graph | Identity resolution only | MEDIUM for complex orgs |
| Real-time permission sync (sub-minute) | Yes | Near-real-time (webhook-driven) | LOW |
| Model Hub (35+ LLMs) | Yes | Configure any single LLM | LOW — bring your own |
| Meeting Notes, Slide Generation | Yes | No | LOW — scope creep |
| People directory / org chart search | Yes | Entra ID only | LOW |
| Enterprise graph queries | Yes | No | MEDIUM for advanced agent use cases |
| Global support SLA | Yes | Self-support + open-source community | HIGH for regulated industries |
| SOC 2 / ISO cert | Yes | Not yet | HIGH for compliance-heavy orgs |

### 15.4 What We Do That Glean Cannot

| Capability | Glean | Our solution |
|---|---|---|
| Open source (MIT) | No | Yes |
| Self-hostable without Glean involvement | No (BYOC still requires Glean) | Yes |
| Free | No | Yes |
| Customizable source code | No | Yes |
| Web fetch + search (Phase 1) | Partial (web results via Exa MCP) | Yes — core feature |
| Per-request MCP tool, no installation | No (requires tenant setup) | Yes — public HTTP endpoint |
| < 5 connector environment | Overkill | Right-sized |
| Hack-friendly / extend yourself | No | Yes |

### 15.5 Decision Framework for Vodacom

Build with markdown-for-agents-mcp Phase 2 if:
- Primary knowledge sources are SharePoint + Confluence (true for most M365 orgs)
- Budget constraint is real ($1M+/year for Glean is a blocker)
- Data sovereignty is non-negotiable (South African data must not leave SA infrastructure)
- Engineering capacity exists to run and maintain the system
- Connector count < 10 covers 90% of use cases

Buy Glean if:
- Knowledge is spread across 15+ heterogeneous SaaS apps, many non-Atlassian/Microsoft
- No-code agent builder for non-technical users is critical
- Compliance certifications (SOC 2, ISO) are a procurement requirement right now
- Budget is not a constraint
- No engineering team to maintain self-hosted infrastructure

**Recommendation:** Start with our MCP server. If the connector coverage gap becomes the limiting factor after 12–18 months of use (i.e., teams are complaining they cannot search ServiceNow or Salesforce), evaluate Glean as a data layer (use its Search API) while keeping our MCP server as the interface layer. This preserves the cost advantage while closing the connector gap.

---

## 16. What to Skip

### Do Not Build

| Feature | Reason |
|---|---|
| Meeting Notes / transcription | Scope creep; specialized compliance requirements; not in Phase 2 scope |
| Slide generation | Not knowledge retrieval; design tools do this better |
| Image generation | Not related to enterprise search |
| No-code agent builder UI | Building Claude Code / Cursor plugins for agents is more valuable than a GUI agent builder |
| People graph / org chart | Useful but complex; Entra ID already provides this for most of what we need |
| Code Writer | GitHub Copilot does this better; not our lane |
| Full entity graph | Start with identity resolution; add graph only when demanded |
| Model Hub (35+ LLMs) | Support the customer's chosen LLM; multi-model routing is a distraction |
| Deep Research / multi-step research agent | This is what users build using our tools, not what we build for them |

### Build Later (Phase 3+)

| Feature | When to Build |
|---|---|
| Jira connector | When demanded by engineering teams |
| Salesforce connector | When demanded by sales teams |
| Slack connector | When demanded by communication-heavy orgs |
| Content verification / Answers system | When search quality feedback loops matter |
| Usage analytics dashboard | When admins need chargeback data |
| A2A (agent-to-agent) protocol support | When multi-agent workflows become common |

---

## 17. Implementation Roadmap

### Phase 2 Sprint Sequence (Based on Glean Pattern Analysis)

**Sprint 1: Foundation (Weeks 1–3)**
- [ ] Postgres + pgvector setup with ACL schema (Pattern 1)
- [ ] Entra ID token validation middleware (Pattern 2)
- [ ] `transitiveMemberOf` group resolution and caching
- [ ] ACL-filtered vector search function (`search_with_acl`)

**Sprint 2: SharePoint Connector (Weeks 4–7)**
- [ ] SharePoint Graph API connector
- [ ] Content extraction (HTML, PDF, Office formats)
- [ ] Permission mapping: SharePoint permissions → Entra group IDs
- [ ] Webhook subscription for SharePoint change notifications (Pattern 3)
- [ ] Incremental sync job

**Sprint 3: Confluence Connector (Weeks 8–11)**
- [ ] Confluence Cloud API connector
- [ ] Content extraction (Confluence storage format → text)
- [ ] Permission mapping: Confluence groups → Entra group IDs via email identity resolution (Pattern 2)
- [ ] Polling-based sync (Confluence lacks webhooks for permission changes)
- [ ] Full re-sync scheduled job (nightly)

**Sprint 4: MCP Integration (Weeks 12–14)**
- [ ] New MCP tools: `enterprise_search`, `enterprise_chat`
- [ ] OAuth auth layer using Entra tokens (mirrors Glean's OAuth + DCR)
- [ ] Streaming responses with citation tracking (Pattern 5)
- [ ] IDE integration documentation (Claude Code, Cursor, VS Code)

**Sprint 5: Federated Search and Quality (Weeks 15–17)**
- [ ] RRF merging across SharePoint + Confluence (Pattern 4)
- [ ] Re-ranking with recency signals
- [ ] Relevance evaluation harness
- [ ] Audit logging for all search and chat calls

**Sprint 6: Production Hardening (Weeks 18–20)**
- [ ] Rate limiting per-user and per-tenant
- [ ] Retry logic and circuit breakers for source API calls
- [ ] Admin dashboard: index status, permission sync health, query logs
- [ ] Documentation site with MCP configuration snippets for all major IDEs

### Key Decision Points

**Q: Which vector dimension?**
Use 1536 (text-embedding-3-small). Cost-effective, good quality, works with pgvector. Only switch to 3072 (text-embedding-3-large) if retrieval quality is measurably insufficient for the specific domain.

**Q: Index chunking strategy?**
512-token chunks with 64-token overlap. Confluence pages should be chunked by section heading. SharePoint documents should be chunked by paragraph boundary. Do not chunk smaller than 256 tokens (context loss) or larger than 1024 tokens (embedding quality degrades).

**Q: How to handle Confluence spaces that use "open" permissions (accessible to all authenticated users)?**
Set `is_public = true` in the ACL. During search, any authenticated Entra user gets access. This is correct — if you can see it in Confluence without special permission, you can see it in our search.

**Q: What to do when a user's Entra token has expired mid-search?**
Return a 401 with `WWW-Authenticate: Bearer` and a descriptive error. The MCP client (Claude Code, Cursor) will surface this to the user and prompt re-authentication. Do not silently fall back to anonymous search.

---

## Sources

1. [developers.glean.com](https://developers.glean.com) — Developer portal, Platform API, Client API, Indexing API, MCP guides, Web SDK, agent toolkit, cookbook
2. [glean.com/connectors](https://glean.com/connectors) — Full connector catalog (scraped August 2026)
3. [glean.com/platform](https://glean.com/platform) — Enterprise Context, Personal Graph, Enterprise Graph, Agent products
4. [glean.com/platform/api](https://glean.com/platform/api) — API page with code examples
5. [docs.glean.com/connectors/about](https://docs.glean.com/connectors/about) — Connector types, data access modes
6. [docs.glean.com/glean-enterprise-flex-pricing](https://docs.glean.com/glean-enterprise-flex-pricing) — Official Enterprise Flex pricing documentation
7. [docs.glean.com/administration/management/usage/flexcredits-dashboard](https://docs.glean.com/administration/management/usage/flexcredits-dashboard) — FlexCredits usage dashboard
8. [docs.glean.com/security/architecture/data-flow](https://docs.glean.com/security/architecture/data-flow) — Query path, data ingestion, security architecture with real request/response schemas
9. [docs.glean.com/security](https://docs.glean.com/security) — Security overview, compliance, BYOC deployment
10. [developers.glean.com/guides/mcp/](https://developers.glean.com/guides/mcp/) — Remote MCP server setup, OAuth/DCR, supported hosts
11. [developers.glean.com/cookbook](https://developers.glean.com/cookbook) — Runnable implementation patterns
12. [developers.glean.com/cookbook/permissions-aware-rag](https://developers.glean.com/cookbook/permissions-aware-rag) — Permissions-aware RAG pattern
13. [glean.com/blog/secure-generative-ai-for-the-enterprise-requires-the-right-permissions-structure](https://www.glean.com/blog/secure-generative-ai-for-the-enterprise-requires-the-right-permissions-structure) — Glean engineering blog on permission architecture
14. [hyperdigitalpulse.com/blog/glean-security-acl-byoc-architecture-2026](https://hyperdigitalpulse.com/blog/glean-security-acl-byoc-architecture-2026) — Third-party deep-dive: three-layer security stack, ACL sync engine, BYOC model
15. [medium.com — Enterprise AI System Design: Inside Glean Architecture](https://medium.com/@kevinrt6911/enterprise-ai-system-design-atlassian-glean-architecture-a36d80f5bc7f) — Technical analysis including RRF + ACL filter pipeline
16. [exploreagentic.ai/insights/glean-flexcredits-explained](https://www.exploreagentic.ai/insights/glean-flexcredits-explained/) — FlexCredits field notes, credit cost estimates, worked example
17. [workagent.ai/glean-pricing](https://workagent.ai/glean-pricing) — FlexCredit rate card from Glean's own Terms document (version 9.25.25, checked Aug 2026)
18. [workativ.com/hr/blog/glean-pricing](https://workativ.com/hr/blog/glean-pricing) — Pricing model analysis, hidden costs, TCO
19. [aitrendtool.com/tools/glean](https://aitrendtool.com/tools/glean) — Independent review, verified pricing, alternatives comparison
20. [onyx.app/insights/enterprise-search-tools-2026](https://onyx.app/insights/enterprise-search-tools-2026) — Enterprise search tools comparison table including Glean, Onyx, Guru, Microsoft Copilot
21. [usagepricing.com/blueprint/glean](https://www.usagepricing.com/blueprint/glean) — Pricing structure tracking, plan details
22. [usagepricing.com/blueprint/activity/glean-2026-08-04-price-change](https://www.usagepricing.com/blueprint/activity/glean-2026-08-04-price-change) — August 2026 model reclassification (GPT 5.6 Luna to Standard)
