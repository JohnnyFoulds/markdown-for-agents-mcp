# SharePoint + Microsoft Graph Connector: Production Implementation Research

**Research date:** 2026-08-26
**Scope:** Building a production-grade SharePoint document connector for the markdown-for-agents-mcp enterprise knowledge index (Phase 2)
**Outcome:** Actionable implementation guide with TypeScript code, API schemas, gotchas, and explicit build/skip recommendations

---

## Table of Contents

1. [Decision: Graph API vs SharePoint REST API](#1-decision-graph-api-vs-sharepoint-rest-api)
2. [Entra App Registration](#2-entra-app-registration)
3. [Authentication: MSAL Node.js](#3-authentication-msal-nodejs)
4. [Discovering Sites](#4-discovering-sites)
5. [Listing Document Libraries](#5-listing-document-libraries)
6. [Traversing Files: driveItem List Children](#6-traversing-files-driveitem-list-children)
7. [File Content Download and Streaming](#7-file-content-download-and-streaming)
8. [Incremental Sync: Delta Query](#8-incremental-sync-delta-query)
9. [Real-Time Updates: Webhook Subscriptions](#9-real-time-updates-webhook-subscriptions)
10. [Per-File Permissions and ACL Resolution](#10-per-file-permissions-and-acl-resolution)
11. [Query-Time ACL Enforcement](#11-query-time-acl-enforcement)
12. [Throttling and Backoff](#12-throttling-and-backoff)
13. [Complete TypeScript Connector Class](#13-complete-typescript-connector-class)
14. [Limitations, Edge Cases, and Gotchas](#14-limitations-edge-cases-and-gotchas)
15. [Build vs. Skip Decisions](#15-build-vs-skip-decisions)

---

## 1. Decision: Graph API vs SharePoint REST API

**Verdict: Use Microsoft Graph v1.0 exclusively. Do not use the SharePoint REST API.**

### Why Graph Wins for This Use Case

| Capability | Microsoft Graph v1.0 | SharePoint REST API |
|---|---|---|
| Delta sync (incremental change tracking) | Yes — `driveItem: delta` endpoint | No native equivalent |
| Change notifications (webhooks) | Yes — `/subscriptions` | No |
| Consistent auth (MSAL, single token endpoint) | Yes | Requires separate auth dance |
| Cross-tenant / multi-geo enumeration | Yes — `sites/getAllSites` | No |
| Structured permission model | Yes — `/permissions` with `grantedToV2` | Partial, complex |
| SDK support (Node.js, TypeScript) | `@microsoft/microsoft-graph-client` | Third-party PnP only |
| Microsoft investment trajectory | Heavy investment, new features only here | Maintenance mode |
| KQL-based search | Yes — `/search/query` endpoint | Yes — `_api/search/query` |

**The only reason to reach for SharePoint REST is for legacy SharePoint-specific operations** (term stores, content types by title lookups, `GetByTitle()` list access) that Graph does not yet expose. For a document-indexing connector, none of those are needed.

Sources: [Graph vs SharePoint REST comparison (iteczone.com, 2026)](https://iteczone.com/microsoft-graph-api-vs-sharepoint-rest-api-comparison/), [andrewconnell.com guide](https://www.andrewconnell.com/articles/sharepoint-rest-api-microsoft-365-developers-guide/)

---

## 2. Entra App Registration

### Step-by-Step: Azure Portal

1. Navigate to **portal.azure.com** > **Microsoft Entra ID** > **App registrations** > **New registration**
2. Name: something like `markdown-for-agents-mcp-connector`
3. Supported account types: **Accounts in this organizational directory only** (single-tenant for enterprise deployment)
4. Redirect URI: leave blank for a daemon/service app
5. Click **Register**

After registration, note:
- **Application (client) ID** — your `clientId`
- **Directory (tenant) ID** — your `tenantId`

### Creating a Client Secret

1. Left menu: **Certificates & secrets** > **New client secret**
2. Description: e.g. `connector-prod`
3. Expiry: 24 months maximum (set a rotation reminder)
4. Copy the **Value** immediately — it is never shown again

**Production recommendation:** Use a certificate instead of a client secret. Upload a self-signed certificate to **Certificates & secrets > Certificates**. Certificate auth is resistant to secret leaks and does not expire on a clock.

### Required API Permissions

Navigate to **API permissions** > **Add a permission** > **Microsoft Graph** > **Application permissions** (not Delegated — this is a background daemon).

**Minimum required permissions for the connector:**

| Permission | Why needed |
|---|---|
| `Sites.Read.All` | List all sites, read site metadata, list drives, `getAllSites` |
| `Files.Read.All` | Read driveItems, download file content, read permissions |

**Do NOT add:**
- `Sites.ReadWrite.All` or `Files.ReadWrite.All` — write access is unnecessary and a blast-radius risk
- `Directory.Read.All` — not needed for file indexing; use only for ACL group expansion
- `User.Read.All` — needed only if you resolve user display names at index time (defer this)

After adding permissions, an **admin must grant consent**: **API permissions** > **Grant admin consent for [tenant]**.

### Sites.Selected: Scoped Access (Recommended for Sensitive Tenants)

Instead of `Sites.Read.All` (which grants access to ALL sites), you can use `Sites.Selected` combined with per-site grants. This requires:

1. Register the app with `Sites.Selected` application permission
2. Use the Graph API (with a Global Admin token) to grant the app access to specific sites:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [{
    "application": {
      "id": "{your-app-client-id}",
      "displayName": "markdown-for-agents-mcp-connector"
    }
  }]
}
```

This is the right model for an enterprise deployment where the customer controls which sites are indexed. Trade-off: requires per-site provisioning automation.

Source: [laurakokkarinen.com Sites.Selected guide](https://laurakokkarinen.com/how-to-set-up-microsoft-graph-and-sharepoint-online-selected-api-permissions/)

---

## 3. Authentication: MSAL Node.js

### Package

```bash
npm install @azure/msal-node
# Current version as of 2026-08: 5.6.0
```

### Client Credentials Flow (Background Sync)

This is the primary auth pattern for the connector daemon. It authenticates as the application (no user context), using the client secret or certificate.

```typescript
import {
  ConfidentialClientApplication,
  Configuration,
  ClientCredentialRequest,
  AuthenticationResult,
} from '@azure/msal-node';

interface ConnectorAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  // OR use certificate:
  // certificate: { thumbprint: string; privateKey: string }
}

export class GraphAuthProvider {
  private readonly msalClient: ConfidentialClientApplication;
  private readonly scopes = ['https://graph.microsoft.com/.default'];

  constructor(config: ConnectorAuthConfig) {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
      // MSAL caches tokens internally; tokens are reused until near expiry
    };
    this.msalClient = new ConfidentialClientApplication(msalConfig);
  }

  async getToken(): Promise<string> {
    const request: ClientCredentialRequest = {
      scopes: this.scopes,
    };
    const result: AuthenticationResult | null =
      await this.msalClient.acquireTokenByClientCredential(request);

    if (!result?.accessToken) {
      throw new Error('Failed to acquire access token from MSAL');
    }
    return result.accessToken;
  }
}
```

MSAL caches tokens in memory automatically. The token is valid for 3600 seconds (1 hour). MSAL will return the cached token until approximately 5 minutes before expiry, then silently refresh. You do not need to manage token lifetime manually.

### On-Behalf-Of Flow (Per-User ACL Queries)

When a user makes a search query and you need to verify their access using their own identity (rather than the app identity), use the On-Behalf-Of (OBO) flow. This requires the user's access token from your MCP server's auth layer.

**When this applies:** If your MCP server uses delegated auth (users log in via OAuth), you can call Graph OBO to verify which files a specific user can actually read. This is the strongest form of ACL enforcement.

```typescript
import { OnBehalfOfRequest } from '@azure/msal-node';

export class GraphAuthProvider {
  // ... (constructor as above)

  async getTokenOnBehalfOf(userAssertion: string): Promise<string> {
    const request: OnBehalfOfRequest = {
      scopes: ['https://graph.microsoft.com/.default'],
      oboAssertion: userAssertion, // The user's incoming Bearer token
    };
    const result = await this.msalClient.acquireTokenOnBehalfOf(request);
    if (!result?.accessToken) {
      throw new Error('OBO token acquisition failed');
    }
    return result.accessToken;
  }
}
```

**OBO prerequisites:**
- Your app registration must have the delegated `Files.Read.All` and `Sites.Read.All` permissions (in addition to application permissions)
- The incoming user token must have the appropriate claims
- The user must have consented or an admin must have pre-consented

**For the initial Phase 2 implementation:** Use client credentials for background indexing and group membership checking. OBO is a Phase 3 enhancement for real-time, per-user permission verification. See [Section 11](#11-query-time-acl-enforcement) for the practical ACL enforcement strategy.

Sources: [MSAL Node samples — OBO](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/samples/msal-node-samples/on-behalf-of/README.md), [npm @azure/msal-node](https://www.npmjs.com/package/@azure/msal-node)

---

## 4. Discovering Sites

### getAllSites: The Correct Endpoint for Full Tenant Enumeration

**Do not use** `/sites?search=*` for production tenant enumeration — it is unreliable for large tenants and does not support multi-geo. Use `sites/getAllSites` instead.

Source: [learn.microsoft.com/en-us/graph/api/site-getallsites](https://learn.microsoft.com/en-us/graph/api/site-getallsites?view=graph-rest-1.0)

**Required permission:** `Sites.Read.All` (Application only — delegated is NOT supported for `getAllSites`).

```http
GET https://graph.microsoft.com/v1.0/sites/getAllSites
Authorization: Bearer {token}
```

**Response schema:**

```json
{
  "value": [
    {
      "id": "contoso.sharepoint.com,bf6fb551-d508-4946-a439-b2a6154fc1d9,65a04b8b-1f44-442b-a1fc-9e5852fb946c",
      "name": "Root Site",
      "displayName": "Contoso Communications",
      "isPersonalSite": false,
      "root": {},
      "siteCollection": {
        "hostName": "contoso.sharepoint.com",
        "dataLocationCode": "NAM",
        "root": {}
      },
      "webUrl": "https://contoso.sharepoint.com"
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/getAllSites?$skiptoken=..."
}
```

**Key fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Composite ID: `hostname,siteCollectionId,webId` |
| `name` | `string` | URL-safe name |
| `displayName` | `string` | Human-readable name |
| `isPersonalSite` | `boolean` | True for OneDrive personal sites — filter these out for enterprise knowledge index |
| `webUrl` | `string` | Full URL |
| `siteCollection.dataLocationCode` | `string` | Geographic region (multi-geo tenants) |

**TypeScript pagination loop:**

```typescript
async function* enumerateAllSites(
  graphClient: GraphHttpClient
): AsyncGenerator<SharePointSite> {
  let url = 'https://graph.microsoft.com/v1.0/sites/getAllSites';

  while (url) {
    const response = await graphClient.get(url);
    const data = await response.json() as SiteListResponse;

    for (const site of data.value ?? []) {
      // Skip personal OneDrive sites unless you want them
      if (!site.isPersonalSite) {
        yield site;
      }
    }

    url = data['@odata.nextLink'] ?? '';
  }
}
```

**Performance note:** A large tenant with 10,000+ sites will return many pages. Each page returns approximately 200 sites. Expect 50+ requests for a large tenant. Run this enumeration in a background job, not on every sync cycle — cache site IDs and only check for new/removed sites periodically (e.g., daily).

### Filtering Sites with Sites.Selected

If using `Sites.Selected` instead of `Sites.Read.All`, you cannot use `getAllSites`. Instead, maintain an explicit list of site IDs in your connector configuration.

---

## 5. Listing Document Libraries

Each SharePoint site has one or more drives. The default document library is a drive of type `documentLibrary`.

```http
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives
Authorization: Bearer {token}
```

**Response schema:**

```json
{
  "value": [
    {
      "id": "b!T4M...",
      "name": "Documents",
      "driveType": "documentLibrary",
      "webUrl": "https://contoso.sharepoint.com/sites/team/Shared%20Documents",
      "quota": {
        "total": 27487790694400,
        "used": 20116678894
      }
    },
    {
      "id": "b!Y5K...",
      "name": "Site Assets",
      "driveType": "documentLibrary",
      "webUrl": "https://contoso.sharepoint.com/sites/team/SiteAssets"
    }
  ]
}
```

**Drive types:**

| driveType | Description |
|---|---|
| `documentLibrary` | Standard SharePoint document library — index these |
| `personal` | OneDrive for Business personal drive |
| `business` | OneDrive for Business shared drive |

**Recommendation:** Index only `driveType === 'documentLibrary'` for enterprise knowledge. Skip `personal` unless the product explicitly includes personal OneDrive files.

```typescript
async function getDocumentLibraries(
  graphClient: GraphHttpClient,
  siteId: string
): Promise<Drive[]> {
  const response = await graphClient.get(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`
  );
  const data = await response.json() as DriveListResponse;
  return (data.value ?? []).filter(d => d.driveType === 'documentLibrary');
}
```

---

## 6. Traversing Files: driveItem List Children

Source: [learn.microsoft.com/en-us/graph/api/driveitem-list-children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children)

### HTTP Request Patterns

```http
# Root of a drive
GET /drives/{drive-id}/root/children

# Children of a known folder
GET /drives/{drive-id}/items/{folder-id}/children

# By path
GET /drives/{drive-id}/root:/{path-relative-to-root}:/children
```

**Permissions required (Application):** `Files.Read.All`

### Response Schema

```json
{
  "value": [
    {
      "id": "01ABCD...",
      "name": "Project Charter.docx",
      "size": 47382,
      "file": {
        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "hashes": {
          "quickXorHash": "b82G...",
          "sha256Hash": "e3b0c44298fc..."
        }
      },
      "lastModifiedDateTime": "2026-07-15T09:32:11Z",
      "createdDateTime": "2025-03-01T14:00:00Z",
      "webUrl": "https://contoso.sharepoint.com/sites/team/Shared%20Documents/Project%20Charter.docx",
      "createdBy": {
        "user": {
          "id": "efee1b77-fb3b-4f65-99d6-274c11914d12",
          "displayName": "Jane Smith"
        }
      },
      "parentReference": {
        "driveId": "b!T4M...",
        "id": "01ABCD...",
        "path": "/drives/b!T4M.../root:/Documents"
      }
    },
    {
      "id": "01EFGH...",
      "name": "Architecture",
      "folder": {
        "childCount": 12
      },
      "lastModifiedDateTime": "2026-08-01T10:00:00Z"
    }
  ],
  "@odata.nextLink": "https://..."
}
```

**Key fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable item ID within the drive |
| `name` | `string` | Filename or folder name |
| `file` | `object` | Present only for files; absence means folder |
| `folder` | `object` | Present only for folders |
| `file.mimeType` | `string` | Content type |
| `file.hashes.quickXorHash` | `string` | Fast hash for change detection |
| `file.hashes.sha256Hash` | `string` | Cryptographic hash (may be null) |
| `size` | `number` | Bytes |
| `lastModifiedDateTime` | `ISO 8601` | Last modification timestamp |
| `webUrl` | `string` | Browser-accessible URL |
| `parentReference.driveId` | `string` | Parent drive ID |

### Default Page Size and Pagination

Default page size is **200 items**. Maximum you can request via `$top` is also 200. Always handle `@odata.nextLink` — large libraries have thousands of files.

### Recursive Traversal Strategy

**Do NOT recurse naively** by following every folder in a depth-first traversal. This generates an enormous number of API calls and will get you throttled.

**Use delta query instead** (see Section 8) — a single delta call enumerates the entire drive hierarchy including all files and folders at all depths, handling pagination automatically. Use manual recursion only for targeted sub-tree crawls where delta is impractical.

If you must recurse manually (e.g., for a targeted re-index of a single library):

```typescript
async function* traverseDriveItems(
  graphClient: GraphHttpClient,
  driveId: string,
  folderId: string = 'root'
): AsyncGenerator<DriveItem> {
  let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}/children`;
  url += '?$select=id,name,file,folder,size,lastModifiedDateTime,webUrl,parentReference,createdBy';

  while (url) {
    const response = await graphClient.get(url);
    const data = await response.json() as DriveItemListResponse;

    for (const item of data.value ?? []) {
      yield item;
      if (item.folder) {
        // Recurse into subfolders
        yield* traverseDriveItems(graphClient, driveId, item.id);
      }
    }

    url = data['@odata.nextLink'] ?? '';
  }
}
```

**Performance optimization:** Use `$select` to request only the fields you need. The full driveItem schema is large and many fields are irrelevant for indexing.

---

## 7. File Content Download and Streaming

Source: [learn.microsoft.com/en-us/graph/api/driveitem-get-content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)

### Download Endpoint

```http
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/items/{item-id}/content
Authorization: Bearer {token}
```

This returns a **302 redirect** to a pre-authenticated download URL for non-streaming clients, OR direct streaming content for clients that follow redirects. As of a 2024 Graph update, SharePoint driveItem content endpoints support **direct streaming** (single call, no redirect hop required for SDK clients).

Source: [devblogs.microsoft.com — Direct streaming of SharePoint DriveItem content](https://devblogs.microsoft.com/microsoft365dev/direct-streaming-of-sharepoint-driveitem-content-in-microsoft-graph-now-available/)

### TypeScript: Streaming Download

```typescript
import { Readable } from 'stream';

async function downloadFileAsStream(
  graphClient: GraphHttpClient,
  driveId: string,
  itemId: string
): Promise<Readable> {
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await authProvider.getToken()}`,
    },
    redirect: 'follow', // Follow the 302 redirect automatically
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  // Stream the response body instead of loading into memory
  return Readable.fromWeb(response.body as any);
}
```

### Pre-authenticated Download URL (Alternative)

driveItems include a `@microsoft.graph.downloadUrl` property that is a pre-authenticated URL valid for approximately 1 hour. Use this for large files or when you need to pass the URL to another service:

```typescript
async function getDownloadUrl(
  graphClient: GraphHttpClient,
  driveId: string,
  itemId: string
): Promise<string> {
  const response = await graphClient.get(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}` +
    `?$select=id,@microsoft.graph.downloadUrl`
  );
  const data = await response.json();
  return data['@microsoft.graph.downloadUrl'];
}
```

**Warning:** The `@microsoft.graph.downloadUrl` is not returned by default — you must include it in `$select`. Do NOT store or cache this URL for more than ~50 minutes.

### File Size Limits

| Method | Max file size | Notes |
|---|---|---|
| `/content` GET (streaming) | 250 GB per file (SharePoint Online limit) | Stream, never buffer large files |
| Upload (create/update) | 250 MB via simple PUT; 250 GB via upload session | Connector reads only — not applicable |

**Practical guidance for indexing:**
- Files under ~50 MB: safe to buffer in memory for text extraction
- Files 50 MB–250 MB: stream to a temp file, extract, delete
- Files over 250 MB: skip content extraction, index metadata only
- Binary files (images, videos, CAD files): skip content, index metadata only

### Supported Content Types for Indexing

| MIME type | Can extract text? | Recommendation |
|---|---|---|
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (`.docx`) | Yes — use `mammoth` or `docx` npm packages | Extract |
| `application/pdf` | Yes — use `pdf-parse` or `pdfjs-dist` | Extract |
| `text/plain`, `text/markdown`, `text/html` | Yes — direct read | Extract |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (`.xlsx`) | Partial — use `xlsx` npm package | Extract cell values as text |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` (`.pptx`) | Partial | Extract slide text |
| `image/*`, `video/*`, `audio/*` | No | Index metadata only |
| `application/zip` | No (without decompression) | Skip |

---

## 8. Incremental Sync: Delta Query

Source: [learn.microsoft.com/en-us/graph/api/driveitem-delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)

Delta query is the **single most important API feature** for the connector. It replaces full re-crawls with incremental change detection, making the connector viable at scale.

### How Delta Works

1. **Initial call** (no token): Graph enumerates the entire drive hierarchy, returning all items. You follow `@odata.nextLink` pages until you get `@odata.deltaLink`.
2. **Store the deltaLink token** persistently (per drive, per site).
3. **Subsequent calls**: Use the deltaLink URL. Graph returns only items that changed (created, updated, or deleted) since the previous call.
4. **Deleted items** appear with a `"deleted": {}` facet — remove them from your index.
5. **410 Gone error**: Delta token expired (tokens are valid for approximately 30 days). Perform a full re-sync from step 1.

### HTTP Request Patterns

```http
# Initial full enumeration
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/root/delta
Authorization: Bearer {token}

# Get latest deltaLink without enumerating (useful for new installs)
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/root/delta?token=latest
Authorization: Bearer {token}

# Incremental sync using stored deltaLink
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/root/delta(token='...')
Authorization: Bearer {token}
```

**Permissions:** `Files.Read.All` (Application)

### Response: Deleted Item Detection

```json
{
  "value": [
    {
      "id": "0123456789abc",
      "name": "folder2",
      "folder": {},
      "deleted": {}
    },
    {
      "id": "123010204abac",
      "name": "file.txt",
      "file": {}
    }
  ],
  "@odata.deltaLink": "https://graph.microsoft.com/v1.0/..."
}
```

Items with `"deleted": {}` must be removed from your index. Items without `deleted` are created or updated.

### 410 Gone: Handling Resync Errors

```json
{
  "error": {
    "code": "resyncRequired",
    "innerError": {
      "code": "resyncChangesApplyDifferences"
    },
    "message": "..."
  }
}
```

| Error Code | Meaning | Action |
|---|---|---|
| `resyncChangesApplyDifferences` | Server state diverged; apply server as authoritative | Full re-sync, replace local index with server state |
| `resyncChangesUploadDifferences` | Upload local changes not on server | Full re-sync, re-upload any local items server doesn't know |

For a read-only indexing connector, always treat 410 as "full re-sync required, discard local delta token".

### TypeScript: Delta Sync Implementation

```typescript
interface DeltaSyncState {
  driveId: string;
  deltaLink: string | null; // null = never synced
  lastSyncedAt: string | null;
}

interface DeltaResult {
  created: DriveItem[];
  updated: DriveItem[];
  deleted: string[]; // item IDs
  newDeltaLink: string;
}

async function runDeltaSync(
  graphClient: GraphHttpClient,
  state: DeltaSyncState
): Promise<DeltaResult> {
  const created: DriveItem[] = [];
  const updated: DriveItem[] = [];
  const deleted: string[] = [];

  let url = state.deltaLink
    ?? `https://graph.microsoft.com/v1.0/drives/${state.driveId}/root/delta`;

  let newDeltaLink = '';

  try {
    while (url) {
      const response = await graphClient.get(url);

      if (response.status === 410) {
        // Token expired — caller must handle full resync
        throw new DeltaTokenExpiredError(state.driveId);
      }

      if (!response.ok) {
        throw new Error(`Delta sync failed: ${response.status}`);
      }

      const data = await response.json() as DeltaResponse;

      for (const item of data.value ?? []) {
        if (item.deleted) {
          deleted.push(item.id);
        } else if (state.deltaLink === null) {
          // First sync — everything is "created"
          created.push(item);
        } else {
          // Subsequent sync — items are created or updated (no way to distinguish without local state)
          updated.push(item);
        }
      }

      if (data['@odata.deltaLink']) {
        newDeltaLink = data['@odata.deltaLink'];
        url = '';
      } else {
        url = data['@odata.nextLink'] ?? '';
      }
    }
  } catch (err) {
    if (err instanceof DeltaTokenExpiredError) throw err;
    throw err;
  }

  return { created, updated, deleted, newDeltaLink };
}
```

### Delta Token Storage

Store delta tokens in your persistence layer (database or KV store), keyed by `driveId`. Schema:

```typescript
interface DriveIndexState {
  driveId: string;
  siteId: string;
  deltaLink: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  itemCount: number;
}
```

**Critical:** Delta tokens are opaque strings that can be several hundred characters long. Do not truncate them. Store in a `TEXT` or `VARCHAR(2048)` column.

---

## 9. Real-Time Updates: Webhook Subscriptions

Sources: [learn.microsoft.com — Create subscription](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions), [learn.microsoft.com — Receive via webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [hookdeck.com — Graph Webhooks Guide](https://hookdeck.com/webhooks/platforms/guide-to-microsoft-graph-webhooks-features-and-best-practices)

Webhooks complement delta query: delta handles bulk sync; webhooks give low-latency notification of individual changes.

### Creating a Subscription

```http
POST https://graph.microsoft.com/v1.0/subscriptions
Content-Type: application/json
Authorization: Bearer {token}

{
  "changeType": "created,updated,deleted",
  "notificationUrl": "https://your-connector.example.com/api/graph-notifications",
  "lifecycleNotificationUrl": "https://your-connector.example.com/api/graph-lifecycle",
  "resource": "drives/{drive-id}/root",
  "expirationDateTime": "2026-09-22T18:23:45.9356913Z",
  "clientState": "your-secret-client-state-value"
}
```

**Required permission:** `Files.Read.All` (Application) for driveItem subscriptions.

### Subscription Lifetimes by Resource Type

| Resource | Max subscription lifetime |
|---|---|
| `driveItem` (OneDrive for Business / SharePoint) | Up to 30 days (check actual max via API) |
| `driveItem` (personal OneDrive) | Up to 30 days |
| `list` (SharePoint list) | Up to 30 days |
| Teams messages, channels | 60 days max |
| Outlook mail | 4230 minutes (~3 days) |

**Always set `expirationDateTime` to the maximum allowed** and renew before expiry.

### The Validation Handshake

When you POST a subscription, Graph immediately sends a GET (or POST) request to your `notificationUrl` with:

```
GET https://your-connector.example.com/api/graph-notifications?validationToken=<URL-encoded-token>
```

You **must** respond within **10 seconds** with:
- HTTP 200 OK
- `Content-Type: text/plain`
- Body: the **URL-decoded** `validationToken` value, as plain text

If you fail this, the subscription creation returns an error and no subscription is created.

```typescript
import express from 'express';

const router = express.Router();

router.post('/api/graph-notifications', express.json(), async (req, res) => {
  // Validation handshake
  if (req.query.validationToken) {
    const token = decodeURIComponent(req.query.validationToken as string);
    return res.status(200).type('text/plain').send(token);
  }

  // Acknowledge within 3 seconds — queue and process asynchronously
  const items: ChangeNotification[] = req.body?.value ?? [];

  // Verify clientState BEFORE acknowledging
  for (const item of items) {
    if (item.clientState !== process.env.GRAPH_WEBHOOK_CLIENT_STATE) {
      // Reject unknown clientState — could be spoofed request
      return res.status(202).end(); // Still return 202 to avoid retry storms
    }
  }

  // Acknowledge immediately
  res.status(202).end();

  // Process asynchronously (enqueue for delta sync trigger)
  for (const item of items) {
    await notificationQueue.add(item);
  }
});
```

### Subscription Renewal

Renew at least 24 hours before expiry:

```typescript
async function renewSubscription(
  graphClient: GraphHttpClient,
  subscriptionId: string,
  newExpirationDateTime: string
): Promise<void> {
  await graphClient.patch(
    `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
    {
      expirationDateTime: newExpirationDateTime,
    }
  );
}

// Scheduled job: check and renew all subscriptions
async function renewAllSubscriptions(
  graphClient: GraphHttpClient,
  store: SubscriptionStore
): Promise<void> {
  const subs = await store.getAll();
  const renewThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

  for (const sub of subs) {
    if (new Date(sub.expirationDateTime) < renewThreshold) {
      const newExpiry = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(); // 29 days
      await renewSubscription(graphClient, sub.id, newExpiry);
      await store.update(sub.id, { expirationDateTime: newExpiry });
    }
  }
}
```

### Lifecycle Notifications

Subscribe with `lifecycleNotificationUrl` to receive warnings about:

| Event | Meaning | Action |
|---|---|---|
| `reauthorizationRequired` | Access token for the subscription is expiring | Call Graph to reauthorize the subscription |
| `subscriptionRemoved` | Graph removed the subscription (auth expired or other reason) | Re-create the subscription |
| `missed` | Some notifications were missed (endpoint was slow/down) | Trigger a delta sync for the affected drive |

```typescript
router.post('/api/graph-lifecycle', express.json(), async (req, res) => {
  if (req.query.validationToken) {
    return res.status(200).type('text/plain').send(
      decodeURIComponent(req.query.validationToken as string)
    );
  }

  res.status(202).end();

  for (const event of req.body?.value ?? []) {
    switch (event.lifecycleEvent) {
      case 'reauthorizationRequired':
        await reauthorizeSubscription(event.subscriptionId);
        break;
      case 'subscriptionRemoved':
        await recreateSubscription(event.subscriptionId);
        break;
      case 'missed':
        await triggerDeltaSync(event.subscriptionId);
        break;
    }
  }
});
```

### Notification Payload Schema

```json
{
  "value": [
    {
      "subscriptionId": "22d3929f-5c57-...",
      "changeType": "updated",
      "clientState": "your-secret-client-state-value",
      "resource": "drives/b!T4M.../root",
      "resourceData": {
        "@odata.type": "#microsoft.graph.driveItem",
        "@odata.id": "drives/b!T4M.../items/01ABCD...",
        "id": "01ABCD..."
      },
      "subscriptionExpirationDateTime": "2026-09-22T18:23:45.9356913Z",
      "tenantId": "84bd8158-6d4d-..."
    }
  ]
}
```

**Important:** The notification payload does NOT include the changed data itself (unless you enable `includeResourceData`, which requires encryption). Use the notification as a trigger to run a targeted delta sync or fetch the specific item.

### Webhook vs Delta Query: When to Use Each

| Scenario | Use |
|---|---|
| Initial full index build | Delta query (full enumeration) |
| Ongoing sync for large drives | Delta query on a schedule (e.g., every 15 minutes) |
| Low-latency notification of changes | Webhooks → trigger targeted delta |
| Tenant with 100+ drives | Delta query only (creating 100+ subscriptions is costly) |
| High-priority content (e.g., news, announcements) | Both: webhook for immediate trigger + delta as safety net |

**Recommendation for Phase 2:** Implement delta query first. Add webhooks as a Phase 3 enhancement for real-time notification. Delta query alone with a 15-minute schedule is sufficient for an enterprise knowledge index.

---

## 10. Per-File Permissions and ACL Resolution

Sources: [learn.microsoft.com — List permissions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0), [learn.microsoft.com — Get permission](https://learn.microsoft.com/en-us/graph/api/permission-get)

### Listing Permissions on a DriveItem

```http
GET https://graph.microsoft.com/v1.0/drives/{drive-id}/items/{item-id}/permissions
Authorization: Bearer {token}
```

**Permission required (Application):** `Files.Read.All`

**Important caveat:** When called with Application permissions (client credentials), this returns ALL permissions on the item. When called with Delegated permissions, it returns only the permissions visible to the calling user. For ACL indexing, use Application permissions.

### Permission Resource Schema

```json
{
  "value": [
    {
      "id": "1",
      "roles": ["write"],
      "grantedTo": {
        "@deprecated": "Use grantedToV2 instead",
        "user": {
          "id": "efee1b77-fb3b-4f65-99d6-274c11914d12",
          "displayName": "Robin Danielsen"
        }
      },
      "grantedToV2": {
        "user": {
          "id": "efee1b77-fb3b-4f65-99d6-274c11914d12",
          "displayName": "Robin Danielsen"
        },
        "siteUser": {
          "id": "1",
          "displayName": "Robin Danielsen",
          "loginName": "Robin Danielsen"
        }
      },
      "inheritedFrom": {
        "driveId": "b!T4M...",
        "id": "01PARENT...",
        "path": "/drive/root:/Documents"
      }
    },
    {
      "id": "2",
      "roles": ["read"],
      "grantedToIdentitiesV2": [
        {
          "group": {
            "id": "c2f798fd-f95d-4623-8824-63aec21fffff",
            "displayName": "Marketing Team"
          }
        }
      ]
    },
    {
      "id": "3",
      "roles": ["read"],
      "link": {
        "webUrl": "https://...",
        "type": "view",
        "scope": "organization"
      }
    }
  ]
}
```

### Permission Types

| Field present | Meaning |
|---|---|
| `grantedToV2.user` | Individual user has explicit permission |
| `grantedToIdentitiesV2[].group` | Security group has permission |
| `link.scope === 'organization'` | Anyone in the tenant can access |
| `link.scope === 'anonymous'` | Public link — anyone on the internet |
| `link` (no scope) | Specific-link sharing |
| `inheritedFrom` present | Permission inherited from parent folder/library (not set on this file directly) |

**Critical:** `grantedTo` is deprecated — use `grantedToV2` and `grantedToIdentitiesV2` always.

### Roles

| Role value | Meaning |
|---|---|
| `read` | Read-only |
| `write` | Read + write |
| `owner` | Full control |
| `sp.full control` | SharePoint full control |
| `sp.contribute` | SharePoint contribute |
| `sp.view` | SharePoint view only |

### Inherited vs Direct Permissions

The `inheritedFrom` property tells you a permission was set on an ancestor (parent folder, drive root, or site). This matters for ACL indexing:

- If a file has only inherited permissions, its effective access is determined entirely by the parent hierarchy
- If a file has direct permissions in addition to inherited ones, both apply (union)
- A direct "deny" permission does NOT exist in SharePoint's Graph API model — SharePoint uses broken inheritance to restrict files

### Enumerating Permissions at Scale

Calling `/permissions` on every file is **extremely expensive** for large libraries. A drive with 100,000 files would require 100,000 API calls just for permissions.

**Practical strategies:**

1. **Inherit from library root (common case):** Most SharePoint files inherit permissions from the document library. Check if `inheritedFrom` points to the drive root. If it does, the file uses the library's ACL — store the library-level ACL and skip per-file calls.

2. **Only fetch permissions for files with broken inheritance:** SharePoint marks files with broken inheritance. Check `item.sharepointIds` or look for a `hasUniqueRoleAssignments` flag. In Graph, you can detect broken inheritance by seeing if `permissions[*].inheritedFrom` exists on all permissions — if none of them do, the file has its own permissions.

3. **Batch permission lookups:** Use Graph batch requests to fetch permissions for up to 20 items in a single HTTP call.

```typescript
async function getItemPermissions(
  graphClient: GraphHttpClient,
  driveId: string,
  itemId: string
): Promise<Permission[]> {
  const response = await graphClient.get(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/permissions`
  );
  const data = await response.json() as PermissionListResponse;
  return data.value ?? [];
}

function extractPrincipalsFromPermissions(permissions: Permission[]): string[] {
  const principalIds: Set<string> = new Set();

  for (const perm of permissions) {
    // Skip read-anonymous sharing links
    if (perm.link?.scope === 'anonymous') continue;

    // Organization-wide link — handled separately (everyone in tenant)
    if (perm.link?.scope === 'organization') {
      principalIds.add('__org__'); // Sentinel for "entire org"
      continue;
    }

    // Direct user grant
    if (perm.grantedToV2?.user?.id) {
      principalIds.add(perm.grantedToV2.user.id);
    }

    // Group grants (can be multiple)
    for (const identity of perm.grantedToIdentitiesV2 ?? []) {
      if (identity.user?.id) principalIds.add(identity.user.id);
      if (identity.group?.id) principalIds.add(`group:${identity.group.id}`);
    }
  }

  return Array.from(principalIds);
}
```

---

## 11. Query-Time ACL Enforcement

This is the critical section for the enterprise knowledge index. The goal: when a user queries the index, return only documents they have permission to access.

### Strategy: Index-Time ACL Capture + Query-Time Group Expansion

The recommended approach for Phase 2:

1. **Index time:** For each indexed document, store the list of Entra group IDs and user IDs that have read access (extracted from permissions as above).
2. **Query time:** When a user queries, call Graph to get the user's transitive group memberships, then filter indexed results to those where the user's ID or any of their group IDs appear in the document's ACL.

### Getting User's Transitive Group Memberships

```http
POST https://graph.microsoft.com/v1.0/users/{userId}/getMemberOf/$ref
# OR the transitive version (includes nested groups):
GET https://graph.microsoft.com/v1.0/users/{userId}/transitiveMemberOf
Authorization: Bearer {token}
```

**Permission required:** `GroupMember.Read.All` (Application) or delegated `Directory.Read.All`

```typescript
async function getUserTransitiveGroupIds(
  graphClient: GraphHttpClient,
  userId: string
): Promise<string[]> {
  const groupIds: string[] = [];
  let url = `https://graph.microsoft.com/v1.0/users/${userId}/transitiveMemberOf` +
    `?$select=id&$filter=@odata.type eq 'microsoft.graph.group'`;

  while (url) {
    const response = await graphClient.get(url);
    const data = await response.json() as GroupListResponse;

    for (const group of data.value ?? []) {
      groupIds.push(group.id);
    }

    url = data['@odata.nextLink'] ?? '';
  }

  return groupIds;
}
```

**Cache the group memberships.** Group memberships change infrequently. Cache per user for 5–15 minutes to avoid excessive Graph calls on every query.

### Filtering at Query Time

```typescript
async function filterResultsByUserAccess(
  results: IndexedDocument[],
  userId: string,
  graphClient: GraphHttpClient,
  groupMembershipCache: Cache
): Promise<IndexedDocument[]> {
  // Get or cache the user's group IDs
  let userGroupIds = await groupMembershipCache.get(userId);
  if (!userGroupIds) {
    userGroupIds = await getUserTransitiveGroupIds(graphClient, userId);
    await groupMembershipCache.set(userId, userGroupIds, { ttl: 600 }); // 10 min TTL
  }

  const userPrincipals = new Set([userId, ...userGroupIds.map(g => `group:${g}`)]);

  return results.filter(doc => {
    // Check if the document is accessible to the entire org
    if (doc.aclPrincipals.includes('__org__')) return true;
    // Check if any of the user's principals match
    return doc.aclPrincipals.some(p => userPrincipals.has(p));
  });
}
```

### Alternative: Microsoft Graph Search API (Does Not Enforce ACLs)

The `/search/query` endpoint searches content visible to the calling identity. If called with client credentials (application context), it searches ALL content with no ACL filtering — it returns results even if a user would not have access. **Do not use Graph Search as a substitute for ACL enforcement.** Use it only for tenant-wide search by privileged service accounts.

### Alternative: SharePoint Search REST API

SharePoint Search (`/_api/search/query`) does enforce ACLs when called with delegated auth. However, it does not support the delta sync model and has a different developer experience. It is not recommended for a Graph-native connector.

---

## 12. Throttling and Backoff

Sources: [learn.microsoft.com/en-us/graph/throttling](https://learn.microsoft.com/en-us/graph/throttling), [learn.microsoft.com/en-us/graph/throttling-limits](https://learn.microsoft.com/en-us/graph/throttling-limits)

### Throttling Response

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

### Global Throttling Limits

| Scope | Limit |
|---|---|
| Per app across all tenants | 130,000 requests per 10 seconds |

### SharePoint / Files Service Limits

SharePoint and OneDrive/Files APIs use a **resource unit model** separate from global limits. See [Avoid getting throttled or blocked in SharePoint](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online).

Key: SharePoint returns `RateLimit-*` headers to signal approaching limits:

| Header | Meaning |
|---|---|
| `RateLimit-Limit` | Total resource units allowed in the window |
| `RateLimit-Remaining` | Resource units remaining |
| `RateLimit-Reset` | Seconds until the window resets |

**Pro tip:** Monitor `RateLimit-Remaining` and proactively slow down requests when it drops below 20% of `RateLimit-Limit`. This prevents 429s rather than reacting to them.

### TypeScript: Retry-with-Backoff Wrapper

```typescript
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

async function graphRequestWithRetry<T>(
  requestFn: () => Promise<Response>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const response = await requestFn();

      if (response.status === 429 || response.status === 503) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : null;

        const delayMs = retryAfterSeconds
          ? retryAfterSeconds * 1000
          : Math.min(
              options.baseDelayMs * Math.pow(2, attempt),
              options.maxDelayMs
            );

        if (attempt < options.maxRetries) {
          await sleep(delayMs);
          continue;
        }
      }

      return response;
    } catch (err) {
      lastError = err as Error;
      if (attempt < options.maxRetries) {
        const delayMs = Math.min(
          options.baseDelayMs * Math.pow(2, attempt),
          options.maxDelayMs
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error('Max retries exceeded');
}

// Respect RateLimit headers proactively
function checkRateLimitHeaders(response: Response): void {
  const remaining = response.headers.get('RateLimit-Remaining');
  const limit = response.headers.get('RateLimit-Limit');
  const reset = response.headers.get('RateLimit-Reset');

  if (remaining && limit) {
    const remainingPct = parseInt(remaining) / parseInt(limit);
    if (remainingPct < 0.2) {
      // Proactively back off
      const resetSeconds = reset ? parseInt(reset) : 5;
      // Signal caller to slow down
      console.warn(`Rate limit at ${(remainingPct * 100).toFixed(0)}%, backing off for ${resetSeconds}s`);
    }
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

### Concurrency Limits for Batch Sync

**Do NOT run unlimited parallel requests.** A well-behaved connector:
- Maximum 4 concurrent Graph API calls during background sync
- Maximum 1 concurrent file download
- Use a semaphore or p-limit to enforce this

```typescript
import pLimit from 'p-limit';

const graphConcurrencyLimit = pLimit(4); // Max 4 concurrent Graph calls
const downloadConcurrencyLimit = pLimit(1); // Max 1 concurrent download

// Usage
await Promise.all(
  drives.map(drive =>
    graphConcurrencyLimit(() => syncDrive(drive))
  )
);
```

### Batch Requests (JSON Batching)

Graph supports batching up to 20 requests into a single HTTP call:

```http
POST https://graph.microsoft.com/v1.0/$batch
Content-Type: application/json

{
  "requests": [
    {
      "id": "1",
      "method": "GET",
      "url": "/drives/{id1}/items/{item1}/permissions"
    },
    {
      "id": "2",
      "method": "GET",
      "url": "/drives/{id2}/items/{item2}/permissions"
    }
  ]
}
```

**Important:** Batch requests are evaluated individually against throttling limits. If one request in a batch gets a 429, only that request failed — the batch itself returns 200. You must check each response's status code individually.

---

## 13. Complete TypeScript Connector Class

This section provides a production-ready skeleton. It omits text extraction logic (handled by a separate `DocumentParser` class) and focuses on the Graph integration layer.

```typescript
import {
  ConfidentialClientApplication,
  Configuration,
  AuthenticationResult,
} from '@azure/msal-node';
import pLimit from 'p-limit';

// -------- Types --------

export interface ConnectorConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  // Which sites to index; empty = all sites
  siteAllowlist?: string[]; // site IDs
  // Max file size in bytes to attempt content extraction
  maxContentSizeBytes?: number;
  // Concurrency limit for parallel Graph calls
  graphConcurrency?: number;
}

export interface IndexedDocument {
  id: string; // Unique: `${driveId}::${itemId}`
  driveId: string;
  itemId: string;
  siteId: string;
  name: string;
  webUrl: string;
  mimeType: string | null;
  size: number;
  lastModifiedDateTime: string;
  createdById: string | null;
  content: string | null; // Extracted text, null if binary/too large
  aclPrincipals: string[]; // User IDs and "group:{groupId}" strings
  indexedAt: string;
}

export interface DriveIndexState {
  driveId: string;
  siteId: string;
  siteName: string;
  deltaLink: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
}

// -------- Auth --------

class GraphAuthProvider {
  private readonly msalClient: ConfidentialClientApplication;

  constructor(config: ConnectorConfig) {
    const msalConfig: Configuration = {
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        clientSecret: config.clientSecret,
      },
    };
    this.msalClient = new ConfidentialClientApplication(msalConfig);
  }

  async getToken(): Promise<string> {
    const result: AuthenticationResult | null =
      await this.msalClient.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
    if (!result?.accessToken) throw new Error('MSAL: failed to acquire token');
    return result.accessToken;
  }
}

// -------- HTTP Client --------

class GraphHttpClient {
  constructor(private readonly auth: GraphAuthProvider) {}

  async get(url: string): Promise<Response> {
    const token = await this.auth.getToken();
    return graphRequestWithRetry(() =>
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ConsistencyLevel: 'eventual',
        },
      })
    );
  }

  async patch(url: string, body: object): Promise<Response> {
    const token = await this.auth.getToken();
    return graphRequestWithRetry(() =>
      fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    );
  }

  async getStream(url: string): Promise<ReadableStream> {
    const token = await this.auth.getToken();
    const response = await graphRequestWithRetry(() =>
      fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'follow',
      })
    );
    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: ${response.status}`);
    }
    return response.body;
  }
}

// -------- Main Connector Class --------

export class SharePointGraphConnector {
  private readonly auth: GraphAuthProvider;
  private readonly http: GraphHttpClient;
  private readonly concurrency: ReturnType<typeof pLimit>;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly documentParser: DocumentParser,
    private readonly indexStore: IndexStore
  ) {
    this.auth = new GraphAuthProvider(config);
    this.http = new GraphHttpClient(this.auth);
    this.concurrency = pLimit(config.graphConcurrency ?? 4);
  }

  // ---- Site Discovery ----

  async* enumerateSites(): AsyncGenerator<Site> {
    let url = 'https://graph.microsoft.com/v1.0/sites/getAllSites';
    while (url) {
      const response = await this.http.get(url);
      const data = await response.json() as SiteListResponse;
      for (const site of data.value ?? []) {
        if (site.isPersonalSite) continue;
        if (
          this.config.siteAllowlist?.length &&
          !this.config.siteAllowlist.includes(site.id)
        ) continue;
        yield site;
      }
      url = data['@odata.nextLink'] ?? '';
    }
  }

  // ---- Drive Discovery ----

  async getDocumentLibraries(siteId: string): Promise<Drive[]> {
    const response = await this.http.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`
    );
    const data = await response.json() as DriveListResponse;
    return (data.value ?? []).filter(d => d.driveType === 'documentLibrary');
  }

  // ---- Delta Sync (Full + Incremental) ----

  async syncDrive(state: DriveIndexState): Promise<DriveIndexState> {
    let url = state.deltaLink
      ?? `https://graph.microsoft.com/v1.0/drives/${state.driveId}/root/delta` +
         `?$select=id,name,file,folder,size,lastModifiedDateTime,webUrl,parentReference,createdBy,deleted`;

    let newDeltaLink: string | null = null;
    const toIndex: DriveItem[] = [];
    const toDelete: string[] = [];

    while (url) {
      const response = await this.http.get(url);

      if (response.status === 410) {
        // Delta token expired — trigger full resync
        const newState: DriveIndexState = { ...state, deltaLink: null };
        return this.syncDrive(newState);
      }

      if (!response.ok) {
        throw new Error(`Delta sync failed for drive ${state.driveId}: ${response.status}`);
      }

      const data = await response.json() as DeltaResponse;

      for (const item of data.value ?? []) {
        if (item.deleted) {
          toDelete.push(item.id);
        } else if (item.file) {
          // Only index files, not folders
          toIndex.push(item);
        }
      }

      if (data['@odata.deltaLink']) {
        newDeltaLink = data['@odata.deltaLink'];
        url = '';
      } else {
        url = data['@odata.nextLink'] ?? '';
      }
    }

    // Delete removed items from index
    if (toDelete.length > 0) {
      await this.indexStore.deleteItems(
        toDelete.map(id => `${state.driveId}::${id}`)
      );
    }

    // Index new/updated files (with concurrency control)
    await Promise.all(
      toIndex.map(item =>
        this.concurrency(() => this.indexFile(state, item))
      )
    );

    return {
      ...state,
      deltaLink: newDeltaLink,
      lastIncrementalSyncAt: new Date().toISOString(),
      lastFullSyncAt: state.deltaLink === null
        ? new Date().toISOString()
        : state.lastFullSyncAt,
    };
  }

  // ---- File Indexing ----

  private async indexFile(
    state: DriveIndexState,
    item: DriveItem
  ): Promise<void> {
    const maxSize = this.config.maxContentSizeBytes ?? 50 * 1024 * 1024; // 50 MB default

    let content: string | null = null;

    // Only attempt content extraction for indexable file types under size limit
    if (item.size && item.size <= maxSize && this.isIndexable(item.file?.mimeType)) {
      try {
        const stream = await this.http.getStream(
          `https://graph.microsoft.com/v1.0/drives/${state.driveId}/items/${item.id}/content`
        );
        content = await this.documentParser.extractText(stream, item.file!.mimeType!);
      } catch (err) {
        // Content extraction failure is non-fatal — index metadata only
        console.warn(`Content extraction failed for ${item.id}: ${err}`);
      }
    }

    // Fetch permissions for this file
    const permissions = await this.getItemPermissions(state.driveId, item.id);
    const aclPrincipals = extractPrincipalsFromPermissions(permissions);

    const doc: IndexedDocument = {
      id: `${state.driveId}::${item.id}`,
      driveId: state.driveId,
      itemId: item.id,
      siteId: state.siteId,
      name: item.name,
      webUrl: item.webUrl ?? '',
      mimeType: item.file?.mimeType ?? null,
      size: item.size ?? 0,
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdById: item.createdBy?.user?.id ?? null,
      content,
      aclPrincipals,
      indexedAt: new Date().toISOString(),
    };

    await this.indexStore.upsert(doc);
  }

  // ---- Permissions ----

  async getItemPermissions(
    driveId: string,
    itemId: string
  ): Promise<Permission[]> {
    const response = await this.http.get(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/permissions`
    );
    const data = await response.json() as PermissionListResponse;
    return data.value ?? [];
  }

  // ---- User Group Expansion ----

  async getUserTransitiveGroupIds(userId: string): Promise<string[]> {
    const groupIds: string[] = [];
    let url = `https://graph.microsoft.com/v1.0/users/${userId}/transitiveMemberOf` +
      `?$select=id&$filter=@odata.type eq 'microsoft.graph.group'`;

    while (url) {
      const response = await this.http.get(url);
      const data = await response.json() as GroupListResponse;
      for (const g of data.value ?? []) groupIds.push(g.id);
      url = data['@odata.nextLink'] ?? '';
    }
    return groupIds;
  }

  // ---- Helpers ----

  private isIndexable(mimeType?: string): boolean {
    if (!mimeType) return false;
    const indexable = [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
    ];
    return indexable.some(t => mimeType.startsWith(t));
  }
}

// ---- Helper functions (defined elsewhere in module) ----

function extractPrincipalsFromPermissions(permissions: Permission[]): string[] {
  const principals = new Set<string>();
  for (const perm of permissions) {
    if (perm.link?.scope === 'anonymous') continue;
    if (perm.link?.scope === 'organization') {
      principals.add('__org__');
      continue;
    }
    if (perm.grantedToV2?.user?.id) principals.add(perm.grantedToV2.user.id);
    for (const identity of perm.grantedToIdentitiesV2 ?? []) {
      if (identity.user?.id) principals.add(identity.user.id);
      if (identity.group?.id) principals.add(`group:${identity.group.id}`);
    }
  }
  return Array.from(principals);
}
```

---

## 14. Limitations, Edge Cases, and Gotchas

### Authentication and Token Issues

**Client credentials cannot call `getAllSites` with Delegated permissions.**
`getAllSites` requires Application permissions only. There is no delegated equivalent — you cannot list all sites in a tenant on behalf of a user.

**Token expiry during long sync jobs.**
MSAL caches tokens, but a full-tenant sync can take hours. MSAL handles token refresh automatically when using `acquireTokenByClientCredential`, but if you cache the token yourself, it will expire. Always call `getToken()` from MSAL per request, not once at job start.

**Certificate rotation.**
If using certificate auth, the connector will fail silently when the certificate expires. Implement certificate expiry monitoring.

### Sites and Drives

**Personal OneDrive sites appear in `getAllSites`.**
Sites where `isPersonalSite === true` are users' personal OneDrive. Filter these unless your product explicitly includes personal OneDrive content.

**Hub sites and subsites.**
SharePoint hub sites aggregate other sites, but the `getAllSites` API returns each site independently — hub membership is not surfaced in the basic response. Sites with a parent (subsites) have `parentReference` populated; in modern SharePoint, subsites are rare but still exist.

**Communication sites vs Team sites.**
Both types appear in `getAllSites` and have document libraries. The content types and metadata differ, but the API is the same.

**Drives with no root folder.**
Some SharePoint configurations result in drives that return 404 on `/root` or `/root/children`. Handle this gracefully with try/catch.

### Delta Query

**Delta tokens expire after approximately 30 days.**
An expired token returns 410 Gone with `resyncRequired`. Your scheduler must ensure syncs run at least every 25 days, but also handle 410 defensively at any time.

**`token=latest` does not enumerate existing content.**
Calling `delta?token=latest` gives you a delta token at the current moment, with no items returned. This is useful when setting up a new subscription for future changes, but if you want to index existing content, start without the `token=latest` parameter.

**Very large drives (100,000+ items) can take hours for initial enumeration.**
A drive with 100,000 items at 200 items per page requires 500 Graph calls. At 4 concurrent calls with realistic latency, expect 5–30 minutes for initial enumeration.

**The `deleted` facet provides only the item ID.**
When an item is deleted, the delta response includes its ID but not its name, path, or metadata. If you need to log what was deleted, you must have stored the metadata at index time.

**Moving a file shows as delete + create.**
Moving a file between folders within a drive shows as two delta events: the old entry gets `deleted: {}` and the new location gets a full item. Moving between drives (or sites) shows as delete only in the source drive; you will see a create in the destination drive only if you have a subscription for that drive.

### Permissions

**Application-permission context returns all permissions including inherited ones.**
Under client credentials, `/permissions` returns the full permission set including all inherited grants. This is what you want for ACL indexing.

**`grantedTo` is deprecated — always use `grantedToV2` and `grantedToIdentitiesV2`.**
Old code using `grantedTo` will miss group grants and will break when Microsoft removes the deprecated property.

**Sharing links with `scope: organization` effectively grant access to all tenant members.**
These are common ("Anyone in your organization with this link can view"). Index these documents as accessible to all authenticated users by using the `__org__` sentinel in your ACL list.

**Files with only a "unique" permission set to "no access" pattern (broken inheritance + no grants).**
It is possible for a file to have broken inheritance with zero explicit grants. Such a file is effectively inaccessible to normal users. Index the metadata but mark `aclPrincipals` as empty — these documents will never surface in search results, which is correct.

**Group nesting depth is unbounded in Entra ID.**
`transitiveMemberOf` resolves all levels of nesting automatically. Do not attempt to manually resolve nested groups.

### File Download

**302 Redirect behavior varies.**
Some Graph clients do not follow redirects automatically. The `@microsoft.graph.downloadUrl` property is the pre-authenticated URL behind the redirect. It is valid for approximately 1 hour — do not cache it across sync cycles.

**The `content` endpoint returns 404 for folders.**
Always check `item.file` is truthy before attempting to download. Attempting to download a folder's content returns 404.

**Files over 250 MB are unusual but possible.**
SharePoint Online now supports files up to 250 GB. Files between 250 MB and 250 GB require streaming — do not buffer them. For indexing purposes, text extraction of files this large is impractical; skip content extraction and index metadata only.

### Throttling

**The `Retry-After` header is authoritative — never ignore it.**
Do not use a fixed backoff if `Retry-After` is present. If `Retry-After: 300` (5 minutes), you must wait 5 minutes, not 10 seconds.

**429s can cascade.**
If your connector gets throttled and retries aggressively, it will stay throttled longer. Implement proper backoff and respect `Retry-After`.

**SharePoint throttling is per-site, not per-drive.**
Multiple drives in the same site share a throttling budget. If you are syncing multiple drives from the same site concurrently, throttle them collectively, not independently.

### Webhooks

**Webhook endpoint must be publicly accessible.**
Graph cannot send notifications to localhost or private network endpoints. For development, use a tunneling service (ngrok, Cloudflare Tunnel, etc.).

**The 3-second acknowledgement window is strict.**
If you do anything async before responding, you will miss the window. Always acknowledge immediately and queue for async processing.

**No HMAC signature — clientState is the primary authenticity check.**
Anyone who can POST to your endpoint can send fake notifications if they know or guess your `clientState`. Keep `clientState` secret. Also restrict your endpoint's firewall to Microsoft Graph's published IP ranges.

**Notifications do not include the changed resource data by default.**
Standard notifications tell you something changed and which item changed (by ID), but not what changed. You must follow up with a Graph read to get the current state, or use delta query triggered by the notification.

---

## 15. Build vs. Skip Decisions

### Build in Phase 2

| Feature | Priority | Reasoning |
|---|---|---|
| Client credentials auth (MSAL) | Must | Required for all Graph calls |
| `getAllSites` enumeration with pagination | Must | Foundation for multi-site indexing |
| Document library listing | Must | Required to find drives |
| Delta query (full + incremental) | Must | The only scalable sync mechanism |
| File content download + streaming | Must | Required for content indexing |
| Per-file permission listing | Must | Required for ACL enforcement |
| Group expansion (`transitiveMemberOf`) | Must | Required for query-time filtering |
| Throttling + retry-with-backoff | Must | Production connector will be throttled |
| Delta token persistence per drive | Must | Required for incremental sync |
| `$select` optimization on all requests | Must | Reduces response size and throttling risk |

### Build in Phase 3

| Feature | Priority | Reasoning |
|---|---|---|
| Webhook subscriptions | High | Real-time change notification; delta query at 15-min intervals is acceptable for Phase 2 |
| On-behalf-of (OBO) flow | High | Stronger per-user ACL enforcement; client credentials + group expansion is acceptable for Phase 2 |
| Sites.Selected permission model | High | Needed for enterprise customers who want scoped access |
| Graph batch requests for permissions | Medium | Performance optimization; acceptable to do serial requests at low scale |
| Certificate auth (replace client secret) | Medium | Security hardening |
| Multi-geo tenant support | Low | Only relevant for large enterprises with multi-geo tenants; `getAllSites` handles it, but geo-aware routing may be needed |

### Skip (Not Worth Building)

| Feature | Reason to skip |
|---|---|
| SharePoint REST API | No delta query, no webhooks, redundant with Graph |
| Graph Search API for ACL enforcement | Does not enforce ACLs in application context |
| Per-item 410 error recovery without full resync | Overly complex; just resync the whole drive |
| Rich notifications with resource data (encrypted) | Complex (RSA + AES decryption), low value — just follow up with a Graph read |
| Excel/PowerPoint formula evaluation during indexing | Not relevant — extract visible text only |
| SharePoint search REST (`_api/search/query`) | Redundant; Graph delta is superior for indexing |

---

## Sources

- [Microsoft Graph API: driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)
- [Microsoft Graph API: List children of driveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children)
- [Microsoft Graph API: sites/getAllSites](https://learn.microsoft.com/en-us/graph/api/site-getallsites?view=graph-rest-1.0)
- [Microsoft Graph API: List permissions on driveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0)
- [Microsoft Graph API: Get sharing permission](https://learn.microsoft.com/en-us/graph/api/permission-get)
- [Microsoft Graph API: Create subscription](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions)
- [Microsoft Graph: Receive change notifications through webhooks](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Microsoft Graph: Throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
- [Microsoft Graph: Service-specific throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)
- [Microsoft Graph: Search API for SharePoint/OneDrive](https://learn.microsoft.com/en-us/graph/search-concept-files)
- [Microsoft Graph: Direct streaming of SharePoint driveItem content](https://devblogs.microsoft.com/microsoft365dev/direct-streaming-of-sharepoint-driveitem-content-in-microsoft-graph-now-available/)
- [Hookdeck: Guide to Microsoft Graph Webhooks (2026)](https://hookdeck.com/webhooks/platforms/guide-to-microsoft-graph-webhooks-features-and-best-practices)
- [MSAL Node samples: On-behalf-of flow](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/samples/msal-node-samples/on-behalf-of/README.md)
- [npm: @azure/msal-node](https://www.npmjs.com/package/@azure/msal-node)
- [Laura Kokkarinen: Sites.Selected permissions guide](https://laurakokkarinen.com/how-to-set-up-microsoft-graph-and-sharepoint-online-selected-api-permissions/)
- [Microsoft Graph API vs SharePoint REST API comparison (iteczone.com, 2026)](https://iteczone.com/microsoft-graph-api-vs-sharepoint-rest-api-comparison/)
- [andrewconnell.com: SharePoint REST API guide](https://www.andrewconnell.com/articles/sharepoint-rest-api-microsoft-365-developers-guide/)
- [imrizwan.com: Graph delta query incremental sync (2026)](https://imrizwan.com/blog/microsoft-graph-delta-query-incremental-sync-2026)
- [imrizwan.com: Graph throttling and 429 survival (2026)](https://imrizwan.com/blog/microsoft-graph-throttling-survive-429-retry-backoff-2026)
