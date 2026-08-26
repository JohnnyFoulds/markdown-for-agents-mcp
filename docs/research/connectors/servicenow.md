# ServiceNow Connector Research

**Project:** markdown-for-agents-mcp  
**Phase:** 2 — Enterprise Knowledge Index  
**Last Updated:** 2026-08-26  
**Status:** Research complete, implementation ready

---

## Table of Contents

1. [Overview and Verdict](#1-overview-and-verdict)
2. [ServiceNow API Surface Map](#2-servicenow-api-surface-map)
3. [Authentication](#3-authentication)
4. [Table API: Core Reference](#4-table-api-core-reference)
5. [Key Tables and Schemas](#5-key-tables-and-schemas)
6. [Knowledge Base: kb_knowledge Deep Dive](#6-knowledge-base-kb_knowledge-deep-dive)
7. [sysparm_query: Complete Operator Reference](#7-sysparm_query-complete-operator-reference)
8. [Pagination and Field Selection](#8-pagination-and-field-selection)
9. [Incremental Sync Strategy](#9-incremental-sync-strategy)
10. [Attachment API](#10-attachment-api)
11. [GlideRecord Reference for Complex Queries](#11-gliderecord-reference-for-complex-queries)
12. [Record-Level ACL and Security Model](#12-record-level-acl-and-security-model)
13. [Rate Limits and Throttling](#13-rate-limits-and-throttling)
14. [TypeScript Connector Implementation](#14-typescript-connector-implementation)
15. [MCP Tool Design](#15-mcp-tool-design)
16. [Limitations, Failure Modes, and Gotchas](#16-limitations-failure-modes-and-gotchas)
17. [What to Build vs What to Skip](#17-what-to-build-vs-what-to-skip)

---

## 1. Overview and Verdict

ServiceNow is the dominant enterprise ITSM platform. Unlike Confluence or SharePoint, which are primarily document stores, ServiceNow is a structured database with a REST API that exposes every table in the system. For an AI agent connector, this means:

- **Incident, change, and problem records** are the primary operational data AI agents need to reason over
- **Knowledge Base articles** (table `kb_knowledge`) are the document layer most similar to Confluence
- **CMDB** records describe infrastructure and application topology
- **Access control is enforced at the service account level** — whatever roles the integration user has, that is exactly what the API returns; there is no per-query ACL bypass possible from outside the instance

**Recommendation for Phase 2:** Build three things, in priority order:

1. **Knowledge Base sync** (`kb_knowledge`) — closest to Confluence; published articles are clean markdown-convertible HTML
2. **Incident + Change read access** — high-value operational context for agents answering "what is broken right now?"
3. **CMDB CI lookup** — optional, adds depth for infrastructure-aware agents

Skip building a write path (creating incidents etc.) in Phase 2. The MCP use case is read-and-reason, not write-back. Keep the connector read-only to minimise the required service account permissions and reduce the security review surface.

**Sources:**
- ServiceNow Table API: `https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html`
- Knit developer guide: `https://www.getknit.dev/blog/servicenow-rest-api-integration-guide`
- SlingData connector docs: `https://docs.slingdata.io/connections/api-connections/servicenow`
- SDK Encoded Query guide: `https://servicenow.github.io/sdk/guides/encoded-query-guide`

---

## 2. ServiceNow API Surface Map

ServiceNow exposes multiple API surfaces. Choose the right one to avoid building on the wrong abstraction.

| API Surface | Endpoint Pattern | Use Case | External Integration |
|---|---|---|---|
| **Table API** | `/api/now/table/{tableName}` | CRUD on any table | Yes — primary surface |
| **Knowledge API** | `/api/now/km/knowledge` | Search KB articles, featured/most-viewed | Yes — supplementary to Table API |
| **Attachment API** | `/api/now/attachment` | List and download file attachments | Yes |
| **Aggregate API** | `/api/now/stats/{tableName}` | Count, sum, group-by without returning rows | Yes |
| **Import Set API** | `/api/now/import/{setName}` | Bulk historical data loads | Yes — but not for real-time |
| **Scripted REST API** | `/api/{namespace}/{version}/{api_id}` | Custom endpoints built inside the instance | Requires ServiceNow dev access to create |
| **GlideRecord (server-side)** | n/a (Business Rules, Script Includes) | Complex server-side queries and triggers | No — internal only |
| **Integration Hub** | n/a (Flow Designer) | Orchestrate external calls from SN flows | No — internal only |

**Decision:** The Table API covers everything we need for Phase 2. The Knowledge API adds search but the Table API gives us more control over field selection. Use Table API as the primary surface, Knowledge API as a search supplement.

Base URL pattern:
```
https://{instance}.service-now.com/api/now/table/{tableName}
```

There is no single ServiceNow. Every customer has their own instance at their own subdomain. This is the single most important architectural implication: instance URL must be collected at connector setup time. There are no shared OAuth endpoints.

Source: `https://www.getknit.dev/blog/servicenow-rest-api-integration-guide`

---

## 3. Authentication

### 3.1 The Three Options

| Method | Security | Complexity | Recommended For |
|---|---|---|---|
| Basic Auth (username:password in Base64) | Low | None | Dev/testing only |
| OAuth 2.0 Client Credentials | High | Medium | Server-to-server integrations |
| OAuth 2.0 Authorization Code | High | High | User-delegated access |

**For an MCP server connector:** Use OAuth 2.0 Client Credentials. The MCP server is a system, not a user. It authenticates as a dedicated service account with read-only roles.

**Warning (2026):** New ServiceNow PDIs (Personal Developer Instances) since mid-2026 reject REST basic auth by default with `401 "Required to provide Auth information"` unless the integration user has the `snc_basic_auth_api_access` role. Do not design production integrations around Basic Auth.

Source: GitHub note from `https://github.com/jschuller/mcp-server-servicenow`

### 3.2 OAuth 2.0: Per-Instance Architecture

ServiceNow OAuth is standard OAuth 2.0 mechanics, but every endpoint is instance-specific:

```
Token endpoint:  https://{instance}.service-now.com/oauth_token.do
Auth endpoint:   https://{instance}.service-now.com/oauth_auth.do
```

This means:
- Collect the customer's instance name before any OAuth flow
- Build all endpoints dynamically from the instance name
- Store per-customer: `{ instanceUrl, clientId, clientSecret, accessToken, refreshToken, tokenExpiry }`

### 3.3 Client Credentials Grant (Recommended)

```
POST https://{instance}.service-now.com/oauth_token.do
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
```

Response:
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "eyJ...",
  "scope": "useraccount"
}
```

Tokens expire after 30 minutes by default (configurable by the admin). Cache and reuse until expiry, then re-request with client credentials.

### 3.4 Authorization Code Grant (User-Delegated)

For scenarios where the agent should act as the connecting user (not a service account):

```
# Step 1: Redirect user to
GET /oauth_auth.do?response_type=code&client_id={id}&redirect_uri={uri}

# Step 2: Receive code, exchange it
POST /oauth_token.do
grant_type=authorization_code&code={auth_code}
&client_id={id}&client_secret={secret}&redirect_uri={uri}
```

Response includes `refresh_token`. Refresh before every call if the access token is expired:

```
POST /oauth_token.do
grant_type=refresh_token
&refresh_token={refresh_token}
&client_id={id}
&client_secret={secret}
```

### 3.5 Service Account Setup (Customer-Side)

The customer's ServiceNow admin must:

1. Navigate to **System OAuth > Application Registry > New > Create an OAuth API endpoint for external clients**
2. Configure: Name, Redirect URL, Token expiry (recommend 1800s), Refresh token expiry (recommend 86400s)
3. Note the auto-generated Client ID and Client Secret
4. Create a dedicated service account (`sys_user`) with:
   - **Web Service Access Only** checkbox enabled (prevents UI login, limits attack surface)
   - Minimum roles: `itil` (read incidents/changes), `knowledge` (read KB articles)
   - No admin roles

**Best practice:** Create one service account per integration, with exactly the roles needed. Do not share credentials between different external systems.

Source: `https://www.nowspectrum.com/blog/oauth2-servicenow-guide`; `https://www.jessems.com/posts/2026-01-08-scripted-rest-api-best-practices-in-servicenow/`

### 3.6 TypeScript Token Management

```typescript
interface ServiceNowAuth {
  instanceUrl: string;      // e.g., "https://mycompany.service-now.com"
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;        // Unix timestamp ms
}

async function getValidToken(auth: ServiceNowAuth): Promise<string> {
  // Refresh 60 seconds before expiry to avoid races
  if (Date.now() < auth.expiresAt - 60_000) {
    return auth.accessToken;
  }
  const resp = await fetch(`${auth.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const data = await resp.json();
  // Persist updated tokens to your store
  auth.accessToken = data.access_token;
  auth.refreshToken = data.refresh_token;
  auth.expiresAt = Date.now() + data.expires_in * 1000;
  return auth.accessToken;
}
```

---

## 4. Table API: Core Reference

### 4.1 Endpoint Matrix

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/now/table/{tableName}` | Fetch multiple records |
| `GET` | `/api/now/table/{tableName}/{sys_id}` | Fetch single record by sys_id |
| `POST` | `/api/now/table/{tableName}` | Create a record |
| `PATCH` | `/api/now/table/{tableName}/{sys_id}` | Partial update |
| `PUT` | `/api/now/table/{tableName}/{sys_id}` | Full replacement |
| `DELETE` | `/api/now/table/{tableName}/{sys_id}` | Delete a record |

For the Phase 2 read-only connector, only `GET` on both endpoints is needed.

### 4.2 Complete sysparm Parameters

| Parameter | Type | Description | Example |
|---|---|---|---|
| `sysparm_query` | string | Encoded query filter (full reference in section 7) | `active=true^priority<=2` |
| `sysparm_fields` | string | Comma-separated fields to return (always specify — reduces payload 10x) | `sys_id,number,short_description,state` |
| `sysparm_limit` | integer | Max records per page. Default: 10. Max: 10,000. | `100` |
| `sysparm_offset` | integer | Zero-based offset for pagination | `100` |
| `sysparm_display_value` | string | `true` returns display labels, `false` returns raw values, `all` returns both | `false` |
| `sysparm_exclude_reference_link` | boolean | Remove `{link, value}` objects from reference fields, return only the sys_id string | `true` |
| `sysparm_suppress_pagination_header` | boolean | Omit `X-Total-Count` response header (use when count query is expensive) | `false` |
| `sysparm_view` | string | Apply a named view to control which fields are returned | usually omit |
| `sysparm_query_no_domain` | boolean | Ignore domain separation (multi-domain instances only) | `false` |
| `sysparm_no_count` | boolean | Skip total count computation for performance | `true` when paginating |

**Key recommendation:** Always set `sysparm_exclude_reference_link=true` and `sysparm_fields` to a specific list. Without these, the response includes nested `{link, value}` objects for every reference field and all 100+ columns on the table, making payloads enormous.

### 4.3 Response Envelope

```json
{
  "result": [
    {
      "sys_id": "abc123...",
      "number": "INC0010001",
      "short_description": "VPN not working",
      "state": "1",
      "priority": "2"
    }
  ]
}
```

Single-record GET returns `"result": { ... }` (object, not array).

Pagination is done by checking the `X-Total-Count` response header:

```
X-Total-Count: 4832
```

### 4.4 Standard Request Headers

```
Authorization: Bearer {access_token}
Accept: application/json
Content-Type: application/json        (required for POST/PATCH/PUT)
X-no-response-body: false             (set true to suppress body on mutations)
```

Source: `https://sn.jace.pro/automations/inbound/rest/table-api/`; `https://www.getknit.dev/blog/servicenow-rest-api-integration-guide`

---

## 5. Key Tables and Schemas

### 5.1 Priority Tables for Phase 2

| Table | Description | Incremental? | Priority |
|---|---|---|---|
| `kb_knowledge` | Knowledge Base articles | Yes (sys_updated_on) | P1 |
| `incident` | IT incident tickets | Yes (sys_updated_on) | P1 |
| `change_request` | Change management records | Yes (sys_updated_on) | P2 |
| `problem` | Problem records | Yes (sys_updated_on) | P2 |
| `sc_req_item` | Service catalog requested items | Yes (sys_updated_on) | P3 |
| `cmdb_ci` | Configuration items (CMDB) | Yes (sys_updated_on) | P3 |
| `sys_user` | User accounts | Yes (sys_updated_on) | P3 (lookup only) |
| `sys_user_group` | Groups/teams | No (small, full-refresh) | P3 (lookup only) |
| `sys_attachment` | Attachment metadata | No | P3 |

### 5.2 incident Table Schema

Fields most useful for AI agents:

| Field | Type | Description | Notes |
|---|---|---|---|
| `sys_id` | string | Unique identifier (GUID) | Use for updates and links |
| `number` | string | Human-readable number (INC0000001) | Display in citations |
| `short_description` | string | One-line summary | Index for search |
| `description` | string | Full problem description | May contain HTML |
| `state` | integer | `1`=New, `2`=In Progress, `3`=On Hold, `6`=Resolved, `7`=Closed | |
| `priority` | integer | `1`=Critical, `2`=High, `3`=Moderate, `4`=Low, `5`=Planning | |
| `impact` | integer | `1`=High, `2`=Medium, `3`=Low | |
| `urgency` | integer | `1`=High, `2`=Medium, `3`=Low | |
| `category` | string | Broad classification (e.g., `network`, `hardware`, `software`) | |
| `subcategory` | string | Sub-classification | |
| `caller_id` | reference | `sys_user` sys_id of the person affected | Dot-walk `.name` for display |
| `assigned_to` | reference | `sys_user` sys_id of the assigned technician | |
| `assignment_group` | reference | `sys_user_group` sys_id | |
| `opened_at` | datetime | When the incident was created | ISO 8601 with timezone |
| `resolved_at` | datetime | Resolution timestamp | null if unresolved |
| `closed_at` | datetime | Close timestamp | |
| `work_notes` | string | Internal work log (write-only journal field) | Not returned by default |
| `comments` | string | Customer-visible comments (write-only journal) | Not returned by default |
| `close_notes` | string | Resolution notes | |
| `sys_created_on` | datetime | Record creation timestamp | |
| `sys_updated_on` | datetime | Last modification timestamp | Use for incremental sync |
| `sys_created_by` | string | Username who created the record | |
| `active` | boolean | Whether incident is open | |
| `escalation` | integer | Escalation level | |
| `reopen_count` | integer | Times this incident was reopened | |

**Note on journal fields:** `work_notes` and `comments` are append-only journal fields. When you read an incident, these fields return empty. To read the journal history, query the `sys_journal_field` table with `name=incident^element_id={sys_id}`.

### 5.3 change_request Table Schema

| Field | Type | Description |
|---|---|---|
| `sys_id` | string | Unique identifier |
| `number` | string | CHG0000001 |
| `short_description` | string | Change title |
| `description` | string | Detailed description |
| `state` | integer | `-5`=New, `-4`=Assess, `-3`=Authorize, `-2`=Scheduled, `-1`=Implement, `0`=Review, `3`=Closed, `4`=Cancelled |
| `type` | string | `normal`, `standard`, `emergency` |
| `risk` | integer | `1`=High, `2`=Medium, `3`=Low, `4`=Very Low |
| `priority` | integer | Same as incident |
| `requested_by` | reference | sys_user |
| `assignment_group` | reference | sys_user_group |
| `start_date` | datetime | Planned start |
| `end_date` | datetime | Planned end |
| `close_code` | string | `successful`, `successful_with_issues`, `unsuccessful` |
| `sys_updated_on` | datetime | For incremental sync |

### 5.4 cmdb_ci Table Schema

| Field | Type | Description |
|---|---|---|
| `sys_id` | string | Unique identifier |
| `name` | string | CI name (hostname, service name, etc.) |
| `sys_class_name` | string | CI type (`cmdb_ci_server`, `cmdb_ci_service`, etc.) |
| `operational_status` | integer | `1`=Operational, `2`=Non-operational, `3`=Repair in progress |
| `environment` | string | `production`, `development`, `test` |
| `ip_address` | string | Primary IP |
| `os` | string | Operating system |
| `owned_by` | reference | sys_user |
| `managed_by_group` | reference | sys_user_group |
| `assigned_to` | reference | sys_user |
| `location` | reference | cmn_location |
| `sys_updated_on` | datetime | For incremental sync |

CMDB uses table inheritance heavily. `cmdb_ci` is the base class. Use `sys_class_nameINSTANCEOFcmdb_ci_server` in sysparm_query to filter by subtype.

---

## 6. Knowledge Base: kb_knowledge Deep Dive

### 6.1 Table Schema

The `kb_knowledge` table is the core of ServiceNow's Knowledge Management module. It is the closest analog to Confluence pages.

| Field | Type | Description | Notes |
|---|---|---|---|
| `sys_id` | string | Unique identifier | |
| `number` | string | KB article number (KB0000001) | Display in citations |
| `short_description` | string | Article title | Primary display name |
| `text` | string | Article body (HTML) | Must convert to markdown |
| `wiki` | string | Alternate body field (wiki format) | Some instances use this instead of `text` |
| `question` | string | FAQ-style question field | Populated on FAQ articles |
| `answer` | string | FAQ-style answer field | Populated on FAQ articles |
| `workflow_state` | string | Article lifecycle state — see below | Filter on `published` |
| `active` | boolean | Whether the article is active | Always filter `active=true` |
| `kb_category` | reference | Knowledge base category | |
| `kb_knowledge_base` | reference | Which KB this belongs to | Multiple KBs common |
| `author` | reference | sys_user who owns the article | |
| `published` | datetime | When the article was published | |
| `valid_to` | datetime | Expiry date (can be null) | Filter out expired |
| `rating` | decimal | Average user rating | |
| `view_count` | integer | Total views | |
| `meta_description` | string | Short summary (if populated) | |
| `meta` | string | Search keywords | |
| `roles` | list | Roles required to view the article | ACL enforcement |
| `can_read_user_criteria` | list | User criteria that can read | Fine-grained access |
| `cannot_read_user_criteria` | list | User criteria that cannot read | Exclusion criteria |
| `sys_created_on` | datetime | Creation timestamp | |
| `sys_updated_on` | datetime | Last modified — use for incremental sync | |
| `sys_created_by` | string | Creator username | |

### 6.2 workflow_state Values

| Value | Meaning | Index? |
|---|---|---|
| `draft` | Not yet published, in authoring | No |
| `review` | Submitted for review | No |
| `published` | Live and visible to users | Yes |
| `retired` | Archived, no longer shown | No |
| `pending_retirement` | Flagged for retirement | No |

**Always filter** `workflow_state=published^active=true` when indexing for AI search. Draft and review articles often contain incomplete or incorrect information.

### 6.3 Multiple Knowledge Bases

Large enterprises have multiple knowledge bases (IT, HR, Finance, etc.). The `kb_knowledge_base` table lists them. To sync a specific KB:

```
sysparm_query=kb_knowledge_base={kb_sys_id}^workflow_state=published^active=true
```

To discover available KBs:
```
GET /api/now/table/kb_knowledge_base?sysparm_fields=sys_id,title,description,active&sysparm_query=active=true
```

### 6.4 Reading Article Body Content

The `text` field contains HTML. Some instances also populate `wiki` (wiki markup). Strategy:

1. Prefer `text` — it is always present on published articles
2. Convert HTML to markdown using a library like `turndown` (Node.js) or `html-to-text`
3. Check `question`/`answer` fields for FAQ articles — some instances use these instead of `text`
4. Strip HTML tags before indexing for semantic search

```typescript
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

function articleToMarkdown(article: KbKnowledge): string {
  const body = article.text || article.wiki || `${article.question}\n\n${article.answer}` || '';
  return turndown.turndown(body);
}
```

### 6.5 Knowledge Management REST API (Supplementary)

ServiceNow also exposes a dedicated Knowledge API at `/api/now/km/knowledge` with search and featured articles endpoints. This is distinct from the Table API.

- `GET /api/now/km/knowledge` — Full-text search with relevance scoring
- `GET /api/now/km/knowledge/{sys_id}` — Single article with rich metadata

The Knowledge API is useful for **agent-time search** (when the agent needs to find articles by query text). The Table API is better for **connector-time indexing** (when you want to pull and index all published articles).

Source: `https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/knowledge-api.html`

### 6.6 KB Article Attachments

Articles can have file attachments (PDFs, images, Word docs). These are metadata in `sys_attachment` and content accessible via the Attachment API. See section 10.

---

## 7. sysparm_query: Complete Operator Reference

The `sysparm_query` parameter accepts an encoded query string. This is the same format used everywhere in ServiceNow — list view URLs, GlideRecord `addEncodedQuery()`, ACL conditions, and notification filters.

### 7.1 Anatomy

A single condition: `{field}{OPERATOR}{value}`  
Multiple conditions: joined by `^` (AND), `^OR` (OR), or `^NQ` (New Query, OR between groups)

```
active=true^priority<=2^assignment_groupISNOTEMPTY
```

### 7.2 Complete Operator Table

| Operator | Meaning | Example |
|---|---|---|
| `=` | Equals | `state=1` |
| `!=` | Not equals | `state!=6` |
| `>` | Greater than | `priority>2` |
| `>=` | Greater than or equal | `priority>=2` |
| `<` | Less than | `priority<3` |
| `<=` | Less than or equal | `priority<=2` |
| `IN` | Value in comma-separated list | `priorityIN1,2,3` |
| `NOT IN` | Value not in list (space after NOT) | `stateNOT IN6,7,8` |
| `BETWEEN` | Inclusive range (number or date) | `priorityBETWEEN1@3` |
| `LIKE` | Case-insensitive substring (no `%` needed) | `short_descriptionLIKEnetwork` |
| `NOTLIKE` | Does not contain | `short_descriptionNOTLIKEtest` |
| `CONTAINS` | Same as LIKE for text fields | `short_descriptionCONTAINSoutage` |
| `DOES NOT CONTAIN` | Does not contain (has a space) | `short_descriptionDOES NOT CONTAINphish` |
| `STARTSWITH` | Begins with | `numberSTARTSWITHINC` |
| `ENDSWITH` | Ends with | `numberENDSWITH001` |
| `ISEMPTY` | Field is null or empty | `assigned_toISEMPTY` |
| `ISNOTEMPTY` | Field has any value | `assigned_toISNOTEMPTY` |
| `ANYTHING` | Matches all rows | `assigned_toANYTHING` |
| `INSTANCEOF` | Table hierarchy match | `sys_class_nameINSTANCEOFcmdb_ci_server` |
| `DYNAMIC` | Dynamic filter option by sys_id | `assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe` |

### 7.3 AND, OR, and Grouping

```
# AND: all conditions must match
active=true^priority<=2^assignment_groupISNOTEMPTY

# OR: either preceding or following condition matches
priority=1^ORpriority=2

# Equivalent shorthand using IN:
priorityIN1,2

# ^NQ — OR between two complete condition groups:
# "(active=true AND priority=1) OR (state=3 AND category=hardware)"
active=true^priority=1^NQstate=3^category=hardware
```

**Precedence gotcha:** `^OR` only binds the two adjacent conditions. For grouped OR logic across multiple ANDs, `^NQ` is required. Build complex queries in the ServiceNow list view filter UI and copy the resulting URL's `sysparm_query` parameter — the platform generates the correctly escaped string.

### 7.4 Date Operators

Absolute timestamps use instance timezone (important: not UTC unless the instance is configured for UTC):

```
sys_updated_on>=2026-01-01 00:00:00^sys_updated_on<=2026-01-31 23:59:59
```

Relative date macros (server-side JavaScript evaluation):

```
sys_updated_on>=javascript:gs.daysAgoStart(7)
sys_created_on>=javascript:gs.beginningOfThisMonth()
sys_created_on<=javascript:gs.endOfThisMonth()
```

Common macros:
- `gs.daysAgoStart(n)` / `gs.daysAgoEnd(n)` — n days ago (start/end of day)
- `gs.beginningOfToday()` / `gs.endOfToday()`
- `gs.beginningOfThisWeek()` / `gs.endOfThisWeek()`
- `gs.beginningOfThisMonth()` / `gs.endOfThisMonth()`
- `gs.beginningOfLastMonth()` / `gs.endOfLastMonth()`
- `gs.hoursAgoStart(n)` / `gs.hoursAgoEnd(n)`

**For incremental sync, use absolute ISO timestamps not relative macros.** Relative macros are for live filters; absolute timestamps give deterministic results across sync runs.

### 7.5 Dot-Walking (Reference Field Traversal)

Filter on fields of referenced records without a join:

```
# Incidents where caller is a VIP user
caller_id.vip=true

# Incidents where assignee is in the IT department
assigned_to.department.name=IT

# Incidents where location is in London
location.nameCONTAINSLondon
```

Dot-walking adds JOINs to the underlying SQL. Limit to 2 levels deep on large tables. Each level reduces index efficiency.

### 7.6 Ordering

Append ordering clauses at the end of the query:

```
active=true^ORDERBYDESCsys_created_on
priority<=2^ORDERBYpriority^ORDERBYDESCsys_updated_on
```

Operators: `^ORDERBY{field}` (ASC) and `^ORDERBYDESC{field}` (DESC). Multiple order clauses are applied left to right.

### 7.7 Escaping and Special Characters

Reserved characters in the query syntax: `^`, `,`, `@`, `=`, `!`, `<`, `>`

ServiceNow provides no escape character for these inside values. If a value contains `^`, the query cannot express it precisely — use `LIKE` for a substring match instead. URL-encode the entire `sysparm_query` parameter value in the HTTP request (spaces become `%20`, `^` becomes `%5E`).

Source: `https://servicenow.github.io/sdk/guides/encoded-query-guide`; `https://docs.noreja.com/en/article/using-advanced-queries-in-servicenow-api`

---

## 8. Pagination and Field Selection

### 8.1 Pagination Pattern

ServiceNow Table API uses limit/offset pagination. There is no cursor-based pagination.

```
GET /api/now/table/incident
  ?sysparm_limit=100
  &sysparm_offset=0
  &sysparm_query=active=true

Response header: X-Total-Count: 4832
```

To paginate:
1. First request: `sysparm_offset=0&sysparm_limit=100` — read `X-Total-Count: N` from response headers
2. Subsequent requests: increment `sysparm_offset` by `sysparm_limit` until `offset >= N`

```typescript
async function* paginateTable(
  instanceUrl: string,
  token: string,
  table: string,
  query: string,
  fields: string[],
  pageSize = 100,
): AsyncGenerator<Record<string, string>[]> {
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = new URL(`${instanceUrl}/api/now/table/${table}`);
    url.searchParams.set('sysparm_query', query);
    url.searchParams.set('sysparm_fields', fields.join(','));
    url.searchParams.set('sysparm_limit', String(pageSize));
    url.searchParams.set('sysparm_offset', String(offset));
    url.searchParams.set('sysparm_exclude_reference_link', 'true');
    url.searchParams.set('sysparm_display_value', 'false');

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Table API error: ${resp.status} ${await resp.text()}`);

    if (total === Infinity) {
      total = parseInt(resp.headers.get('X-Total-Count') ?? '0', 10);
    }

    const { result } = await resp.json();
    yield result;
    offset += pageSize;
  }
}
```

### 8.2 Field Selection Best Practices

Always specify `sysparm_fields`. Without it, ServiceNow returns all columns (50-150+ per table) including large text fields and nested reference objects. This inflates payload size 10-50x.

Minimal field sets for common tables:

```typescript
const INCIDENT_FIELDS = [
  'sys_id', 'number', 'short_description', 'description',
  'state', 'priority', 'category', 'subcategory',
  'caller_id', 'assigned_to', 'assignment_group',
  'opened_at', 'resolved_at', 'sys_created_on', 'sys_updated_on',
  'active', 'close_notes',
];

const KB_FIELDS = [
  'sys_id', 'number', 'short_description', 'text', 'wiki',
  'question', 'answer', 'workflow_state', 'active',
  'kb_knowledge_base', 'kb_category', 'author',
  'published', 'valid_to', 'sys_updated_on', 'sys_created_on',
  'meta_description', 'meta',
];

const CHANGE_FIELDS = [
  'sys_id', 'number', 'short_description', 'description',
  'state', 'type', 'risk', 'priority',
  'requested_by', 'assignment_group',
  'start_date', 'end_date', 'close_code',
  'sys_updated_on', 'sys_created_on',
];
```

### 8.3 sysparm_display_value

| Value | Effect | Use When |
|---|---|---|
| `false` (default) | Returns raw stored values (sys_ids, integer codes) | Indexing — consistent, stable |
| `true` | Returns display labels for choice/reference fields | User-facing output |
| `all` | Returns both as `{display_value, value}` per field | Debugging |

For connector indexing, use `false`. Store raw values and resolve display names separately if needed. Raw values are stable across locale changes; display labels vary with user language settings.

---

## 9. Incremental Sync Strategy

### 9.1 The sys_updated_on Pattern

Every ServiceNow table inherits `sys_updated_on` (and `sys_created_on`) from the base `sys_metadata` class. These fields are updated automatically whenever a record changes.

**Baseline incremental sync query:**

```
sys_updated_on>={last_sync_timestamp}^ORDERBYsys_updated_on
```

Where `last_sync_timestamp` is in the format `YYYY-MM-DD HH:MM:SS` in the instance's configured timezone (or UTC if the instance is UTC-configured).

**Caution:** ServiceNow stores timestamps in the instance's local timezone by default. If you store ISO timestamps in UTC and the instance is in Eastern Time, your watermark comparisons will drift. Confirm the instance timezone and either:
- Always convert your watermark to instance timezone before querying, or
- Use `javascript:gs.daysAgoStart(n)` relative macros (but these are imprecise for exact watermarks)

### 9.2 What Does and Does Not Update sys_updated_on

`sys_updated_on` is bumped when:
- Any field value on the record changes
- A record is imported or imported and transformed
- Business Rules or Script Includes explicitly update fields

`sys_updated_on` is NOT bumped when:
- Journal fields (`work_notes`, `comments`) are added — these go to a separate table (`sys_journal_field`)
- Attachments are added or removed — these are in `sys_attachment`
- A related record changes (e.g., assignment group name changes)

**Implication for KB indexing:** If article content is in `text` and a user edits the article, `sys_updated_on` is bumped. If only a comment is added to a KB article (unusual but possible), incremental sync may miss it.

Source: ServiceNow Community discussion; Snowflake connector docs `https://docs.snowflake.com/en/connectors/servicenow/ingestion`

### 9.3 Full vs Incremental Sync Decision Matrix

| Table | First Sync | Subsequent Syncs | Notes |
|---|---|---|---|
| `kb_knowledge` | Full (filter published+active) | Incremental (sys_updated_on) | Primary content source |
| `incident` | Anchor date (default: 1 year back) | Incremental | Large table; anchor is critical |
| `change_request` | Anchor date (1 year back) | Incremental | |
| `problem` | Anchor date (1 year back) | Incremental | |
| `sys_user` | Full | Incremental | Needed for display name resolution |
| `sys_user_group` | Full | Full (small) | |
| `cmn_location` | Full | Full (small, rarely changes) | |
| `sys_attachment` | Filter by parent table | Incremental (sys_created_on) | Append-only — use sys_created_on |

### 9.4 Sync State Storage

Store per-table watermarks:

```typescript
interface SyncState {
  table: string;
  lastSyncAt: string;       // ISO 8601 UTC
  instanceTimezoneOffset: number; // minutes, e.g., -300 for EST
  recordCount: number;
  errorCount: number;
}
```

After each successful page, update the watermark to the maximum `sys_updated_on` value in that page's records — not to `Date.now()`. This handles the case where a sync takes a long time and records updated during the sync would be missed.

### 9.5 Deleted Records

ServiceNow soft-deletes are invisible to the Table API by default (deleted records simply disappear from results). The `sys_audit_delete` table logs deletions. For a content index, periodically query `sys_audit_delete` to find records that were deleted since the last sync:

```
GET /api/now/table/sys_audit_delete
  ?sysparm_query=tablename=kb_knowledge^sys_created_on>={last_sync}
  &sysparm_fields=documentkey,tablename,sys_created_on
```

`documentkey` is the `sys_id` of the deleted record. Remove it from your index.

**Note:** Access to `sys_audit_delete` requires admin or `itil_admin` role. Design the service account with this in mind, or implement a reconciliation scan (full re-fetch of active records) weekly to catch deletions.

---

## 10. Attachment API

### 10.1 Overview

ServiceNow stores file attachments separately from table records. The `sys_attachment` table holds metadata; actual file content is retrieved via a separate binary endpoint.

Endpoint: `GET /api/now/attachment`  
Docs: `https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AttachmentAPI.html`

### 10.2 List Attachments for a Record

```
GET /api/now/attachment
  ?sysparm_query=table_name=kb_knowledge^table_sys_id={article_sys_id}
  &sysparm_fields=sys_id,file_name,content_type,size_bytes,download_link
```

Response:
```json
{
  "result": [
    {
      "sys_id": "def456...",
      "file_name": "deployment-checklist.pdf",
      "content_type": "application/pdf",
      "size_bytes": "204800",
      "download_link": "https://mycompany.service-now.com/api/now/attachment/def456/file"
    }
  ]
}
```

### 10.3 Download Attachment Content

```
GET /api/now/attachment/{sys_id}/file
Authorization: Bearer {token}
```

Returns raw binary content with appropriate `Content-Type` header.

**Size limit:** Default max attachment size is 1024 MB (`com.glide.attachment.max_size` property). In practice, KB article attachments are typically PDFs and Word documents under 50 MB.

### 10.4 Attachment Processing Strategy for Phase 2

For the MCP connector:

1. When indexing a KB article, list its attachments
2. For PDF attachments under a configurable size limit (default: 10 MB): download, extract text with a PDF parser, include in the indexed content
3. For Word documents: download and convert with `mammoth` or `docx-parser`
4. For images: skip text extraction unless OCR is in scope
5. Store `download_link` in the indexed record so the agent can cite the source

```typescript
const INDEXABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/html',
  'text/markdown',
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

async function extractAttachmentText(
  attachment: SysAttachment,
  token: string,
): Promise<string | null> {
  if (!INDEXABLE_MIME_TYPES.has(attachment.content_type)) return null;
  if (parseInt(attachment.size_bytes) > MAX_ATTACHMENT_BYTES) return null;

  const resp = await fetch(attachment.download_link, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;

  const buffer = await resp.arrayBuffer();
  // delegate to pdf-parse / mammoth based on content_type
  return extractTextFromBuffer(Buffer.from(buffer), attachment.content_type);
}
```

### 10.5 Bulk Attachment Export

For bulk export, use the Aggregate API to count attachments per table before fetching:

```
GET /api/now/stats/sys_attachment
  ?sysparm_query=table_name=kb_knowledge
  &sysparm_count=true
```

Then paginate the attachment listing with `sysparm_limit=100&sysparm_offset=N`.

Source: `https://support.servicenow.com/kb/kb/kb/kb?id=kb_article_view&sysparm_article=KB0790002`

---

## 11. GlideRecord Reference for Complex Queries

GlideRecord is ServiceNow's server-side JavaScript API for database queries. It runs inside the ServiceNow instance (Business Rules, Script Includes, Scheduled Jobs). It is **not accessible from external REST calls** — it is documented here because:

1. You will encounter GlideRecord examples in ServiceNow documentation
2. If you build a Scripted REST API inside the instance, you will use GlideRecord
3. The encoded query syntax used in GlideRecord is identical to `sysparm_query`

### 11.1 Core Pattern

```javascript
var gr = new GlideRecord('incident');
gr.addQuery('active', true);
gr.addQuery('priority', '<=', 2);
gr.orderByDesc('sys_created_on');
gr.setLimit(100);
gr.query();
while (gr.next()) {
  gs.info(gr.getValue('number') + ': ' + gr.getValue('short_description'));
}
```

### 11.2 GlideRecord vs GlideRecordSecure

| Class | ACL Enforcement | Use In |
|---|---|---|
| `GlideRecord` | Bypasses ACLs | Admin scripts, trusted Business Rules |
| `GlideRecordSecure` | Enforces ACLs for the running user | Scripted REST APIs, Service Portal widgets |

**Critical for Scripted REST APIs:** Always use `GlideRecordSecure` when the caller is an external system. Using `GlideRecord` in a Scripted REST API exposes data beyond what the caller's roles permit.

Source: `https://www.jessems.com/posts/2026-01-08-scripted-rest-api-best-practices-in-servicenow/`

### 11.3 addQuery vs addEncodedQuery

These are functionally equivalent — both produce SQL AND conditions:

```javascript
// Equivalent forms:
gr.addEncodedQuery('active=true^priority<=2^assignment_groupISNOTEMPTY');

gr.addQuery('active', true);
gr.addQuery('priority', '<=', 2);
gr.addNotNullQuery('assignment_group');
```

Use `addEncodedQuery()` for complex conditions built from the UI. Use `addQuery()` for dynamic conditions where the value comes from a variable.

### 11.4 GlideAggregate for Counts

Never use `getRowCount()` on GlideRecord for count queries on large tables — it loads all records into memory. Use GlideAggregate:

```javascript
var ga = new GlideAggregate('incident');
ga.addQuery('active', true);
ga.addAggregate('COUNT');
ga.groupBy('assignment_group');
ga.query();
while (ga.next()) {
  gs.info(ga.getDisplayValue('assignment_group') + ': ' + ga.getAggregate('COUNT'));
}
```

External equivalent (Table API + Aggregate API):
```
GET /api/now/stats/incident
  ?sysparm_query=active=true
  &sysparm_count=true
  &sysparm_group_by=assignment_group
```

### 11.5 chooseWindow for Pagination (Server-Side)

For server-side paging in GlideRecord scripts:

```javascript
gr.chooseWindow(0, 49);  // rows 0-49 (50 rows)
gr.orderBy('sys_created_on');  // ALWAYS pair chooseWindow with an explicit orderBy
gr.query();
```

Never use `chooseWindow` without `orderBy` — results are undefined-order without it.

---

## 12. Record-Level ACL and Security Model

### 12.1 How ServiceNow Enforces Access

ServiceNow ACLs (Access Control Lists) operate at four levels:

1. **Table-level ACL** — controls whether a role can read/write/create/delete any record in a table
2. **Record-level ACL** — scripts that evaluate per-record whether the current user can access that specific record
3. **Field-level ACL** — controls which fields a role can see
4. **Row-level security via Query Business Rules** — Before Query business rules that silently add conditions to filter records

When you call the Table API:
- The API runs as the authenticated user (your service account)
- Table-level ACLs are evaluated — if the service account doesn't have `itil` role, the `incident` table is inaccessible
- Record-level ACLs are evaluated on each record returned — records the service account cannot read are silently excluded
- Field-level ACLs are evaluated — fields the service account cannot read are silently omitted from the response
- Query Business Rules run transparently — they add filters to your query without any indication that filtering occurred

**Key implication:** A response with fewer records than `X-Total-Count` suggests, or fields missing from the response, can indicate ACL filtering. You will never receive an explicit "access denied" for individual records — they are simply absent.

### 12.2 Service Account Roles Required

For Phase 2 read-only connector:

| Capability | Required Role |
|---|---|
| Read incidents, changes, problems | `itil` |
| Read knowledge base articles | `knowledge` |
| Read user and group records | `itil` (includes `sys_user` access) |
| Read CMDB records | `itil` or `asset` |
| Read attachments | `itil` (for ITSM) or `knowledge` (for KB) |
| Read audit log (sys_audit_delete) | `itil_admin` or `admin` |

Avoid granting `admin` role to the integration service account. The `itil` + `knowledge` combination covers the vast majority of Phase 2 use cases.

### 12.3 User Criteria on Knowledge Base Articles

KB articles support fine-grained access via User Criteria (`user_criteria` table). An article can have:
- `can_read_user_criteria` — list of criteria that grant access
- `cannot_read_user_criteria` — list of criteria that deny access

When you query `kb_knowledge` with your service account, User Criteria are evaluated against the service account's profile (roles, groups, location, etc.). Articles that restrict access to specific groups will be excluded from your results even if the service account has the `knowledge` role.

**Recommendation:** When setting up the service account, assign it to a role or user criteria group that represents the "all knowledge readers" scope. Discuss with the customer's KB admin to confirm the service account has broad-enough read access for indexing.

### 12.4 Domain Separation

Enterprise ServiceNow instances sometimes use Domain Separation — a multi-tenancy feature where different business units operate in isolated domains. Records in one domain are invisible to users in another domain.

If the service account is in the `global` domain, it sees all records. If in a sub-domain, it sees only that domain's records plus global records.

If the customer uses Domain Separation and the connector is not seeing expected records, the service account may be in a sub-domain. Use `sysparm_query_no_domain=true` to override (requires elevated role) or move the service account to the global domain.

Source: `https://docs.noreja.com/en/article/using-advanced-queries-in-servicenow-api`

---

## 13. Rate Limits and Throttling

### 13.1 Rate Limit Overview

ServiceNow's rate limiting varies significantly by instance type and subscription:

| Instance Type | Rate Limit | Notes |
|---|---|---|
| Developer Instance (PDI) | Low (undocumented, ~5 req/s) | Free instances are heavily throttled |
| Production — Standard | Higher, subscription-based | Configurable by admin |
| Production — Plus/Enterprise | Highest | Custom SLAs available |

ServiceNow does not publish specific rate limit numbers in public documentation. The limit is enforced per instance and per user/IP. Violating it returns `HTTP 429 Too Many Requests`.

### 13.2 Conservative Defaults

Based on community practice and SlingData connector implementation:

- **Target:** 5 requests/second maximum
- **Burst:** Implement exponential backoff starting at 1 second on 429
- **Concurrency:** Maximum 3 concurrent requests (avoid thundering-herd on full initial sync)
- **Page size:** 100-500 records per request (1000 is valid but slower and harder to retry)

```typescript
class RateLimiter {
  private queue: Array<() => Promise<unknown>> = [];
  private running = 0;
  private readonly maxConcurrent = 3;
  private readonly minDelayMs = 200; // 5 req/s

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()); } catch (e) { reject(e); }
      });
      this.drain();
    });
  }

  private async drain() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const fn = this.queue.shift()!;
    await delay(this.minDelayMs);
    await fn();
    this.running--;
    this.drain();
  }
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const resp = await fetch(url, options);
    if (resp.status !== 429 && resp.status !== 503) return resp;
    const retryAfter = parseInt(resp.headers.get('Retry-After') ?? String(Math.pow(2, attempt)));
    await delay(retryAfter * 1000);
  }
  throw new Error(`Max retries exceeded for ${url}`);
}
```

### 13.3 Throttling Behaviour

When rate-limited:
- `HTTP 429` with optional `Retry-After` header (seconds to wait)
- `HTTP 503 Service Unavailable` during maintenance windows (usually Sunday nights)
- No differentiation between "too many requests from this client" and "instance is under load"

On 503: wait 30-60 seconds before retrying. ServiceNow maintenance windows are typically 2-4 hours and scheduled in advance.

### 13.4 Batch API

ServiceNow provides a Batch API (`/api/now/v1/batch`) that bundles multiple Table API requests into a single HTTP call. This reduces TCP overhead on initial syncs. However, it does not bypass rate limits — the server still counts each bundled sub-request. Use it during initial full sync to reduce connection overhead, not to circumvent throttling.

Source: `https://docs.slingdata.io/connections/api-connections/servicenow`

---

## 14. TypeScript Connector Implementation

### 14.1 Full Connector Class

```typescript
import type { SyncState } from './types';

// ---- Types ----

interface ServiceNowConfig {
  instanceUrl: string;            // e.g., "https://acme.service-now.com"
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiresAt?: number;        // Unix ms
}

interface KbArticle {
  sys_id: string;
  number: string;
  short_description: string;
  text: string;
  wiki: string;
  question: string;
  answer: string;
  workflow_state: string;
  active: string;
  kb_knowledge_base: string;
  kb_category: string;
  author: string;
  published: string;
  valid_to: string;
  sys_updated_on: string;
  sys_created_on: string;
  meta_description: string;
  meta: string;
}

interface Incident {
  sys_id: string;
  number: string;
  short_description: string;
  description: string;
  state: string;
  priority: string;
  category: string;
  subcategory: string;
  caller_id: string;
  assigned_to: string;
  assignment_group: string;
  opened_at: string;
  resolved_at: string;
  sys_created_on: string;
  sys_updated_on: string;
  active: string;
  close_notes: string;
}

// ---- Token management ----

async function refreshAccessToken(config: ServiceNowConfig): Promise<string> {
  const resp = await fetch(`${config.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ServiceNow token refresh failed: ${resp.status} ${body}`);
  }
  const data = await resp.json();
  config.accessToken = data.access_token;
  config.refreshToken = data.refresh_token;
  config.tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return config.accessToken!;
}

async function getToken(config: ServiceNowConfig): Promise<string> {
  if (config.accessToken && config.tokenExpiresAt && Date.now() < config.tokenExpiresAt - 60_000) {
    return config.accessToken;
  }
  return refreshAccessToken(config);
}

// ---- HTTP helpers ----

async function snGet(
  config: ServiceNowConfig,
  path: string,
  params: Record<string, string>,
): Promise<{ data: unknown; totalCount: number }> {
  const token = await getToken(config);
  const url = new URL(`${config.instanceUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await delay(Math.pow(2, attempt - 1) * 1000);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '5');
      await delay(retryAfter * 1000);
      continue;
    }
    if (!resp.ok) {
      lastError = new Error(`ServiceNow API error: ${resp.status} ${await resp.text()}`);
      break;
    }

    const totalCount = parseInt(resp.headers.get('X-Total-Count') ?? '0', 10);
    const body = await resp.json();
    return { data: body.result, totalCount };
  }
  throw lastError ?? new Error('Max retries exceeded');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Table pagination ----

const PAGE_SIZE = 200;

async function* fetchTable<T>(
  config: ServiceNowConfig,
  table: string,
  query: string,
  fields: string[],
): AsyncGenerator<T[]> {
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const { data, totalCount } = await snGet(config, `/api/now/table/${table}`, {
      sysparm_query: query,
      sysparm_fields: fields.join(','),
      sysparm_limit: String(PAGE_SIZE),
      sysparm_offset: String(offset),
      sysparm_exclude_reference_link: 'true',
      sysparm_display_value: 'false',
    });

    if (total === Infinity) total = totalCount;

    const records = data as T[];
    if (records.length === 0) break;
    yield records;
    offset += PAGE_SIZE;

    // Polite delay between pages
    await delay(200);
  }
}

// ---- KB Article sync ----

const KB_FIELDS = [
  'sys_id', 'number', 'short_description', 'text', 'wiki',
  'question', 'answer', 'workflow_state', 'active',
  'kb_knowledge_base', 'kb_category', 'author',
  'published', 'valid_to', 'sys_updated_on', 'sys_created_on',
  'meta_description', 'meta',
];

export async function* syncKbArticles(
  config: ServiceNowConfig,
  since?: string,           // ISO 8601 UTC timestamp
  kbSysId?: string,         // filter to a specific knowledge base
): AsyncGenerator<KbArticle[]> {
  const conditions: string[] = [
    'workflow_state=published',
    'active=true',
  ];

  if (since) {
    // Convert UTC to the format ServiceNow accepts for sys_updated_on
    // ServiceNow typically stores in yyyy-MM-dd HH:mm:ss (instance TZ)
    // Safe approach: use ISO string and let ServiceNow parse it
    conditions.push(`sys_updated_on>=${since.replace('T', ' ').replace('Z', '')}`);
  }

  if (kbSysId) {
    conditions.push(`kb_knowledge_base=${kbSysId}`);
  }

  const query = conditions.join('^') + '^ORDERBYsys_updated_on';

  yield* fetchTable<KbArticle>(config, 'kb_knowledge', query, KB_FIELDS);
}

// ---- Incident sync ----

const INCIDENT_FIELDS = [
  'sys_id', 'number', 'short_description', 'description',
  'state', 'priority', 'category', 'subcategory',
  'caller_id', 'assigned_to', 'assignment_group',
  'opened_at', 'resolved_at', 'sys_created_on', 'sys_updated_on',
  'active', 'close_notes',
];

export async function* syncIncidents(
  config: ServiceNowConfig,
  since?: string,
  activeOnly = false,
): AsyncGenerator<Incident[]> {
  const conditions: string[] = [];

  if (activeOnly) conditions.push('active=true');
  if (since) conditions.push(`sys_updated_on>=${since.replace('T', ' ').replace('Z', '')}`);

  const query = (conditions.join('^') || 'sys_updated_on>=2020-01-01 00:00:00') + '^ORDERBYsys_updated_on';

  yield* fetchTable<Incident>(config, 'incident', query, INCIDENT_FIELDS);
}

// ---- Single record lookup ----

export async function getRecordBySysId<T>(
  config: ServiceNowConfig,
  table: string,
  sysId: string,
  fields: string[],
): Promise<T | null> {
  try {
    const { data } = await snGet(config, `/api/now/table/${table}/${sysId}`, {
      sysparm_fields: fields.join(','),
      sysparm_exclude_reference_link: 'true',
      sysparm_display_value: 'false',
    });
    return data as T;
  } catch {
    return null;
  }
}

// ---- Attachments ----

interface SysAttachment {
  sys_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  download_link: string;
  table_sys_id: string;
  table_name: string;
}

export async function listAttachments(
  config: ServiceNowConfig,
  tableName: string,
  recordSysId: string,
): Promise<SysAttachment[]> {
  const { data } = await snGet(config, '/api/now/attachment', {
    sysparm_query: `table_name=${tableName}^table_sys_id=${recordSysId}`,
    sysparm_fields: 'sys_id,file_name,content_type,size_bytes,download_link,table_sys_id,table_name',
    sysparm_exclude_reference_link: 'true',
  });
  return data as SysAttachment[];
}

export async function downloadAttachment(
  config: ServiceNowConfig,
  sysId: string,
): Promise<Buffer> {
  const token = await getToken(config);
  const resp = await fetch(`${config.instanceUrl}/api/now/attachment/${sysId}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Attachment download failed: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// ---- Deleted record detection ----

export async function getDeletedSysIds(
  config: ServiceNowConfig,
  tableName: string,
  since: string,
): Promise<string[]> {
  const query = `tablename=${tableName}^sys_created_on>=${since.replace('T', ' ').replace('Z', '')}`;
  const { data } = await snGet(config, '/api/now/table/sys_audit_delete', {
    sysparm_query: query,
    sysparm_fields: 'documentkey,sys_created_on',
    sysparm_limit: '1000',
    sysparm_exclude_reference_link: 'true',
  });
  return (data as Array<{ documentkey: string }>).map((r) => r.documentkey);
}
```

### 14.2 Content Transformation

```typescript
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Remove ServiceNow-specific editor artifacts
turndown.addRule('stripSnowAnnotations', {
  filter: (node) => node.nodeName === 'DIV' && node.getAttribute('class')?.includes('sn-html-editor'),
  replacement: (content) => content,
});

export function kbArticleToMarkdown(article: KbArticle): string {
  // Prefer text field (HTML), fall back to wiki, then FAQ fields
  const rawHtml = article.text
    || (article.wiki ? `<pre>${article.wiki}</pre>` : '')
    || [article.question && `<h2>${article.question}</h2>`, article.answer].filter(Boolean).join('\n')
    || '';

  if (!rawHtml) return '';

  const markdown = turndown.turndown(rawHtml);

  // Build frontmatter-style header
  return [
    `# ${article.short_description}`,
    '',
    `**Article:** ${article.number}  `,
    article.meta_description ? `**Summary:** ${article.meta_description}  ` : '',
    `**Published:** ${article.published}  `,
    `**Last Updated:** ${article.sys_updated_on}  `,
    '',
    '---',
    '',
    markdown,
  ].filter((l) => l !== null).join('\n');
}

export function incidentToMarkdown(incident: Incident): string {
  const stateLabels: Record<string, string> = {
    '1': 'New', '2': 'In Progress', '3': 'On Hold',
    '6': 'Resolved', '7': 'Closed',
  };
  const priorityLabels: Record<string, string> = {
    '1': 'Critical', '2': 'High', '3': 'Moderate', '4': 'Low', '5': 'Planning',
  };

  return [
    `# ${incident.number}: ${incident.short_description}`,
    '',
    `**State:** ${stateLabels[incident.state] ?? incident.state}  `,
    `**Priority:** ${priorityLabels[incident.priority] ?? incident.priority}  `,
    `**Category:** ${incident.category}${incident.subcategory ? ` / ${incident.subcategory}` : ''}  `,
    `**Opened:** ${incident.opened_at}  `,
    incident.resolved_at ? `**Resolved:** ${incident.resolved_at}  ` : '',
    '',
    '## Description',
    '',
    incident.description || '_No description provided._',
    '',
    incident.close_notes ? ['## Resolution', '', incident.close_notes, ''].join('\n') : '',
  ].filter((l) => l !== null).join('\n');
}
```

---

## 15. MCP Tool Design

### 15.1 Recommended MCP Tools for ServiceNow Connector

Based on the API capabilities and typical agent use cases:

| Tool Name | Description | Key Parameters |
|---|---|---|
| `servicenow_search_kb` | Full-text search of published KB articles | `query`, `limit`, `kb_sys_id` (optional) |
| `servicenow_get_article` | Fetch a single KB article by number or sys_id | `identifier` (number or sys_id) |
| `servicenow_list_incidents` | List recent incidents with filters | `state`, `priority`, `since`, `limit` |
| `servicenow_get_incident` | Fetch single incident by number or sys_id | `identifier` |
| `servicenow_list_changes` | List change requests | `state`, `type`, `since`, `limit` |
| `servicenow_get_change` | Fetch single change request | `identifier` |
| `servicenow_search_cmdb` | Search CMDB for configuration items | `query`, `class`, `limit` |
| `servicenow_list_kb_bases` | List available knowledge bases | none |

### 15.2 servicenow_search_kb Implementation

```typescript
// MCP tool handler
async function servicenowSearchKb(params: {
  query: string;
  limit?: number;
  kb_sys_id?: string;
}): Promise<ToolResult> {
  const conditions = [
    'workflow_state=published',
    'active=true',
    `short_descriptionLIKE${params.query}^ORtextLIKE${params.query}^ORmetaLIKE${params.query}`,
  ];

  if (params.kb_sys_id) conditions.push(`kb_knowledge_base=${params.kb_sys_id}`);

  const query = conditions.join('^');
  const fields = ['sys_id', 'number', 'short_description', 'meta_description', 'sys_updated_on', 'kb_knowledge_base'];

  const { data, totalCount } = await snGet(config, '/api/now/table/kb_knowledge', {
    sysparm_query: query,
    sysparm_fields: fields.join(','),
    sysparm_limit: String(params.limit ?? 10),
    sysparm_offset: '0',
    sysparm_exclude_reference_link: 'true',
    sysparm_display_value: 'false',
  });

  const articles = data as Array<{ sys_id: string; number: string; short_description: string; meta_description: string; sys_updated_on: string }>;

  // Format as markdown list with citations
  const formatted = articles
    .map((a) => `- **${a.number}**: [${a.short_description}](${config.instanceUrl}/kb_view.do?sys_kb_id=${a.sys_id}) — ${a.meta_description || 'No summary'}`)
    .join('\n');

  return {
    content: [
      {
        type: 'text',
        text: `Found ${totalCount} articles matching "${params.query}". Showing top ${articles.length}:\n\n${formatted}`,
      },
    ],
  };
}
```

### 15.3 Knowledge Base Indexing vs Live Search

Two patterns for the connector:

**Pattern A: Index-first (recommended for Phase 2)**
- Full sync of published KB articles into the MCP server's local index (SQLite + vector embeddings)
- Incremental sync every 15-30 minutes
- Agent queries the local index — zero latency, works offline, supports semantic search
- Deleted/retired articles are removed from index via `sys_audit_delete` polling

**Pattern B: Live pass-through**
- Agent's search query is forwarded directly to ServiceNow Table API in real time
- No local index needed
- Higher latency (network round trip)
- Subject to ServiceNow rate limits per query
- Cannot support semantic/vector search

**Recommendation:** Pattern A for KB articles (content is stable, indexing provides semantic search). Pattern B as a fallback or for incident/change lookups (fresher data, lower volume).

---

## 16. Limitations, Failure Modes, and Gotchas

### 16.1 The journal fields problem

`work_notes` and `comments` are write-only journal fields on incidents, changes, and problems. Reading the record does NOT return these fields. To read the work notes history, you must query:

```
GET /api/now/table/sys_journal_field
  ?sysparm_query=name=incident^element_id={sys_id}^elementIN work_notes,comments
  &sysparm_fields=element,value,sys_created_on,sys_created_by
  &sysparm_limit=50
  &sysparm_orderby=sys_created_on
```

This is a significant gap for incident context. Agents asking "what happened with this incident?" need the work notes. Include this as a Phase 2.5 enhancement.

### 16.2 sys_updated_on vs instance timezone

ServiceNow's `sys_updated_on` is stored in the instance's configured timezone. If you store watermarks in UTC and the instance is in US/Eastern (UTC-5), your watermark comparison is off by 5 hours. In spring/autumn DST transitions, the offset changes.

**Safe approach:** Query with a buffer — use `sys_updated_on >= {last_watermark minus 2 hours}` and deduplicate on `sys_id` on your side. Alternatively, ask the customer to confirm their instance timezone and convert explicitly.

### 16.3 HTML in article text

The `text` field in `kb_knowledge` contains HTML generated by the ServiceNow rich text editor (based on TinyMCE). It may include:
- ServiceNow-specific CSS class names
- Inline styles that mean nothing outside the instance
- Embedded image URLs pointing to the instance (`/sys_attachment.do?...`)
- JavaScript-dependent interactive widgets

The HTML is generally parseable but will have artifacts after `turndown` conversion. Apply a sanitisation pass to remove ServiceNow-specific markup before indexing.

### 16.4 Attachment inline images

KB articles often embed images as attachments and reference them with relative URLs like `/sys_attachment.do?sys_id=abc123`. These URLs:
- Require authentication to access
- Are not stable (sys_id-based, but this is stable enough)
- Will appear as broken images if the markdown is rendered outside ServiceNow context

Strategy: Download critical images during indexing and replace URLs with locally-hosted or data-URI versions, or strip image tags and note "images available at source."

### 16.5 The "10,000 record" cliff

ServiceNow Table API accepts `sysparm_limit` up to 10,000. For very large tables (large enterprises have millions of incidents), even 10,000-record pages can be slow to fetch and large to process. If `X-Total-Count` exceeds ~100,000, consider:
- Narrowing the query (e.g., only last 2 years, only active records)
- Splitting by date range and running parallel fetches (respecting rate limits)
- For CMDB: filter by `sys_class_name` to fetch specific CI types separately

### 16.6 Reference fields return sys_ids not display values

With `sysparm_display_value=false` (recommended), reference fields return sys_ids. `caller_id=abc123def456...` is not human-readable. You need a display name resolution layer:

**Strategy 1:** Use `sysparm_display_value=all` — doubles response size but returns both sys_id and display value for every reference field.

**Strategy 2:** Build a local sys_user lookup cache. Sync `sys_user` table (fields: `sys_id,name,email`) into an in-memory or SQLite lookup table. Resolve display names locally.

**Strategy 3:** Use dot-walking to request display names in the same call:
```
sysparm_fields=sys_id,number,short_description,caller_id.name,assigned_to.name,assignment_group.name
```
This returns `caller_id.name` as a string alongside `caller_id` as a sys_id. Note: dot-walked fields are keyed as `"caller_id.name"` in the JSON, not nested.

### 16.7 Basic auth deprecation

As noted in section 3.1, ServiceNow is progressively restricting Basic Auth on new instances. From mid-2026, PDIs reject Basic Auth by default. Do not build the connector assuming Basic Auth will always work. OAuth 2.0 must be the primary auth path.

### 16.8 Scripted REST API requirement for custom search

The out-of-box Table API uses SQL LIKE for text search. This is keyword-only (no relevance ranking, no synonym expansion). For semantic search, you have two options:
1. Pull data into the MCP server's own vector index (Pattern A above)
2. Deploy a Scripted REST API inside the ServiceNow instance that calls ServiceNow's AI Search API (requires instance-side development access)

Option 1 is recommended for Phase 2. Option 2 is a future enhancement for enterprises with Now Assist enabled.

### 16.9 Domain Separation and sys_query_no_domain

If the service account is in a sub-domain and the customer uses Domain Separation, records from other domains (including global) may not appear. Setting `sysparm_query_no_domain=true` bypasses domain separation, but requires the `admin` or `domain_admin` role. Design the service account in `global` domain where possible.

### 16.10 Empty text field on some article types

Some KB article types (e.g., FAQ templates, video articles, external URL articles) have an empty `text` field. Always check `wiki`, `question`/`answer` as fallbacks. Articles with no text content in any field can still be indexed by `short_description` and `meta_description` alone.

---

## 17. What to Build vs What to Skip

### Build First (Phase 2 MVP)

1. **KB article sync** — `kb_knowledge` paginated sync with incremental updates, HTML-to-markdown conversion, published+active filter
2. **Incident read access** — live lookup tool (`servicenow_get_incident`) and recent incidents list (`servicenow_list_incidents`)
3. **OAuth 2.0 token management** — Client Credentials grant, auto-refresh, per-instance storage
4. **Pagination helper** — generic `fetchTable()` generator with rate limiting and retry
5. **Deleted record cleanup** — weekly poll of `sys_audit_delete` to remove retired/deleted articles from index

### Build Later (Phase 2.5)

6. **Work notes / comments history** — `sys_journal_field` queries to include the full work notes thread for incidents
7. **Attachment indexing** — PDF and DOCX extraction for KB article attachments
8. **Change request sync** — add `change_request` and `problem` tables to the incremental sync pipeline
9. **CMDB lookup tool** — search CIs by name for infrastructure-aware agents
10. **Display name cache** — local `sys_user` + `sys_user_group` lookup tables for reference field resolution

### Skip (Out of Scope)

- **Write-back to ServiceNow** (create incidents via MCP) — high risk, expand attack surface, deferred to Phase 3
- **Scripted REST API deployment** — requires instance-side developer access; cannot be done from the connector
- **Integration Hub spokes** — internal orchestration; not accessible externally
- **ServiceNow MID Server** — network proxy for on-premises data; relevant for hybrid on-prem deployment only
- **Now Assist / AI Search API** — requires specific licensing; build index-side semantic search instead
- **Webhook ingest (real-time push)** — requires customer-side Business Rule setup; use incremental polling instead for Phase 2
- **Multi-domain sync with domain_admin** — overly broad permissions; request global-domain service account instead

### Feature Comparison vs Confluence Connector

| Feature | Confluence | ServiceNow | Notes |
|---|---|---|---|
| Auth method | OAuth 2.0 per-instance or API token | OAuth 2.0 per-instance | Same pattern |
| Content primary field | page body (storage format) | `kb_knowledge.text` (HTML) | Both need HTML-to-MD conversion |
| Incremental sync field | `lastModified` | `sys_updated_on` | Both reliable |
| Deleted record detection | Explicit API | `sys_audit_delete` table | ServiceNow less direct |
| ACL model | Space/page permissions | Role + User Criteria + Domain | ServiceNow more complex |
| Attachment support | Yes, via content endpoint | Yes, via Attachment API | Both supported |
| Full-text search | Yes, via CQL | Table API LIKE only (no ranking) | ServiceNow weaker; use local index |
| Structured metadata | Labels, spaces | Rich ITSM fields (state, priority) | ServiceNow stronger for operational data |

---

## Sources

All research conducted 2026-08-26.

| URL | Section |
|---|---|
| `https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html` | 4 |
| `https://www.servicenow.com/docs/r/api-reference/rest-apis/c_AttachmentAPI.html` | 10 |
| `https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/knowledge-api.html` | 6.5 |
| `https://www.getknit.dev/blog/servicenow-rest-api-integration-guide` | 3, 4, 5 |
| `https://sn.jace.pro/automations/inbound/rest/table-api/` | 4 |
| `https://servicenow.github.io/sdk/guides/encoded-query-guide` | 7 |
| `https://docs.noreja.com/en/article/using-advanced-queries-in-servicenow-api` | 7 |
| `https://www.nowspectrum.com/blog/oauth2-servicenow-guide` | 3 |
| `https://www.nowspectrum.com/blog/gliderecord-encoded-queries` | 7, 11 |
| `https://snowcoder.ai/blog/servicenow-gliderecord-cheat-sheet-2026` | 11 |
| `https://www.jessems.com/posts/2026-01-08-scripted-rest-api-best-practices-in-servicenow/` | 3.5, 12 |
| `https://docs.slingdata.io/connections/api-connections/servicenow` | 9, 13 |
| `https://docs.snowflake.com/en/connectors/servicenow/ingestion` | 9 |
| `https://support.servicenow.com/kb/kb/kb/kb?id=kb_article_view&sysparm_article=KB0790002` | 10 |
| `https://github.com/jschuller/mcp-server-servicenow` (note) | 3.1 |
