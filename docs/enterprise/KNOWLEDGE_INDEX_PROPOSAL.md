# Internal Enterprise Knowledge Index — Product Proposal

> **Status: proposal.** This document describes a possible product direction that extends
> `markdown-for-agents-mcp` into an enterprise knowledge indexing platform. No
> implementation has started. All cost figures are estimates. The document is intended to
> support a go/no-go decision, not to authorise build work.
>
> **Authored:** 2026-08-25

---

## 1. Recommendation

Build a **Phase 1 MVP**: a self-hosted, MCP-native knowledge index that crawls
SharePoint and Confluence, stores LLM-ready markdown, and exposes it to agents via
MCP tools. Scope Phase 1 to documents accessible to all authenticated employees —
deferred ACL enforcement removes the most complex technical risk and still covers the
majority of the corpus an agent needs (policy documents, runbooks, product
documentation, internal procedures).

Do not build this unless two preconditions hold: (a) there is a named agent workload
today that is blocked because the agent cannot see internal documents, and (b) the
sponsoring organisation can support 0.5–1.0 FTE of engineering for the initial build
period (12–16 weeks). Building infrastructure ahead of demand is the most common
failure mode in enterprise RAG projects.

If both preconditions hold, Phase 1 is a six- to eight-week project that produces
something demonstrable, and the existing codebase gives a meaningful head start.

---

## 2. What This Is

An enterprise knowledge index is a continuously updated store of LLM-ready markdown
derived from internal corporate sources. Agents query it via MCP tools instead of
making live API calls to source systems. The index sits between your agents and your
internal knowledge corpus, providing three things source-system APIs cannot:

**Speed.** A live Graph API call to retrieve a SharePoint page takes 200–500 ms plus
rendering time. An index lookup returns in milliseconds.

**Format.** SharePoint pages and Confluence pages are HTML with embedded macros,
navigation chrome, and JavaScript-rendered content. The index returns clean markdown
that an LLM can consume without prompt-padding noise.

**Unified access.** An agent does not need separate authentication and API knowledge
for each source system. It calls one MCP tool — `search_knowledge` — and the index
resolves across all connectors.

