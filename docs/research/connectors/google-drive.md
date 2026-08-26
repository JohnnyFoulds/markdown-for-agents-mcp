# Google Drive + Workspace Connector Research

**Purpose:** Inform the design and implementation of a Google Drive connector for markdown-for-agents-mcp — a self-hosted MCP server giving AI agents enterprise knowledge-base access with per-user ACL enforcement.

**Last updated:** 2026-08-26
**Sources:** Google Drive API v3 official docs, googleapis Node.js client, service account auth guide, push notifications guide

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Authentication: service accounts and domain-wide delegation](#2-authentication-service-accounts-and-domain-wide-delegation)
3. [files.list: search query operators and corpora](#3-fileslist-search-query-operators-and-corpora)
4. [Content export: Google Docs, Sheets, Slides to text](#4-content-export-google-docs-sheets-slides-to-text)
5. [Changes API: incremental sync with page tokens](#5-changes-api-incremental-sync-with-page-tokens)
6. [Push notifications: watch channels and webhook setup](#6-push-notifications-watch-channels-and-webhook-setup)
7. [Permissions API: reading effective access](#7-permissions-api-reading-effective-access)
8. [Shared drives: drives.list, driveId, membership model](#8-shared-drives-driveslist-driveid-membership-model)
9. [MIME types: Google Workspace vs blob vs shortcuts](#9-mime-types-google-workspace-vs-blob-vs-shortcuts)
10. [Rate limits and quotas](#10-rate-limits-and-quotas)
11. [Google's own MCP server: competitive analysis](#11-googles-own-mcp-server-competitive-analysis)
12. [Complete TypeScript connector implementation](#12-complete-typescript-connector-implementation)
13. [Failure modes, gotchas, and edge cases](#13-failure-modes-gotchas-and-edge-cases)
14. [Build recommendations](#14-build-recommendations)

---

## 1. Architecture overview

Source: https://developers.google.com/workspace/drive/api/guides/about-sdk (last updated 2026-07-22)

### What the Drive API provides

The Google Drive API v3 is a REST API that lets applications access files stored in Google Drive cloud storage. The key conceptual components:

| Component | Description |
|-----------|-------------|
| **My Drive** | Per-user personal storage; individual owns files. Files can be shared but ownership stays with user. |
| **Shared drives** | Organisational storage owned by the organisation, not an individual. All members access all files based on their role. |
| **OAuth 2.0** | Required auth protocol for all Drive API access. |
| **Files resource** | Central resource — every file, folder, Google Doc, shortcut, etc. |
| **Changes resource** | Log of all changes to files visible to the authenticated principal. |
| **Permissions resource** | Who has access to each file, at what role level. |

### Connector design decision upfront

**Our connector has two operating modes:**

1. **Per-user mode (Phase 1):** User authenticates via OAuth; connector fetches only files that user can see. Simple, correct ACL enforcement naturally.
2. **Service account + domain-wide delegation mode (Phase 2 enterprise):** A single service account impersonates each user in turn, crawls all drives, stores documents + ACL data, and enforces ACLs at query time in our index.

Mode 1 is simpler but requires users to authenticate. Mode 2 is what enterprise customers need — a background sync with full corpus indexing.

**Verdict: implement Mode 1 first, Mode 2 for enterprise.**

---

## 2. Authentication: service accounts and domain-wide delegation

Sources:
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation

### 2.1 OAuth scopes

The minimum scopes needed for a read-only knowledge-index connector:

| Scope | Use |
|-------|-----|
| `https://www.googleapis.com/auth/drive.readonly` | Read all files the user can see (My Drive + shared drives) |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | Metadata only — cheaper for listing/ACL crawls |
| `https://www.googleapis.com/auth/drive.file` | Read/write only files created by this app (restricted) |

**Use `drive.readonly` for the connector.** It is the broadest read-only scope and is what Google's own MCP server requires.

### 2.2 Service account setup (step by step)

**In Google Cloud Console:**

1. Create a Google Cloud project; enable the Drive API:
   ```
   gcloud services enable drive.googleapis.com --project=PROJECT_ID
   ```
2. Go to IAM & Admin > Service Accounts > Create Service Account
3. Note the service account email (format: `name@project.iam.gserviceaccount.com`)
4. On the Keys tab: Add Key > Create New Key > JSON. Download and store securely.
5. The JSON key file contains:
   ```json
   {
     "type": "service_account",
     "project_id": "my-project",
     "private_key_id": "abc123",
     "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...",
     "client_email": "connector@my-project.iam.gserviceaccount.com",
     "client_id": "123456789",
     "auth_uri": "https://accounts.google.com/o/oauth2/auth",
     "token_uri": "https://oauth2.googleapis.com/token"
   }
   ```

### 2.3 Domain-wide delegation (DWD)

Domain-wide delegation allows the service account to impersonate **any user in the Google Workspace domain** without requiring each user to consent individually. This is the mechanism enterprise connectors need.

**In Google Workspace Admin Console** (requires super-admin privileges):

1. Main menu > Security > Access and data control > API Controls
2. Domain Wide Delegation pane > Manage Domain Wide Delegation
3. Click Add new
4. **Client ID**: The service account's numeric client ID (found on the Service Accounts page, distinct from the email)
5. **OAuth scopes**: `https://www.googleapis.com/auth/drive.readonly`
6. Click Authorize

Important notes:
- Propagation takes **a few minutes, up to 24 hours** after granting
- Service accounts granted DWD are **not subject to domain sharing policies** (e.g., a policy preventing sharing outside the domain does not apply to service accounts)
- DWD grants access to the **entire domain** — security review by the Workspace admin is essential
- The service account itself has **no storage quota** and cannot own files; it can only access files through impersonation

### 2.4 Node.js / TypeScript implementation

```typescript
import { google, Auth } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

/**
 * Create an authenticated Drive client impersonating the given user.
 * Requires domain-wide delegation to be configured.
 */
function getDriveClientForUser(
  serviceAccountKeyPath: string,
  impersonateEmail: string
): ReturnType<typeof google.drive> {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountKeyPath,
    scopes: SCOPES,
    // Subject triggers impersonation via DWD
    clientOptions: {
      subject: impersonateEmail,
    },
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Alternative: load from in-memory credentials object (for secrets managers).
 */
function getDriveClientFromCredentials(
  credentials: {
    client_email: string;
    private_key: string;
    project_id: string;
  },
  impersonateEmail: string
): ReturnType<typeof google.drive> {
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
    subject: impersonateEmail, // DWD impersonation
  });

  return google.drive({ version: 'v3', auth });
}
```

**Key gotcha:** The `subject` field on `JWT` or `clientOptions.subject` on `GoogleAuth` is what triggers domain-wide delegation. Without it, the service account acts as itself (which has no Drive files unless explicitly shared).

### 2.5 Token lifecycle

- Access tokens expire after **1 hour**
- The `googleapis` library handles token refresh automatically when using `GoogleAuth` or `JWT` auth objects
- Do not cache the Drive client across user context switches — each user impersonation creates a separate auth credential

---

## 3. files.list: search query operators and corpora

Sources:
- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list

### 3.1 Request structure

```
GET https://www.googleapis.com/drive/v3/files
```

Key parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query string (see operators below) |
| `corpora` | string | Collection to search: `user`, `domain`, `drive`, `allDrives` |
| `driveId` | string | ID of shared drive when `corpora=drive` |
| `includeItemsFromAllDrives` | boolean | Whether shared drive items are included in results |
| `supportsAllDrives` | boolean | Must be `true` when working with shared drives |
| `pageSize` | integer | Max items per page (1–1000, default 100) |
| `pageToken` | string | Token for next page of results |
| `orderBy` | string | Sort order (see below) |
| `fields` | string | Fields mask — use this to reduce response size |
| `spaces` | string | Comma-separated: `drive`, `appDataFolder` (default: `drive`) |

### 3.2 Query operators

The `q` parameter is a query string combining terms with operators.

**Syntax:** `query_term operator values`

#### Equality / inequality operators

| Operator | Example | Notes |
|----------|---------|-------|
| `=` | `name = 'hello'` | Exact match |
| `!=` | `mimeType != 'application/vnd.google-apps.folder'` | Not equal |
| `contains` | `name contains 'budget'` | Substring match |
| `>`, `>=`, `<`, `<=` | `modifiedTime > '2024-01-01T00:00:00'` | Timestamps in RFC3339 |

#### Collection membership operator

```
'folderID' in parents
'user@example.com' in owners
'user@example.com' in writers
'user@example.com' in readers
```

#### Logical operators

```
and, or, not
```

#### Complete query examples

```
# All non-trashed files in a specific folder
'FOLDER_ID' in parents and trashed = false

# Google Docs modified in the last 7 days
mimeType = 'application/vnd.google-apps.document' and modifiedTime > '2026-08-19T00:00:00'

# Full-text search across all files
fullText contains 'machine learning'

# Exact phrase full-text search
fullText contains '"quarterly report"'

# Files owned by a specific user
'alice@company.com' in owners and trashed = false

# All file types except folders, not trashed
mimeType != 'application/vnd.google-apps.folder' and trashed = false

# All Workspace documents (Docs + Sheets + Slides)
(mimeType = 'application/vnd.google-apps.document' or
 mimeType = 'application/vnd.google-apps.spreadsheet' or
 mimeType = 'application/vnd.google-apps.presentation') and trashed = false

# Files with a custom property
properties has { key='department' and value='engineering' }
```

### 3.3 orderBy values

Multiple fields can be combined with commas. Append ` desc` for descending:

```
orderBy: 'modifiedTime desc,name'
```

Available orderBy fields: `createdTime`, `folder`, `modifiedByMeTime`, `modifiedTime`, `name`, `name_natural` (natural sort), `quotaBytesUsed`, `recency`, `sharedWithMeTime`, `starred`, `viewedByMeTime`

### 3.4 Corpora behaviour

| Corpus | Description | When to use |
|--------|-------------|-------------|
| `user` | Files owned by or shared with the authenticated user (default) | Per-user queries |
| `domain` | All files across the domain visible to the user | Domain-wide search (requires `drive.readonly` on DWD account) |
| `drive` | Files in a specific shared drive | Must combine with `driveId` |
| `allDrives` | My Drive + all shared drives the user can access | Full corpus; less efficient |

**Performance note:** Google explicitly recommends `user` or `drive` over `allDrives` for efficiency. Use `allDrives` only when you genuinely need to search all content.

### 3.5 TypeScript pagination example

```typescript
import { drive_v3 } from 'googleapis';

async function listAllFiles(
  drive: drive_v3.Drive,
  query: string,
  fields: string = 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, owners, permissions)'
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: query,
      fields,
      pageSize: 1000,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });

    if (response.data.files) {
      files.push(...response.data.files);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}
```

### 3.6 Fields mask (always use this)

Without a `fields` mask, the API returns a large default set of fields. Always specify what you need:

```typescript
// Minimum for indexing
const FIELDS = 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, trashed)';

// With permissions (expensive — see rate limits section)
const FIELDS_WITH_PERMS = 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, trashed, permissions(id, role, type, emailAddress))';
```

**Important:** Including `permissions` in a `files.list` call does work but returns only permissions directly set on each file, not inherited permissions from parent folders or shared drive membership. See Section 7 for how effective permissions actually work.

---

## 4. Content export: Google Docs, Sheets, Slides to text

Sources:
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export

### 4.1 Two distinct download methods

Google Drive distinguishes between two types of files:

1. **Blob files**: uploaded binary content (PDFs, Word docs, images, etc.)  
   → Downloaded via `files.get` with `alt=media`

2. **Google Workspace files**: Google Docs, Sheets, Slides, Forms, Drawings  
   → Exported via `files.export` to a chosen MIME type

**You cannot use `files.get` with `alt=media` on Google Workspace files** — it returns a 403 with `fileNotDownloadable`.

### 4.2 Export MIME types for Workspace files

| Source type | Source MIME | Export as text | Export MIME |
|-------------|-------------|----------------|-------------|
| Google Docs | `application/vnd.google-apps.document` | Plain text | `text/plain` |
| Google Docs | `application/vnd.google-apps.document` | HTML | `text/html` |
| Google Docs | `application/vnd.google-apps.document` | Markdown | `text/markdown` (available as of ~2025) |
| Google Docs | `application/vnd.google-apps.document` | docx | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Google Docs | `application/vnd.google-apps.document` | PDF | `application/pdf` |
| Google Sheets | `application/vnd.google-apps.spreadsheet` | CSV (first sheet) | `text/csv` |
| Google Sheets | `application/vnd.google-apps.spreadsheet` | HTML | `text/html` |
| Google Sheets | `application/vnd.google-apps.spreadsheet` | xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Google Slides | `application/vnd.google-apps.presentation` | Plain text | `text/plain` |
| Google Slides | `application/vnd.google-apps.presentation` | pptx | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| Google Forms | `application/vnd.google-apps.form` | None (not exportable via export API) | — |
| Google Drawings | `application/vnd.google-apps.drawing` | SVG | `image/svg+xml` |

**For our MCP connector, use `text/plain` or `text/markdown` for Docs and `text/plain` for Slides. For Sheets, `text/csv` gives the best machine-readable output.**

### 4.3 Export size limits

Google enforces export size limits. Attempting to export a file that exceeds the limit returns an error:
- Google Docs exports: **10 MB** limit for text/HTML exports
- Exceeding the limit returns HTTP 403 `exportSizeLimitExceeded`

For large documents, consider:
1. Exporting in chunks by revision, if applicable
2. Exporting as PDF and using a PDF text extractor (but this adds complexity)
3. Surfacing only the first N characters from oversized exports with a note

### 4.4 TypeScript export implementation

```typescript
import { drive_v3 } from 'googleapis';

const GOOGLE_WORKSPACE_MIME_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/svg+xml',
};

const GOOGLE_WORKSPACE_MIME_TYPES_HTML: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/html',
  'application/vnd.google-apps.spreadsheet': 'text/html',
  'application/vnd.google-apps.presentation': 'text/plain', // no HTML export for Slides
};

/**
 * Fetch file content as text.
 * Handles both blob files (download) and Workspace files (export).
 * Returns null for binary files that can't be meaningfully text-extracted.
 */
async function getFileContent(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File
): Promise<string | null> {
  const mimeType = file.mimeType ?? '';
  const fileId = file.id!;

  // Google Workspace file — must use export
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    const exportMime = GOOGLE_WORKSPACE_MIME_TYPES[mimeType];
    if (!exportMime) {
      // Non-exportable type (Forms, Maps, Vids, etc.)
      return null;
    }

    try {
      const response = await drive.files.export(
        { fileId, mimeType: exportMime },
        { responseType: 'text' }
      );
      return response.data as string;
    } catch (err: any) {
      if (err?.response?.status === 403 && 
          err?.response?.data?.error?.errors?.[0]?.reason === 'exportSizeLimitExceeded') {
        console.warn(`File ${fileId} exceeds export size limit`);
        return `[Content too large to export: ${file.name}]`;
      }
      throw err;
    }
  }

  // Text files — download directly
  const textMimeTypes = [
    'text/plain', 'text/html', 'text/markdown', 'text/csv',
    'application/json', 'application/xml', 'text/xml',
  ];
  if (textMimeTypes.includes(mimeType)) {
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );
    return response.data as string;
  }

  // PDF files — binary, skip unless using pdf-parse separately
  if (mimeType === 'application/pdf') {
    return null; // handle separately
  }

  // All other binary files (images, video, etc.)
  return null;
}
```

### 4.5 Handling multi-sheet Spreadsheets

`files.export` with `text/csv` only exports the **first sheet**. For multi-sheet spreadsheets:

Option A: Use the Google Sheets API (`sheets.spreadsheets.get`) to list all sheets, then export each individually by constructing export URLs like:
```
https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid={SHEET_GID}
```
(These require an OAuth Bearer token.)

Option B: Export as HTML, which includes all sheets in one HTML table dump.

**Recommendation: export multi-sheet spreadsheets as HTML for indexing. Strip the HTML tags to get plain text.**

---

## 5. Changes API: incremental sync with page tokens

Sources:
- https://developers.google.com/workspace/drive/api/guides/manage-changes
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list

### 5.1 Concept

The Drive Changes API provides a time-ordered log of all changes to files visible to the authenticated principal. Instead of re-crawling the entire Drive on each sync, you:

1. On first run: call `changes.getStartPageToken` to get the current state token
2. Store that token
3. On subsequent runs: call `changes.list` with the stored token to get only new changes
4. Process each change (file updated, deleted, permissions changed, etc.)
5. Store the new `newStartPageToken` from the response for next time

### 5.2 Changes resource schema

```typescript
interface Change {
  kind: 'drive#change';
  type: 'file' | 'drive';         // 'drive' = shared drive metadata changed
  changeType: 'file' | 'drive';
  time: string;                    // RFC3339 timestamp
  removed: boolean;                // true if file was deleted or access revoked
  fileId: string;
  file?: File;                     // populated when removed=false
  driveId?: string;                // for shared drive changes
  drive?: Drive;                   // populated for type='drive' changes
}
```

### 5.3 TypeScript incremental sync

```typescript
import { drive_v3 } from 'googleapis';

interface SyncState {
  pageToken: string;
  lastSyncTime: Date;
}

/**
 * Get the start page token for a user — call once to bootstrap.
 */
async function getStartPageToken(
  drive: drive_v3.Drive,
  driveId?: string // pass for shared drive-specific token
): Promise<string> {
  const response = await drive.changes.getStartPageToken({
    driveId,
    supportsAllDrives: true,
  });
  return response.data.startPageToken!;
}

/**
 * Fetch all changes since the last saved page token.
 * Returns the array of changes and the new page token to save.
 */
async function fetchChangesSince(
  drive: drive_v3.Drive,
  savedPageToken: string
): Promise<{ changes: drive_v3.Schema$Change[]; newStartPageToken: string }> {
  const allChanges: drive_v3.Schema$Change[] = [];
  let pageToken: string = savedPageToken;
  let newStartPageToken = savedPageToken;

  while (true) {
    const response = await drive.changes.list({
      pageToken,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'nextPageToken, newStartPageToken, changes(kind, type, changeType, time, removed, fileId, file(id, name, mimeType, modifiedTime, trashed, parents), driveId)',
      pageSize: 1000,
      includeRemoved: true, // important: capture deletions
    });

    const data = response.data;

    if (data.changes) {
      allChanges.push(...data.changes);
    }

    if (data.newStartPageToken) {
      // This appears on the LAST page — save it for next sync
      newStartPageToken = data.newStartPageToken;
    }

    if (!data.nextPageToken) {
      break;
    }
    pageToken = data.nextPageToken;
  }

  return { changes: allChanges, newStartPageToken };
}

/**
 * Process a batch of changes to update the index.
 */
async function processChanges(
  drive: drive_v3.Drive,
  changes: drive_v3.Schema$Change[],
  indexDocument: (file: drive_v3.Schema$File) => Promise<void>,
  removeDocument: (fileId: string) => Promise<void>
): Promise<void> {
  for (const change of changes) {
    if (change.removed || change.file?.trashed) {
      // File deleted or access revoked or trashed
      await removeDocument(change.fileId!);
      continue;
    }

    if (change.type === 'file' && change.file) {
      await indexDocument(change.file);
    }
    // change.type === 'drive' means shared drive metadata changed — handle if needed
  }
}
```

### 5.4 Important behaviours

- `newStartPageToken` only appears on the **last page** of a multi-page response. If you exit the pagination loop early, you'll lose it.
- Changes are in **chronological order** (oldest first).
- If the stored page token is **too old** (stale), the API returns a `410 Gone` error. In this case, perform a full re-crawl and get a new start token. Google does not document exactly how long tokens are valid, but it's typically weeks to months.
- `includeRemoved: true` is critical — without it you won't see deleted files or files for which the user's access was revoked.
- For shared drives, you need a **separate page token per shared drive** if you use `driveId` parameter. Alternatively, use `includeItemsFromAllDrives: true` on a single token for the user's consolidated change log.

### 5.5 Full re-crawl vs incremental sync decision

| Scenario | Approach |
|----------|----------|
| First time setup | Full crawl with `files.list`, then save `getStartPageToken` result |
| Normal sync | `changes.list` from last saved token |
| Token expired (410 Gone) | Full re-crawl again |
| Permission change detected (change with `removed=false` on file with same modifiedTime) | Re-fetch permissions for that file |

---

## 6. Push notifications: watch channels and webhook setup

Sources:
- https://developers.google.com/workspace/drive/api/guides/push (last updated 2026-07-22)

### 6.1 Overview

Instead of polling `changes.list` on a timer, you can register a **watch channel** that causes Google to POST to your webhook URL whenever a change occurs. This eliminates polling overhead.

**Practical caveat for our use case:** Push notifications are excellent for near-real-time updates but add operational complexity (HTTPS endpoint, TLS cert, channel renewal). For a self-hosted connector that runs batch syncs every 5–60 minutes, polling is simpler and often sufficient. **Push is worth implementing once the connector is proven.**

### 6.2 Watch channel lifecycle

1. Register a channel via `changes.watch` (returns channel metadata including expiry)
2. Google sends a **sync message** immediately to confirm delivery
3. Google sends **notification messages** as changes occur
4. Channel expires (max 1 week for changes, max 1 day for a specific file watch)
5. Must renew before expiry or restart

### 6.3 Registering a watch channel

```
POST https://www.googleapis.com/drive/v3/changes/watch
Authorization: Bearer TOKEN

{
  "id": "unique-channel-id-uuid",
  "type": "web_hook",
  "address": "https://your-server.com/webhooks/drive",
  "token": "custom-verification-token",
  "expiration": 1739999999000   // optional, unix millis; max 7 days
}
```

Response:
```json
{
  "kind": "api#channel",
  "id": "unique-channel-id-uuid",
  "resourceId": "o3hgv1538sdjfh",
  "resourceUri": "https://www.googleapis.com/drive/v3/changes",
  "token": "custom-verification-token",
  "expiration": 1739999999000
}
```

**Channel parameters:**
- `id`: UUID for this channel. Max 64 chars. Echoed back in `X-Goog-Channel-Id` header of each notification.
- `type`: Must be `"web_hook"`
- `address`: Your HTTPS endpoint. Must have a valid, non-self-signed TLS cert.
- `token`: Arbitrary verification string. Max 256 chars. Echoed in `X-Goog-Channel-Token` header.
- `expiration`: Optional Unix timestamp in milliseconds. Max: 604800 seconds (7 days) from now for `changes`, 86400 (1 day) for `files`. Default: 3600 seconds.

### 6.4 Notification message format

Each notification arrives as an HTTP POST to your webhook URL with these headers (no body):

```
X-Goog-Channel-Id: unique-channel-id-uuid
X-Goog-Channel-Token: custom-verification-token
X-Goog-Channel-Expiration: Mon, 01 Jan 2027 00:00:00 GMT
X-Goog-Resource-Id: o3hgv1538sdjfh
X-Goog-Resource-Uri: https://www.googleapis.com/drive/v3/changes
X-Goog-Resource-State: change   (or "sync" for the first confirmation message)
X-Goog-Changed: content,properties (or "parents,children,permissions")
```

**The notification does NOT include what changed** — it's a signal to poll `changes.list`.

Your webhook handler:
1. Returns HTTP 200 immediately
2. Verifies `X-Goog-Channel-Token` matches what you stored
3. Triggers an async `fetchChangesSince()` call

### 6.5 TypeScript webhook handler (Express)

```typescript
import express from 'express';

const app = express();

app.post('/webhooks/drive', (req, res) => {
  const channelId = req.headers['x-goog-channel-id'] as string;
  const token = req.headers['x-goog-channel-token'] as string;
  const state = req.headers['x-goog-resource-state'] as string;
  const expiration = req.headers['x-goog-channel-expiration'] as string;

  // Always respond 200 immediately
  res.sendStatus(200);

  // Ignore the initial sync confirmation message
  if (state === 'sync') return;

  // Verify the token matches what we registered
  if (!verifyChannelToken(channelId, token)) {
    console.warn(`Invalid token for channel ${channelId}`);
    return;
  }

  // Check if channel is about to expire (within 24 hours)
  const expiryMs = new Date(expiration).getTime();
  if (expiryMs - Date.now() < 24 * 60 * 60 * 1000) {
    scheduleChannelRenewal(channelId);
  }

  // Trigger async incremental sync
  triggerSync(channelId).catch(err => {
    console.error('Sync error after push notification:', err);
  });
});
```

### 6.6 Channel renewal

Channels must be renewed before they expire. The pattern:

1. When you receive a notification with an `X-Goog-Channel-Expiration` header within 24 hours, schedule renewal
2. Register a new channel (new `id`, same `address` and `token`)
3. Stop the old channel via `channels.stop`:

```typescript
async function stopChannel(
  drive: drive_v3.Drive,
  channelId: string,
  resourceId: string
): Promise<void> {
  await drive.channels.stop({
    requestBody: {
      id: channelId,
      resourceId,
    },
  });
}
```

**Run two channels briefly in overlap** during renewal to avoid missing notifications.

### 6.7 Domain verification requirement

Your webhook `address` domain must be verified in Google Search Console or Google Cloud Console for your Google Cloud project. Self-hosted services on custom domains need this verification. This is a meaningful operational hurdle.

---

## 7. Permissions API: reading effective access

Sources:
- https://developers.google.com/workspace/drive/api/guides/ref-roles
- https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions

### 7.1 Permission resource schema

```typescript
interface Permission {
  kind: 'drive#permission';
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader';
  emailAddress?: string;         // for type=user or type=group
  domain?: string;               // for type=domain
  displayName?: string;
  allowFileDiscovery?: boolean;  // for type=domain or type=anyone
  deleted?: boolean;             // true if user/group was deleted
  pendingOwner?: boolean;
  permissionDetails?: PermissionDetail[]; // for shared drive files — see below
  expirationTime?: string;       // RFC3339, optional expiry
}

interface PermissionDetail {
  permissionType: 'file' | 'member' | 'inherited';
  role: string;
  inheritedFrom?: string;        // ID of the folder permissions are inherited from
  inherited?: boolean;
}
```

### 7.2 Roles hierarchy

| Role | My Drive | Shared Drives | Capabilities |
|------|----------|---------------|--------------|
| `owner` | Yes | No (not used in shared drives) | Full control including deletion |
| `organizer` | No | Yes | Full control of shared drive membership + content |
| `fileOrganizer` | No | Yes | Move/trash files, cannot manage membership |
| `writer` | Yes | Yes | Edit files, share within drive |
| `commenter` | Yes | Yes | Add comments, view file |
| `reader` | Yes | Yes | View file only |

### 7.3 Listing permissions for a file

```typescript
async function getFilePermissions(
  drive: drive_v3.Drive,
  fileId: string,
  supportsAllDrives = true
): Promise<drive_v3.Schema$Permission[]> {
  const permissions: drive_v3.Schema$Permission[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.permissions.list({
      fileId,
      supportsAllDrives,
      fields: 'nextPageToken, permissions(id, type, role, emailAddress, domain, displayName, deleted, permissionDetails, expirationTime)',
      pageToken,
    });

    if (response.data.permissions) {
      permissions.push(...response.data.permissions);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return permissions;
}
```

### 7.4 Effective permissions: the critical subtlety

**Drive does NOT expose a single "can user X read this file?" API.** You must infer effective access from the combination of:

1. **Direct permissions** on the file
2. **Inherited permissions** from parent folders (for My Drive files)
3. **Shared drive membership** (for shared drive files) — membership role provides access to ALL files within the drive
4. **Domain-wide access** (permissions with `type=domain` or `type=anyone`)

For shared drive files, the `permissionDetails` array is essential:
- `permissionType: 'member'` = user is a shared drive member with this role
- `permissionType: 'file'` = user was directly granted access to this specific file
- `permissionType: 'inherited'` = permission inherited from a parent folder

### 7.5 ACL enforcement strategy for our connector

For a connector that needs to enforce "user X can only see files they have access to":

**Approach A — Per-user context (recommended for Phase 1):**
- Authenticate each API call as the user (via OAuth or DWD impersonation)
- Call `files.list` as that user — Google automatically scopes results to what they can see
- No explicit ACL checking needed — Drive enforces it

**Approach B — Service account index with ACL metadata (Phase 2 enterprise):**
1. Crawl all files as a DWD service account with admin-level access
2. For each file, store `permissions.list` result in your index
3. At query time, filter results to files where the requesting user's email appears in the permissions (directly, via group, domain, or `anyone`)

**Problem with Approach B:** Groups. A user might have access via a Google Group, but `permissions.list` returns the group email, not individual members. You'd need to call the Google Admin Directory API to enumerate group members — a significant additional complexity and scope requirement.

**Practical recommendation:** For Phase 2, use Approach A with DWD impersonation per user, not a single-index approach. This avoids the group membership enumeration problem entirely.

### 7.6 "anyoneWithLink" files

Files shared with `type=anyone` and `role=reader` are accessible to anyone with the link — including your connector service account. When indexing, treat these as public but tag them accordingly. In ACL enforcement, they should be visible to all users of the connector.

---

## 8. Shared drives: drives.list, driveId, membership model

Sources:
- https://developers.google.com/workspace/drive/api/guides/about-shareddrives
- https://developers.google.com/workspace/drive/api/guides/shared-drives-diffs

### 8.1 Shared drive fundamentals

A **shared drive** (formerly "Team Drive") is an organisational storage space where:
- Files are owned by the **organisation**, not an individual
- All members have access to **all files** in the drive based on their role
- Files can only exist in one location (no multi-parenting)
- Permissions are **strictly expansive** — you cannot reduce access further down the hierarchy, only increase it

### 8.2 Differences from My Drive

| Aspect | My Drive | Shared Drive |
|--------|----------|--------------|
| File ownership | Individual user | Organisation |
| `owner` role | Yes | No (not supported) |
| Multi-parent files | Supported | Not supported |
| Permission propagation | Expansive and restrictive | Strictly expansive only |
| File can be removed by member | Only by owner | By `fileOrganizer` or `organizer` |
| Service account can own files | Yes | No (cannot own files in shared drive) |
| Files removed when member leaves | No | No (files stay in shared drive) |

### 8.3 Listing shared drives

```typescript
async function listSharedDrives(
  drive: drive_v3.Drive
): Promise<drive_v3.Schema$Drive[]> {
  const drives: drive_v3.Schema$Drive[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.drives.list({
      pageSize: 100,
      pageToken,
      fields: 'nextPageToken, drives(id, name, kind, capabilities)',
    });

    if (response.data.drives) {
      drives.push(...response.data.drives);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return drives;
}
```

### 8.4 Listing files in a shared drive

When working with shared drives, you **must** pass `supportsAllDrives: true` and `includeItemsFromAllDrives: true` on most methods, or shared drive content is silently excluded:

```typescript
const response = await drive.files.list({
  corpora: 'drive',
  driveId: 'SHARED_DRIVE_ID',
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  q: 'trashed = false',
  fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
});
```

### 8.5 Shared drive file schema differences

| Field | My Drive | Shared Drive |
|-------|----------|--------------|
| `owners` | Present | Absent (no individual owner) |
| `driveId` | Absent | Present — ID of the containing shared drive |
| `teamDriveId` | Absent | Present (deprecated alias for `driveId`) |
| `capabilities.canMoveItemOutOfDrive` | Varies | `false` typically |
| `permissionDetails` | Absent | Present on permissions |

**Always check for `driveId` presence to identify shared drive files.**

### 8.6 Connector implementation: handling both types

```typescript
function isSharedDriveFile(file: drive_v3.Schema$File): boolean {
  return !!file.driveId;
}

async function crawlEntireCorpus(
  drive: drive_v3.Drive
): Promise<drive_v3.Schema$File[]> {
  // First get My Drive files
  const myDriveFiles = await listAllFiles(
    drive,
    'trashed = false',
    // corpora defaults to user
  );

  // Then get files from each shared drive
  const sharedDrives = await listSharedDrives(drive);
  const sharedDriveFiles: drive_v3.Schema$File[] = [];

  for (const sharedDrive of sharedDrives) {
    const files = await listAllFilesInSharedDrive(drive, sharedDrive.id!);
    sharedDriveFiles.push(...files);
  }

  return [...myDriveFiles, ...sharedDriveFiles];
}

async function listAllFilesInSharedDrive(
  drive: drive_v3.Drive,
  driveId: string
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      corpora: 'drive',
      driveId,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: 'trashed = false',
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, driveId)',
    });

    if (response.data.files) {
      files.push(...response.data.files);
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}
```

---

## 9. MIME types: Google Workspace vs blob vs shortcuts

Sources: https://developers.google.com/workspace/drive/api/reference/rest/v3/files

### 9.1 Google Workspace MIME types

These are files stored natively in Google's format — they have no `size` in bytes and cannot be downloaded with `alt=media`:

| MIME type | File type |
|-----------|-----------|
| `application/vnd.google-apps.document` | Google Docs |
| `application/vnd.google-apps.spreadsheet` | Google Sheets |
| `application/vnd.google-apps.presentation` | Google Slides |
| `application/vnd.google-apps.form` | Google Forms |
| `application/vnd.google-apps.drawing` | Google Drawings |
| `application/vnd.google-apps.site` | Google Sites |
| `application/vnd.google-apps.script` | Google Apps Script |
| `application/vnd.google-apps.map` | Google My Maps |
| `application/vnd.google-apps.vid` | Google Vids |
| `application/vnd.google-apps.folder` | Folder |
| `application/vnd.google-apps.shortcut` | Drive shortcut |
| `application/vnd.google-apps.drive-sdk` | Third-party app file |

### 9.2 Blob files (uploaded content)

Any file uploaded to Drive that is NOT a Google Workspace file. These are stored in their original format and downloaded via `files.get?alt=media`. Examples:
- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx)
- `text/plain`
- `image/jpeg`
- etc.

**Key difference:** Blob files have a `size` field; Google Workspace files do not (or show `0`).

### 9.3 Shortcuts

MIME type: `application/vnd.google-apps.shortcut`

Shortcuts point to files in other locations (including files in other shared drives). They have a `shortcutDetails` field:

```typescript
interface ShortcutDetails {
  targetId: string;       // The ID of the target file
  targetMimeType: string; // The MIME type of the target file
  targetResourceKey?: string; // Resource key for link-shared targets
}
```

**When crawling, skip shortcuts** (they would cause you to index the same file twice). When you encounter a shortcut, the target is indexed via its actual location.

### 9.4 Decision tree for content extraction

```
Is mimeType a Google Workspace type?
├── Yes, is it a folder or shortcut?
│   └── Skip — no content to extract
├── Yes, is it a document/sheet/presentation/drawing?
│   └── Use files.export with appropriate MIME type
└── No — it's a blob file
    ├── Is it a text/* type? → files.get?alt=media
    ├── Is it application/pdf? → Use pdf extractor
    └── Otherwise → Skip (binary, no text extraction)
```

```typescript
type ContentStrategy = 'workspace-export' | 'text-download' | 'pdf-extract' | 'skip';

function getContentStrategy(mimeType: string): ContentStrategy {
  if (mimeType === 'application/vnd.google-apps.folder' ||
      mimeType === 'application/vnd.google-apps.shortcut' ||
      mimeType === 'application/vnd.google-apps.drive-sdk') {
    return 'skip';
  }

  if (mimeType.startsWith('application/vnd.google-apps.')) {
    // Check if it's exportable
    const exportable = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.drawing',
    ];
    return exportable.includes(mimeType) ? 'workspace-export' : 'skip';
  }

  if (mimeType === 'application/pdf') return 'pdf-extract';

  if (mimeType.startsWith('text/')) return 'text-download';

  // Common text-ish blob types
  const textBlobs = ['application/json', 'application/xml', 'application/javascript'];
  if (textBlobs.includes(mimeType)) return 'text-download';

  return 'skip';
}
```

---

## 10. Rate limits and quotas

Sources:
- https://developers.google.com/workspace/drive/api/guides/limits
- https://primrose.dev/mcp/googledrive/limits (community documentation)

### 10.1 Default quota values

| Quota | Default limit |
|-------|---------------|
| Queries per day (per project) | 1,000,000,000 (1 billion) |
| Queries per minute (per user) | 1,000 |
| Queries per minute (per project) | ~12,000 |
| Export requests per day | Subject to per-user quotas |

**These are the project-level defaults.** In practice, per-user limits are the binding constraint.

### 10.2 Rate limit error responses

When you exceed a quota, the API returns:
- `HTTP 429 Too Many Requests` — transient rate limit
- `HTTP 403` with `reason: 'userRateLimitExceeded'` or `reason: 'rateLimitExceeded'`

### 10.3 Exponential backoff implementation

**Always implement exponential backoff with jitter.** Google strongly recommends it and the googleapis library does NOT do it automatically:

```typescript
interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 5, initialDelayMs = 500, maxDelayMs = 32000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit = 
        err?.response?.status === 429 ||
        (err?.response?.status === 403 &&
         err?.response?.data?.error?.errors?.some(
           (e: any) => e.reason === 'rateLimitExceeded' || 
                       e.reason === 'userRateLimitExceeded'
         ));

      if (!isRateLimit || attempt === maxRetries) throw err;

      const jitter = Math.random() * 1000;
      const delay = Math.min(initialDelayMs * Math.pow(2, attempt) + jitter, maxDelayMs);
      
      console.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Max retries exceeded');
}

// Usage:
const files = await withRetry(() => drive.files.list({ ... }));
```

### 10.4 Batching requests

The Drive API supports batch requests (multiple API calls in a single HTTP request) to reduce per-call overhead. For the `googleapis` Node.js client:

```typescript
// Note: batch is not well-supported in the googleapis Node.js client v8+
// Use manual batching with Promise.all and concurrency limiting instead

import pLimit from 'p-limit';

const limit = pLimit(5); // max 5 concurrent requests

const fileContents = await Promise.all(
  fileIds.map(fileId => 
    limit(() => withRetry(() => getFileContent(drive, fileId)))
  )
);
```

### 10.5 Quota strategies for large-scale indexing

For indexing a large organisation's Drive:

1. **Use `fields` masks aggressively** — every field you don't request is bandwidth and quota you don't spend
2. **Do not request permissions on every file** — fetch permissions only for files that need ACL checking. A file's `permissions` being embedded in `files.list` is convenient but expensive.
3. **Use `changes.list` instead of re-crawling** after initial index — changes API is far more efficient
4. **Spread export calls over time** — export calls (for Docs/Sheets/Slides content) count more heavily than metadata calls
5. **Per-user quota distribution** — when using DWD impersonation across many users, the per-user quota is 1,000 qpm per user. Distribute load by rotating through users.
6. **Request quota increase** from Google Cloud Console if needed for production-scale usage

---

## 11. Google's own MCP server: competitive analysis

Sources:
- https://developers.google.com/workspace/drive/api/guides/configure-mcp-server (last updated 2026)
- https://cloud.google.com/blog/products/ai-machine-learning/announcing-official-mcp-support-for-google-services

### 11.1 What Google has built

Google has launched an **official remote MCP server for Google Drive** at:
```
https://drivemcp.googleapis.com/mcp/v1
```

**How it works:**
- Remote MCP server — runs on Google's infrastructure, not self-hosted
- Uses OAuth 2.0 (user must authenticate with their Google Account)
- Available as "Developer Preview" as of mid-2026
- Works with Claude (Enterprise/Pro/Max/Team plan required), Google Antigravity CLI, and other MCP clients
- Requires enabling `drivemcp.googleapis.com` API in a Google Cloud project

**Enable command:**
```bash
gcloud services enable drivemcp.googleapis.com --project=PROJECT_ID
```

**Scopes required:**
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

### 11.2 Tools exposed by Google's Drive MCP server

| MCP Tool | Description |
|----------|-------------|
| `copy_file` | Copy a file |
| `create_file` | Create a new file |
| `download_file_content` | Download file content |
| `get_file_metadata` | Get metadata for a file |
| `get_file_permissions` | Get permissions for a file |
| `list_recent_files` | List recently modified files |
| `read_file_content` | Read the content of a file |
| `search_files` | Search files by query |

### 11.3 How our connector competes

| Feature | Google's Drive MCP | markdown-for-agents-mcp connector |
|---------|-------------------|----------------------------------|
| Hosting | Google-hosted (cloud) | Self-hosted |
| Data governance | Google holds your tokens | Your infrastructure, your data |
| Compliance | Standard Google ToS | Enterprise-deployable, air-gapped possible |
| Multi-tenant indexing | Per-user auth only | DWD service account + enterprise index |
| Full-text search | Via Drive API search | Local index with semantic search (Phase 2) |
| Cross-source search | Drive only | Drive + SharePoint + Confluence (unified) |
| Change tracking | Not indexed | Incremental sync, local index |
| Offline/cached content | No | Yes — cached index |
| ACL enforcement model | Live per-call | Cached ACL with per-user filter at query time |
| License | Google proprietary | MIT |
| Cost | Usage-based (Google API quotas) | Infrastructure cost only |
| Claude plan requirement | Enterprise/Pro/Max/Team | Any |

**Our key differentiators:**
1. **Self-hosted** — critical for regulated industries (banking, healthcare, government)
2. **Cross-source unified search** — Drive + SharePoint in one query
3. **Semantic search** — vector embeddings beyond keyword search
4. **Enterprise index** — batch-indexed content is faster than live Drive API calls for every query
5. **No Google Cloud project required** for end users

### 11.4 Workspace Events API (alternative to push notifications)

Google also offers a **Workspace Events API** (`workspace.googleapis.com`) as a higher-level event bus over Drive changes. It supports subscribing to events via Google Cloud Pub/Sub rather than direct webhooks. This is more cloud-native but requires Google Cloud infrastructure. Reference: `https://developers.google.com/workspace/events`

For self-hosted connectors, the Drive push notifications (`changes.watch`) remain the simplest approach without requiring Google Cloud Pub/Sub.

---

## 12. Complete TypeScript connector implementation

This is the reference implementation pattern. In production, split into separate files.

### 12.1 Types

```typescript
// src/connectors/google-drive/types.ts

export interface GoogleDriveConfig {
  serviceAccountKeyPath?: string;
  serviceAccountCredentials?: {
    client_email: string;
    private_key: string;
    project_id: string;
  };
  impersonateEmail: string;          // User to impersonate via DWD
  indexSharedDrives: boolean;
  exportFormat: 'text' | 'html';    // For Workspace files
  maxFileSizeBytes: number;          // Skip files larger than this
}

export interface IndexedDocument {
  id: string;
  name: string;
  mimeType: string;
  content: string;
  modifiedTime: string;
  webViewLink?: string;
  parents: string[];
  driveId?: string;
  owners: string[];
  permissions: EffectivePermission[];
  indexedAt: Date;
}

export interface EffectivePermission {
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader';
  emailAddress?: string;
  domain?: string;
}

export interface SyncState {
  userPageToken: string;            // Changes token for user's My Drive
  sharedDriveTokens: Record<string, string>; // driveId -> token
  lastFullCrawlTime: string;
  lastIncrementalSyncTime: string;
}
```

### 12.2 Auth module

```typescript
// src/connectors/google-drive/auth.ts

import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { GoogleDriveConfig } from './types.js';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
];

export function createDriveClient(
  config: GoogleDriveConfig
): drive_v3.Drive {
  let auth: InstanceType<typeof google.auth.JWT>;

  if (config.serviceAccountCredentials) {
    auth = new google.auth.JWT({
      email: config.serviceAccountCredentials.client_email,
      key: config.serviceAccountCredentials.private_key,
      scopes: SCOPES,
      subject: config.impersonateEmail,
    });
  } else if (config.serviceAccountKeyPath) {
    // GoogleAuth will read the key file and set up JWT automatically
    const googleAuth = new google.auth.GoogleAuth({
      keyFile: config.serviceAccountKeyPath,
      scopes: SCOPES,
      clientOptions: {
        subject: config.impersonateEmail,
      },
    });
    // Note: GoogleAuth returns a wrapper; for JWT we need the underlying client
    // for explicit subject setting. Use JWT directly for DWD.
    throw new Error('Use serviceAccountCredentials for DWD; load key file manually');
  } else {
    throw new Error('Must provide serviceAccountCredentials or serviceAccountKeyPath');
  }

  return google.drive({ version: 'v3', auth });
}
```

### 12.3 Crawler module

```typescript
// src/connectors/google-drive/crawler.ts

import type { drive_v3 } from 'googleapis';
import type { GoogleDriveConfig, IndexedDocument, SyncState } from './types.js';

const INDEXABLE_WORKSPACE_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

const SKIP_TYPES = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.drive-sdk',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.vid',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.form',
]);

const FILE_FIELDS = [
  'id', 'name', 'mimeType', 'modifiedTime', 'size',
  'parents', 'driveId', 'trashed', 'owners',
  'webViewLink', 'capabilities/canDownload',
].join(', ');

export class GoogleDriveCrawler {
  private drive: drive_v3.Drive;
  private config: GoogleDriveConfig;

  constructor(drive: drive_v3.Drive, config: GoogleDriveConfig) {
    this.drive = drive;
    this.config = config;
  }

  async fullCrawl(): Promise<IndexedDocument[]> {
    const allFiles: drive_v3.Schema$File[] = [];

    // Crawl My Drive
    const myDriveFiles = await this.listFiles('user', undefined);
    allFiles.push(...myDriveFiles);

    // Crawl Shared Drives
    if (this.config.indexSharedDrives) {
      const sharedDrives = await this.listSharedDrives();
      for (const drive of sharedDrives) {
        const driveFiles = await this.listFiles('drive', drive.id!);
        allFiles.push(...driveFiles);
      }
    }

    // Export content and build index documents
    const documents: IndexedDocument[] = [];
    for (const file of allFiles) {
      const doc = await this.processFile(file);
      if (doc) documents.push(doc);
    }

    return documents;
  }

  async incrementalSync(
    syncState: SyncState
  ): Promise<{
    updated: IndexedDocument[];
    deleted: string[];
    newSyncState: SyncState;
  }> {
    const { changes, newStartPageToken } = await this.fetchChangesSince(
      syncState.userPageToken
    );

    const updated: IndexedDocument[] = [];
    const deleted: string[] = [];

    for (const change of changes) {
      if (change.removed || change.file?.trashed) {
        deleted.push(change.fileId!);
        continue;
      }

      if (change.file) {
        const doc = await this.processFile(change.file);
        if (doc) updated.push(doc);
      }
    }

    return {
      updated,
      deleted,
      newSyncState: {
        ...syncState,
        userPageToken: newStartPageToken,
        lastIncrementalSyncTime: new Date().toISOString(),
      },
    };
  }

  private async processFile(
    file: drive_v3.Schema$File
  ): Promise<IndexedDocument | null> {
    const mimeType = file.mimeType ?? '';

    if (SKIP_TYPES.has(mimeType)) return null;
    if (file.trashed) return null;

    // Check size limit for blob files
    if (file.size && parseInt(file.size) > this.config.maxFileSizeBytes) {
      return null;
    }

    let content: string | null = null;

    try {
      content = await this.extractContent(file);
    } catch (err: any) {
      console.warn(`Failed to extract content for ${file.id} (${file.name}):`, err.message);
      return null;
    }

    if (content === null) return null;

    // Get permissions
    const permissions = await this.getFilePermissions(file.id!);

    return {
      id: file.id!,
      name: file.name ?? '',
      mimeType,
      content: content.slice(0, 100_000), // Truncate to 100KB for index
      modifiedTime: file.modifiedTime ?? new Date().toISOString(),
      webViewLink: file.webViewLink,
      parents: file.parents ?? [],
      driveId: file.driveId,
      owners: file.owners?.map(o => o.emailAddress ?? '') ?? [],
      permissions,
      indexedAt: new Date(),
    };
  }

  private async extractContent(
    file: drive_v3.Schema$File
  ): Promise<string | null> {
    const mimeType = file.mimeType ?? '';

    const exportMime = INDEXABLE_WORKSPACE_TYPES[mimeType];
    if (exportMime) {
      return await this.withRetry(async () => {
        const response = await this.drive.files.export(
          { fileId: file.id!, mimeType: exportMime },
          { responseType: 'text' }
        );
        return response.data as string;
      });
    }

    if (mimeType.startsWith('text/') ||
        ['application/json', 'application/xml'].includes(mimeType)) {
      return await this.withRetry(async () => {
        const response = await this.drive.files.get(
          { fileId: file.id!, alt: 'media' },
          { responseType: 'text' }
        );
        return response.data as string;
      });
    }

    return null;
  }

  private async listFiles(
    corpora: 'user' | 'drive',
    driveId?: string
  ): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.withRetry(() =>
        this.drive.files.list({
          corpora,
          driveId,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          q: 'trashed = false',
          pageSize: 1000,
          pageToken,
          fields: `nextPageToken, files(${FILE_FIELDS})`,
        })
      );

      files.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return files;
  }

  private async listSharedDrives(): Promise<drive_v3.Schema$Drive[]> {
    const drives: drive_v3.Schema$Drive[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.withRetry(() =>
        this.drive.drives.list({
          pageSize: 100,
          pageToken,
          fields: 'nextPageToken, drives(id, name)',
        })
      );

      drives.push(...(response.data.drives ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return drives;
  }

  private async getFilePermissions(
    fileId: string
  ): Promise<EffectivePermission[]> {
    try {
      const response = await this.withRetry(() =>
        this.drive.permissions.list({
          fileId,
          supportsAllDrives: true,
          fields: 'permissions(id, type, role, emailAddress, domain, deleted)',
        })
      );

      return (response.data.permissions ?? [])
        .filter(p => !p.deleted)
        .map(p => ({
          type: p.type as any,
          role: p.role as any,
          emailAddress: p.emailAddress,
          domain: p.domain,
        }));
    } catch (err: any) {
      // 403 on permissions.list means the impersonated user can't see permissions
      // (e.g., they're only a reader). Return empty — ACL filter will handle it
      if (err?.response?.status === 403) return [];
      throw err;
    }
  }

  private async fetchChangesSince(pageToken: string): Promise<{
    changes: drive_v3.Schema$Change[];
    newStartPageToken: string;
  }> {
    const changes: drive_v3.Schema$Change[] = [];
    let currentToken = pageToken;
    let newStartPageToken = pageToken;

    while (true) {
      const response = await this.withRetry(() =>
        this.drive.changes.list({
          pageToken: currentToken,
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          includeRemoved: true,
          fields: 'nextPageToken, newStartPageToken, changes(kind, type, removed, fileId, file(id, name, mimeType, modifiedTime, trashed, parents, driveId))',
          pageSize: 1000,
        })
      );

      changes.push(...(response.data.changes ?? []));

      if (response.data.newStartPageToken) {
        newStartPageToken = response.data.newStartPageToken;
      }

      if (!response.data.nextPageToken) break;
      currentToken = response.data.nextPageToken;
    }

    return { changes, newStartPageToken };
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.response?.status;
        const reason = err?.response?.data?.error?.errors?.[0]?.reason;
        const isRateLimit =
          status === 429 ||
          (status === 403 &&
            ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));

        if (!isRateLimit || attempt === maxRetries) throw err;

        const jitter = Math.random() * 1000;
        const delay = Math.min(500 * Math.pow(2, attempt) + jitter, 32000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }
}
```

### 12.4 MCP tool wrappers

```typescript
// src/connectors/google-drive/mcp-tools.ts

import type { GoogleDriveCrawler } from './crawler.js';
import type { drive_v3 } from 'googleapis';

/**
 * MCP tool: search Drive files for the authenticated user.
 */
export async function searchDriveFiles(
  drive: drive_v3.Drive,
  query: string,
  options: {
    corpora?: 'user' | 'allDrives';
    maxResults?: number;
  } = {}
): Promise<{ files: Array<{ id: string; name: string; mimeType: string; webViewLink?: string }> }> {
  const response = await drive.files.list({
    q: `${query} and trashed = false`,
    corpora: options.corpora ?? 'user',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    pageSize: options.maxResults ?? 20,
  });

  return {
    files: (response.data.files ?? []).map(f => ({
      id: f.id!,
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      webViewLink: f.webViewLink ?? undefined,
    })),
  };
}

/**
 * MCP tool: read file content for a specific file.
 */
export async function readDriveFileContent(
  drive: drive_v3.Drive,
  fileId: string
): Promise<{ content: string; mimeType: string; name: string }> {
  // Get file metadata first
  const metaResponse = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: 'id, name, mimeType, size, capabilities/canDownload',
  });

  const file = metaResponse.data;
  const mimeType = file.mimeType ?? '';

  if (!file.capabilities?.canDownload) {
    throw new Error(`File ${fileId} cannot be downloaded (permissions or content restrictions)`);
  }

  // Determine export strategy
  const workspaceExportMime: Record<string, string> = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  let content: string;

  const exportMime = workspaceExportMime[mimeType];
  if (exportMime) {
    const exportResponse = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: 'text' }
    );
    content = exportResponse.data as string;
  } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    const downloadResponse = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );
    content = downloadResponse.data as string;
  } else {
    throw new Error(`MIME type ${mimeType} is not text-extractable`);
  }

  return {
    content,
    mimeType,
    name: file.name ?? fileId,
  };
}
```

### 12.5 package.json dependencies

```json
{
  "dependencies": {
    "googleapis": "^144.0.0",
    "google-auth-library": "^9.0.0",
    "p-limit": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## 13. Failure modes, gotchas, and edge cases

### 13.1 Authentication failures

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Unauthorized` | Token expired or invalid | Ensure GoogleAuth object is reused (it refreshes); check system clock skew |
| `403 forbidden` on DWD call | DWD not configured or propagation pending | Wait up to 24h; verify client ID is numeric, not the email |
| `403 insufficientPermissions` | Wrong scope | Ensure `drive.readonly` scope is in DWD grant |
| `400 bad request: subject` | `subject` email not in domain | Only users in the Workspace domain can be impersonated |

### 13.2 changes.list stale token

When the pageToken stored for `changes.list` becomes too old (typically weeks to months), the API returns:
```
HTTP 410 Gone
{"error": {"code": 410, "message": "The specified changeToken is expired."}}
```

**Handle this case explicitly:**
```typescript
try {
  const { changes, newStartPageToken } = await fetchChangesSince(savedToken);
  // process...
} catch (err: any) {
  if (err?.response?.status === 410) {
    // Token expired — trigger full re-crawl
    const newToken = await getStartPageToken(drive);
    await fullCrawl();
    saveSyncState({ pageToken: newToken });
  } else {
    throw err;
  }
}
```

### 13.3 Export size limit exceeded

```
HTTP 403 { "reason": "exportSizeLimitExceeded" }
```

Files larger than ~10MB cannot be exported as text. Options:
1. Skip and log
2. Export as PDF and use a secondary PDF extractor (adds latency and dependency)
3. Export as HTML (sometimes succeeds when text fails for slightly oversized files)

### 13.4 Drive files with multiple parents (deprecated)

Prior to 2021, Drive files could have multiple parent folders. This is no longer allowed for new files, but legacy files may still have multiple parents. Your crawler should handle this gracefully (the `parents` array can still have multiple entries for old files).

### 13.5 Orphaned files

Files in Drive can become "orphaned" — they appear in `files.list` but have no `parents`. This happens when a file's parent folder was deleted but the file was kept. An orphaned file is still accessible directly by ID. When building a file tree, handle `parents: []` gracefully.

### 13.6 Shared drive membership vs file permissions

When a user is a **member** of a shared drive, the `permissions.list` call for files within that drive shows `permissionType: 'member'` entries, not explicit file permissions. A user without an explicit file permission may still have access if they are a drive member. When checking "can user X see file Y?":

1. Check if the file is in a shared drive (`driveId` present)
2. If so, check shared drive membership (requires a separate `drives.get` call)
3. Only rely on file permissions for My Drive files

### 13.7 Resource keys for link-shared files

Files shared via "anyone with the link" in certain workspace configurations require a `resourceKey` parameter when accessing them programmatically. The `resourceKey` is part of the shared link URL. The API will return a `404` for these files without the key, even if you theoretically have access.

For connector purposes, skip files with `capabilities.canDownload = false` to avoid this problem.

### 13.8 Google Vids files

`application/vnd.google-apps.vid` (Google Vids) cannot be exported via the standard `files.export` method. They require the `files.download` long-running operation. For a text indexing connector, skip this type.

### 13.9 Service account storage quota

Service accounts have **no storage quota** and cannot own files. If your connector attempts to create or copy files (for any reason), those operations must be done under a human user context. For read-only indexing, this is irrelevant but worth knowing if you ever add write operations.

### 13.10 Workspace domain policies vs service accounts

Domain-wide delegation service accounts are **not subject to domain sharing policies**. A policy restricting users from sharing files outside the domain does NOT apply to your service account. This is a security feature (not a bug) for internal connectors, but ensure your security review accounts for it.

### 13.11 Notification channel domain verification

Your webhook endpoint domain must be registered in Google Cloud Console (verified domain). Attempts to register a watch channel with an unverified domain return:
```
HTTP 400 { "reason": "forbidden" }
```

During development, use ngrok or a similar tunnel to expose a local server with a verified-domain-proxied URL.

---

## 14. Build recommendations

### 14.1 What to build first (Phase 1 — per-user OAuth)

Build the simplest working connector first:

1. **OAuth 2.0 per-user auth** — user authenticates once; connector stores refresh token
2. **`files.list` with `q` parameter** — expose as an MCP search tool
3. **`files.export` / `files.get`** — expose as an MCP read-file tool
4. **Minimal caching** — cache exported content for 15 minutes to avoid re-exporting on repeated reads

**Skip for Phase 1:** DWD, incremental sync, push notifications, shared drive enumeration

### 14.2 What to build for Phase 2 (enterprise service account)

1. **Service account + DWD auth** with per-user impersonation
2. **Full crawl** on first run: enumerate My Drive + shared drives, export text content, store in local index
3. **Incremental sync** using `changes.list` on a timer (every 5–60 minutes)
4. **ACL enforcement** at query time using impersonation (simplest) or cached permissions (complex but faster)
5. **`p-limit` concurrency control** to stay within rate limits
6. **Exponential backoff** on all API calls

### 14.3 What to skip

| Feature | Reason to skip |
|---------|---------------|
| Push notifications / watch channels | Polling `changes.list` every few minutes is sufficient; webhooks add TLS cert management and domain verification complexity |
| Group membership enumeration for ACLs | Requires Admin Directory API scope — significant additional privilege. Use per-user impersonation instead. |
| PDF text extraction | Adds binary dependency (pdf-parse or similar). Index metadata + filename; skip body content for PDFs. |
| Google Forms content | Not exportable via standard API |
| Google Sites content | Limited export support |
| Google Vids | Requires long-running operations, no text content |
| Multi-sheet CSV export | Complex; export as HTML and strip tags instead |

### 14.4 Security checklist

- [ ] Store service account key in a secrets manager (not in env files or git)
- [ ] Use the most restrictive scope that meets your needs (`drive.readonly` not `drive`)
- [ ] Document that DWD grants full domain read access — require explicit admin approval
- [ ] Sanitise and truncate exported content before storage (XSS not a concern for MCP but length limits are)
- [ ] Never log access tokens or service account private keys
- [ ] Implement audit logging: who searched for what, when
- [ ] Consider separate service accounts per connector deployment to limit blast radius

### 14.5 Comparison with SharePoint connector

Our SharePoint connector (see `sharepoint-graph.md`) uses the Microsoft Graph API with transitiveMemberOf for group-aware ACL enforcement. Google Drive lacks an equivalent single-call "what groups is this user in" API from the Drive API itself — you'd need the Admin Directory API for that. This makes per-user impersonation the recommended ACL approach for Drive, whereas SharePoint is more amenable to a central service-account index with group ACL enforcement.

| Aspect | SharePoint (Graph API) | Google Drive (Drive API v3) |
|--------|----------------------|----------------------------|
| Auth for enterprise | App registration + client credentials | Service account + DWD |
| Group ACL enforcement | `transitiveMemberOf` in Graph | Needs Admin Directory API — use impersonation instead |
| Incremental sync | `delta` tokens on lists | `changes.list` page tokens |
| Content extraction | `/content` endpoint | `files.export` for Workspace types |
| Rate limits | 10k req/10min per app | 1k req/min per user |
| Native MCP server | No (as of 2026) | Yes (`drivemcp.googleapis.com`) |

---

*Document written 2026-08-26 based on Google Drive API v3 documentation and googleapis Node.js client library. All API behaviour verified against official documentation at developers.google.com/workspace/drive/api.*
