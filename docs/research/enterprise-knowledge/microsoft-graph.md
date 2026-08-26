# Microsoft Graph API + M365 Copilot — Enterprise Knowledge Retrieval Implementation Guide

**For:** markdown-for-agents-mcp SharePoint/Confluence connector (Phase 2)
**Scope:** Complete implementation guide covering search, delta sync, webhooks, auth, ACL enforcement, throttling
**Last updated:** 2026-08-26
**Sources:** Microsoft Learn docs fetched live; see inline citations throughout

---

## Table of Contents

1. [Why Microsoft Graph for Enterprise Knowledge](#1-why-microsoft-graph)
2. [Architecture Overview for Our SharePoint Connector](#2-architecture-overview)
3. [Entra ID App Registration — Step-by-Step](#3-entra-id-app-registration)
4. [Authentication: Client Credentials vs OBO Flow](#4-authentication-flows)
5. [Graph Search API — All Entity Types + KQL Reference](#5-graph-search-api)
6. [SharePoint-Specific APIs](#6-sharepoint-specific-apis)
7. [Delta Sync (Change Tracking)](#7-delta-sync)
8. [Change Notifications (Webhooks)](#8-change-notifications-webhooks)
9. [Microsoft Graph MCP Server (Preview)](#9-microsoft-graph-mcp-server)
10. [transitiveMemberOf — Per-User ACL Enforcement](#10-transitivememberof-acl)
11. [MSAL Node.js — Token Patterns](#11-msal-nodejs)
12. [Throttling — Limits, Headers, Retry Strategy](#12-throttling)
13. [TypeScript Implementation Plan](#13-typescript-implementation-plan)
14. [What to Build vs What to Skip](#14-build-vs-skip)
15. [Limitations, Failure Modes, Gotchas](#15-limitations-and-gotchas)

---

## 1. Why Microsoft Graph

Microsoft Graph is the single API gateway for all M365 data — SharePoint, OneDrive, Outlook, Teams, Planner, and Entra identity. For our SharePoint connector the critical properties are:

| Property | Detail |
|---|---|
| Unified endpoint | `https://graph.microsoft.com/v1.0/` and `/beta/` |
| Auth standard | OAuth 2.0 / MSAL |
| Search API | One POST covers driveItem, listItem, site, message, event, externalItem |
| Delta sync | Pull-based incremental change tracking with token |
| Webhooks | Push notifications within seconds of a change |
| ACL enforcement | Delegated tokens automatically enforce SharePoint permissions |
| MCP server (preview) | Microsoft's own MCP wrapper around Graph (Entra data only today) |

**Why not just use CSOM or SharePoint REST?** Graph is the strategic investment; CSOM is deprecated for new work. The Search API via Graph is the only way to run cross-site federated queries.

Sources: [Graph overview](https://learn.microsoft.com/en-us/graph/search-concept-overview), [MCP server overview](https://learn.microsoft.com/en-us/graph/mcp-server/overview)

---

## 2. Architecture Overview

```
User request (MCP tool call)
        │
        ▼
 markdown-for-agents-mcp
 SharePoint Connector (TypeScript)
        │
        ├─── MSAL OBO token exchange (user's Entra token → Graph token)
        │
        ├─── POST /v1.0/search/query          ← real-time query path
        │        entityTypes: [driveItem, listItem, site]
        │        queryString: KQL
        │        delegated token (user's ACL applies automatically)
        │
        ├─── GET /v1.0/sites/{id}/drive/root/delta   ← background indexing
        │        delta token stored in our DB per site
        │
        ├─── GET /v1.0/users/{id}/transitiveMemberOf  ← group ACL cache
        │        cached per user, TTL 15 min
        │
        └─── POST /v1.0/subscriptions          ← webhook for live updates
                 resource: /sites/{id}/drive/root
                 notificationUrl: our HTTPS endpoint
```

### Two operating modes

**Mode A: Delegated search (recommended for most queries)**
- User provides an Entra access token with `Files.Read.All` or `Sites.Read.All`
- We exchange it via OBO for a Graph token
- POST to Search API with delegated token
- SharePoint enforces item-level permissions automatically — we get only what the user can see
- No separate ACL enforcement needed

**Mode B: App-only with transitiveMemberOf filtering (for indexing)**
- App registers as service principal with `Sites.Read.All` (application permission)
- Crawls all sites and documents for indexing
- Before returning any result, calls transitiveMemberOf to get the requesting user's groups
- Filters indexed results to items where the user's groups match ACLs stored during crawl
- Required when we build our own index (Postgres/vector store) that persists content

Mode A is simpler and always correct. Mode B is needed only if we want sub-second latency from our own vector store. **Recommendation: start with Mode A, add Mode B only when search latency from Graph becomes the bottleneck.**

---

## 3. Entra ID App Registration — Step-by-Step

### 3.1 Register the application

1. Go to [portal.azure.com](https://portal.azure.com) → Entra ID → App registrations → New registration
2. Name: `markdown-for-agents-mcp`
3. Supported account types: `Accounts in this organizational directory only` (single tenant) OR `Any Azure AD directory` (multi-tenant SaaS)
4. Redirect URI: `https://your-domain/auth/callback` (Web platform) — only needed for delegated flows

### 3.2 Minimal required permissions

#### For delegated search (Mode A — recommended)

| Permission | Type | Why |
|---|---|---|
| `Files.Read.All` | Delegated | Read all files on behalf of user |
| `Sites.Read.All` | Delegated | Read all SharePoint sites |
| `User.Read` | Delegated | Read signed-in user profile |
| `GroupMember.Read.All` | Delegated | Optional: for transitiveMemberOf |

#### For app-only indexing (Mode B)

| Permission | Type | Why |
|---|---|---|
| `Sites.Read.All` | Application | Crawl all SharePoint sites |
| `Files.Read.All` | Application | Read all files |
| `User.Read.All` | Application | Resolve user IDs during indexing |
| `Group.Read.All` | Application | Read group memberships for ACL |

> **Important:** Application permissions require admin consent. Delegated permissions for `Files.Read.All` and `Sites.Read.All` also require admin consent (they are not user-grantable). Plan this into your onboarding flow.

### 3.3 Configure credentials

**Option A: Client secret** (simpler, rotate every 90 days)
- Certificates & secrets → New client secret → copy immediately

**Option B: Certificate** (production recommended)
```bash
# Generate self-signed cert
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
# Upload cert.pem to Azure portal under Certificates & secrets
```

**Option C: Federated identity credential** (best for Azure-hosted deployments)
- Eliminates rotating secrets by federating with Azure Managed Identity

### 3.4 Collect values

After registration, save:
- **Application (client) ID** — your `clientId`
- **Directory (tenant) ID** — your `tenantId`
- **Client secret or certificate thumbprint** — your `clientSecret`

### 3.5 For OBO flow: expose an API

For Mode A (OBO), your app must also expose an API scope so clients can request a token for it:

1. Expose an API → Add a scope
2. Scope name: `SharePointSearch.Read`
3. Consent: `Admins and users`
4. Note the Application ID URI (e.g. `api://your-client-id`)

---

## 4. Authentication Flows

Source: [Graph auth without user](https://learn.microsoft.com/en-us/graph/auth-v2-service), [auth concepts](https://learn.microsoft.com/en-us/graph/auth/auth-concepts)

### 4.1 Client Credentials Flow (app-only, Mode B)

Used for background indexing jobs where no user is present.

```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=<clientId>
&client_secret=<clientSecret>
&scope=https://graph.microsoft.com/.default
&grant_type=client_credentials
```

Response:
```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "ext_expires_in": 3599,
  "access_token": "eyJ0..."
}
```

TypeScript with MSAL:
```typescript
import { ConfidentialClientApplication } from '@azure/msal-node';

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
  },
});

async function getAppToken(): Promise<string> {
  const result = await msalClient.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result) throw new Error('Failed to acquire app token');
  return result.accessToken;
}
```

### 4.2 On-Behalf-Of (OBO) Flow (delegated, Mode A)

The canonical flow for MCP servers acting on behalf of a user:

```
1. User authenticates with your app → receives access token for your API scope
2. Your MCP server exchanges that token for a Graph token via OBO
3. Call Graph using the exchanged token — Graph enforces the user's SharePoint permissions
```

OBO exchange request:
```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
&client_id=<clientId>
&client_secret=<clientSecret>
&assertion=<user's access token for your API>
&scope=https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All
&requested_token_use=on_behalf_of
```

TypeScript OBO with MSAL:
```typescript
import { ConfidentialClientApplication, OnBehalfOfRequest } from '@azure/msal-node';

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
  },
  cache: {
    // IMPORTANT: plug in a persistent cache (Redis, Postgres) for production
    // Without this every OBO call hits the token endpoint — very expensive
    cachePlugin: buildMsalCachePlugin(),
  },
});

export async function getOboToken(userAccessToken: string): Promise<string> {
  const oboRequest: OnBehalfOfRequest = {
    oboAssertion: userAccessToken,
    scopes: [
      'https://graph.microsoft.com/Files.Read.All',
      'https://graph.microsoft.com/Sites.Read.All',
      'https://graph.microsoft.com/User.Read',
    ],
  };
  const result = await msalClient.acquireTokenOnBehalfOf(oboRequest);
  if (!result) throw new Error('OBO token exchange failed');
  return result.accessToken;
}
```

> **Gotcha:** OBO requires the incoming token to be issued for YOUR app's scope, not for Graph directly. If the user authenticates directly to Graph you cannot OBO. Configure your clients to request a token for `api://<your-client-id>/SharePointSearch.Read` first.

### 4.3 Token caching strategy

Tokens are valid for ~1 hour (`expires_in: 3599`). MSAL's in-memory cache handles per-process caching but dies on restart.

For production:
```typescript
import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import Redis from 'ioredis';

function buildMsalCachePlugin(redis: Redis): ICachePlugin {
  return {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
      const cached = await redis.get('msal:token-cache');
      if (cached) ctx.tokenCache.deserialize(cached);
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
      if (ctx.cacheHasChanged) {
        await redis.set('msal:token-cache', ctx.tokenCache.serialize(), 'EX', 3600);
      }
    },
  };
}
```

For OBO tokens, cache per user (`userId` as Redis key prefix). App tokens can share a single cache entry.

---

## 5. Graph Search API — All Entity Types + KQL Reference

Source: [Search concept overview](https://learn.microsoft.com/en-us/graph/search-concept-overview), [Search SharePoint](https://learn.microsoft.com/en-us/graph/search-concept-files), [App permissions search](https://learn.microsoft.com/en-us/graph/search-concept-searchall)

### 5.1 Endpoint

```
POST https://graph.microsoft.com/v1.0/search/query
Authorization: Bearer {token}
Content-Type: application/json
```

### 5.2 Request schema

```typescript
interface SearchRequest {
  requests: Array<{
    entityTypes: EntityType[];           // required — what to search
    query: {
      queryString: string;               // KQL query string
    };
    from?: number;                       // pagination start (default 0)
    size?: number;                       // page size (default 25, max 500)
    fields?: string[];                   // properties to return in hits
    region?: string;                     // required for app-only! e.g. "NAM"
    sharePointOneDriveOptions?: {
      includeContent?: 'privateContent,sharedContent' | 'sharedContent';
    };
    sortProperties?: Array<{
      name: string;
      isDescending: boolean;
    }>;
    aggregations?: Array<{
      field: string;
      bucketDefinition: { minimumCount: number; ranges?: unknown[] };
    }>;
    trimDuplicates?: boolean;
    enableTopResults?: boolean;          // semantic boost for top result
  }>;
}
```

### 5.3 Supported entity types

| Entity Type | What it covers | Notes |
|---|---|---|
| `driveItem` | Files and folders in OneDrive/SharePoint document libraries | Most common for document search |
| `listItem` | Items in SharePoint lists (non-document) | Custom columns accessible via `fields` |
| `list` | SharePoint list metadata | Not individual items |
| `site` | SharePoint site metadata | Good for site discovery queries |
| `drive` | Drive (document library) metadata | Less commonly searched |
| `message` | Outlook email messages | Requires `Mail.Read` |
| `event` | Calendar events | Requires `Calendars.Read` |
| `person` | People in the org most relevant to user | Beta only; requires `People.Read.All` |
| `externalItem` | Content indexed via Copilot connectors | Requires connector setup |

**You can mix entity types in one request:**
```json
{
  "requests": [{
    "entityTypes": ["driveItem", "listItem", "site"],
    "query": { "queryString": "quarterly report" }
  }]
}
```

> **Limitation:** `message` and `event` cannot be combined with SharePoint types in the same request element. Use separate request objects in the array.

### 5.4 KQL syntax reference

KQL (Keyword Query Language) is used for the `queryString`. Supported operators:

| Syntax | Example | Effect |
|---|---|---|
| Plain text | `contoso strategy` | Full-text search |
| Quoted phrase | `"quarterly report"` | Exact phrase match |
| Property restriction | `filetype:docx` | Filter by property |
| AND (implicit) | `contoso strategy` | Both terms required |
| OR | `contoso OR adatum` | Either term |
| NOT | `contoso NOT adatum` | Exclude term |
| Parentheses | `(contoso OR adatum) strategy` | Grouping |
| Wildcard | `contoso*` | Prefix wildcard only |
| Path restriction | `path:"https://contoso.sharepoint.com/sites/team/Documents/Project"` | Scope to folder |
| Date range | `LastModifiedTime > 2024-01-01` | Temporal filter |
| Date range | `(LastModifiedTime > 2024-01-01 AND Created > 2023-01-01)` | Combined |
| File type | `filetype:docx OR filetype:pdf` | Multiple types |
| Document flag | `isDocument=true` | Exclude folders/containers |
| Content class | `contentclass:STS_List_Events` | SharePoint content type |
| Author | `author:"John Smith"` | By author name |

**KQL examples for common scenarios:**

```
# Recent Word docs about project X
quarterly project filetype:docx LastModifiedTime > 2025-01-01

# All PDFs in a specific site
path:"https://contoso.sharepoint.com/sites/hr" filetype:pdf

# Non-container items matching "budget"
budget isDocument=true

# Exact phrase in a specific folder
"headcount reduction" path:"https://contoso.sharepoint.com/sites/hr/Documents"

# Any doc type, recent, with author
author:"Jane Doe" LastModifiedTime > 2025-06-01
```

> **Gotcha:** Property names in KQL are case-sensitive for managed properties. `filetype` is lowercase. `LastModifiedTime` is PascalCase (SharePoint managed property). Test in Graph Explorer before assuming a property name works.

### 5.5 Response schema

```typescript
interface SearchResponse {
  value: Array<{
    searchTerms: string[];
    hitsContainers: Array<{
      total: number;
      moreResultsAvailable: boolean;
      hits: Array<{
        hitId: string;              // item ID (drive item path or GUID)
        rank: number;               // relevance rank (1-based)
        summary: string;            // HTML snippet with <c0> highlights
        resource: DriveItemResource | ListItemResource | SiteResource;
      }>;
    }>;
  }>;
}

interface DriveItemResource {
  '@odata.type': '#microsoft.graph.driveItem';
  id: string;
  name: string;
  webUrl: string;
  createdDateTime: string;          // ISO 8601
  lastModifiedDateTime: string;
  size?: number;                    // bytes
  createdBy: { user: { displayName: string; id?: string } };
  lastModifiedBy: { user: { displayName: string; id?: string } };
  parentReference: {
    siteId: string;                 // format: hostname,siteGuid,webGuid
    driveId: string;
    sharepointIds: {
      listId: string;
      listItemId: string;
      listItemUniqueId: string;     // GUID, stable across renames
    };
  };
  fileSystemInfo: {
    createdDateTime: string;
    lastModifiedDateTime: string;
  };
  listItem?: {                      // present when fields requested
    '@odata.type': '#microsoft.graph.listItem';
    fields: Record<string, unknown>;
  };
}

interface ListItemResource {
  '@odata.type': '#microsoft.graph.listItem';
  id: string;
  name: string;
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  sharepointIds: { listId: string; listItemId: string };
  parentReference: { siteId: string };
  fields?: Record<string, unknown>; // custom columns
}
```

### 5.6 Requesting custom columns (fields)

For `listItem` or `driveItem` with internal `listItem`:
```json
{
  "requests": [{
    "entityTypes": ["listItem"],
    "query": { "queryString": "contoso" },
    "fields": ["title", "contentclass", "author", "department"]
  }]
}
```

Field names must be SharePoint internal names (often different from display names). Find them via: `GET /sites/{id}/lists/{listId}/fields`.

### 5.7 Pagination

The API does not return a `@odata.nextLink`. Use `from` and `size` for pagination:

```typescript
async function* searchAll(query: string, token: string): AsyncGenerator<SearchHit[]> {
  const size = 50;
  let from = 0;
  
  while (true) {
    const body = {
      requests: [{
        entityTypes: ['driveItem', 'listItem'],
        query: { queryString: query },
        from,
        size,
      }],
    };
    
    const resp = await fetch('https://graph.microsoft.com/v1.0/search/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    const data = await resp.json();
    const container = data.value[0].hitsContainers[0];
    yield container.hits;
    
    if (!container.moreResultsAvailable) break;
    from += size;
  }
}
```

> **Limit:** Maximum page size is 500. Total results beyond 500 are silently truncated in many scenarios. This is a significant limitation — you cannot page through all 10,000 results of a broad query.

### 5.8 Application permissions search — important differences

When using app-only tokens (no user):
- You **must** specify `region` (e.g. `"NAM"`, `"EUR"`, `"APC"`) — queries without it fail
- By default only **shared** content is searched
- To search private OneDrive content, specify `sharePointOneDriveOptions.includeContent: "privateContent,sharedContent"`
- Provisioning a private content index takes **days to a week** for large tenants
- The private content index is decommissioned after 3 months of inactivity

```json
{
  "requests": [{
    "entityTypes": ["listItem"],
    "query": { "queryString": "confidential" },
    "region": "NAM",
    "sharePointOneDriveOptions": {
      "includeContent": "privateContent,sharedContent"
    }
  }]
}
```

**Verdict:** For our Phase 2 connector, use delegated OBO tokens for search. This avoids the region requirement, the private content provisioning delay, and eliminates the need for separate ACL filtering. Reserve app-only for background indexing jobs.

---

## 6. SharePoint-Specific APIs

Sources: [driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta), [site list](https://learn.microsoft.com/en-us/graph/api/site-list)

### 6.1 Site enumeration

List all SharePoint site collections (app permission required):
```
GET /v1.0/sites?$filter=siteCollection/root ne null&$select=siteCollection,webUrl,id,displayName
```

List all sites (including subsites) — paginated:
```
GET /v1.0/sites?$search=*
```

Get a specific site by hostname + path:
```
GET /v1.0/sites/{hostname}:/{server-relative-path}
# e.g. GET /v1.0/sites/contoso.sharepoint.com:/sites/hr
```

Get all subsites of a site:
```
GET /v1.0/sites/{site-id}/sites
```

Response shape for a site:
```typescript
interface Site {
  id: string;                   // "hostname,siteGuid,webGuid" — the three-part ID
  displayName: string;
  name: string;                 // URL slug
  webUrl: string;
  description?: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  siteCollection?: {
    hostname: string;
    dataLocationCode?: string;  // e.g. "NAM" — use this for region in search
    root?: {};                  // present if root site collection
  };
}
```

### 6.2 Drive (document library) listing

Each SharePoint site can have multiple document libraries (drives):
```
GET /v1.0/sites/{site-id}/drives
```

Get the default drive:
```
GET /v1.0/sites/{site-id}/drive
```

Response:
```typescript
interface Drive {
  id: string;
  name: string;                 // e.g. "Documents", "Shared Documents"
  driveType: 'business' | 'personal' | 'documentLibrary';
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  quota?: {
    total: number;
    used: number;
    remaining: number;
    state: string;
  };
  owner?: {
    user?: { id: string; displayName: string };
    group?: { id: string; displayName: string };
  };
}
```

### 6.3 DriveItem download and content

Get content (download URL) for a file:
```
GET /v1.0/drives/{driveId}/items/{itemId}/content
```
This returns a 302 redirect to a short-lived (a few minutes) pre-authenticated download URL. Follow the redirect to get the bytes.

Alternatively, get the download URL without redirecting:
```
GET /v1.0/drives/{driveId}/items/{itemId}?$select=id,name,@microsoft.graph.downloadUrl
```
The `@microsoft.graph.downloadUrl` field gives a direct URL valid for ~1 hour.

TypeScript download helper:
```typescript
async function downloadDriveItem(
  driveId: string,
  itemId: string,
  token: string
): Promise<Buffer> {
  const metaResp = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}` +
    `?$select=id,name,@microsoft.graph.downloadUrl`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaResp.json();
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  
  // Download URL is pre-authenticated — no token needed
  const fileResp = await fetch(downloadUrl);
  return Buffer.from(await fileResp.arrayBuffer());
}
```

### 6.4 List all items in a drive/folder

For shallow listing (one folder level):
```
GET /v1.0/drives/{driveId}/root/children
GET /v1.0/drives/{driveId}/items/{folderId}/children
```

For recursive listing — use delta instead (see section 7). Manual recursion creates too many API calls and gets throttled.

### 6.5 SharePoint list metadata and custom columns

Get all lists in a site:
```
GET /v1.0/sites/{site-id}/lists?$select=id,name,displayName,list
```

Get field definitions (schema) for a list:
```
GET /v1.0/sites/{site-id}/lists/{list-id}/fields?$select=name,displayName,type,indexed
```

Get list items with custom fields:
```
GET /v1.0/sites/{site-id}/lists/{list-id}/items?$expand=fields
```

Response for a list item with fields:
```json
{
  "id": "1",
  "webUrl": "https://contoso.sharepoint.com/sites/hr/Lists/Policies/DispForm.aspx?ID=1",
  "createdDateTime": "2024-01-15T09:00:00Z",
  "fields": {
    "Title": "Annual Leave Policy",
    "PolicyCategory": "HR",
    "EffectiveDate": "2024-01-01T00:00:00Z",
    "ReviewDate": "2025-01-01T00:00:00Z",
    "Department": "All",
    "id": "1"
  }
}
```

> **Gotcha:** Internal field names differ from display names. `Title` is always `Title`. But a custom column "Review Date" might be `OData__x0052_eviewDate` or `Review_x0020_Date` depending on how it was created. Always check via `GET .../fields`.

### 6.6 Get SharePoint permissions on an item

```
GET /v1.0/drives/{driveId}/items/{itemId}/permissions
```

This returns the explicit permission grants. For ACL enforcement at index time, this is how you determine which groups/users have access to a file. Note: inherited permissions are NOT returned — only explicit grants and the unique permission set if permissions are broken.

---

## 7. Delta Sync (Change Tracking)

Source: [Delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview), [driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)

### 7.1 How it works

Delta query uses a pull model. The flow:

1. **Initial sync:** `GET /drives/{driveId}/root/delta` (no token) — returns all current items plus a `@odata.deltaLink`
2. **Follow pages:** If response has `@odata.nextLink`, follow it until you get `@odata.deltaLink`
3. **Store the deltaLink** (contains an opaque `$deltatoken`)
4. **Subsequent syncs:** Use the stored `@odata.deltaLink` — only changed items are returned

```
Initial call: GET .../root/delta
              → pages of ALL current items
              → @odata.nextLink (while more pages)
              → @odata.deltaLink (at end)
              
Later call:   GET @odata.deltaLink
              → only items changed since last call
              → @odata.deltaLink (updated token)
```

### 7.2 Change representation

- **New item:** Full item object with all properties
- **Modified item:** Partial object — only `id` plus changed properties. Always includes `lastModifiedDateTime`
- **Deleted item:** `{ "id": "...", "deleted": {} }` — the `deleted` facet signals removal

```typescript
interface DeltaItem {
  id: string;
  name?: string;
  size?: number;
  file?: {};              // present if this is a file
  folder?: {};            // present if this is a folder
  deleted?: {};           // present if deleted — remove from your index
  lastModifiedDateTime?: string;
  '@odata.type'?: string;
}
```

### 7.3 TypeScript delta sync implementation

```typescript
interface DeltaState {
  driveId: string;
  deltaLink: string;      // opaque URL including $deltatoken
  lastSyncedAt: Date;
}

class DriveIndexer {
  private db: YourDatabase;
  
  async initialSync(driveId: string, token: string): Promise<void> {
    let nextUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/delta`;
    const allItems: DeltaItem[] = [];
    
    while (nextUrl) {
      const resp = await this.graphGet(nextUrl, token);
      allItems.push(...resp.value);
      
      if (resp['@odata.nextLink']) {
        nextUrl = resp['@odata.nextLink'];
      } else {
        // Save the delta token for future incremental syncs
        await this.db.saveDeltaState({
          driveId,
          deltaLink: resp['@odata.deltaLink'],
          lastSyncedAt: new Date(),
        });
        nextUrl = null;
      }
    }
    
    await this.db.bulkUpsertItems(allItems.filter(i => !i.deleted));
  }
  
  async incrementalSync(driveId: string, token: string): Promise<void> {
    const state = await this.db.getDeltaState(driveId);
    if (!state) {
      await this.initialSync(driveId, token);
      return;
    }
    
    let nextUrl = state.deltaLink;
    
    while (nextUrl) {
      const resp = await this.graphGet(nextUrl, token);
      
      for (const item of resp.value) {
        if (item.deleted) {
          await this.db.deleteItem(item.id);
        } else {
          await this.db.upsertItem(item);
        }
      }
      
      if (resp['@odata.nextLink']) {
        nextUrl = resp['@odata.nextLink'];
      } else {
        await this.db.saveDeltaState({
          driveId,
          deltaLink: resp['@odata.deltaLink'],
          lastSyncedAt: new Date(),
        });
        nextUrl = null;
      }
    }
  }
  
  private async graphGet(url: string, token: string): Promise<any> {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    
    if (resp.status === 410) {
      // Delta token expired — full resync required
      throw new DeltaTokenExpiredError('Delta token gone, need full resync');
    }
    
    if (!resp.ok) throw new Error(`Graph error: ${resp.status}`);
    return resp.json();
  }
}
```

### 7.4 Token expiry and the 410 Gone response

Delta tokens for OneDrive/SharePoint drives do NOT have a documented fixed expiry. They expire after the internal delta cache is exhausted. In practice, tokens older than ~4 weeks are unreliable.

When Graph returns HTTP 410 Gone:
- The delta token is invalid
- You must restart with a full initial sync
- The response body includes a `Location` header with a new initial delta URL

```typescript
if (resp.status === 410) {
  const newStartUrl = resp.headers.get('Location');
  // Start fresh sync from newStartUrl (equivalent to initial sync)
}
```

### 7.5 "Sync from now" — skip the initial full read

If you only care about changes going forward (not indexing historical content):
```
GET /v1.0/drives/{driveId}/root/delta?token=latest
```
Returns an empty value array plus a `@odata.deltaLink`. Use this to start receiving only future changes without reading the entire drive.

### 7.6 listItem delta

For SharePoint list items (not files):
```
GET /v1.0/sites/{site-id}/lists/{list-id}/items/delta
```

Same token mechanics apply. Useful for tracking changes to structured list data (policies, contracts, etc.).

### 7.7 site delta

Track site-level changes across the tenant:
```
GET /v1.0/sites/delta
```
Returns newly created, updated, and deleted sites. Useful for discovering new SharePoint sites to index.

### 7.8 Storage recommendation

Store delta states per drive (or per site + list) in your database:

```sql
CREATE TABLE delta_sync_state (
  drive_id         VARCHAR(255) PRIMARY KEY,
  delta_link       TEXT NOT NULL,          -- the full @odata.deltaLink URL
  last_synced_at   TIMESTAMPTZ NOT NULL,
  status           VARCHAR(50) DEFAULT 'ready',  -- 'syncing', 'error', 'ready'
  item_count       INTEGER DEFAULT 0
);
```

---

## 8. Change Notifications (Webhooks)

Source: [Webhooks delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [Subscription post](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions)

### 8.1 Push vs Pull — when to use which

| Criterion | Delta Query (pull) | Webhooks (push) |
|---|---|---|
| Latency | Seconds to minutes (you choose polling interval) | Near-real-time (seconds) |
| Complexity | Low | Medium (need public HTTPS endpoint) |
| Reliability | Gap-free (all changes captured on next poll) | At-least-once (retry up to 4 hours) |
| Use case | Background indexing, batch sync | Live search index invalidation |

**Recommendation:** Use webhooks to trigger delta syncs, not to process individual changes. Subscribe to a drive → on notification → call incremental delta sync immediately. This combines the real-time trigger of webhooks with the reliability of delta query.

### 8.2 Subscription lifecycle

```
1. POST /v1.0/subscriptions  →  Graph sends validationToken to your endpoint
2. Your endpoint echoes validationToken as plain text (200 OK, < 3 seconds)
3. Graph responds with subscription ID and expirationDateTime
4. Changes occur → Graph POSTs notifications to your endpoint
5. Subscription expires → you must PATCH to renew before expiry
```

### 8.3 Create a subscription

```typescript
const subscription = {
  changeType: 'created,updated,deleted',
  notificationUrl: 'https://your-server.com/webhooks/graph',
  lifecycleNotificationUrl: 'https://your-server.com/webhooks/graph-lifecycle',
  resource: `/drives/${driveId}/root`,
  expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
  clientState: crypto.randomUUID(), // store this — validate on incoming notifications
};

const resp = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(subscription),
});
```

### 8.4 Subscription expiry limits by resource

| Resource | Maximum expiry |
|---|---|
| `driveItem` (OneDrive for Business) | 42300 minutes (~29 days) |
| `driveItem` (personal OneDrive) | 20160 minutes (14 days) |
| `listItem` | 29 days |
| `site` | 29 days |
| `message` | 10,080 minutes (7 days) |
| `event` | 10,080 minutes (7 days) |
| `group` | 41760 minutes (~29 days) |
| `user` | 41760 minutes (~29 days) |

You should renew at 50–75% of the maximum expiry, not right before it expires.

### 8.5 Webhook endpoint implementation

```typescript
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// Your stored client states per subscription
const subscriptionClientStates = new Map<string, string>();

app.post('/webhooks/graph', async (req, res) => {
  // Step 1: Handle validation request from Graph during subscription creation
  const validationToken = req.query.validationToken as string;
  if (validationToken) {
    // MUST respond within 3 seconds with plain text
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(validationToken);
  }
  
  // Step 2: Validate clientState to prevent spoofing
  const notifications = req.body.value as GraphNotification[];
  for (const notif of notifications) {
    const expectedState = subscriptionClientStates.get(notif.subscriptionId);
    if (notif.clientState !== expectedState) {
      console.warn(`Invalid clientState for subscription ${notif.subscriptionId}`);
      continue;
    }
    
    // Queue for async processing — DO NOT process inline (3s timeout)
    await notificationQueue.enqueue(notif);
  }
  
  // Must respond 202 within 3 seconds
  res.status(202).send();
});

// Process notifications asynchronously
async function processNotification(notif: GraphNotification): Promise<void> {
  const { resource, changeType, resourceData } = notif;
  // Trigger incremental delta sync for the affected drive
  const driveId = extractDriveId(resource);
  await driveIndexer.incrementalSync(driveId, await getAppToken());
}
```

### 8.6 Notification payload

```typescript
interface GraphNotification {
  changeType: 'created' | 'updated' | 'deleted';
  clientState: string;
  id: string;
  resource: string;             // e.g. "/drives/abc/root"
  resourceData?: {
    '@odata.type': string;
    '@odata.id': string;
    id: string;                 // item ID
  };
  subscriptionExpirationDateTime: string;
  subscriptionId: string;
  tenantId: string;
}
```

### 8.7 Lifecycle notifications

Add `lifecycleNotificationUrl` to your subscription. These arrive when:
- `subscriptionRemoved` — Graph deleted your subscription (e.g. resource deleted, permissions revoked)
- `missed` — Graph could not deliver notifications (endpoint was down)
- `reauthorizationRequired` — Your endpoint needs to prove it's still alive

Handle `reauthorizationRequired`:
```typescript
app.post('/webhooks/graph-lifecycle', async (req, res) => {
  const validationToken = req.query.validationToken as string;
  if (validationToken) {
    return res.status(200).contentType('text/plain').send(validationToken);
  }
  
  for (const notif of req.body.value) {
    if (notif.lifecycleEvent === 'reauthorizationRequired') {
      // Renew the subscription
      await renewSubscription(notif.subscriptionId);
    } else if (notif.lifecycleEvent === 'subscriptionRemoved') {
      // Re-create the subscription
      await createSubscription(extractDriveId(notif.resource));
    }
  }
  
  res.status(202).send();
});
```

### 8.8 Subscription renewal

```typescript
async function renewSubscription(subscriptionId: string, token: string): Promise<void> {
  const newExpiry = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();
  
  await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expirationDateTime: newExpiry }),
  });
}
```

### 8.9 Endpoint performance requirements

Graph monitors your endpoint and will throttle/drop notifications if it becomes slow:

- **Slow state:** >10% of responses take >3 seconds in a 10-minute window → notifications delayed 10 minutes
- **Drop state:** >15% of responses take >10 seconds → notifications dropped for 10 minutes
- **Recovery:** Endpoint must bring timeouts below threshold; missed notifications cannot be recovered

**Always return 202 immediately and process in a background queue.** Never do synchronous I/O (database writes, API calls) before responding to Graph.

---

## 9. Microsoft Graph MCP Server (Preview)

Source: [MCP server overview](https://learn.microsoft.com/en-us/graph/mcp-server/overview), [Get started](https://learn.microsoft.com/en-us/graph/mcp-server/get-started)

### 9.1 What it is

Microsoft's own MCP server exposing natural-language access to Microsoft Graph. Available at: `https://mcp.svc.cloud.microsoft/enterprise`

It translates NL queries → Graph API calls via RAG over a curated catalog of Graph examples, then executes them using the user's delegated permissions.

**Current scope (as of August 2026):** Read-only Microsoft Entra identity and directory data only. NOT SharePoint documents, NOT email content, NOT files.

### 9.2 The three exposed tools

| Tool | Purpose |
|---|---|
| `microsoft_graph_suggest_queries` | RAG search over Graph API example catalog — converts NL intent to candidate API calls |
| `microsoft_graph_get` | Executes a read-only Graph API GET call; enforces user permissions and throttle limits |
| `microsoft_graph_list_properties` | Returns the schema of a Graph entity (property names and types) |

### 9.3 Setup steps

1. Run in PowerShell (admin): `Install-Module Microsoft.Entra.Beta -Force -AllowClobber`
2. Authenticate: `Connect-Entra -Scopes 'Application.ReadWrite.All', 'Directory.Read.All', 'DelegatedPermissionGrant.ReadWrite.All'`
3. Register + consent: `Grant-EntraBetaMCPServerPermission -ApplicationName VisualStudioCode`
4. Verify app IDs:
   - MCP Server: `e8c77dc2-69b3-43f4-bc51-3213c9d915b4`
   - VS Code: `aebc6443-996d-45c2-90f0-388ff96faa56`

### 9.4 Rate limits

- 100 calls per minute per user
- Subject to standard Graph throttling on top of that

### 9.5 How it works vs how we implement something similar

| Aspect | Microsoft MCP Server | Our SharePoint connector |
|---|---|---|
| Data covered | Entra identity only (users, groups, apps, devices) | SharePoint documents + list items |
| Search approach | RAG over curated Graph example catalog → executes suggested API | Direct Search API with KQL |
| Access model | Delegated only (user must sign in) | OBO delegated for queries, app-only for indexing |
| Available publicly | Yes, at `mcp.svc.cloud.microsoft/enterprise` | Self-hosted, MIT-licensed |
| Configuration | Tenant admin provisions it | Customer configures per tenant |

**Key insight:** Microsoft's MCP server is a query interface for Entra directory data, not a document search engine. Our connector fills the gap they explicitly left open — SharePoint document and knowledge retrieval.

### 9.6 Logging and monitoring

Microsoft logs all MCP server calls to Microsoft Graph Activity Logs. Filter by `AppId = e8c77dc2-69b3-43f4-bc51-3213c9d915b4` in Log Analytics.

For our connector, we should implement equivalent structured logging capturing `userId`, `tenantId`, `queryString`, `entityTypes`, `hitCount`, `latencyMs`.

---

## 10. transitiveMemberOf — Per-User ACL Enforcement

Source: [API reference](https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof)

### 10.1 What it returns

Returns all groups, directory roles, and administrative units a user belongs to — **transitively**. If a user is in Group A, and Group A is a member of Group B, both A and B are returned.

This is critical for SharePoint ACL enforcement in Mode B (app-only indexing + search) because SharePoint uses nested AD groups extensively.

### 10.2 API reference

```
GET /v1.0/users/{id | userPrincipalName}/transitiveMemberOf
```

For the signed-in user (delegated only):
```
GET /v1.0/me/transitiveMemberOf
```

Get only group IDs (efficient):
```
GET /v1.0/users/{id}/transitiveMemberOf/microsoft.graph.group?$select=id
ConsistencyLevel: eventual
```

Get group count:
```
GET /v1.0/users/{id}/transitiveMemberOf/$count
ConsistencyLevel: eventual
```

### 10.3 Permissions

| Scenario | Minimum permission |
|---|---|
| Get current user's memberships | `User.Read` (delegated) |
| Get another user's memberships | `User.Read.All` (delegated or application) |
| App-only (service) | `User.Read.All` (application) |

> **Important:** Application permissions for transitiveMemberOf are not supported when using the `/me` endpoint. For app-only, you must use `/users/{id}`.

### 10.4 Response schema

```typescript
interface TransitiveMemberOfResponse {
  '@odata.context': string;
  value: Array<{
    '@odata.type': '#microsoft.graph.group' | '#microsoft.graph.directoryRole' | '#microsoft.graph.administrativeUnit';
    id: string;
    displayName?: string;
    mailEnabled?: boolean;
    mailNickname?: string;
    securityEnabled?: boolean;
    // ... other group properties
  }>;
  '@odata.nextLink'?: string;   // paginate if >100 groups
}
```

### 10.5 Performance characteristics

- Default page size: 100 objects
- Maximum page size: 999 objects (`$top=999`)
- Response time: typically 50–200ms per call
- User in many groups (>999): requires pagination — use `@odata.nextLink`
- Consistency: eventual — uses `ConsistencyLevel: eventual` header for filtered queries; uses index that may lag by seconds

### 10.6 Caching strategy

transitiveMemberOf is expensive to call on every search request. Cache aggressively:

```typescript
import NodeCache from 'node-cache';

// TTL: 15 minutes is a good balance between freshness and cost
// Large enterprises change group membership infrequently
const membershipCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

async function getUserGroupIds(userId: string, token: string): Promise<Set<string>> {
  const cacheKey = `groups:${userId}`;
  const cached = membershipCache.get<Set<string>>(cacheKey);
  if (cached) return cached;
  
  const groupIds = new Set<string>();
  let nextUrl: string | null = 
    `https://graph.microsoft.com/v1.0/users/${userId}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999`;
  
  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual',
      },
    });
    
    const data = await resp.json();
    for (const group of data.value) {
      groupIds.add(group.id);
    }
    nextUrl = data['@odata.nextLink'] ?? null;
  }
  
  membershipCache.set(cacheKey, groupIds);
  return groupIds;
}
```

Cache invalidation triggers:
- User changes teams/department: invalidate on org change events (HR system webhook or manual TTL)
- For most enterprises: 15-minute TTL is sufficient
- For high-security scenarios: reduce to 5 minutes or make TTL configurable per tenant

### 10.7 ACL enforcement pattern for indexed content

At index time (app-only crawl):
```typescript
// When indexing a driveItem, fetch its permissions
const permissions = await getItemPermissions(driveId, itemId, appToken);

// Store ACL with the indexed item
const indexedItem = {
  itemId,
  content: extractedText,
  allowedGroupIds: permissions
    .filter(p => p.grantedToV2?.group)
    .map(p => p.grantedToV2.group.id),
  allowedUserIds: permissions
    .filter(p => p.grantedToV2?.user)
    .map(p => p.grantedToV2.user.id),
  isPublic: permissions.some(p => p.link?.scope === 'anonymous'),
};
```

At search time (for the requesting user):
```typescript
async function searchWithAcl(query: string, userId: string, appToken: string) {
  const userGroups = await getUserGroupIds(userId, appToken);
  
  // Filter indexed results where user's groups overlap with item's ACL
  return indexedItems.filter(item => 
    item.isPublic ||
    item.allowedUserIds.includes(userId) ||
    item.allowedGroupIds.some(g => userGroups.has(g))
  );
}
```

---

## 11. MSAL Node.js — Token Patterns

### 11.1 Install

```bash
npm install @azure/msal-node
# TypeScript types are included
```

### 11.2 Client credential pattern (background indexing)

```typescript
import { ConfidentialClientApplication, Configuration } from '@azure/msal-node';

const msalConfig: Configuration = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    // OR: clientCertificate: { thumbprint, privateKey }
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level === 0) console.error('[MSAL]', message); // errors only
      },
      piiLoggingEnabled: false,
    },
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

// App tokens can be shared — acquire once and cache
let cachedAppToken: { token: string; expiresAt: number } | null = null;

export async function getAppToken(): Promise<string> {
  if (cachedAppToken && Date.now() < cachedAppToken.expiresAt - 60_000) {
    return cachedAppToken.token;
  }
  
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  
  if (!result) throw new Error('Failed to acquire app token');
  
  cachedAppToken = {
    token: result.accessToken,
    expiresAt: result.expiresOn!.getTime(),
  };
  
  return result.accessToken;
}
```

### 11.3 OBO pattern (per-user search)

```typescript
import { OnBehalfOfRequest } from '@azure/msal-node';
import Redis from 'ioredis';

// Use Redis-backed cache so OBO tokens survive restarts and are shared across instances
const redis = new Redis(process.env.REDIS_URL!);

const oboMsalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
  cache: {
    cachePlugin: {
      beforeCacheAccess: async (ctx) => {
        const data = await redis.get('msal:cache');
        if (data) ctx.tokenCache.deserialize(data);
      },
      afterCacheAccess: async (ctx) => {
        if (ctx.cacheHasChanged) {
          await redis.set('msal:cache', ctx.tokenCache.serialize(), 'EX', 7200);
        }
      },
    },
  },
});

export async function getOboToken(
  userToken: string,
  scopes: string[] = [
    'https://graph.microsoft.com/Files.Read.All',
    'https://graph.microsoft.com/Sites.Read.All',
  ]
): Promise<string> {
  const request: OnBehalfOfRequest = {
    oboAssertion: userToken,
    scopes,
  };
  
  try {
    const result = await oboMsalClient.acquireTokenOnBehalfOf(request);
    if (!result) throw new Error('OBO returned null');
    return result.accessToken;
  } catch (err: any) {
    // AADSTS65001: user hasn't consented to required scopes
    if (err.errorCode === 'AADSTS65001') {
      throw new ConsentRequiredError('User must consent to SharePoint permissions');
    }
    throw err;
  }
}
```

### 11.4 Certificate authentication (production)

Avoids rotating secrets. Load the private key from Key Vault at startup:

```typescript
import * as fs from 'fs';

const certConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID!,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientCertificate: {
      thumbprint: process.env.AZURE_CERT_THUMBPRINT!,
      privateKey: fs.readFileSync(process.env.AZURE_CERT_KEY_PATH!, 'utf-8'),
    },
  },
};
```

### 11.5 Token cache serialization format

MSAL stores tokens in a JSON blob with this shape (abbreviated):
```json
{
  "Account": { "key": { "homeAccountId": "...", ... } },
  "AccessToken": { "key": { "homeAccountId": "...", "realm": "...", "target": "..." } },
  "RefreshToken": { ... },
  "IdToken": { ... }
}
```

For multi-tenant apps, be careful: the cache contains tokens for ALL tenants. If you store the entire cache in one Redis key, a write from tenant A overwrites tenant B's tokens. **Partition the cache by tenantId.**

---

## 12. Throttling — Limits, Headers, Retry Strategy

Source: [Throttling guidance](https://learn.microsoft.com/en-us/graph/throttling), [Service-specific limits](https://learn.microsoft.com/en-us/graph/throttling-limits)

### 12.1 Global limits

| Scope | Limit |
|---|---|
| Per app across ALL tenants | 130,000 requests per 10 seconds |

This global limit is very high and rarely hit unless you're operating at hyperscale.

### 12.2 Files and Lists (SharePoint/OneDrive) limits

Graph delegates to SharePoint's own throttling. Per Microsoft docs: "See [Avoid getting throttled or blocked in SharePoint](https://docs.microsoft.com/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online)."

SharePoint-specific (as of 2026):
- Approximate limit: **100–400 requests per second** per tenant
- Tenant-wide, not per-app — if another app is hammering SharePoint, your app is affected
- Write operations are more aggressively throttled than reads

### 12.3 Identity/Entra limits (for transitiveMemberOf)

| Scope | Limit |
|---|---|
| App + tenant pair (>500 users) | 8,000 resource units per 10 seconds |
| App + tenant pair (50–500 users) | 5,000 resource units per 10 seconds |
| App + tenant pair (<50 users) | 3,500 resource units per 10 seconds |
| Per app (all tenants) | 150,000 resource units per 20 seconds |
| Write quota (app + tenant) | 3,000 requests per 2.5 minutes |

Resource units are not 1:1 with API calls — some calls cost more based on response complexity.

### 12.4 Search API limits

The Search API inherits SharePoint limits for SharePoint entity types and Outlook limits for mail/calendar types. No specific documented limit for search, but empirically: **~500–1000 search queries per minute** before throttling in large tenants.

### 12.5 Throttle response format

When throttled, Graph returns:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 10
Content-Type: application/json

{
  "error": {
    "code": "TooManyRequests",
    "innerError": {
      "code": "429",
      "date": "2026-08-26T12:51:51",
      "message": "Please retry after",
      "request-id": "94fb3b52-452a-4535-a601-69e0a90e3aa2",
      "status": "429"
    },
    "message": "Please retry again later."
  }
}
```

The `Retry-After` header value is in **seconds** and is the minimum wait time. Graph also returns a `x-ms-ags-diagnostic` header with trace info.

### 12.6 Retry implementation

```typescript
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function graphRequestWithRetry<T>(
  fn: () => Promise<Response>,
  options: RetryOptions = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 60_000 }
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    const resp = await fn();
    
    if (resp.ok) {
      return resp.json() as Promise<T>;
    }
    
    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = resp.headers.get('Retry-After');
      let delayMs: number;
      
      if (retryAfter) {
        // Retry-After can be seconds (integer) or HTTP date
        const retrySeconds = parseInt(retryAfter, 10);
        delayMs = isNaN(retrySeconds) 
          ? new Date(retryAfter).getTime() - Date.now()
          : retrySeconds * 1000;
      } else {
        // Exponential backoff with jitter
        delayMs = Math.min(
          options.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
          options.maxDelayMs
        );
      }
      
      console.warn(`Graph throttled (${resp.status}), waiting ${delayMs}ms (attempt ${attempt + 1})`);
      await sleep(delayMs);
      lastError = new Error(`Throttled after ${attempt + 1} attempts`);
      continue;
    }
    
    // Non-retryable error
    const body = await resp.text();
    throw new Error(`Graph error ${resp.status}: ${body}`);
  }
  
  throw lastError!;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
```

### 12.7 Proactive throttle avoidance

- **Batch requests:** Combine up to 20 requests in one `POST /$batch` call
- **Use delta instead of polling:** A delta query at the right interval beats N individual item fetches
- **Select only needed fields:** `$select=id,name,lastModifiedDateTime` reduces response size and server load
- **Avoid fan-out:** Don't fire 50 transitiveMemberOf calls in parallel; use a queue with concurrency limit
- **Use exponential backoff with jitter:** Avoids the "thundering herd" problem on recovery
- **Cache aggressively:** transitiveMemberOf, site lists, drive metadata — all change infrequently

```typescript
// Concurrency-limited parallel execution
import PQueue from 'p-queue';

const graphQueue = new PQueue({
  concurrency: 10,          // max 10 concurrent Graph calls
  intervalCap: 50,          // max 50 calls per interval
  interval: 1000,           // per second
});

// Usage
const results = await Promise.all(
  driveIds.map(id => graphQueue.add(() => getDriveDelta(id, token)))
);
```

---

## 13. TypeScript Implementation Plan

### 13.1 Package structure for Phase 2

```
src/
  connectors/
    sharepoint/
      index.ts              # exports SharePointConnector class
      auth.ts               # MSAL OBO + client credentials
      search.ts             # Graph Search API wrapper
      delta.ts              # delta sync engine
      webhooks.ts           # subscription management + endpoint handler
      permissions.ts        # transitiveMemberOf ACL cache
      types.ts              # all TypeScript interfaces
    confluence/             # Phase 2b
  tools/
    searchEnterpriseKnowledge.ts   # MCP tool exposed to agents
    fetchDocument.ts               # MCP tool to fetch full content
  store/
    deltaState.ts           # delta token persistence
    itemIndex.ts            # indexed content store (optional Mode B)
```

### 13.2 Core SharePoint connector

```typescript
// src/connectors/sharepoint/index.ts
import { getOboToken, getAppToken } from './auth';
import { searchSharePoint, SearchOptions, SearchResult } from './search';
import { DriveIndexer } from './delta';
import { getUserGroupIds } from './permissions';
import { SubscriptionManager } from './webhooks';

export interface SharePointConnectorConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  certThumbprint?: string;
  certPrivateKey?: string;
  mode: 'delegated' | 'app-only';
  region?: string;           // required for app-only: 'NAM' | 'EUR' | 'APC' | etc.
}

export class SharePointConnector {
  private config: SharePointConnectorConfig;
  private indexer: DriveIndexer;
  private subscriptions: SubscriptionManager;
  
  constructor(config: SharePointConnectorConfig) {
    this.config = config;
    this.indexer = new DriveIndexer();
    this.subscriptions = new SubscriptionManager();
  }
  
  /**
   * Search SharePoint — primary MCP tool entry point.
   * In delegated mode: user's OBO token, ACLs enforced by Graph automatically.
   * In app-only mode: app token, returns results from local index with ACL filter.
   */
  async search(
    query: string,
    options: SearchOptions,
    userAccessToken?: string  // required in delegated mode
  ): Promise<SearchResult[]> {
    if (this.config.mode === 'delegated') {
      if (!userAccessToken) throw new Error('userAccessToken required for delegated mode');
      const graphToken = await getOboToken(userAccessToken);
      return searchSharePoint(query, options, graphToken);
    } else {
      const appToken = await getAppToken(this.config);
      const results = await searchSharePoint(query, { ...options, region: this.config.region }, appToken);
      // ACL filtering for app-only mode (optional — only if we maintain a local index)
      return results;
    }
  }
  
  /**
   * Fetch full content of a document.
   * Returns raw bytes — caller is responsible for text extraction.
   */
  async fetchDocument(
    driveId: string,
    itemId: string,
    userAccessToken?: string
  ): Promise<{ content: Buffer; mimeType: string; name: string }> {
    const token = userAccessToken 
      ? await getOboToken(userAccessToken) 
      : await getAppToken(this.config);
    
    return downloadDriveItem(driveId, itemId, token);
  }
  
  /**
   * Start background indexing for a drive.
   * App-only mode only.
   */
  async startIndexing(siteId: string, driveId: string): Promise<void> {
    const appToken = await getAppToken(this.config);
    await this.indexer.incrementalSync(driveId, appToken);
    await this.subscriptions.ensureSubscription(driveId, appToken);
  }
}
```

### 13.3 Search wrapper

```typescript
// src/connectors/sharepoint/search.ts
export interface SearchOptions {
  entityTypes?: Array<'driveItem' | 'listItem' | 'site' | 'list'>;
  from?: number;
  size?: number;
  fields?: string[];
  region?: string;
  includePrivateContent?: boolean;
}

export interface SearchResult {
  id: string;
  name: string;
  webUrl: string;
  summary: string;
  rank: number;
  type: string;
  createdAt: string;
  modifiedAt: string;
  modifiedBy: string;
  siteId: string;
  driveId?: string;
  fields?: Record<string, unknown>;
}

export async function searchSharePoint(
  query: string,
  options: SearchOptions = {},
  token: string
): Promise<SearchResult[]> {
  const {
    entityTypes = ['driveItem', 'listItem'],
    from = 0,
    size = 25,
    fields,
    region,
    includePrivateContent = false,
  } = options;
  
  const requestBody: any = {
    requests: [{
      entityTypes,
      query: { queryString: query },
      from,
      size,
      ...(fields && { fields }),
      ...(region && { region }),
      ...(includePrivateContent && {
        sharePointOneDriveOptions: { includeContent: 'privateContent,sharedContent' }
      }),
    }],
  };
  
  const resp = await graphRequestWithRetry<any>(() =>
    fetch('https://graph.microsoft.com/v1.0/search/query', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })
  );
  
  const container = resp.value?.[0]?.hitsContainers?.[0];
  if (!container?.hits) return [];
  
  return container.hits.map(normalizeHit);
}

function normalizeHit(hit: any): SearchResult {
  const r = hit.resource;
  return {
    id: r.id || hit.hitId,
    name: r.name || r.displayName,
    webUrl: r.webUrl,
    summary: stripHtmlTags(hit.summary),
    rank: hit.rank,
    type: r['@odata.type']?.replace('#microsoft.graph.', '') ?? 'unknown',
    createdAt: r.createdDateTime,
    modifiedAt: r.lastModifiedDateTime,
    modifiedBy: r.lastModifiedBy?.user?.displayName ?? '',
    siteId: r.parentReference?.siteId ?? r.id,
    driveId: r.parentReference?.driveId,
    fields: r.fields,
  };
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<c0>/g, '**').replace(/<\/c0>/g, '**')  // highlight → bold
    .replace(/<ddd\/>/g, '...')
    .replace(/<[^>]+>/g, '');
}
```

### 13.4 MCP tool definition

```typescript
// src/tools/searchEnterpriseKnowledge.ts
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SharePointConnector } from '../connectors/sharepoint/index.js';

export const searchEnterpriseKnowledgeTool: Tool = {
  name: 'search_enterprise_knowledge',
  description: 
    'Search your organisation\'s SharePoint sites and document libraries. ' +
    'Supports natural language and KQL syntax. ' +
    'Returns document titles, summaries, URLs, and custom metadata. ' +
    'Results respect your SharePoint permissions — you only see documents you have access to.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Supports plain text, KQL (filetype:docx, author:"Name", path:"/url", date ranges). Example: "project roadmap filetype:pptx LastModifiedTime > 2025-01-01"',
      },
      entityTypes: {
        type: 'array',
        items: { type: 'string', enum: ['driveItem', 'listItem', 'site'] },
        description: 'Types of content to search. Default: ["driveItem", "listItem"]',
        default: ['driveItem', 'listItem'],
      },
      size: {
        type: 'number',
        description: 'Number of results to return (1–25, default 10)',
        default: 10,
        minimum: 1,
        maximum: 25,
      },
    },
    required: ['query'],
  },
};
```

### 13.5 Recommended database schema

```sql
-- Delta sync state
CREATE TABLE sharepoint_delta_state (
  tenant_id        VARCHAR(36) NOT NULL,
  drive_id         VARCHAR(255) NOT NULL,
  delta_link       TEXT NOT NULL,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_status      VARCHAR(20) NOT NULL DEFAULT 'ready',
  item_count       INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  PRIMARY KEY (tenant_id, drive_id)
);

-- Webhook subscriptions
CREATE TABLE graph_subscriptions (
  tenant_id           VARCHAR(36) NOT NULL,
  subscription_id     VARCHAR(36) NOT NULL PRIMARY KEY,
  resource            TEXT NOT NULL,            -- e.g. /drives/{id}/root
  drive_id            VARCHAR(255) NOT NULL,
  client_state        VARCHAR(36) NOT NULL,     -- random UUID for validation
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON graph_subscriptions (tenant_id, expires_at);

-- User group membership cache
CREATE TABLE user_group_cache (
  tenant_id      VARCHAR(36) NOT NULL,
  user_id        VARCHAR(36) NOT NULL,
  group_ids      TEXT[] NOT NULL,               -- array of group GUIDs
  cached_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

-- Optional: indexed documents for Mode B
CREATE TABLE indexed_documents (
  tenant_id             VARCHAR(36) NOT NULL,
  item_id               VARCHAR(255) NOT NULL,
  drive_id              VARCHAR(255) NOT NULL,
  site_id               VARCHAR(255) NOT NULL,
  name                  VARCHAR(500) NOT NULL,
  web_url               TEXT NOT NULL,
  content_text          TEXT,
  content_vector        vector(1536),           -- pgvector for semantic search
  allowed_group_ids     TEXT[] NOT NULL DEFAULT '{}',
  allowed_user_ids      TEXT[] NOT NULL DEFAULT '{}',
  is_public             BOOLEAN NOT NULL DEFAULT false,
  last_modified_at      TIMESTAMPTZ NOT NULL,
  indexed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);

CREATE INDEX ON indexed_documents USING ivfflat (content_vector vector_cosine_ops)
  WITH (lists = 100);
```

---

## 14. What to Build vs What to Skip

### Build immediately (Phase 2)

| Feature | Why |
|---|---|
| OBO token flow for delegated search | Correct ACL enforcement with zero ACL-filter code |
| Search API with driveItem + listItem | Core search over SharePoint documents and lists |
| KQL passthrough to users | Power users can use full KQL syntax |
| Webhook-triggered delta sync | Real-time index freshness without continuous polling |
| transitiveMemberOf cache | Needed if/when we add Mode B indexing |
| Retry with Retry-After header | Required for production stability |

### Build in Phase 2b

| Feature | Why | Risk if delayed |
|---|---|---|
| App-only search with local vector index | Lower latency, semantic search | Search is already functional via delegated mode |
| Custom columns via `fields` | Richer metadata in results | Works without it |
| Per-site subscription management | Granular notifications | Polling delta every 5 min is acceptable initially |
| Multi-tenant MSAL cache (Redis) | Cross-instance token sharing | In-memory works for single-instance MVP |

### Skip entirely (for now)

| Feature | Why to skip |
|---|---|
| Copilot connectors (Graph connectors) ingestion API | Complex to set up, requires separate licensing, only needed for non-SharePoint external data |
| Private content indexing (app-only) | Requires days to provision, high tenant-side storage cost |
| Microsoft Graph MCP server integration | It covers Entra directory data only, not our use case |
| Confluence via Graph | Confluence uses its own API; Graph connectors exist but add complexity — use Confluence REST directly |
| email/calendar search | Out of scope for Phase 2; different permission model |

---

## 15. Limitations, Failure Modes, and Gotchas

### 15.1 Search API limitations

- **Maximum 500 results per query.** You cannot page through 10,000 results with `from`/`size` beyond 500. For bulk discovery, use delta query instead.
- **No full-text result for non-indexed file types.** Binary files (images, executables) return no text summary.
- **KQL property names are case-sensitive and environment-specific.** Custom managed properties vary per SharePoint environment.
- **Cross-tenant search not supported.** One Graph token = one tenant.
- **Application permissions require region.** Forgetting `region` returns a 400 error with an unhelpful message.
- **Private content index takes days.** If you switch from delegated to app-only mode mid-deployment, private search results will be empty for days.
- **Schema change in beta.** The beta search API has renamed/removed properties. If you use `/beta/search/query`, test carefully after Graph SDK updates.

### 15.2 Delta sync failure modes

| Failure | Symptoms | Recovery |
|---|---|---|
| 410 Gone on deltaLink | `HTTP 410` response | Full resync from `Location` header URL |
| Delta token expired (~4 weeks) | `410` or empty results with no new deltaLink | Delete state, restart initial sync |
| Replication delay | Item appears in delta but properties are stale | Retry after delay; Graph notes "eventual consistency" |
| Replay (same item twice) | Duplicate items in your merge logic | Design upsert logic, not insert — idempotent by `id` |
| Drive deleted | All future delta calls fail | Listen for webhooks or poll site delta |

### 15.3 Webhook endpoint failure modes

| Failure | Consequence | Mitigation |
|---|---|---|
| Endpoint returns non-2xx | Graph retries for up to 4 hours with backoff | Queue incoming requests — return 202 immediately |
| Endpoint takes >3 seconds | Response counted as timeout | Never do I/O before responding |
| Endpoint marked "slow" (>10% timeouts) | 10 min notification delay | Return 202 immediately, process async |
| Endpoint marked "drop" (>15% timeouts) | Notifications silently dropped | Monitor your endpoint latency |
| Subscription expired without renewal | No notifications until re-subscribed | Subscribe to lifecycle notifications; add scheduled renewal job |
| Subscription deleted by Graph | Missed changes until re-created | Listen for `subscriptionRemoved` lifecycle event |

### 15.4 OBO flow edge cases

- **Consent not granted:** OBO returns `AADSTS65001`. The user must consent to `Files.Read.All` and `Sites.Read.All`. You must implement a consent redirect flow.
- **Conditional Access blocked:** If the tenant has Conditional Access policies requiring device compliance or MFA step-up, the OBO exchange fails with `AADSTS50076` or `AADSTS50079`. Inform the user to complete the CA challenge.
- **Token audience mismatch:** The incoming user token must be for YOUR app's scope (`api://<client-id>/SharePointSearch.Read`), not for Graph directly. If users authenticate to Graph directly, OBO fails. Ensure your client app requests a token for your API, not Graph.
- **Guest users:** Guests in a tenant may have restricted directory access. transitiveMemberOf for guests sometimes returns incomplete results.

### 15.5 SharePoint multi-geo

Large enterprises use Multi-Geo SharePoint (data residency). In app-only mode:
- Each geo has a different `region` value (NAM, EUR, APC, CAN, AUS, IND, JPN, GBR, FRA, ARE, ZAF, SWE, KOR)
- You must search each region separately
- Delegated mode is NOT affected — user tokens are geo-aware automatically

### 15.6 SharePoint throttling quirks

- **Burst mode:** SharePoint allows a brief burst above the per-second limit (~30 seconds) before throttling
- **HTTP 503 Service Unavailable:** SharePoint returns 503 (not 429) in some throttle scenarios. Treat 503 the same as 429.
- **No X-RateLimit headers:** Unlike many APIs, Graph does not return X-RateLimit-Remaining or X-RateLimit-Limit. You must rely on the 429/503 status code.
- **Tenant-wide limit shared:** If another app in your tenant is hammering SharePoint (e.g. a Power Automate flow gone rogue), your app is throttled even if your own call rate is low.

### 15.7 Permission scope pitfalls

- `Files.Read.All` does not grant access to items with unique permissions broken AND the site collection admin ACL excluded the app. This is rare but possible.
- `Sites.Read.All` does not allow listing all sites in `GET /sites` with delegated tokens. That endpoint requires application permissions.
- `User.Read.All` (application) is needed for transitiveMemberOf on other users. Without it, you can only get memberships for the authenticated user.
- **Admin consent blockers:** Some tenants lock down admin consent — the tenant admin must manually approve your app. This can delay enterprise deployments by days or weeks.

### 15.8 MSAL gotchas

- **Silent token acquisition can fail** if the refresh token expired (default 90-day sliding window). Build a refresh error handler that prompts re-authentication.
- **MSAL Node in-process cache is not shared between instances.** In any horizontally scaled deployment, tokens are re-acquired per instance unless you add a persistent `cachePlugin`.
- **OBO tokens are not the same as user tokens.** The OBO token is for YOUR app acting on the user's behalf. You cannot pass the OBO token to another service and have THAT service OBO again without being in the OBO chain.

---

## Appendix: Useful Graph Explorer Queries

```
# Search for files
POST https://graph.microsoft.com/v1.0/search/query
Body: { "requests": [{ "entityTypes": ["driveItem"], "query": { "queryString": "test" }, "from": 0, "size": 5 }]}

# List all SharePoint site collections
GET https://graph.microsoft.com/v1.0/sites?$filter=siteCollection/root ne null&$select=id,webUrl,displayName

# Get drives for a site
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives

# Start delta sync for a drive
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/root/delta

# Get my group memberships
GET https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.group?$select=id,displayName

# Get another user's group memberships (app permission)
GET https://graph.microsoft.com/v1.0/users/{user-id}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=999
Headers: ConsistencyLevel: eventual

# List active subscriptions
GET https://graph.microsoft.com/v1.0/subscriptions
```

---

## Appendix: Minimal Required npm Packages

```json
{
  "dependencies": {
    "@azure/msal-node": "^2.x",
    "node-cache": "^5.x",
    "p-queue": "^8.x"
  },
  "optionalDependencies": {
    "ioredis": "^5.x"
  }
}
```

No Microsoft Graph SDK is strictly required — the REST API is well-documented and a thin fetch wrapper is sufficient and more controllable for our use case. The Graph SDK adds ~3MB of dependencies for convenience features we don't need.

---

*Sources: All content sourced from live fetches of Microsoft Learn documentation on 2026-08-26. Key pages:*
- *https://learn.microsoft.com/en-us/graph/search-concept-overview*
- *https://learn.microsoft.com/en-us/graph/delta-query-overview*
- *https://learn.microsoft.com/en-us/graph/mcp-server/overview*
- *https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof*
- *https://learn.microsoft.com/en-us/graph/search-concept-files*
- *https://learn.microsoft.com/en-us/graph/throttling*
- *https://learn.microsoft.com/en-us/graph/throttling-limits*
- *https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks*
- *https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions*
- *https://learn.microsoft.com/en-us/graph/api/driveitem-delta*
- *https://learn.microsoft.com/en-us/graph/api/site-list*
- *https://learn.microsoft.com/en-us/graph/auth-v2-service*
- *https://learn.microsoft.com/en-us/graph/auth/auth-concepts*
- *https://learn.microsoft.com/en-us/graph/search-concept-custom-types*
- *https://learn.microsoft.com/en-us/graph/search-concept-searchall*