The product is not a general-purpose enterprise search engine. It is a purpose-built
retrieval layer for AI agents, designed for the same deployment posture
(`markdown-for-agents-mcp` already occupies: self-hosted, POPIA-compliant, MCP-native.

---

## 3. What This Is Not

**Not a Tavily or Firecrawl competitor.** Those products index the public web. The
public web is infinite, constantly changing, and already crawled by vendors with
billions of dollars of infrastructure. This product indexes a bounded, stable, private
corpus that vendors cannot access by definition.

**Not a general enterprise search UI.** There is no end-user search interface proposed
here. The consumers are AI agents, not humans typing queries into a search box.

**Not a replacement for Microsoft Copilot or Glean** in organisations that already use
them. This is the self-hosted alternative for organisations that cannot or will not
send internal documents to a US-hosted SaaS.

**Not a one-week project.** The SharePoint connector alone requires Microsoft Graph
integration, OAuth 2.0 service principal setup, delta query polling, and ACL extraction.
Phase 1 is realistic at six to eight weeks; the full three-phase roadmap is 12–18 months.

---

## 4. The Market Gap

### What exists

| Product | Self-hosted | MCP interface | Per-user ACL | POPIA-clean posture |
|---|:---:|:---:|:---:|:---:|
| Glean | No ‡ | No | Yes (sub-minute sync) | No (engineers retain access) |
| Microsoft 365 Copilot | No | Partial (directory only) | Yes (native M365) | Depends on SA region routing |
| Azure AI Search | No | Yes (cloud only) | Yes (token-based) | No |
| Atlassian Rovo MCP | No | Yes (cloud only) | Yes | No |
| AWS Kendra (af-south-1) | No | No | Yes | Partial (SA region but managed) |
| Elasticsearch / OpenSearch | **Yes** | No | Yes (complex) | **Yes** |
| Community SharePoint MCP servers | Yes | Yes | **No** (app-level) | Depends on deployment |

‡ Glean's "Customer Hosted" deploys Glean-managed infrastructure into your cloud
account. Glean engineers retain support access and manage all upgrades. It is not
self-hosted in the sense that you can modify or audit the running software.

The specific combination that does not exist: **self-hostable + MCP-native + per-user
ACL enforcement + multi-source aggregation**. Elasticsearch comes closest on the
self-host and ACL dimensions but has no MCP layer, no Playwright rendering, and
requires significant connector engineering to support multiple source systems.

### Why the gap is structural, not accidental

SaaS vendors cannot serve the POPIA-constrained market. Under POPIA Section 72,
indexing internal documents to a US-hosted service is a cross-border transfer of
personal information that requires legal justification (binding agreement, adequacy
finding, or data subject consent). For regulated SA enterprises — banks, insurers,
telecommunications operators — "we signed Glean's DPA" is not sufficient to satisfy
an internal DPO review. Only self-hosted software running entirely on infrastructure
within South Africa removes Section 72 risk entirely.

Microsoft 365's SA data centres reduce (but do not eliminate) cross-border risk for
M365 workloads, and M365 Copilot at $30/user/month on top of base licences is expensive
enough that a self-hosted alternative remains commercially interesting at medium scale.

The existing codebase already demonstrates that this organisation can build and
maintain a POPIA-compliant, self-hosted MCP server. The governance pack — POPIA
assessment, threat model, data flow inventory, SLO template, runbook — is in the repo
and applicable to an extended product with minimal additions.

---

## 5. Target Corpus

Ranked by value-to-build-cost ratio. Phase 1 covers Tier 1 only.

### Tier 1 — High value, well-defined APIs, universal in SA enterprises

**SharePoint / Microsoft 365** is the single highest-value source. Policy documents,
governance procedures, product documentation, compliance artefacts, and HR knowledge
bases all live in SharePoint at every large SA enterprise. The Microsoft Graph API
(mandatory since the SharePoint REST API sunset on 2 April 2026) provides delta
queries, webhook change notifications, and structured permission metadata. This is the
most important connector to build first.

**Confluence** (Cloud and Data Center) is where engineering teams store runbooks,
architecture decisions, deployment guides, and technical knowledge bases. The REST API
is well-documented, supports webhooks, and both Cloud (API tokens) and Data Center
(Personal Access Tokens) authentication are straightforward. Atlassian Data Center is
widely deployed in regulated SA enterprises that cannot use Cloud because of POPIA.
The official Atlassian Rovo MCP server is cloud-only, which means Data Center
deployments — a significant fraction of the regulated market — have no AI/MCP
integration path. This is a direct opportunity.

**Internal intranet and web portals** (SharePoint modern sites, custom internal web
apps, departmental portals) are already within the existing tool's core competency.
The Playwright renderer handles JavaScript-rendered pages that raw API fetches would
miss. This connector is largely free, built on existing infrastructure.

### Tier 2 — High value for specific departments

**ServiceNow knowledge base** — IT service management knowledge articles, known issues,
ITSM procedures, approved workarounds. Every large SA enterprise runs ServiceNow.
Agents answering IT support questions need this corpus. REST API with incremental
polling; ACL handled via User Criteria (role-based KB access). Estimated two weeks to
build a working connector.

**Jira and GitHub/GitLab wikis and README files** — engineering documentation, sprint
notes, architecture decision records stored as issues or wiki pages. The Atlassian
Cloud MCP server covers Jira if Cloud is acceptable; Data Center requires a custom
connector. GitHub/GitLab are lower-priority unless the agent workloads specifically
target engineering knowledge.

**PDF repositories** — term sheets, product schedules, regulatory submissions, board
papers stored in SharePoint document libraries or file shares. The existing Playwright
pipeline already handles PDF rendering via `pdf.js`; this is an extension of the
SharePoint connector, not a new connector.

### Tier 3 — Valuable but architecturally complex

**Microsoft Teams messages** — very high signal for decision context and project
history, but requires `ChannelMessage.Read.All` (an elevated admin-consent permission),
produces noisy content that is expensive to chunk meaningfully, and is regulated as
employee communication under multiple SA statutes. The ACL model is per-team and
per-channel. Defer to Phase 3 or exclude entirely; the risk-benefit ratio is poor
compared to Tier 1.

**Slack** — similar concerns to Teams. Additionally: Slack's Enterprise Grid rate
limits are aggressive for crawling workloads (Tier 3: 50 req/min for channel history).
Noisy, ephemeral content. Low priority.

**SAP and other ERP systems** — structured operational data (HR, finance, procurement).
Different extraction problem from document crawling. Requires schema mapping and
structured query interfaces, not a Playwright renderer. Out of scope for this proposal.

**Outlook/Exchange email archives** — highest sensitivity data in the enterprise.
Individual employee emails are personal information with the strongest POPIA protections
and legal privilege implications. Explicitly excluded from scope in all phases. The
downside risk (a single data breach exposing email archives) outweighs any retrieval
benefit.

---

## 6. Architecture

### 6.1 Core pipeline

```
Source systems                  Index pipeline                     Agent interface
─────────────                  ───────────────                     ───────────────
SharePoint     ──── Connector ──→ Fetch + Render (Playwright)  ──→ Chunk + Store
Confluence         (Graph API,   ↓                                  ↓
ServiceNow          REST API,    Extract markdown                  SQLite / Postgres
Intranet pages      webhooks)    ↓                                  ↓
                                ACL extract (groups, users)       BM25 search index
                                ↓                                  (Phase 1)
                                Chunk (semantic boundaries)       + Vector index
                                ↓                                  (Phase 2)
                                Store (content + ACL metadata)         ↓
                                                                   MCP tools:
                                                                   search_knowledge()
                                                                   get_document()
                                                                   list_sources()
```

**Rendering:** SharePoint modern pages and Confluence pages with rich macros are
JavaScript-rendered. Raw API content endpoints return markup that is noisy for LLMs.
The existing Playwright pipeline in `src/fetcher.ts` handles this correctly today.
Connectors call the same rendering pipeline with appropriate authentication headers
injected; this is a configuration extension, not a new capability.

**Chunking:** Long documents must be split before indexing. Naive fixed-length splitting
produces chunks that break across sentence or topic boundaries and degrades retrieval
quality. Phase 1 uses paragraph-boundary chunking (split on double newlines, merge
short paragraphs up to ~800 tokens). Phase 2 upgrades to semantic chunking using a
lightweight embedding model.

**Storage:** SQLite for Phase 1 deployments up to ~500k documents. Postgres for larger
deployments. Schema: `documents(url, source_type, title, raw_markdown, content_hash,
crawled_at, acl_json)` and `chunks(id, document_url, chunk_text, chunk_index, acl_json,
embedding blob)`. Content hash enables skip-on-unchanged crawls without fetching the
full document.

**Change detection:** Microsoft Graph delta queries return only changed items since the
last sync token — efficient for large SharePoint tenants. Graph subscriptions
(webhooks) trigger immediate re-crawl on document change; subscriptions expire after
30 days and must be renewed. Confluence webhooks provide equivalent coverage. For
sources without webhook support (ServiceNow), incremental polling on
`sys_updated_on >= last_crawl_timestamp` is the fallback.

### 6.2 The ACL problem and chosen approach

The ACL problem is the central technical challenge of this product. Getting it wrong
has two failure modes: over-sharing (an agent returns documents a user is not permitted
to see — a compliance incident) and under-sharing (an agent cannot answer a question
it should be able to answer — a product failure). Neither is acceptable in production.

**The wrong approach: application-layer post-retrieval filtering.** Retrieve the
top-K documents, then check permissions at the application layer and discard unauthorised
results before returning them to the LLM. This is insecure by design: unauthorised
content enters the retrieval pipeline before it is filtered. Glean's architecture
documentation explicitly identifies this as the pattern to avoid.

**Phase 1 approach: broad-access-only crawling.** Crawl only documents accessible to
all authenticated employees — content where the SharePoint permission is "Everyone
except external users" or the Confluence space permission includes all authenticated
users. Skip any document with restricted permissions. This entirely eliminates the ACL
enforcement problem: the index contains only content any authenticated employee is
permitted to see, so no per-user filtering is required at query time.

This is not a compromise — it matches the highest-value corpus. Policy documents,
product documentation, runbooks, and internal procedures are almost universally
broad-access content. The restricted content (M&A files, individual HR records,
executive communications) is precisely the content you do not want agents surfacing
without careful controls. Phase 1 defers that problem to Phase 2.

**Phase 2 approach: crawl-time ACL snapshot + query-time token enforcement.** This is
the production-grade pattern used by Azure AI Search (their published `x-ms-query-source-
authorization` approach) and by Elasticsearch's document-level security (DLS).

Implementation:

1. **At crawl time**, for each document, extract ACL metadata from the source system:
   - SharePoint: call `GET /sites/{siteId}/driveItems/{itemId}/permissions` via
     Microsoft Graph. Returns individual user principals and Entra ID group object IDs
     (GUIDs). Store as an array on the document record.
   - Confluence: call the space and page restrictions API. Map Confluence groups to
     Entra ID groups via the IdP.
   - Store the ACL as `acl_allowed: [guid1, guid2, user@corp.com, ...]` on each
     document and its derived chunks.

2. **At query time**, resolve the authenticated user's identity to their group
   memberships. Call Microsoft Graph `GET /users/{id}/transitiveMemberOf` to get all
   transitive group GUIDs (includes nested group memberships). Cache the result with a
   configurable TTL (default: 5 minutes) to avoid Graph rate limits.

3. **Inject a filter** into every search query: `acl_allowed CONTAINS ANY (user_email,
   group_guid_1, group_guid_2, ...)`. Results not matching the filter are excluded before
   the response is formed. No unauthorised document reaches the LLM.

**ACL staleness caveat.** Crawl-time snapshot means permission changes in the source
system are not reflected immediately. If a document's permissions are restricted after
crawl, it remains queryable for ACL-permitted users until the next incremental sync.
If permissions are broadened, the document is not visible until re-crawl. The sync
interval (configurable, default: 1 hour for incremental, 24 hours for full) is the
maximum staleness window. This is the same trade-off that Azure AI Search, AWS Kendra,
and Glean all make — real-time ACL enforcement at query time against live source systems
is computationally prohibitive at scale.

**ACL chunking invariant.** Every chunk derived from a document must carry the same
ACL metadata as its parent document. This is not automatic — the chunking pipeline must
explicitly propagate `acl_json` from the document record to each chunk record. Failure
to enforce this creates a gap where an agent can retrieve a chunk from a restricted
document even when the document-level ACL check would have blocked it.

### 6.3 Search

**Phase 1: BM25 keyword search** using SQLite FTS5 (built into SQLite, no external
dependency). BM25 is term-frequency/inverse-document-frequency ranking — fast, works
well for known-domain queries ("what is the roaming surcharge policy for Africa"),
and requires no embedding model or GPU. Limitations: does not handle synonyms or
semantic paraphrase ("remote work policy" vs "work from home guidelines").

**Phase 2: hybrid search** (BM25 + vector similarity). Add a lightweight embedding
model (`nomic-embed-text` or equivalent, runnable on CPU) to generate chunk embeddings.
Store embeddings in SQLite (via `sqlite-vec` extension) or Postgres (`pgvector`).
At query time, run BM25 and vector search in parallel, merge with reciprocal rank
fusion (RRF). This is the same RRF merge pattern already used in `src/search.ts` for
multi-provider search results.

**Phase 3: reranking.** Add a cross-encoder reranker (BGE-reranker or similar) to
re-score the top-K candidates from hybrid search before returning to the LLM. Improves
precision at the cost of latency (~100–200 ms for a small model on CPU).

### 6.4 MCP interface

Three tools sufficient for Phase 1:

```
search_knowledge(query: string, top_k?: number, sources?: string[]) → chunks[]
  Search the knowledge index. Returns document chunks ranked by relevance.
  Each chunk includes: text, source_url, document_title, source_type, crawled_at.
  If the server has ACL enforcement enabled, results are filtered to the requesting
  user's permitted documents. Without ACL enforcement (Phase 1), all indexed content
  is returned.

get_document(url: string) → document | null
  Retrieve the full markdown for a document by URL.
  Returns null if the URL is not indexed.

list_sources() → source_summary[]
  List all configured source connectors with document counts, last crawl time,
  and crawl status. Diagnostic tool.
```

The MCP server implementation extends the existing server in `src/server.ts`. The
existing `fetch` and `search` tools remain as-is — they handle live web rendering.
The new knowledge tools query the local index. Both tool sets are available on the
same server; the operator configures which are exposed via the existing tool-visibility
configuration.

---

## 7. Connector Specifications

### 7.1 SharePoint (Microsoft Graph)

**Authentication:** Entra ID app registration with `client_credentials` OAuth 2.0
grant. Required application permissions (admin consent required):
- `Sites.Read.All` — read SharePoint sites and pages
- `Files.Read.All` — read document library files
- `GroupMember.Read.All` — enumerate group memberships for ACL extraction
- `User.Read.All` — resolve user principals in ACL metadata

The SharePoint REST API (`/_api/`) was sunset 2 April 2026. All integrations must
use Microsoft Graph. Any code referencing `/_api/web/lists` or `/_api/search` is
broken on new tenants.

**Crawl strategy:**
1. Enumerate site collections via `GET /sites?search=*`
2. For each site, enumerate document libraries via `GET /sites/{id}/lists` filtered
   to `list.list.template == 101` (document libraries)
3. For each library, fetch items with delta query: `GET /sites/{id}/lists/{id}/items/delta`
4. For pages: `GET /sites/{id}/pages` (modern SharePoint pages)
5. For file content: download via `GET /drives/{id}/items/{itemId}/content`
6. Pass HTML/DOCX/PDF through existing rendering pipeline to produce markdown

**Change detection:** Register a Graph subscription on `/sites/{siteId}/lists/{listId}/items`
with 30-day expiry and daily renewal. On notification, queue the changed item for
re-crawl. Fallback: delta query poll on configurable interval (default: 1 hour).

**Rate limits:** Microsoft does not publish exact limits. HTTP 429 with `Retry-After`
header is the signal. Implement exponential backoff with jitter. Practical guideline:
~10,000 Graph requests per 10-minute window per app per tenant for most calls. Crawling
a 100,000-document library safely takes 2–4 hours at conservative throttle settings.

**ACL extraction (Phase 2):** `GET /drives/{driveId}/items/{itemId}/permissions` returns
all permission grants including groups (as Entra ID object IDs) and individual users.
Store as `acl_json` array on the document record.

### 7.2 Confluence

**Authentication — Cloud:** Create a service account and generate an API token via
`id.atlassian.com`. Use HTTP Basic auth: `Authorization: Basic base64(email:token)`.

**Authentication — Data Center:** Create a service account and generate a Personal
Access Token (available since DC 7.9, 2021). Use Bearer token auth:
`Authorization: Bearer <pat>`. PATs do not expire by default (configurable); rotate on
a schedule.

**Crawl strategy:**
1. List all spaces: `GET /wiki/rest/api/space?limit=50&type=global`
2. For each space, paginate pages: `GET /wiki/rest/api/space/{key}/content`
3. For each page, fetch body in `storage` format: `GET /wiki/rest/api/content/{id}?expand=body.storage,version`
4. Convert Confluence storage XML to markdown (existing HTML→markdown pipeline handles
   most of this; Confluence macros require custom handling for common types)
5. For attachments (PDFs, Office docs): download and pass through rendering pipeline

**Change detection:** Register webhooks for `page_updated`, `page_created`, `page_removed`
events via Confluence admin console or REST API. On Confluence Cloud, the March 2026
API points model has made polling expensive — prefer webhooks where available.

**Rate limits — Cloud:** Points-based model (enforced March 2026). Treat any HTTP 429
as a hard stop; back off exponentially. Recommended sustained rate: ≤1 request/second
per connector instance. For large Confluence instances (>10,000 pages) plan initial
crawl as an overnight job.

**ACL extraction (Phase 2):** Space-level: `GET /wiki/rest/api/space/{key}/permission`.
Page-level restrictions (individual page overrides): `GET /wiki/rest/api/content/{id}/restriction/byOperation`.
Map Confluence groups to Entra ID groups via the configured IdP mapping table.

### 7.3 Intranet pages and internal web apps

No new connector required — this is the existing Playwright rendering pipeline already
in `src/fetcher.ts`. The operator provides a list of seed URLs and crawl boundaries
(domain allowlist, path prefix allowlist). The existing `urlCache` becomes the basis
for the knowledge index store for these sources.

For Phase 1, ACL on internal web pages is assumed to be "all authenticated employees"
(network-boundary controlled). Fine-grained web ACLs would require integration with
whatever identity-aware proxy the intranet uses (e.g., Entra Application Proxy,
Cloudflare Access). Defer to Phase 2 or handle as a source-specific configuration.

### 7.4 ServiceNow (Phase 2)

**Authentication:** OAuth 2.0 Client Credentials grant (configure an OAuth app in
ServiceNow under System OAuth > Application Registry). Each instance has its own OAuth
server at `https://{instance}.service-now.com/oauth_token.do`.

**Crawl strategy:** Table API with incremental polling:
`GET /api/now/table/kb_knowledge?sysparm_query=sys_updated_on>={last_crawl}&active=true`
for knowledge articles. `GET /api/now/table/kb_knowledge_base` to enumerate bases.

**Change detection:** Polling only — ServiceNow's Business Rules can push changes
outbound but require admin configuration. Polling on `sys_updated_on` is the standard
integration pattern.

**ACL extraction (Phase 2):** ServiceNow KB User Criteria: `GET /api/now/table/kb_uc_can_read_mtom?sysparm_query=kb_knowledge_base={id}` to get read criteria for a KB. User Criteria can be based on role, group, or scripted conditions. Simple role-based criteria are extractable; scripted criteria require case-by-case interpretation.

---

## 8. Implementation Phases

### Phase 1 — MVP (6–8 weeks, ~0.75 FTE)

**Scope:** SharePoint connector + Confluence connector + intranet pages + SQLite index
+ BM25 search + three MCP tools + broad-access-only ACL policy.

**Definition of done:**
- An agent can call `search_knowledge("annual leave policy")` and receive relevant
  chunks sourced from SharePoint and Confluence
- The index is populated and kept current by a background crawl process
- Broad-access-only filter prevents restricted documents from entering the index
- Deployment runs on OpenShift (Mode G) with no new infrastructure cost
- `list_sources()` shows connector status and last-crawl timestamps
- Crawl logs are structured and queryable for debugging

**Deliverables:** Connector implementations, index schema and migrations, background
crawl scheduler, three MCP tools, operator documentation, POPIA addendum to existing
assessment.

**Does not include:** Per-user ACL enforcement, vector search, ServiceNow connector,
user-facing admin UI, SLO measurement (same caveat as current tool: SLOs TBD until
deployed and under load).

### Phase 2 — ACL enforcement and vector search (8–12 weeks, 1.0 FTE)

**Scope:** Entra ID group membership integration, crawl-time ACL extraction for
SharePoint and Confluence, query-time ACL filter injection, membership cache, vector
embeddings, hybrid search (BM25 + cosine), ServiceNow connector.

**Definition of done:**
- An agent acting for User A cannot retrieve a document that User A is not permitted
  to see in SharePoint
- ACL staleness is bounded by the configured sync interval (max 1 hour by default)
- Hybrid search demonstrably improves retrieval quality on paraphrase queries vs BM25
  alone (measured by recall@5 on a test query set)
- ServiceNow knowledge articles are indexed and searchable

**Does not include:** Reranking, Teams/Slack connectors, data-subject-rights deletion
tooling, multi-tenant support.

### Phase 3 — Production hardening (8–12 weeks, 0.5 FTE ongoing)

**Scope:** Data-subject-rights deletion (remove all chunks containing data about a
named individual — required under POPIA Section 23–25), TTL-based document expiry
(propagate source deletions to the index), reranking, admin dashboard showing connector
health and index coverage, Jira/GitHub connectors, SLO measurement and formal SLO
document.

---

## 9. Cost and Effort

### Build cost

| Phase | Calendar time | FTE | Engineering cost (0.5 FTE at R1.5M/yr) |
|---|---|---|---|
| Phase 1 MVP | 6–8 weeks | 0.75 FTE | ~R144k–R192k |
| Phase 2 ACL + vector | 8–12 weeks | 1.0 FTE | ~R240k–R360k |
| Phase 3 hardening | 8–12 weeks ongoing | 0.5 FTE | ~R120k–R180k |
| **Total to Phase 2** | **~5–6 months** | | **~R380k–R550k** |

### Infrastructure cost

Phase 1 and 2 can run on the existing OpenShift cluster (Mode G, $0 marginal infra).
Additional resource requirements per `docs/enterprise/COST_ANALYSIS.md` Mode G economics:
the index storage (SQLite or Postgres), a crawl scheduler process, and the connector
workers can all fit within existing cluster capacity at low-to-medium document volumes.

Estimated compute at 500k indexed documents:
- Persistent storage: 50–100 GB (markdown is compact; embeddings add ~1 GB per 100k
  chunks at 768-dim float32)
- Memory: 2–4 GB for the index server + crawl workers
- CPU: 0.5–1.0 cores sustained for crawl workers; burst to 2–4 during initial index

These fit comfortably within a right-sized OpenShift deployment. No new infrastructure
cost is anticipated for Phase 1 or 2 assuming the cluster already exists.

### Comparison to buying

**Glean Enterprise:** ~$50/user/month. At 500 users: $25,000/month ($300,000/year).
Glean engineers retain access (a POPIA concern). US-hosted.

**Microsoft 365 Copilot:** $30/user/month add-on. At 500 users: $15,000/month
($180,000/year) on top of existing M365 licensing costs. SA data centres available
but AI processing routing not fully resolved.

**AWS Kendra (GenAI edition, af-south-1):** ~$1,981/month for 200k documents at 25k
searches/day. Does not include connector engineering or embedding costs. No MCP
interface. Cloud-managed.

**Build (this proposal to Phase 2):** R380k–R550k one-time build cost, then $100/month
ongoing (Mode G engineering floor) or $527/month during setup amortisation period.
No per-user licensing. Full POPIA data sovereignty.

The build case is strongest when: (a) document volume is medium-to-large (above ~50k
documents), (b) POPIA posture rules out SaaS, and (c) the organisation already runs
OpenShift. All three conditions are likely true for the target buyer.

---

## 10. Risks and Ceilings

**1. SharePoint connector complexity is underestimated.** Microsoft Graph is
well-documented but has operational complexity: OAuth token refresh, tenant-specific
rate limit behaviour, delta token management, handling of large file types, and the
distinction between SharePoint pages (modern vs classic) and document library files.
Plan for this connector taking 3–4 weeks of the Phase 1 budget, not one.

**2. Confluence Data Center macros degrade markdown quality.** Confluence macros
(status indicators, panels, decision boxes, Jira issue links, code blocks, table of
contents) are stored as XML in the `storage` format and render inconsistently to
markdown. A `@` mention, a status lozenge, and a multi-level table of contents all
require custom handling. The resulting markdown may be noisy enough to harm retrieval
quality on macro-heavy content. Measure recall on a sample of your actual Confluence
corpus before committing to Phase 2.

**3. ACL group expansion at query time adds latency.** Calling Microsoft Graph
`transitiveMemberOf` on every search query adds ~100–300 ms of latency plus Graph rate
limit pressure. The membership cache mitigates this but introduces staleness. A user
added to a group will not see the corresponding documents until their cache entry
expires. A user removed from a group continues to see documents for up to the cache
TTL. Document the TTL as a configurable parameter and its staleness implication in the
operator documentation.

**4. Initial crawl time for large tenants is long.** A SharePoint tenant with 1 million
documents at conservative throttle settings takes 20–40 hours to fully crawl. Plan for
an initial crawl window, notify stakeholders, and ensure the index is available in
read-only (partially populated) mode during crawl. This is not a defect — it is an
inherent property of any index that must be bootstrapped from a large corpus.

**5. Data-subject-rights deletion is not in Phase 1.** Under POPIA Sections 23–25, a
data subject (an employee) can request erasure of their personal information from the
index. Phase 1 has no tooling to support this. If the sponsoring organisation's DPO
requires deletion capability before any indexed data can be held, Phase 1 is not
deployable without Phase 3's deletion tooling. Clarify this with the DPO before
starting Phase 1.

**6. This product does not exist in isolation.** The knowledge index is useful only in
conjunction with an agent that queries it. The value of Phase 1 depends entirely on
having an agent workflow that benefits from internal document retrieval. If no such
workflow exists at go-live, the index will not be used and the build cost will not be
recovered. The precondition in Section 1 is load-bearing.

**7. Scope creep into a general enterprise search product.** Enterprise search is a
product category with multi-year development timescales and dedicated teams. The
differentiated value here is the MCP interface, POPIA posture, and Playwright rendering
— not general enterprise search features (facets, entity extraction, spelling
correction, analytics dashboards). Resist feature requests that move toward general
search and away from the agent-consumption use case.

---

## 11. Decision Gates

Before committing to Phase 1 build:

- [ ] **Named agent workload identified.** There is a specific agent (in production or
  active development) that is blocked today because it cannot access internal documents.
  The agent team has confirmed they will integrate `search_knowledge` if it exists.
- [ ] **Sponsoring organisation can support 0.75 FTE for 8 weeks.** This is not a
  weekend project. If engineering capacity is constrained, defer.
- [ ] **POPIA DPO review.** Confirm with the DPO that: (a) indexing broad-access
  SharePoint and Confluence content is within the stated purpose of the AI platform,
  (b) Phase 1's broad-access-only policy is acceptable as a temporary ACL approach,
  and (c) the timeline for Phase 3 deletion tooling (if required before go-live).
- [ ] **Microsoft Graph app registration approved.** The `Sites.Read.All` and
  `Files.Read.All` permissions require admin consent from the M365 tenant administrator.
  This is a governance approval, not a technical step, and should be initiated early
  to avoid blocking Phase 1 delivery.
- [ ] **Confluence service account provisioned.** Either Cloud API token or Data Center
  PAT, with read access to the relevant spaces.
- [ ] **Scope of Phase 1 corpus agreed.** Which SharePoint sites and which Confluence
  spaces are in scope for Phase 1. Starting with a bounded corpus (one business unit,
  or one category of content) reduces initial crawl time and makes the MVP more
  demonstrable.

Before committing to Phase 2 (per-user ACL):

- [ ] **Phase 1 is in use.** At least one agent workload is actively using Phase 1 and
  the ACL gap (agents seeing content users are not permitted to see) is a real observed
  problem, not a theoretical one. If no ACL violation has been observed or reported,
  Phase 1 may be sufficient.
- [ ] **Entra ID app registration extended** to include `GroupMember.Read.All` and
  `User.Read.All` (additional admin consent required).
- [ ] **Group mapping strategy agreed** for Confluence groups on Data Center (which do
  not use Entra ID object IDs natively and require an IdP mapping table).

---

## 12. Relation to Existing Codebase

The `markdown-for-agents-mcp` codebase provides a meaningful head start:

| Existing capability | Reused for knowledge index |
|---|---|
| Playwright HTML→markdown renderer (`src/fetcher.ts`) | Core of all connector rendering pipelines |
| `urlCache` (in-memory, configurable TTL) | Extended to persistent SQLite store |
| RRF merge (`src/search.ts`) | Reused for hybrid BM25 + vector merge in Phase 2 |
| MCP server (`src/server.ts`) | Extended with three new tool registrations |
| POPIA assessment (`docs/enterprise/POPIA_ASSESSMENT.md`) | Updated with addendum for knowledge index data flows |
| Threat model (`docs/enterprise/THREAT_MODEL.md`) | Updated to cover new attack surfaces (ACL bypass, crawler poisoning) |
| Governance pack (all `docs/enterprise/` documents) | Templates for knowledge index governance extension |
| OpenShift deployment assets (`deploy/openshift/`) | Reused for knowledge index service deployment |

The primary new build is: connector implementations, index schema, ACL extraction and
enforcement logic, background crawl scheduler, and Phase 2 vector embedding pipeline.
The rendering and MCP layers are largely reused.

---

## 13. Open Questions

These are not blockers for the decision to proceed, but must be resolved before Phase 1
delivery:

1. **Which Confluence deployment model?** Cloud (API tokens, points-based rate limits)
   or Data Center (PATs, admin-configurable limits). Different authentication and rate
   limit handling; connector code diverges.
2. **SharePoint tenant structure.** Multi-site-collection tenants with geographic splits
   (e.g., one M365 tenant per country) require per-tenant app registrations. Confirm
   the tenant topology before designing the connector.
3. **Chunking strategy for Office documents** (DOCX, XLSX, PPTX in SharePoint
   document libraries). Playwright renders these via Office Online's web preview when
   available; native extraction via `python-docx`/`openpyxl` is an alternative. The
   approach affects rendering quality and infrastructure requirements.
4. **Embedding model choice for Phase 2.** `nomic-embed-text-v1.5` (768-dim, 512 token
   context, runs on CPU, ~300 MB model weight) is a reasonable starting point.
   Confirm whether the OpenShift cluster permits pulling model weights at runtime or
   whether they must be baked into the container image.
5. **Index freshness SLO.** What is the acceptable maximum staleness for indexed
   content? 1 hour? 4 hours? 24 hours? This drives the crawl frequency design and has
   direct cost implications (more frequent crawls = more Graph API calls = higher rate
   limit pressure).

---

*This document is a proposal, not an authorisation. See `docs/enterprise/PRODUCTION_AUTHORISATION.md`
for the authorisation gate that governs any production deployment of software in this
governance pack.*
