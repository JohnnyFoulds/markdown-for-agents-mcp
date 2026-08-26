# Confluence Connector: Production Implementation Research

**Project:** markdown-for-agents-mcp  
**Phase:** Phase 2 — Enterprise Knowledge Index  
**Date:** 2026-08-26  
**Sources:** Atlassian developer docs (developer.atlassian.com), Atlassian community forums, npm ecosystem

---

## Table of Contents

1. [Executive Summary and Recommendations](#1-executive-summary-and-recommendations)
2. [Deployment Variants: Cloud vs Data Center](#2-deployment-variants-cloud-vs-data-center)
3. [Authentication](#3-authentication)
4. [REST API v1 vs v2](#4-rest-api-v1-vs-v2)
5. [Spaces: Listing and Schema](#5-spaces-listing-and-schema)
6. [Pages: Fetching and Body Formats](#6-pages-fetching-and-body-formats)
7. [Blog Posts](#7-blog-posts)
8. [CQL: Complete Reference](#8-cql-complete-reference)
9. [Permissions and Content Restrictions](#9-permissions-and-content-restrictions)
10. [Attachments](#10-attachments)
11. [Incremental Sync and Deletion Detection](#11-incremental-sync-and-deletion-detection)
12. [Content Body Processing: Macros and Storage Format](#12-content-body-processing-macros-and-storage-format)
13. [Rate Limiting](#13-rate-limiting)
14. [Alternative Content Types: Whiteboards, Databases, Folders](#14-alternative-content-types-whiteboards-databases-folders)
15. [Atlassian Connect vs OAuth vs API Token](#15-atlassian-connect-vs-oauth-vs-api-token)
16. [Complete TypeScript Connector Implementation](#16-complete-typescript-connector-implementation)
17. [Limitations, Edge Cases, and Gotchas](#17-limitations-edge-cases-and-gotchas)
18. [What to Build, What to Skip](#18-what-to-build-what-to-skip)

---

## 1. Executive Summary and Recommendations

Confluence is the dominant enterprise wiki. The connector must handle two fundamentally different deployment models (Cloud and Data Center), two API version generations (v1 and v2), and a permission model that is deeper and more complex than SharePoint. The core indexing path for an enterprise knowledge index is:

**List spaces → enumerate pages via CQL → fetch body in `storage` format → strip macros → store plain text + metadata**

Key decisions up front:

| Decision | Recommendation |
|---|---|
| API version | Use v2 for pages/spaces/attachments, fall back to v1 for CQL search and content restrictions |
| Auth for Cloud | API token (email + token) for service accounts; OAuth 2.0 (3LO) for per-user ACL enforcement |
| Auth for Data Center | Personal Access Token (PAT) via `Authorization: Bearer <token>` |
| Body format | Request `storage` (XHTML-based) for all content; post-process macros client-side |
| Incremental sync | CQL `lastmodified > "<timestamp>"` on the v1 `/wiki/rest/api/content/search` endpoint |
| Deletion detection | No reliable delete event stream exists in Cloud; use periodic full-space diff of known IDs |
| Attachment indexing | Index PDF and Office formats only; skip images, media, and binary blobs |
| Whiteboards/databases | Skip for Phase 2 — no meaningful text content is accessible via the API |

---

## 2. Deployment Variants: Cloud vs Data Center

### 2.1 Two Different Products

Confluence Cloud and Confluence Data Center share the brand but are operationally distinct:

| Dimension | Cloud | Data Center |
|---|---|---|
| Base URL | `https://<org>.atlassian.net/wiki` | `https://your-host/confluence` or any custom path |
| REST API path | `/wiki/api/v2/...` (v2) or `/wiki/rest/api/...` (v1) | `/rest/api/...` (v1 only; no v2) |
| Authentication | API token (Basic) or OAuth 2.0 3LO | Username/password Basic or Personal Access Token (PAT) |
| Rate limiting | Points-based, hourly quotas (see §13) | Configurable by admin; not enforced by default |
| CQL support | Full | Full (same syntax) |
| Audit log | Limited (no delete events) | Full audit trail |
| v2 API | Yes | No — Data Center runs v1 only |
| Space types | `global`, `personal` | `global`, `personal` |
| New content types | Whiteboards, Databases, Smart Links, Folders | Pages, Blog Posts, Attachments only |

Source: [Atlassian Cloud vs Data Center comparison](https://www.atlassian.com/migration/assess/compare-cloud-data-center/confluence), [Atlassian community — v1 vs v2 functionality gaps](https://community.atlassian.com/forums/Confluence-questions/the-funciton-lackness-of-REST-API-v2-compared-with-v1/qaq-p/3101941)

### 2.2 Connector Configuration

```typescript
interface ConfluenceConnectorConfig {
  deploymentType: 'cloud' | 'datacenter';
  // Cloud: 'https://acme.atlassian.net'
  // DC: 'https://wiki.acme.internal'
  baseUrl: string;
  // Cloud: { email: string; apiToken: string }
  // DC: { personalAccessToken: string } or { username: string; password: string }
  auth: ConfluenceAuth;
  // Optional: restrict to specific space keys
  spaces?: string[];
  // Optional: skip spaces matching these keys
  excludeSpaces?: string[];
  // Optional: attachment size limit in bytes (default 10MB)
  maxAttachmentBytes?: number;
}
```

---

## 3. Authentication

### 3.1 Confluence Cloud — API Token (Recommended for Service Accounts)

Create an API token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Use HTTP Basic Auth with `email:token` encoded in Base64.

```typescript
// Cloud: email + API token via Basic Auth
const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');
const headers = {
  'Authorization': `Basic ${credentials}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

// Example: fetch page
const response = await fetch(
  'https://acme.atlassian.net/wiki/api/v2/pages/12345',
  { headers }
);
```

Source: [developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/](https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/)

**Important:** Cloud API tokens are **not** Bearer tokens. They are Basic Auth passwords. Data Center PATs **are** Bearer tokens.

### 3.2 Confluence Cloud — OAuth 2.0 (3LO) for Per-User ACL Enforcement

For a system that enforces per-user Entra ID permissions (the Phase 2 goal), OAuth 2.0 3LO is the correct approach. The token must be tied to the user's identity.

**Flow:**
1. Register an OAuth 2.0 app at [developer.atlassian.com/console](https://developer.atlassian.com/console)
2. Configure scopes: `read:confluence-content.all`, `read:confluence-space.summary`, `read:page:confluence`, `read:attachment:confluence`
3. User authorizes; you receive an access token and refresh token
4. API calls go to `https://api.atlassian.com/ex/confluence/<cloudId>/wiki/api/v2/...` (not the site domain)

```typescript
// 3LO token usage — note the api.atlassian.com domain
const cloudId = await getCloudId(accessToken); // call /oauth/token/accessible-resources

const response = await fetch(
  `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages`,
  {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    }
  }
);
```

**Critical gotcha:** 3LO tokens only work through `api.atlassian.com`, never directly against the site domain. Source: [github.com/MrRefactoring/confluence.js](https://github.com/MrRefactoring/confluence.js)

**Token refresh:** Access tokens expire in 1 hour. Store refresh tokens and renew proactively. The `confluence.js` library handles this automatically.

### 3.3 Confluence Data Center — Personal Access Token (PAT)

PATs are available from Confluence DC version 7.9+. They are managed per user in their profile settings.

```typescript
// Data Center: PAT as Bearer token
const headers = {
  'Authorization': `Bearer ${personalAccessToken}`,
  'Accept': 'application/json',
};

// DC base URL uses /rest/api, not /wiki/rest/api
const response = await fetch(
  'https://wiki.acme.internal/rest/api/content/12345?expand=body.storage',
  { headers }
);
```

Source: [confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)

### 3.4 OAuth 2.0 for Data Center

Data Center 7.17+ supports OAuth 2.0. Configure an "incoming link" in Application Links, then follow the standard OAuth 2.0 authorization code flow. The token is a Bearer token used on the DC instance directly (not via api.atlassian.com).

Source: [confluence.atlassian.com/confkb/oauth-2-0-configuration-for-confluence-1224638905.html](https://confluence.atlassian.com/confkb/oauth-2-0-configuration-for-confluence-1224638905.html)

### 3.5 Scopes Required for Read-Only Indexing

For OAuth 2.0 3LO (Cloud), request these granular scopes (preferred over classic broad scopes):

```
read:page:confluence          # pages and blog posts
read:attachment:confluence    # attachments
read:space:confluence         # spaces
read:space.permission:confluence  # space permission assignments
read:content.metadata:confluence  # status, history metadata
```

The classic scope `read:confluence-content.all` covers most but may be deprecated on newer apps.

---

## 4. REST API v1 vs v2

### 4.1 Key Structural Differences

| Aspect | v1 (`/wiki/rest/api/`) | v2 (`/wiki/api/v2/`) |
|---|---|---|
| Pagination | Offset-based (`start`, `limit`) | Cursor-based (`cursor`, `limit`; Link header) |
| Content model | Generic `Content` object (type field distinguishes page/blog) | Typed endpoints: `/pages`, `/blogposts`, `/whiteboards` |
| Body in list responses | Optional via `expand=body.storage` | Not returned by default; must use `body-format` param |
| CQL search | `/wiki/rest/api/content/search?cql=...` | No CQL search endpoint in v2 |
| Content restrictions | `/wiki/rest/api/content/{id}/restriction` | No equivalent in v2 |
| Ancestors/children | `expand=ancestors,children` | Dedicated endpoints: `/pages/{id}/ancestors`, `/pages/{id}/children` |
| Space detail | `expand=permissions` on space endpoint | `include-permissions=true` on v2 `/spaces/{id}` |
| Performance | Slower (generic, expands everything) | Faster (specialized, lower latency) |
| Available in DC | Yes | No — Cloud only |

Source: [developer.atlassian.com/cloud/confluence/rest/v2/intro/](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/), [Atlassian blog on v2 improvements](https://www.atlassian.com/blog/development/the-confluence-cloud-rest-api-v2-brings-major-performance-improvements)

### 4.2 What Exists Only in v1

These endpoints do not have v2 equivalents (as of August 2026):

- **CQL content search**: `GET /wiki/rest/api/content/search?cql=...` — critical for incremental sync
- **Content restrictions**: `GET /wiki/rest/api/content/{id}/restriction/byOperation/{operationKey}`
- **Content permissions check**: `GET /wiki/rest/api/user/current/space/{spaceKey}`
- **Body with `export_view`/`styled_view`**: Available in v1 expand, no v2 equivalent
- **Macro body**: `GET /wiki/rest/api/content/{id}/history/{version}/macro/id/{macroId}`
- **Templates**: No v2 equivalent
- **Long-running tasks** (for async operations): v1 only

### 4.3 URL Prefix Summary

```
Cloud v1:  https://{org}.atlassian.net/wiki/rest/api/
Cloud v2:  https://{org}.atlassian.net/wiki/api/v2/
DC v1:     https://{host}/rest/api/   (no /wiki/ prefix in default DC installs)
           or https://{host}/confluence/rest/api/  (varies by deployment)
```

### 4.4 Strategy: Hybrid v1+v2

Use v2 where it exists and is faster; fall back to v1 for missing functionality:

```typescript
class ConfluenceApiClient {
  // Use v2 for bulk page/space enumeration
  async listPages(spaceId: string) { /* GET /wiki/api/v2/spaces/{id}/pages */ }
  
  // Use v1 for CQL-based incremental sync
  async searchByCql(cql: string) { /* GET /wiki/rest/api/content/search?cql= */ }
  
  // Use v1 for content restrictions
  async getRestrictions(pageId: string) { /* GET /wiki/rest/api/content/{id}/restriction */ }
  
  // Use v2 for space listing (faster, cleaner model)
  async listSpaces() { /* GET /wiki/api/v2/spaces */ }
}
```

---

## 5. Spaces: Listing and Schema

### 5.1 v2 `/spaces` Endpoint

```
GET /wiki/api/v2/spaces
```

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `ids` | `integer[]` | Filter by specific space IDs |
| `keys` | `string[]` | Filter by space keys (e.g., `DEV`, `HR`) |
| `type` | `string` | `global` or `personal` |
| `status` | `string` | `current` or `archived` |
| `labels` | `string[]` | Filter by space labels |
| `favorited-by` | `string` | accountId of user whose favorites to return |
| `not-favorited-by` | `string` | Exclude spaces favorited by this user |
| `sort` | `SpaceSortOrder` | e.g., `key`, `-key`, `name`, `-name` |
| `description-format` | `plain` or `view` | Format of returned description |
| `include-icon` | `boolean` | Include space icon data |
| `cursor` | `string` | Pagination cursor from Link header |
| `limit` | `integer` | Max results (default 25, max 250) |

**Response schema (Space object):**

```json
{
  "id": "12345",
  "key": "DEV",
  "name": "Development",
  "type": "global",
  "status": "current",
  "authorId": "557058:...",
  "spaceOwnerId": "557058:...",
  "currentActiveAlias": "development",
  "createdAt": "2023-01-15T10:30:00.000Z",
  "homepageId": "98765",
  "description": {
    "plain": { "value": "Development team space", "representation": "plain" },
    "view": { "value": "<p>Development team space</p>", "representation": "view" }
  },
  "icon": {
    "path": "/wiki/download/...",
    "apiDownloadLink": "/wiki/api/v2/spaces/12345/icon"
  },
  "_links": {
    "webui": "/spaces/DEV",
    "base": "https://acme.atlassian.net/wiki"
  }
}
```

### 5.2 Get Space by ID (with Permissions)

```
GET /wiki/api/v2/spaces/{id}?include-permissions=true&include-labels=true&include-operations=true
```

The `include-permissions` flag returns `permissions` array with:

```json
{
  "permissions": {
    "results": [
      {
        "id": "perm-uuid",
        "principal": {
          "type": "user",  // or "group"
          "id": "557058:accountId"
        },
        "operation": {
          "key": "read",  // or "create", "delete", "export", "administer"
          "targetType": "space"
        }
      }
    ]
  }
}
```

### 5.3 Pagination Pattern

```typescript
async function* iterateSpaces(
  client: ConfluenceApiClient,
  options: { type?: 'global' | 'personal'; status?: 'current' | 'archived' } = {}
): AsyncGenerator<Space> {
  let cursor: string | undefined;
  
  do {
    const params = new URLSearchParams({
      limit: '50',
      ...(options.type && { type: options.type }),
      ...(options.status && { status: options.status }),
      ...(cursor && { cursor }),
    });
    
    const response = await client.get<MultiEntityResult<Space>>(
      `/wiki/api/v2/spaces?${params}`
    );
    
    for (const space of response.results) {
      yield space;
    }
    
    // Parse cursor from Link header: </wiki/api/v2/spaces?cursor=TOKEN>; rel="next"
    cursor = extractNextCursor(response._links.next);
  } while (cursor);
}
```

---

## 6. Pages: Fetching and Body Formats

### 6.1 v2 Page Endpoints

```
GET /wiki/api/v2/pages                    # all pages (requires explicit filters)
GET /wiki/api/v2/spaces/{id}/pages        # pages in a specific space
GET /wiki/api/v2/pages/{id}               # single page by ID
GET /wiki/api/v2/labels/{id}/pages        # pages with a label
```

### 6.2 Query Parameters for `/spaces/{id}/pages`

| Parameter | Type | Description |
|---|---|---|
| `body-format` | `PrimaryBodyRepresentation` | `storage`, `atlas_doc_format`, or omit for no body |
| `sort` | `PageSortOrder` | `id`, `-id`, `created-date`, `-created-date`, `modified-date`, `-modified-date`, `title`, `-title` |
| `status` | `string[]` | `current`, `archived`, `draft`, `deleted` |
| `title` | `string` | Exact title filter |
| `cursor` | `string` | Pagination cursor |
| `limit` | `integer` | Max results (default 25, max 250) |

**Important:** When enumerating all pages in a space for indexing, do NOT request `body-format` in bulk list calls. The body makes responses large and slow. Instead:

1. List page IDs and metadata with no body
2. Fetch each page individually with `body-format=storage`
3. Process content client-side

### 6.3 Page Object Schema (Full Single Page Response)

```json
{
  "id": "123456",
  "status": "current",
  "title": "Architecture Decision Records",
  "spaceId": "12345",
  "parentId": "99999",
  "parentType": "page",
  "position": 1000,
  "authorId": "557058:abc-123",
  "ownerId": "557058:abc-123",
  "lastOwnerId": null,
  "subtype": null,
  "createdAt": "2023-06-01T09:00:00.000Z",
  "version": {
    "createdAt": "2024-11-15T14:22:00.000Z",
    "message": "Updated section 3",
    "number": 47,
    "minorEdit": false,
    "authorId": "557058:xyz-456"
  },
  "body": {
    "storage": {
      "value": "<p>This page documents...</p><ac:structured-macro ac:name=\"info\">...</ac:structured-macro>",
      "representation": "storage"
    },
    "atlas_doc_format": {
      "value": "{\"version\":1,\"type\":\"doc\",...}",
      "representation": "atlas_doc_format"
    }
  },
  "_links": {
    "webui": "/spaces/DEV/pages/123456/Architecture+Decision+Records",
    "editui": "/pages/resumedraft.action?draftId=123456",
    "tinyui": "/x/ABCD"
  }
}
```

### 6.4 Body Formats Compared

| Format | Description | When to Use |
|---|---|---|
| `storage` | XHTML-based XML with Confluence macros. Human-readable-ish. | Primary format for indexing — strip macros, parse HTML |
| `atlas_doc_format` | Atlassian Document Format (ADF) — JSON AST | Better for structured extraction; newer content uses this |
| `view` | Rendered HTML as Confluence displays it | Single-page requests only; too large/slow for bulk |
| `export_view` | HTML suitable for export | v1 only; max 25 results with expand |
| `styled_view` | Styled HTML | v1 only; max 25 results with expand |

**Recommendation:** Use `storage` for all indexing. It is the most consistent across Cloud and DC, and macros can be stripped with simple XML parsing. ADF is also good but is JSON-only and requires the full ADF schema to parse correctly.

### 6.5 Fetching a Single Page with Body

```typescript
async function fetchPageWithBody(
  client: ConfluenceApiClient,
  pageId: string
): Promise<PageWithBody> {
  const params = new URLSearchParams({
    'body-format': 'storage',
    'include-version': 'true',
    'include-labels': 'true',
  });
  
  return client.get<PageSingle>(`/wiki/api/v2/pages/${pageId}?${params}`);
}
```

### 6.6 v1 Page Fetch (for Data Center or When v2 Unavailable)

```typescript
// v1 with expand parameter
const response = await fetch(
  `${baseUrl}/rest/api/content/${pageId}?expand=body.storage,version,space,ancestors`,
  { headers }
);
```

v1 response includes a top-level `body.storage.value` string with the XHTML content.

---

## 7. Blog Posts

Blog posts are first-class content types in Confluence. For knowledge indexing, they contain valuable institutional content (announcements, decisions, retrospectives).

### 7.1 v2 Blog Post Endpoints

```
GET /wiki/api/v2/blogposts                     # all blog posts
GET /wiki/api/v2/spaces/{id}/blogposts         # blog posts in a space
GET /wiki/api/v2/blogposts/{id}                # single blog post
```

### 7.2 Blog Post Schema

Blog posts share the same field structure as pages with these differences:

```json
{
  "id": "789012",
  "status": "current",
  "title": "Q3 2024 Engineering All-Hands Summary",
  "spaceId": "12345",
  "authorId": "557058:abc-123",
  "createdAt": "2024-09-30T16:00:00.000Z",
  "version": { ... },
  "body": {
    "storage": { "value": "<p>...</p>", "representation": "storage" },
    "atlas_doc_format": { ... }
  }
}
```

Blog posts do **not** have `parentId` (they are not in the page hierarchy). They are dated content organized at the space level.

### 7.3 Scope for CQL

In CQL, blog posts use `type = blogpost`. Include them explicitly when searching:

```
type IN (page, blogpost) AND space = "DEV" AND lastmodified > "2024-01-01"
```

---

## 8. CQL: Complete Reference

CQL (Confluence Query Language) is the primary mechanism for the v1 search API. It is used for incremental sync, permission-filtered search, and targeted enumeration. The endpoint is **v1 only**:

```
GET /wiki/rest/api/content/search?cql=<query>&expand=<fields>&limit=<n>&start=<offset>
```

Source: [developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/)

### 8.1 Basic Syntax

```
field operator value [AND|OR field operator value] [ORDER BY field [ASC|DESC]]
```

Constraints:
- Cannot compare two fields against each other
- A negative expression cannot be the **first** clause in a statement
- `NOT` can negate a clause or a parenthesized group

### 8.2 All CQL Fields

| Field | Type | Operators | Notes |
|---|---|---|---|
| `ancestor` | CONTENT | `=`, `!=`, `IN`, `NOT IN` | All descendants of content ID |
| `content` | CONTENT | `=`, `!=`, `IN`, `NOT IN` | Alias for `id` |
| `created` | DATE | `=`, `!=`, `>`, `>=`, `<`, `<=` | Creation date |
| `creator` | USER | `=`, `!=`, `IN`, `NOT IN` | accountId of creator |
| `contributor` | USER | `=`, `!=`, `IN`, `NOT IN` | Created or edited |
| `favourite` | USER | `=`, `!=`, `IN`, `NOT IN` | Only allowed for current user |
| `fileExtension` | TEXT | `=`, `!=`, `IN`, `NOT IN` | e.g., `"pdf"`, `"png"` |
| `id` | CONTENT | `=`, `!=`, `IN`, `NOT IN` | Content ID |
| `label` | STRING | `=`, `!=`, `IN`, `NOT IN` | Page labels |
| `lastmodified` | DATE | `=`, `!=`, `>`, `>=`, `<`, `<=` | **Key for incremental sync** |
| `macro` | STRING | `=`, `!=`, `IN`, `NOT IN` | Macro name in page body |
| `mention` | USER | `=`, `!=`, `IN`, `NOT IN` | Users @mentioned |
| `owner` | OWNER | `=`, `!=`, `IN`, `NOT IN` | Page owner |
| `pageStatus` | TEXT | `=`, `!=`, `IN`, `NOT IN` | Custom workflow status |
| `parent` | CONTENT | `=`, `!=` | Direct parent only |
| `space` | SPACE | `=`, `!=`, `IN`, `NOT IN` | Space key |
| `subtype` | SUBTYPE | `=`, `!=` | `live` for Live Docs |
| `text` | TEXT | `~`, `!~` | Full-text search (title + body + labels) |
| `title` | TEXT | `=`, `!=`, `~`, `!~` | Page/blog title |
| `type` | TYPE | `=`, `!=`, `IN`, `NOT IN` | `page`, `blogpost`, `comment`, `attachment`, `whiteboard`, `database`, `embed`, `folder` |
| `watcher` | USER | `=`, `!=`, `IN`, `NOT IN` | Users watching content |

### 8.3 All CQL Operators

| Operator | Symbol | Field types | Notes |
|---|---|---|---|
| EQUALS | `=` | CONTENT, USER, STRING, SPACE, TYPE, DATE | Exact match |
| NOT EQUALS | `!=` | All except TEXT | Cannot be first clause |
| GREATER THAN | `>` | DATE, numeric | |
| GREATER THAN EQUALS | `>=` | DATE, numeric | |
| LESS THAN | `<` | DATE, numeric | |
| LESS THAN EQUALS | `<=` | DATE, numeric | |
| IN | `IN` | CONTENT, USER, STRING, SPACE, TYPE | Equivalent to multiple `=` with OR |
| NOT IN | `NOT IN` | CONTENT, USER, STRING, SPACE, TYPE | Equivalent to multiple `!=` with AND |
| CONTAINS | `~` | TEXT | Lucene full-text search; supports wildcards |
| DOES NOT CONTAIN | `!~` | TEXT | |

### 8.4 CQL Functions

| Function | Applicable Fields | Description |
|---|---|---|
| `currentUser()` | USER fields | Currently authenticated user |
| `startOfDay()` | DATE | Start of today |
| `endOfDay()` | DATE | End of today |
| `startOfWeek()` | DATE | Start of current week |
| `endOfWeek()` | DATE | End of current week |
| `startOfMonth()` | DATE | Start of current month |
| `endOfMonth()` | DATE | End of current month |
| `startOfYear()` | DATE | Start of current year |
| `endOfYear()` | DATE | End of current year |
| `now("-4w")` | DATE | 4 weeks ago; supports `-Xd`, `-Xw`, `-Xm`, `-Xy` |

### 8.5 Date Format

CQL accepts these date formats:
```
"yyyy/MM/dd HH:mm"
"yyyy-MM-dd HH:mm"
"yyyy/MM/dd"
"yyyy-MM-dd"
```

Dates are relative to the **Confluence server's configured timezone**, not UTC. When using API tokens with a service account, this is typically the instance timezone. Store sync timestamps in the instance's timezone or use explicit `HH:mm` to avoid drift.

### 8.6 Practical Query Patterns

```cql
-- All current pages in a space, sorted by last modified
type = page AND space = "DEV" AND status = current ORDER BY lastmodified DESC

-- Incremental sync: pages modified since last crawl
type IN (page, blogpost) AND space IN ("DEV", "HR", "ENG") 
  AND lastmodified > "2024-11-01 00:00"
  AND status = current

-- Everything in a space (pages + blog posts)
type IN (page, blogpost) AND space = "DEV" ORDER BY created ASC

-- Pages modified in the last 7 days across all spaces
type = page AND lastmodified > now("-7d")

-- Pages by a specific author
type = page AND creator = "557058:abc-def-123"

-- Pages with a label
type = page AND label = "architecture-decision"

-- Descendants of a specific page
type = page AND ancestor = 123456

-- Pages using a specific macro
type = page AND macro = "jira"

-- Text search
type = page AND text ~ "kubernetes deployment"

-- Attachments by file type
type = attachment AND fileExtension IN ("pdf", "docx", "pptx")
```

### 8.7 CQL via v1 API

```typescript
async function searchByCql(
  client: ConfluenceApiClient,
  cql: string,
  options: { expand?: string[]; limit?: number } = {}
): Promise<CqlSearchResult> {
  const params = new URLSearchParams({
    cql,
    limit: String(options.limit ?? 50),
    ...(options.expand?.length && { expand: options.expand.join(',') }),
  });
  
  // v1 endpoint only — no v2 CQL equivalent
  return client.get(`/wiki/rest/api/content/search?${params}`);
}

// Paginate over large result sets
async function* searchAllByCql(
  client: ConfluenceApiClient,
  cql: string
): AsyncGenerator<ConfluenceContent> {
  let start = 0;
  const limit = 50;
  
  while (true) {
    const params = new URLSearchParams({
      cql,
      limit: String(limit),
      start: String(start),
    });
    
    const result = await client.get<{
      results: ConfluenceContent[];
      size: number;
      totalSize: number;
      _links: { next?: string };
    }>(`/wiki/rest/api/content/search?${params}`);
    
    for (const item of result.results) {
      yield item;
    }
    
    if (!result._links.next || result.results.length < limit) break;
    start += limit;
  }
}
```

**Gotcha:** In v1, when using `expand=body.storage` with CQL search, results are capped at **50 even if you set a higher limit**. The API does not warn about this. For full bodies, either use the 50-item cap or fetch each page individually after getting IDs.

---

## 9. Permissions and Content Restrictions

Confluence has a three-tier permission model. Understanding all three tiers is critical for correct ACL enforcement in the enterprise knowledge index.

### 9.1 Permission Tier Overview

```
Global Permissions (site-wide)
  └── Space Permissions (per space)
        └── Content Restrictions (per page/blog post)
```

Source: [support.atlassian.com/confluence-cloud/docs/what-are-confluence-cloud-permissions-and-restrictions/](https://support.atlassian.com/confluence-cloud/docs/what-are-confluence-cloud-permissions-and-restrictions/)

**Effective access = all three tiers must grant access.** A space-level view permission does not override a page-level restriction. An admin can bypass content restrictions but a regular user cannot.

### 9.2 Space Permissions

Retrieve space permissions via v2:

```
GET /wiki/api/v2/spaces/{id}/permissions?limit=250
```

Response:

```json
{
  "results": [
    {
      "id": "perm-uuid-1",
      "principal": {
        "type": "user",
        "id": "557058:account-id"
      },
      "operation": {
        "key": "read",
        "targetType": "space"
      }
    },
    {
      "id": "perm-uuid-2",
      "principal": {
        "type": "group",
        "id": "group-uuid"
      },
      "operation": {
        "key": "read",
        "targetType": "space"
      }
    }
  ]
}
```

**Operation keys:** `use`, `read`, `create`, `delete`, `export`, `administer`, `archive`, `restrict_content`

**Principal types:** `user` (Atlassian accountId), `group` (Confluence group UUID), `role` (available in RBAC-enabled tenants)

### 9.3 Content Restrictions (Page-Level)

Content restrictions restrict individual pages beyond space permissions. These are accessed via **v1 only**:

```
GET /wiki/rest/api/content/{id}/restriction/byOperation/{operationKey}
```

Where `operationKey` is `read` or `update`.

```typescript
async function getPageRestrictions(
  client: ConfluenceApiClient,
  pageId: string
): Promise<{ users: string[]; groups: string[] }> {
  const result = await client.get<{
    restrictions: {
      read: {
        restrictions: {
          user: { results: Array<{ accountId: string }> };
          group: { results: Array<{ id: string; name: string }> };
        }
      }
    }
  }>(`/wiki/rest/api/content/${pageId}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`);
  
  const readRestrictions = result.restrictions.read.restrictions;
  
  return {
    users: readRestrictions.user.results.map(u => u.accountId),
    groups: readRestrictions.group.results.map(g => g.id),
  };
}
```

**Important behavior:**
- If `restrictions.read.restrictions` contains **no entries**, the page inherits space permissions (no restriction applied).
- If it contains entries, **only those listed users and groups can read** the page, overriding space permission inheritance for everyone else.
- Space admins can always read; content restrictions do not apply to admins.

### 9.4 ACL Enforcement Strategy for Enterprise Knowledge Index

For Phase 2 per-user Entra ID ACL enforcement:

```typescript
interface ConfluencePageAcl {
  pageId: string;
  spaceKey: string;
  // null means "inherit from space" (no restriction)
  pageRestrictions: null | {
    allowedUserAccountIds: string[];
    allowedGroupIds: string[];
  };
  spacePermissions: {
    allowedUserAccountIds: string[];
    allowedGroupIds: string[];
  };
}

async function buildPageAcl(
  client: ConfluenceApiClient,
  pageId: string,
  spaceId: string
): Promise<ConfluencePageAcl> {
  const [restrictions, spacePerms] = await Promise.all([
    getPageRestrictions(client, pageId),
    getSpaceReadPermissions(client, spaceId),
  ]);
  
  return {
    pageId,
    spaceKey: spacePerms.key,
    pageRestrictions: restrictions.users.length === 0 && restrictions.groups.length === 0
      ? null  // No restriction — inherits space
      : { allowedUserAccountIds: restrictions.users, allowedGroupIds: restrictions.groups },
    spacePermissions: spacePerms,
  };
}

// At query time, check:
// 1. User has space "read" permission (via group membership or direct)
// 2. If page has restrictions: user is in allowedUserAccountIds OR in a group from allowedGroupIds
function canUserViewPage(acl: ConfluencePageAcl, userAccountId: string, userGroupIds: string[]): boolean {
  // Check space permission
  const hasSpaceAccess = 
    acl.spacePermissions.allowedUserAccountIds.includes(userAccountId) ||
    acl.spacePermissions.allowedGroupIds.some(g => userGroupIds.includes(g));
  
  if (!hasSpaceAccess) return false;
  
  // No page restriction — space permission is sufficient
  if (acl.pageRestrictions === null) return true;
  
  // Page restriction active — must be explicitly listed
  return acl.pageRestrictions.allowedUserAccountIds.includes(userAccountId) ||
    acl.pageRestrictions.allowedGroupIds.some(g => userGroupIds.includes(g));
}
```

### 9.5 Entra ID Mapping

Confluence Cloud users are identified by Atlassian accountId. To enforce Entra ID groups (from `transitiveMemberOf`):

1. Map Entra UPN/objectId → Atlassian accountId via Atlassian admin API or by email match
2. Map Confluence group names → Entra group names (Atlassian's managed Confluence groups often mirror Azure AD groups when SCIM provisioning is enabled)
3. Cache the mapping with a TTL; refresh when 403 errors occur on known-accessible content

**Key note:** When Atlassian Access (Atlassian Guard) is configured with Entra ID, Confluence group membership is synced via SCIM. Group IDs in Confluence will correspond to Entra group names. Query `/wiki/rest/api/group` to enumerate groups and match by name.

---

## 10. Attachments

### 10.1 v2 Attachment Endpoints

```
GET /wiki/api/v2/attachments                        # all attachments (requires filter)
GET /wiki/api/v2/pages/{id}/attachments             # attachments for a page
GET /wiki/api/v2/blogposts/{id}/attachments         # attachments for a blog post
GET /wiki/api/v2/attachments/{id}                   # single attachment
GET /wiki/api/v2/attachments/{id}/thumbnail/download
```

### 10.2 Attachment Object Schema

```json
{
  "id": "att-123456",
  "status": "current",
  "title": "architecture-diagram.pdf",
  "createdAt": "2024-10-01T11:00:00.000Z",
  "pageId": "123456",
  "blogPostId": null,
  "customContentId": null,
  "mediaType": "application/pdf",
  "mediaTypeDescription": "PDF Document",
  "comment": "Updated for Q4 review",
  "fileId": "media-uuid-xyz",
  "fileSize": 1048576,
  "webuiLink": "/pages/viewpageattachments.action?pageId=123456",
  "downloadLink": "/wiki/download/attachments/123456/architecture-diagram.pdf",
  "version": {
    "createdAt": "2024-10-01T11:00:00.000Z",
    "number": 3,
    "authorId": "557058:abc"
  },
  "_links": {
    "webui": "...",
    "download": "/wiki/download/attachments/123456/architecture-diagram.pdf"
  }
}
```

### 10.3 Downloading Attachment Content

**Critical gotcha for Cloud:** The `_links.download` path (legacy `/download/` URL) returns 401 when using scoped API tokens. Use the v1 REST endpoint to download:

```typescript
async function downloadAttachment(
  client: ConfluenceApiClient,
  attachmentId: string
): Promise<Buffer> {
  // Cloud: use v1 REST endpoint for download (legacy /download/ returns 401 with scoped tokens)
  // Source: https://mcp-atlassian.soomiles.com/docs/tools/confluence-attachments
  const response = await client.rawGet(
    `/wiki/rest/api/content/${attachmentId}/download`
  );
  
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

// Data Center: the _links.download URL works fine with PAT
async function downloadAttachmentDC(
  baseUrl: string,
  downloadPath: string,
  headers: Headers
): Promise<Buffer> {
  const response = await fetch(`${baseUrl}${downloadPath}`, { headers });
  return Buffer.from(await response.arrayBuffer());
}
```

Source: [Atlassian community — attachment download auth with scoped token](https://community.atlassian.com/forums/Confluence-questions/How-do-i-download-attachments-from-pages-with-scoped-token/qaq-p/3222385), [MCP Atlassian attachment docs](https://mcp-atlassian.soomiles.com/docs/tools/confluence-attachments)

### 10.4 MIME Types for Text Extraction

Only index attachments with extractable text content:

```typescript
const INDEXABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',                                           // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel',                                    // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-powerpoint',                               // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'text/html',
]);

function shouldIndexAttachment(attachment: Attachment): boolean {
  if (attachment.fileSize > MAX_ATTACHMENT_BYTES) return false;
  return INDEXABLE_MIME_TYPES.has(attachment.mediaType);
}
```

### 10.5 Query Parameters for Attachment Listing

| Parameter | Type | Description |
|---|---|---|
| `sort` | `AttachmentSortOrder` | `created-date`, `-created-date`, `modified-date`, `-modified-date`, `title`, `-title` |
| `cursor` | `string` | Pagination cursor |
| `status` | `string[]` | `current`, `archived` |
| `mediaType` | `string` | Filter by MIME type |
| `filename` | `string` | Filter by filename |
| `limit` | `integer` | Max 250 |

---

## 11. Incremental Sync and Deletion Detection

### 11.1 Incremental Sync with CQL `lastmodified`

The `lastmodified` CQL field is the primary mechanism for incremental sync. Use the v1 search endpoint:

```typescript
interface SyncState {
  spaceKey: string;
  lastSyncAt: string; // ISO format: "2024-11-15 14:22"
}

async function incrementalSync(
  client: ConfluenceApiClient,
  syncState: SyncState
): Promise<void> {
  const cql = [
    `space = "${syncState.spaceKey}"`,
    `type IN (page, blogpost)`,
    `lastmodified > "${syncState.lastSyncAt}"`,
    `status = current`,
  ].join(' AND ');
  
  let pageCount = 0;
  
  for await (const item of searchAllByCql(client, cql)) {
    await indexPage(item);
    pageCount++;
  }
  
  console.log(`Incremental sync: ${pageCount} pages updated`);
  
  // Update sync state
  await saveSyncState({
    spaceKey: syncState.spaceKey,
    lastSyncAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
  });
}
```

**Gotcha — timezone sensitivity:** The CQL date comparison is server-timezone-relative. If your service runs in UTC but the Confluence instance is configured in US/Eastern, you may miss pages updated in the early UTC hours. Use a 5-minute overlap (subtract 5 minutes from the last sync timestamp) to handle clock skew and boundary conditions.

### 11.2 Handling Status Changes (Draft, Archived)

Pages can transition between statuses:

| Status | Meaning | Indexing action |
|---|---|---|
| `current` | Published and visible | Index / re-index |
| `draft` | Unpublished draft | Skip (may be indexed separately if permitted) |
| `archived` | Archived by space admin | Remove from active index, add to archive |
| `deleted` | In trash | Remove from all indexes |

To detect pages that were previously indexed but are now archived/deleted, use this v2 pattern:

```typescript
// Fetch specific page; 404 means deleted, check status for archived
async function checkPageStatus(
  client: ConfluenceApiClient,
  pageId: string
): Promise<'current' | 'archived' | 'deleted'> {
  try {
    // Request both current and archived statuses
    const page = await client.get<{ status: string }>(
      `/wiki/api/v2/pages/${pageId}?status=current,archived,deleted`
    );
    return page.status as 'current' | 'archived';
  } catch (err) {
    if (err.status === 404) return 'deleted';
    throw err;
  }
}
```

### 11.3 Deletion Detection: The Hard Problem

**There is no reliable deletion event stream in Confluence Cloud.** This is a known limitation:

- Confluence Cloud audit logs do not include page delete events (only Data Center has full audit trails)
- The v1 and v2 APIs have no "deleted content" endpoint for pages and blog posts
- The `status=deleted` filter on v2 page endpoints is inconsistently populated

Source: [Atlassian Developer Community — Detecting Page Deletes in Confluence](https://community.developer.atlassian.com/t/detecting-page-deletes-in-confluence/68022)

**Available workarounds:**

**Option A: Periodic full-ID diff (recommended for < 100,000 pages)**

```typescript
async function detectDeletions(
  client: ConfluenceApiClient,
  spaceKey: string,
  knownPageIds: Set<string>
): Promise<string[]> {
  const currentIds = new Set<string>();
  
  // Enumerate all current page IDs without body (fast)
  const cql = `space = "${spaceKey}" AND type IN (page, blogpost) AND status = current`;
  
  for await (const item of searchAllByCql(client, cql)) {
    currentIds.add(item.id);
  }
  
  // IDs that were known but are no longer present
  return [...knownPageIds].filter(id => !currentIds.has(id));
}
```

**Option B: Archive detection** — use CQL with `status = archived` to find recently archived pages, then cross-reference with your index.

**Option C: Use trash endpoint (v1)** — Confluence has a trash API for some content types, but coverage is incomplete for Cloud (no trash for whiteboards, smart links, or folders per Atlassian community reports).

### 11.4 Full Re-index Schedule

Given deletion detection limitations, schedule a full re-index periodically:

```typescript
const syncSchedule = {
  incremental: '*/15 * * * *',  // Every 15 minutes via CQL lastmodified
  fullReindex: '0 2 * * 0',     // Weekly full re-index on Sunday 2 AM
};
```

---

## 12. Content Body Processing: Macros and Storage Format

### 12.1 Storage Format Overview

Confluence pages are stored in XHTML-based XML called "storage format". It is technically XML (not valid XHTML). Key features:

- Standard HTML tags: `<p>`, `<table>`, `<ul>`, `<h1>` through `<h6>`, `<code>`, etc.
- Custom `ac:` namespace elements for Confluence macros: `<ac:structured-macro>`, `<ac:parameter>`, `<ac:rich-text-body>`
- Custom `ri:` namespace elements for resource inclusion: `<ri:page>`, `<ri:attachment>`, `<ri:url>`
- `<ac:link>` for page links; `<ac:image>` for inline images

Source: [confluence.atlassian.com/docm/latest/confluence-storage-format-838287719.html](https://confluence.atlassian.com/docm/latest/confluence-storage-format-838287719.html)

### 12.2 Example Storage Format

```xml
<p>See the <ac:link><ri:page ri:content-title="API Reference" ri:space-key="DEV"/></ac:link> for details.</p>

<ac:structured-macro ac:name="code" ac:schema-version="1">
  <ac:parameter ac:name="language">typescript</ac:parameter>
  <ac:plain-text-body><![CDATA[
    const x = 42;
    console.log(x);
  ]]></ac:plain-text-body>
</ac:structured-macro>

<ac:structured-macro ac:name="info">
  <ac:rich-text-body>
    <p>This is an info panel with important notes.</p>
  </ac:rich-text-body>
</ac:structured-macro>

<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="server">JIRA</ac:parameter>
  <ac:parameter ac:name="key">PROJ-123</ac:parameter>
</ac:structured-macro>
```

### 12.3 Macro Handling Strategy

Different macros require different treatment:

| Macro type | Examples | Handling |
|---|---|---|
| Content macros | `code`, `panel`, `info`, `warning`, `note`, `expand` | Extract `ac:plain-text-body` or `ac:rich-text-body` and include in output |
| Navigation macros | `toc`, `pagetree`, `children` | Drop entirely — no meaningful text content |
| External data macros | `jira`, `roadmap`, `chart` | Drop the macro, optionally emit `[Jira: PROJ-123]` stub |
| Include macros | `include`, `excerpt-include` | Optionally follow and include referenced page content |
| User macros | Custom macros | Drop — content unpredictable |
| Layout macros | `section`, `column`, `layoutsection` | Pass through and extract nested content |

### 12.4 TypeScript Storage Format to Plain Text

```typescript
import { DOMParser } from '@xmldom/xmldom';
import { XMLSerializer } from '@xmldom/xmldom';

export function storageFormatToPlainText(storageXml: string): string {
  // Wrap in a root element to make valid XML
  const xml = `<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/content">${storageXml}</root>`;
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  
  return extractText(doc.documentElement);
}

function extractText(node: Element | Document | ChildNode): string {
  const parts: string[] = [];
  
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const text = child.nodeValue?.trim();
      if (text) parts.push(text);
      continue;
    }
    
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const el = child as Element;
    const tagName = el.tagName.toLowerCase();
    
    // Block elements — add newlines
    if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'div'].includes(tagName)) {
      const text = extractText(el).trim();
      if (text) parts.push(text + '\n');
      continue;
    }
    
    // Code blocks — preserve content
    if (tagName === 'ac:plain-text-body') {
      const text = el.textContent?.trim();
      if (text) parts.push('\n```\n' + text + '\n```\n');
      continue;
    }
    
    // Macros with rich text bodies — recurse
    if (tagName === 'ac:rich-text-body') {
      parts.push(extractText(el));
      continue;
    }
    
    // Navigation macros — drop
    const macroName = el.getAttribute('ac:name') ?? '';
    if (['toc', 'pagetree', 'children', 'recently-updated'].includes(macroName)) {
      continue;
    }
    
    // Jira macro — emit stub
    if (macroName === 'jira') {
      const key = el.querySelector('ac\\:parameter[ac\\:name="key"]')?.textContent;
      if (key) parts.push(`[Jira: ${key}]`);
      continue;
    }
    
    // Default: recurse
    parts.push(extractText(el));
  }
  
  return parts.join(' ').replace(/\s{3,}/g, '\n\n').trim();
}
```

### 12.5 Atlassian Document Format (ADF)

Newer Confluence Cloud pages, Live Docs, and pages created in the Fabric editor use ADF (JSON AST) instead of storage format. ADF content is returned as a JSON string in `body.atlas_doc_format.value`.

```typescript
interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

export function adfToPlainText(adfJson: string): string {
  const doc: AdfDocument = JSON.parse(adfJson);
  return extractAdfText(doc.content ?? []);
}

function extractAdfText(nodes: AdfNode[]): string {
  return nodes.map(node => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'rule') return '\n---\n';
    if (node.content) {
      const childText = extractAdfText(node.content);
      // Add newlines for block types
      if (['paragraph', 'heading', 'listItem', 'tableRow', 'bulletList', 'orderedList'].includes(node.type)) {
        return childText + '\n';
      }
      if (node.type === 'codeBlock') {
        return '\n```\n' + childText + '\n```\n';
      }
      return childText;
    }
    return '';
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
}
```

---

## 13. Rate Limiting

### 13.1 Points-Based Model (Cloud Only)

Confluence Cloud introduced a points-based API rate limiting model (enforcement began March 2, 2026). Source: [developer.atlassian.com/cloud/confluence/rate-limiting/](https://developer.atlassian.com/cloud/confluence/rate-limiting/)

**Point costs per request:**

| Operation | Cost |
|---|---|
| Read core domain objects (pages, spaces, attachments) | 1 base + 1 per object = **2 points** |
| Read identity/access (users, groups, permissions) | 1 base + 2 per object = **3 points** |
| Write/create/update/delete | **1 point** flat |
| Search/admin operations | Higher burst cost; check `X-RateLimit-Remaining` |

### 13.2 Quota Tiers

| Tier | Quota |
|---|---|
| Tier 1 — Global Pool (default) | **65,000 points/hour** shared across all tenants |
| Tier 2 — Per-Tenant, Free | 65,000 points/hour |
| Tier 2 — Per-Tenant, Standard | 100,000 + (10 × users) points/hour |
| Tier 2 — Per-Tenant, Premium | 130,000 + (20 × users) points/hour |
| Tier 2 — Per-Tenant, Enterprise | 150,000 + (30 × users) points/hour, capped at 500,000 |

**For a typical enterprise full re-index:** If a space has 10,000 pages and you fetch each page + attachments (2 API calls each = 4 points), that is 40,000 points. You can do a full space re-index in one hour under Tier 1 if you pace at ~18 requests/second.

### 13.3 Rate Limit Response Headers

```
HTTP/1.1 429 Too Many Requests
Retry-After: 45
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2026-08-26T15:00:00Z
X-RateLimit-NearLimit: true
RateLimit-Reason: confluence-quota-global-based
```

Beta quota headers (informational until enforcement):
```
Beta-RateLimit-Policy: "global-app-quota";q=65000;w=3600
Beta-RateLimit: "global-app-quota";r=12000;t=1800
```

### 13.4 Retry Implementation

```typescript
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429) {
        const retryAfter = parseInt(err.headers?.get('retry-after') ?? '60', 10);
        const jitter = Math.random() * 5; // Add jitter to avoid thundering herd
        const delay = (retryAfter + jitter) * 1000;
        
        console.warn(`Rate limited. Waiting ${retryAfter}s before retry ${attempt + 1}/${maxRetries}`);
        await sleep(delay);
        attempt++;
        continue;
      }
      
      // 5xx transient errors also may have Retry-After
      if (err.status >= 500 && err.headers?.get('retry-after')) {
        const delay = parseInt(err.headers.get('retry-after'), 10) * 1000;
        await sleep(delay);
        attempt++;
        continue;
      }
      
      throw err;
    }
  }
  
  throw new Error(`Exceeded max retries (${maxRetries})`);
}

// Concurrency-controlled fetcher
import pLimit from 'p-limit';

const limit = pLimit(10); // Max 10 concurrent requests

async function batchFetchPages(client: ConfluenceApiClient, pageIds: string[]): Promise<Page[]> {
  return Promise.all(
    pageIds.map(id => limit(() => withRateLimitRetry(() => client.fetchPage(id))))
  );
}
```

### 13.5 Data Center Rate Limiting

Data Center rate limiting is configurable by the Confluence admin (disabled by default). When enabled, the admin configures limits per user or per hour. The same `429` + `Retry-After` headers are returned. Check `X-RateLimit-Remaining` header presence to detect if DC rate limiting is enabled.

---

## 14. Alternative Content Types: Whiteboards, Databases, Folders

### 14.1 Content Types in Confluence Cloud

Confluence Cloud has expanded beyond pages and blog posts with several new content types:

| Type | API Endpoint | Text Content Available? | Recommendation |
|---|---|---|---|
| Page | `/wiki/api/v2/pages` | Yes — storage/ADF | Index |
| Blog Post | `/wiki/api/v2/blogposts` | Yes — storage/ADF | Index |
| Whiteboard | `/wiki/api/v2/whiteboards/{id}` | No — visual canvas only | Skip |
| Database | `/wiki/api/v2/databases/{id}` | Schema + data rows via custom content | Skip for Phase 2 |
| Smart Link | `/wiki/api/v2/smart-links/{id}` | External URL embed, no text | Skip |
| Folder | `/wiki/api/v2/folders/{id}` | Container only, no content | Skip |
| Custom Content | `/wiki/api/v2/custom-content` | Varies by app | App-specific |

### 14.2 Whiteboards

Whiteboards are visual collaboration boards (sticky notes, shapes, connectors). The v2 API provides create/read/delete but **no text content extraction**. The whiteboard content (canvas data) is not accessible via the REST API.

```typescript
// Whiteboard response — NO body field
{
  "id": "wb-123",
  "type": "whiteboard",
  "status": "current",
  "title": "Q4 Planning Session",  // Only the title is useful
  "parentId": "page-456",
  "spaceId": "12345",
  "authorId": "...",
  "createdAt": "...",
  "version": { ... }
  // No body. No text. Just metadata.
}
```

**Recommendation:** Index whiteboard title only (may be meaningful for search), but do not attempt content extraction.

### 14.3 Databases

Confluence databases are structured data tables. They are accessible via the custom content API but the data model is complex:

```
GET /wiki/api/v2/custom-content?type=database&page-id={pageId}
```

The database structure and row data are encoded as custom content, requiring knowledge of the Confluence database schema format. This is not documented in the public API as of August 2026.

Source: [Stack Overflow — Confluence read database via REST API](https://stackoverflow.com/questions/78000092/confluence-read-database-via-rest-api)

**Recommendation:** Skip for Phase 2. No reliable extraction path exists.

### 14.4 Navigating Hierarchy with v2

```
GET /wiki/api/v2/pages/{id}/children      # Direct children
GET /wiki/api/v2/pages/{id}/ancestors     # All ancestors (breadcrumb)
GET /wiki/api/v2/pages/{id}/descendants   # All descendants recursively
```

These replace the v1 `expand=children,ancestors,descendants` pattern and are faster.

---

## 15. Atlassian Connect vs OAuth vs API Token

Choosing the right authentication approach for an enterprise deployment:

| Approach | Use Case | Pros | Cons |
|---|---|---|---|
| **API Token** | Service account indexing | Simple setup; no OAuth flow | Single user's permissions; no per-user impersonation |
| **OAuth 2.0 3LO** | Per-user ACL enforcement | True user identity; supports impersonation | Requires each user to authorize; token refresh complexity |
| **PAT (Data Center)** | DC service account | Simple; no expiry by default | DC only; user-scoped |
| **Atlassian Connect App** | Published Marketplace app | Full API surface; JWT auth | Complex app lifecycle; requires Atlassian review for P1+ scopes |
| **Forge App** | Hosted on Atlassian infra | No auth management; secure | Locked to Atlassian hosting; no self-hosted option |

Source: [developer.atlassian.com/developer-guide/auth/](https://developer.atlassian.com/developer-guide/auth/), [Atlassian community — Connect vs OAuth](https://community.atlassian.com/forums/Jira-questions/Atlassian-Connect-App-Vs-OAuth2-O-3LO/qaq-p/1285456)

### 15.1 Recommendation for markdown-for-agents-mcp

For Phase 2 enterprise knowledge index:

1. **Primary path:** Service account API token — registers one bot user with "Can use" and "Read" permissions on all spaces being indexed. Simple, reliable, no OAuth flow needed for the indexing pipeline.

2. **ACL enforcement at query time:** Store the `allowedUserAccountIds` and `allowedGroupIds` from space permissions and page restrictions in the index. At query time, look up the calling user's Confluence accountId (via email match or SCIM mapping) and their group memberships, then filter results server-side.

3. **Do not use OAuth 2.0 3LO for the crawler** — it requires per-user authorization and is inappropriate for a background indexing service.

---

## 16. Complete TypeScript Connector Implementation

### 16.1 Base Client

```typescript
// src/connectors/confluence/client.ts
import fetch, { Response } from 'node-fetch';

export interface ConfluenceClientConfig {
  baseUrl: string;       // e.g., 'https://acme.atlassian.net'
  deploymentType: 'cloud' | 'datacenter';
  auth: {
    type: 'api-token';
    email: string;
    token: string;
  } | {
    type: 'pat';
    token: string;
  } | {
    type: 'oauth2';
    accessToken: string;
    cloudId?: string;  // Required for Cloud OAuth 2.0 3LO
  };
}

export class ConfluenceClient {
  private headers: Record<string, string>;
  private v1Base: string;
  private v2Base: string;

  constructor(private config: ConfluenceClientConfig) {
    this.headers = this.buildAuthHeaders();
    
    if (config.deploymentType === 'cloud') {
      if (config.auth.type === 'oauth2' && config.auth.cloudId) {
        // 3LO tokens go through api.atlassian.com
        const apiBase = `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}`;
        this.v1Base = `${apiBase}/wiki/rest/api`;
        this.v2Base = `${apiBase}/wiki/api/v2`;
      } else {
        this.v1Base = `${config.baseUrl}/wiki/rest/api`;
        this.v2Base = `${config.baseUrl}/wiki/api/v2`;
      }
    } else {
      // Data Center — path varies by installation
      this.v1Base = `${config.baseUrl}/rest/api`;
      this.v2Base = '';  // Not available on DC
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    const auth = this.config.auth;
    
    if (auth.type === 'api-token') {
      const credentials = Buffer.from(`${auth.email}:${auth.token}`).toString('base64');
      return {
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };
    }
    
    if (auth.type === 'pat' || auth.type === 'oauth2') {
      return {
        'Authorization': `Bearer ${auth.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      };
    }
    
    throw new Error('Unknown auth type');
  }

  async getV2<T>(path: string): Promise<T> {
    if (!this.v2Base) throw new Error('v2 API not available on Data Center');
    return this.request<T>(`${this.v2Base}${path}`);
  }

  async getV1<T>(path: string): Promise<T> {
    return this.request<T>(`${this.v1Base}${path}`);
  }

  async getRaw(path: string): Promise<Response> {
    // Determine if path is v1 or v2
    const url = path.startsWith('/wiki/api/v2') || path.startsWith('/wiki/rest/api')
      ? `${this.config.baseUrl}${path}`
      : `${this.v1Base}${path}`;
    
    return fetch(url, { headers: this.headers });
  }

  private async request<T>(url: string, retries = 5): Promise<T> {
    let attempt = 0;
    
    while (attempt <= retries) {
      const response = await fetch(url, { headers: this.headers });
      
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '60', 10);
        await sleep((retryAfter + Math.random() * 5) * 1000);
        attempt++;
        continue;
      }
      
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error(`Confluence API error: ${response.status}`), {
          status: response.status,
          headers: response.headers,
          body,
        });
      }
      
      return response.json() as Promise<T>;
    }
    
    throw new Error(`Exceeded max retries for ${url}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 16.2 Space Enumerator

```typescript
// src/connectors/confluence/spaces.ts
import { ConfluenceClient } from './client';

export interface Space {
  id: string;
  key: string;
  name: string;
  type: 'global' | 'personal';
  status: 'current' | 'archived';
  homepageId: string;
  _links: { webui: string; base: string };
}

export async function* listSpaces(
  client: ConfluenceClient,
  options: { type?: 'global' | 'personal'; status?: 'current' } = { status: 'current' }
): AsyncGenerator<Space> {
  let cursor: string | undefined;
  
  do {
    const params = new URLSearchParams({
      limit: '50',
      ...(options.type && { type: options.type }),
      ...(options.status && { status: options.status }),
      ...(cursor && { cursor }),
    });
    
    const result = await client.getV2<{
      results: Space[];
      _links: { next?: string; base: string };
    }>(`/spaces?${params}`);
    
    for (const space of result.results) {
      yield space;
    }
    
    cursor = parseCursorFromNextLink(result._links.next);
  } while (cursor);
}

function parseCursorFromNextLink(nextLink?: string): string | undefined {
  if (!nextLink) return undefined;
  const match = nextLink.match(/cursor=([^&>]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
```

### 16.3 Page Enumerator with Incremental Sync

```typescript
// src/connectors/confluence/pages.ts
import { ConfluenceClient } from './client';
import { storageFormatToPlainText } from './content-processor';

export interface IndexablePage {
  id: string;
  title: string;
  spaceId: string;
  spaceKey: string;
  parentId: string | null;
  contentType: 'page' | 'blogpost';
  status: string;
  authorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;  // version.createdAt
  plainTextContent: string;
  webUrl: string;
  // ACL info
  spacePermissions?: SpacePermissionInfo;
  pageRestrictions?: PageRestrictionInfo | null;
}

// Use v1 CQL search for incremental sync (works on both Cloud and DC)
export async function* syncPages(
  client: ConfluenceClient,
  options: {
    spaceKeys?: string[];
    since?: string;  // ISO datetime: "2024-11-15 14:22"
    includeBodyInSearch?: boolean;  // Risky — max 50 results per CQL page
  } = {}
): AsyncGenerator<IndexablePage> {
  const clauses: string[] = ['type IN (page, blogpost)', 'status = current'];
  
  if (options.spaceKeys?.length) {
    const keys = options.spaceKeys.map(k => `"${k}"`).join(', ');
    clauses.push(`space IN (${keys})`);
  }
  
  if (options.since) {
    clauses.push(`lastmodified > "${options.since}"`);
  }
  
  const cql = clauses.join(' AND ') + ' ORDER BY lastmodified ASC';
  
  let start = 0;
  const limit = 50;
  
  while (true) {
    const params = new URLSearchParams({
      cql,
      limit: String(limit),
      start: String(start),
      // Request metadata but NOT body in bulk — fetch individually
      expand: 'space,version,ancestors',
    });
    
    const result = await client.getV1<{
      results: Array<{
        id: string;
        type: 'page' | 'blogpost';
        status: string;
        title: string;
        space: { key: string; id: string };
        version: { number: number; when: string; by: { accountId: string } };
        history: { createdDate: string };
        ancestors: Array<{ id: string }>;
        _links: { webui: string; base: string };
      }>;
      size: number;
      _links: { next?: string };
    }>(`/content/search?${params}`);
    
    for (const item of result.results) {
      // Fetch full body individually
      const body = await fetchPageBody(client, item.id, item.type);
      
      yield {
        id: item.id,
        title: item.title,
        spaceId: item.space.id,
        spaceKey: item.space.key,
        parentId: item.ancestors[item.ancestors.length - 1]?.id ?? null,
        contentType: item.type,
        status: item.status,
        authorId: item.version.by.accountId,
        version: item.version.number,
        createdAt: item.history.createdDate,
        updatedAt: item.version.when,
        plainTextContent: body,
        webUrl: item._links.base + item._links.webui,
      };
    }
    
    if (!result._links.next || result.results.length < limit) break;
    start += limit;
  }
}

async function fetchPageBody(
  client: ConfluenceClient,
  pageId: string,
  type: 'page' | 'blogpost'
): Promise<string> {
  // Cloud: use v2 with body-format=storage
  // DC: use v1 with expand=body.storage
  try {
    const endpoint = type === 'page'
      ? `/pages/${pageId}?body-format=storage`
      : `/blogposts/${pageId}?body-format=storage`;
    
    const page = await client.getV2<{
      body: { storage: { value: string } };
    }>(endpoint);
    
    return storageFormatToPlainText(page.body.storage.value);
  } catch (err) {
    // Fallback to v1 (works on DC too)
    if (err.status !== 400) {
      const page = await client.getV1<{
        body: { storage: { value: string } };
      }>(`/content/${pageId}?expand=body.storage`);
      
      return storageFormatToPlainText(page.body.storage.value);
    }
    throw err;
  }
}
```

### 16.4 Permission Fetcher

```typescript
// src/connectors/confluence/permissions.ts
import { ConfluenceClient } from './client';

export interface SpacePermissionInfo {
  spaceId: string;
  spaceKey: string;
  allowedUserAccountIds: string[];
  allowedGroupIds: string[];
  isPublic: boolean;  // true if anonymous users have read access
}

export interface PageRestrictionInfo {
  pageId: string;
  hasRestrictions: boolean;
  allowedUserAccountIds: string[];
  allowedGroupIds: string[];
}

export async function getSpaceReadPermissions(
  client: ConfluenceClient,
  spaceId: string,
  spaceKey: string
): Promise<SpacePermissionInfo> {
  const allowedUsers: string[] = [];
  const allowedGroups: string[] = [];
  let isPublic = false;
  let cursor: string | undefined;
  
  do {
    const params = new URLSearchParams({ limit: '250', ...(cursor && { cursor }) });
    
    const result = await client.getV2<{
      results: Array<{
        id: string;
        principal: { type: 'user' | 'group' | 'anonymous'; id: string };
        operation: { key: string; targetType: string };
      }>;
      _links: { next?: string };
    }>(`/spaces/${spaceId}/permissions?${params}`);
    
    for (const perm of result.results) {
      if (perm.operation.key !== 'read') continue;
      
      if (perm.principal.type === 'anonymous') {
        isPublic = true;
      } else if (perm.principal.type === 'user') {
        allowedUsers.push(perm.principal.id);
      } else if (perm.principal.type === 'group') {
        allowedGroups.push(perm.principal.id);
      }
    }
    
    cursor = parseCursorFromNextLink(result._links.next);
  } while (cursor);
  
  return { spaceId, spaceKey, allowedUserAccountIds: allowedUsers, allowedGroupIds: allowedGroups, isPublic };
}

export async function getPageRestrictions(
  client: ConfluenceClient,
  pageId: string
): Promise<PageRestrictionInfo> {
  // v1 only — no v2 equivalent
  try {
    const result = await client.getV1<{
      read: {
        restrictions: {
          user: { results: Array<{ accountId: string }> };
          group: { results: Array<{ id: string }> };
        };
      };
    }>(`/content/${pageId}/restriction/byOperation/read?expand=restrictions.user,restrictions.group`);
    
    const users = result.read.restrictions.user.results.map(u => u.accountId);
    const groups = result.read.restrictions.group.results.map(g => g.id);
    
    return {
      pageId,
      hasRestrictions: users.length > 0 || groups.length > 0,
      allowedUserAccountIds: users,
      allowedGroupIds: groups,
    };
  } catch (err) {
    // 404 means no restrictions exist
    if (err.status === 404) {
      return { pageId, hasRestrictions: false, allowedUserAccountIds: [], allowedGroupIds: [] };
    }
    throw err;
  }
}

function parseCursorFromNextLink(nextLink?: string): string | undefined {
  if (!nextLink) return undefined;
  const match = nextLink.match(/cursor=([^&>]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
```

### 16.5 Attachment Indexer

```typescript
// src/connectors/confluence/attachments.ts
import { ConfluenceClient } from './client';

const INDEXABLE_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export async function* listPageAttachments(
  client: ConfluenceClient,
  pageId: string
): AsyncGenerator<{
  id: string;
  title: string;
  mediaType: string;
  fileSize: number;
  downloadLink: string;
  createdAt: string;
}> {
  let cursor: string | undefined;
  
  do {
    const params = new URLSearchParams({
      limit: '50',
      status: 'current',
      ...(cursor && { cursor }),
    });
    
    const result = await client.getV2<{
      results: Array<{
        id: string;
        title: string;
        mediaType: string;
        fileSize: number;
        downloadLink: string;
        createdAt: string;
        _links: { download: string };
      }>;
      _links: { next?: string };
    }>(`/pages/${pageId}/attachments?${params}`);
    
    for (const att of result.results) {
      if (att.fileSize <= MAX_ATTACHMENT_BYTES && INDEXABLE_TYPES.has(att.mediaType)) {
        yield att;
      }
    }
    
    cursor = parseCursorFromNextLink(result._links.next);
  } while (cursor);
}

export async function downloadAttachment(
  client: ConfluenceClient,
  attachmentId: string,
  deploymentType: 'cloud' | 'datacenter'
): Promise<Buffer> {
  // Cloud: use v1 REST endpoint (legacy /download/ returns 401 with scoped tokens)
  // Source: https://community.atlassian.com/forums/Confluence-questions/How-do-i-download-attachments-from-pages-with-scoped-token/qaq-p/3222385
  if (deploymentType === 'cloud') {
    const response = await client.getRaw(`/wiki/rest/api/content/${attachmentId}/download`);
    if (!response.ok) {
      throw new Error(`Failed to download attachment ${attachmentId}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  
  // DC: use the downloadLink from the attachment metadata
  const att = await client.getV1<{ _links: { download: string }; }>(`/content/${attachmentId}`);
  const response = await client.getRaw(att._links.download);
  if (!response.ok) {
    throw new Error(`Failed to download attachment ${attachmentId}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseCursorFromNextLink(nextLink?: string): string | undefined {
  if (!nextLink) return undefined;
  const match = nextLink.match(/cursor=([^&>]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
```

### 16.6 Main Connector Orchestrator

```typescript
// src/connectors/confluence/index.ts
import { ConfluenceClient, ConfluenceClientConfig } from './client';
import { listSpaces } from './spaces';
import { syncPages } from './pages';
import { getSpaceReadPermissions, getPageRestrictions } from './permissions';
import { listPageAttachments, downloadAttachment } from './attachments';
import pLimit from 'p-limit';

export interface ConnectorOptions {
  config: ConfluenceClientConfig;
  spaceFilter?: string[];          // Only sync these space keys
  excludeSpaces?: string[];        // Never sync these space keys
  includeAttachments?: boolean;
  since?: string;                  // Incremental: ISO datetime
  onPage?: (page: IndexablePage) => Promise<void>;
  onError?: (err: Error, context: string) => void;
}

export async function runConfluenceConnector(options: ConnectorOptions): Promise<{
  pagesProcessed: number;
  attachmentsProcessed: number;
  errors: number;
}> {
  const client = new ConfluenceClient(options.config);
  const deploymentType = options.config.deploymentType;
  const pageFetchLimit = pLimit(5); // Conservative concurrency for body fetches
  
  let pagesProcessed = 0;
  let attachmentsProcessed = 0;
  let errors = 0;
  
  // Step 1: Get target spaces
  const targetSpaces: Array<{ id: string; key: string; name: string }> = [];
  
  for await (const space of listSpaces(client, { status: 'current' })) {
    if (options.excludeSpaces?.includes(space.key)) continue;
    if (options.spaceFilter?.length && !options.spaceFilter.includes(space.key)) continue;
    targetSpaces.push(space);
  }
  
  // Step 2: Pre-fetch space permissions (needed for ACL)
  const spacePermissionsCache = new Map<string, SpacePermissionInfo>();
  
  await Promise.all(
    targetSpaces.map(space =>
      getSpaceReadPermissions(client, space.id, space.key)
        .then(perms => spacePermissionsCache.set(space.id, perms))
        .catch(err => options.onError?.(err, `permissions:${space.key}`))
    )
  );
  
  // Step 3: Sync pages from all target spaces
  const spaceKeys = targetSpaces.map(s => s.key);
  
  for await (const page of syncPages(client, {
    spaceKeys,
    since: options.since,
  })) {
    try {
      // Fetch page-level restrictions
      const restrictions = await pageFetchLimit(() =>
        getPageRestrictions(client, page.id)
      );
      
      const enrichedPage: IndexablePage = {
        ...page,
        spacePermissions: spacePermissionsCache.get(page.spaceId),
        pageRestrictions: restrictions.hasRestrictions ? restrictions : null,
      };
      
      await options.onPage?.(enrichedPage);
      pagesProcessed++;
      
      // Optional: index attachments
      if (options.includeAttachments) {
        for await (const att of listPageAttachments(client, page.id)) {
          try {
            const content = await downloadAttachment(client, att.id, deploymentType);
            // Pass to text extraction pipeline (pdf-parse, mammoth, etc.)
            await options.onPage?.({
              ...enrichedPage,
              id: `att:${att.id}`,
              title: att.title,
              plainTextContent: await extractTextFromBinary(content, att.mediaType),
            });
            attachmentsProcessed++;
          } catch (attErr) {
            errors++;
            options.onError?.(attErr as Error, `attachment:${att.id}`);
          }
        }
      }
    } catch (pageErr) {
      errors++;
      options.onError?.(pageErr as Error, `page:${page.id}`);
    }
  }
  
  return { pagesProcessed, attachmentsProcessed, errors };
}
```

---

## 17. Limitations, Edge Cases, and Gotchas

### 17.1 API

| Issue | Detail | Mitigation |
|---|---|---|
| v2 CQL missing | No CQL endpoint in v2; must use v1 for all search-based sync | Always use v1 `/content/search` for incremental sync |
| Body in bulk CQL | Using `expand=body.storage` in v1 CQL caps results at 50 (silently) | Fetch IDs first, bodies individually |
| Cloud attachment download 401 | Scoped tokens get 401 on legacy `/download/` URLs | Use v1 REST download endpoint instead |
| 3LO tokens on wrong domain | 3LO tokens fail on site domain; must use `api.atlassian.com` | Always route 3LO requests through `api.atlassian.com/ex/confluence/{cloudId}` |
| No delete event stream | Cloud audit logs omit page delete events | Periodic full ID diff for deletion detection |
| Content restriction API v1 only | No v2 equivalent for `GET /content/{id}/restriction` | Must stay on v1 for restrictions |
| DC has no v2 | Data Center is v1 only | Detect deployment type; skip v2 calls on DC |
| Space personal type | Personal spaces have a `~accountId` key format | Filter with `type=global` if only indexing team spaces |

### 17.2 Content

| Issue | Detail | Mitigation |
|---|---|---|
| Macro proliferation | Complex macros (Jira, status, roadmap) inflate storage XML without useful text | Macro allow-list approach in extractor |
| Include macros | `include` and `excerpt-include` reference other pages | Optionally follow references; mark as transclusion in metadata |
| ADF vs storage | Some pages have ADF content, some have storage, some have both | Always request `storage`; fall back to ADF extraction if storage is empty |
| Tables as plain text | HTML tables flatten to poor plain text | Serialize table content row by row with separators |
| Large pages | Pages can be 10MB+ with complex macros expanded | Stream body parsing; set body size limit |
| Draft pages | CQL `status = current` excludes drafts; status changes can cause pages to appear/disappear | Only index `status = current` |
| Archived content | Archived pages are not in `status = current` CQL results | Track `status IN (current, archived)` separately |
| Confluence inline tasks | Task items are structured as `ac:task-list` elements | Extract task text; optionally include completion status |

### 17.3 Permissions

| Issue | Detail | Mitigation |
|---|---|---|
| Parent hierarchy restrictions | Confluence does NOT inherit parent page restrictions; each page is independent | Fetch restrictions per page, not per subtree |
| Space admin bypass | Space admins always see all content regardless of page restrictions | Treat admins as unrestricted in ACL model |
| Group nesting | Confluence groups are flat (no nested groups) | No recursive group expansion needed |
| SCIM group sync lag | When Entra AD groups change, SCIM sync to Confluence may lag 10-60 min | Cache group memberships with short TTL; handle 403 on stale cache |
| Anonymous read spaces | Some spaces have anonymous read access; these are effectively public | Check `isPublic` flag in SpacePermissionInfo; no ACL filter for these |

### 17.4 Rate Limits

| Issue | Detail | Mitigation |
|---|---|---|
| Points-based accounting | Permission lookups cost 3 points vs 2 for content reads | Batch permission fetches; cache aggressively |
| Burst limits on search | CQL search endpoint has additional burst protection | Add 100ms delay between CQL requests |
| Hourly reset | Quota resets at top of UTC hour — no carry-over | Schedule full re-indexes to start near the top of the hour |
| Global pool shared | Tier 1 (65,000 pts/hr) is shared across all tenants using your OAuth app | Consider a service-account API token (not counted against app quota in the same way) |

### 17.5 Data Center Specific

| Issue | Detail | Mitigation |
|---|---|---|
| Non-standard paths | DC installs may use `/confluence/rest/api/` or `/rest/api/` | Make base path configurable; auto-detect via OPTIONS request |
| SSL certificates | Internal DC instances commonly use self-signed certs | Allow `NODE_TLS_REJECT_UNAUTHORIZED=0` in config (document the risk) |
| Older versions | Some DC instances run Confluence 7.x which lacks PAT support (7.9+) | Fall back to username/password Basic Auth |
| No audit API | DC audit log is file-based, not API-accessible | No programmatic deletion detection; full re-index weekly |

---

## 18. What to Build, What to Skip

### Build for Phase 2 MVP

| Feature | Priority | Notes |
|---|---|---|
| Cloud and DC authentication (API token + PAT) | P0 | Foundation for everything |
| Space listing with status filter | P0 | Both types: global + personal |
| Page enumeration via CQL (v1) | P0 | Core incremental sync mechanism |
| Page body fetch (storage format) | P0 | Both v1 and v2 paths |
| Storage format to plain text conversion | P0 | Handle macros, ADF, code blocks |
| Space permission fetching | P0 | ACL enforcement foundation |
| Page restriction fetching (v1) | P0 | Per-page ACL |
| Rate limit handling with `Retry-After` | P0 | Prevent crawler failures |
| Blog post indexing (same as pages) | P1 | High-value content for knowledge index |
| Attachment indexing (PDF, DOCX) | P1 | Common enterprise content format |
| Incremental sync state persistence | P1 | Avoid full re-index on every run |
| Deletion detection (ID diff) | P1 | Keep index fresh |
| Cursor-based pagination | P1 | Required for large spaces |

### Skip for Phase 2

| Feature | Reason |
|---|---|
| Whiteboard content extraction | No text content accessible via API |
| Confluence databases | No documented extraction API |
| Smart Links / Folders | No text content; metadata only |
| OAuth 2.0 3LO crawler | Service account API token is simpler and sufficient |
| Comment indexing | Low signal-to-noise for enterprise knowledge |
| Template indexing | Structural, not knowledge content |
| Custom macros | Unpredictable structure; skip safely |
| Space export (bulk download) | XML export is not a real-time sync mechanism |
| Webhook-based sync | Confluence Cloud webhooks exist but have reliability issues and don't cover all event types |

### Architecture Decisions

1. **Hybrid v1+v2:** Use v2 for space/page metadata enumeration (faster, typed); use v1 for CQL search, content restrictions, and attachment downloads.

2. **Storage format is canonical:** Always request `storage` body format. It is the most portable format across Cloud and DC versions. Parse macros client-side rather than relying on server-side rendering.

3. **Permission caching:** Space permissions change infrequently. Cache with a 30-minute TTL. Page restrictions change more often — fetch on each page crawl but cache per sync run.

4. **Concurrency budget:** Use 5 concurrent page body fetches and 3 concurrent attachment downloads to stay well within burst limits and per-Confluence-instance connection limits.

5. **Content fingerprinting:** Store `version.number` and `version.createdAt` from each page. Compare on next incremental sync to skip unchanged pages even if they appear in the `lastmodified` window.

---

## References

- [Confluence REST API v2 Reference](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Confluence REST API v1 Reference (Cloud)](https://developer.atlassian.com/cloud/confluence/rest/v1/intro/)
- [Confluence Data Center REST API](https://developer.atlassian.com/server/confluence/rest/v951/intro/)
- [CQL Advanced Search Documentation](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/)
- [CQL Fields Reference](https://developer.atlassian.com/cloud/confluence/cql-fields/)
- [Confluence Rate Limiting](https://developer.atlassian.com/cloud/confluence/rate-limiting/)
- [OAuth 2.0 3LO Apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)
- [Personal Access Tokens (Data Center)](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
- [Confluence Storage Format](https://confluence.atlassian.com/docm/latest/confluence-storage-format-838287719.html)
- [Confluence Permissions Model](https://support.atlassian.com/confluence-cloud/docs/what-are-confluence-cloud-permissions-and-restrictions/)
- [confluence.js — TypeScript client](https://mrrefactoring.github.io/confluence.js/)
- [MCP Atlassian — Attachment Download Notes](https://mcp-atlassian.soomiles.com/docs/tools/confluence-attachments)
- [Atlassian blog — API v2 Performance Improvements](https://www.atlassian.com/blog/development/the-confluence-cloud-rest-api-v2-brings-major-performance-improvements)
- [Atlassian Developer Community — v1 vs v2 Function Gaps](https://community.atlassian.com/forums/Confluence-questions/the-funciton-lackness-of-REST-API-v2-compared-with-v1/qaq-p/3101941)
- [Atlassian Developer Community — Detecting Page Deletes](https://community.developer.atlassian.com/t/detecting-page-deletes-in-confluence/68022)
- [Atlassian Points-Based Rate Limiting Blog](https://www.atlassian.com/blog/development/evolving-api-rate-limits)
