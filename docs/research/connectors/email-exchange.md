# Email / Exchange Connector Research

**Status:** Research complete — August 2026
**Scope:** Microsoft Graph Mail API, IMAP/Exchange, thread reconstruction, knowledge extraction for the markdown-for-agents-mcp knowledge index

---

## Table of Contents

1. [Decision: What to Build](#1-decision-what-to-build)
2. [Protocol Landscape](#2-protocol-landscape)
3. [Graph Mail API — Complete Reference](#3-graph-mail-api--complete-reference)
4. [Authentication and Permissions](#4-authentication-and-permissions)
5. [Shared Mailboxes and Scoped Access](#5-shared-mailboxes-and-scoped-access)
6. [Delta Sync — Incremental Indexing](#6-delta-sync--incremental-indexing)
7. [Message Schema — All Fields](#7-message-schema--all-fields)
8. [Attachments](#8-attachments)
9. [MIME Content Retrieval](#9-mime-content-retrieval)
10. [Thread Reconstruction via conversationId](#10-thread-reconstruction-via-conversationid)
11. [HTML to Markdown / Text Extraction](#11-html-to-markdown--text-extraction)
12. [IMAP Connector Path](#12-imap-connector-path)
13. [Rate Limits and Throttling](#13-rate-limits-and-throttling)
14. [Sensitivity Labels and Privacy Filtering](#14-sensitivity-labels-and-privacy-filtering)
15. [What NOT to Index](#15-what-not-to-index)
16. [Exchange Web Services (EWS) — Deprecated](#16-exchange-web-services-ews--deprecated)
17. [Complete TypeScript Connector Implementation](#17-complete-typescript-connector-implementation)
18. [Production Checklist](#18-production-checklist)

---

## 1. Decision: What to Build

**Build this order:**

| Priority | Component | Reason |
|----------|-----------|--------|
| P0 | Graph Mail connector (Exchange Online / M365) | 95%+ of enterprise target is M365; Graph is the only supported path post-2022 |
| P1 | Shared mailbox support (project@, support@) | High-value for knowledge indexing — shared mailboxes have the most organizational knowledge |
| P2 | Thread grouping via conversationId | Transforms per-message noise into coherent decision records |
| P3 | Attachment text extraction (PDF/DOCX/XLSX) | Deferred — use SharePoint connector for file knowledge; email attachments are secondary |
| P4 | IMAP connector | Fallback for non-M365 environments (Google Workspace, self-hosted Exchange on-prem) |

**Skip for now:**

- Exchange Web Services (EWS) — Microsoft is actively decommissioning it in Exchange Online
- EML/PST file import — niche use case; can be added as a separate ingestion script if needed
- Real-time webhook subscriptions for mail — adds operational complexity; scheduled delta sync is sufficient for a knowledge index

---

## 2. Protocol Landscape

### 2.1 Authentication Reality (Post-2022)

Basic authentication for ALL Exchange Online protocols was permanently disabled on December 31, 2022. This is irreversible — Microsoft support cannot re-enable it.

Sources:
- https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online

**Impact on connector design:**

| Protocol | Auth requirement | Status |
|----------|-----------------|--------|
| Microsoft Graph Mail API | OAuth 2.0 (MSAL / client credentials) | **Primary — use this** |
| IMAP (Exchange Online) | OAuth 2.0 via XOAUTH2 SASL | Supported but complex |
| EWS | OAuth 2.0 | Being decommissioned (see section 16) |
| SMTP AUTH | OAuth 2.0 | Microsoft announced deprecation; avoid for read |
| POP3 | OAuth 2.0 | Supported but ancient; ignore |

### 2.2 Protocol Comparison

| Dimension | Graph Mail API | IMAP + OAuth | EWS |
|-----------|---------------|-------------|-----|
| Auth | OAuth 2.0 client credentials | OAuth 2.0 XOAUTH2 | OAuth 2.0 |
| Format | JSON | IMAP protocol (raw MIME fetch) | SOAP/XML |
| Delta sync | Native delta links | CONDSTORE / QRESYNC extensions | SyncFolderItems |
| Rate limits | 10K req/10min per mailbox | Server-dependent | EWS-specific limits |
| Shared mailbox | /users/{address}/messages | IMAP AUTHENTICATE with shared UPN | Impersonation |
| Deprecation | None — this is the future | IMAP itself not deprecated; auth methods were | Actively decommissioned |
| Library quality (Node.js) | `@microsoft/microsoft-graph-client` | `imapflow` (excellent) | None maintained |
| Recommendation | **Primary** | Fallback for non-M365 | Avoid |

---

## 3. Graph Mail API — Complete Reference

Source: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview

Base URL: `https://graph.microsoft.com/v1.0`

### 3.1 Core Endpoints

```
# All messages in user's mailbox (includes Deleted Items, Clutter)
GET /me/messages
GET /users/{id|userPrincipalName}/messages

# Messages in a specific folder
GET /me/mailFolders/{id}/messages
GET /users/{id|userPrincipalName}/mailFolders/{id}/messages

# Single message
GET /me/messages/{id}
GET /users/{id|userPrincipalName}/messages/{id}

# MIME content of a message
GET /me/messages/{id}/$value
GET /users/{id|userPrincipalName}/messages/{id}/$value

# List folders
GET /me/mailFolders
GET /users/{id|userPrincipalName}/mailFolders

# List child folders
GET /me/mailFolders/{id}/childFolders

# Delta sync (incremental changes)
GET /me/mailFolders/{id}/messages/delta
GET /users/{id|userPrincipalName}/mailFolders/{id}/messages/delta

# Attachments on a message
GET /me/messages/{id}/attachments
GET /users/{id|userPrincipalName}/messages/{id}/attachments
GET /users/{id|userPrincipalName}/messages/{id}/attachments/{attachmentId}
```

### 3.2 Well-Known Folder Names

Instead of looking up folder IDs, use these string aliases directly:

| Well-known name | Description |
|-----------------|-------------|
| `Inbox` | Primary inbox |
| `SentItems` | Sent items |
| `Drafts` | Draft messages |
| `DeletedItems` | Deleted items (soft delete) |
| `Archive` | Archive folder |
| `Clutter` | Clutter (low-priority inbox) |
| `JunkEmail` | Spam / junk email |
| `RecoverableItemsDeletions` | Permanently deleted (available briefly) |

Usage:
```
GET /users/{id}/mailFolders('Inbox')/messages
GET /users/{id}/mailFolders('SentItems')/messages
```

### 3.3 OData Query Parameters

```
$select    # Return only named fields — critical for performance
$filter    # Filter results (limited in delta queries)
$top       # Page size, 1-1000 (default 10)
$orderby   # Sort — use receivedDateTime desc
$search    # Full-text search (NOT supported in delta queries)
$expand    # Expand relationships (e.g., $expand=attachments)
$count     # Include count of items
```

**Important:** Current behavior returns message bodies in HTML format only for the list operation. To get text, either convert client-side or use `Prefer: outlook.body-content-type: text` header.

### 3.4 Performance Best Practices

```typescript
// Good — request only the fields you need
GET /users/{id}/messages?$select=id,subject,from,receivedDateTime,conversationId,bodyPreview,hasAttachments,importance,internetMessageId&$top=100

// Bad — fetches all fields including full HTML body for 100 messages
GET /users/{id}/messages?$top=100
```

Per Microsoft documentation: "Fine-tune the values for $select and $top, especially when you must use a larger page size, as returning a page with hundreds of messages each with a full response payload may trigger the gateway timeout (HTTP 504)."

---

## 4. Authentication and Permissions

### 4.1 App Registration Requirements

For a background knowledge index (no signed-in user), use **application permissions** (client credentials flow):

```
Tenant admin must grant (via admin consent):
  Mail.Read         — read all mailboxes (application permission)
  Mail.ReadBasic.All — lighter permission, no message body/attachments

Optional:
  MailboxSettings.Read  — for per-user settings/timezone
```

### 4.2 Permission Levels

| Permission | Scope | What it allows |
|------------|-------|---------------|
| `Mail.ReadBasic.All` | Application | Subject, sender, received date — no body, no attachments. Least-privilege. |
| `Mail.Read` | Application | Full message including body and attachments. Needed for knowledge extraction. |
| `Mail.ReadWrite` | Application | Read + write. Do NOT request unless writing back labels/flags. |
| `Mail.Read.Shared` | Delegated only | Access shared mailboxes as the signed-in user. |

### 4.3 Client Credentials Flow (Node.js / TypeScript)

```typescript
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!
);

const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  scopes: ["https://graph.microsoft.com/.default"],
});

const graphClient = Client.initWithMiddleware({ authProvider });

// Access any user's mailbox
const messages = await graphClient
  .api(`/users/${userEmail}/messages`)
  .select("id,subject,from,receivedDateTime,conversationId,bodyPreview")
  .top(50)
  .get();
```

---

## 5. Shared Mailboxes and Scoped Access

Sources:
- https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access
- https://learn.microsoft.com/en-us/answers/questions/1406369/access-shared-mailbox-via-graph-api

### 5.1 Accessing a Shared Mailbox

Shared mailboxes have a UPN/email address just like user mailboxes. With application permissions (`Mail.Read`), access them identically to user mailboxes:

```typescript
// Shared mailbox: same endpoint, use shared mailbox address
const messages = await graphClient
  .api(`/users/support@contoso.com/messages`)
  .select("id,subject,from,receivedDateTime,conversationId,bodyPreview")
  .top(50)
  .get();

// Or via Inbox folder specifically
const inboxMessages = await graphClient
  .api(`/users/support@contoso.com/mailFolders('Inbox')/messages`)
  .top(50)
  .get();
```

**Key difference from delegated permissions:** With application permissions, you do NOT need `Mail.Read.Shared` — that permission is delegated only. The application permission `Mail.Read` covers both user and shared mailboxes.

### 5.2 Scoping Application Permissions to Specific Mailboxes

**Problem:** By default, `Mail.Read` with application permissions gives the app access to ALL mailboxes in the tenant. This is overkill and a security risk.

**Solution: RBAC for Applications (replaces old ApplicationAccessPolicy)**

Microsoft introduced RBAC for Applications in Exchange Online (replaces the deprecated `New-ApplicationAccessPolicy`). This allows scoping an app to specific mailboxes.

```powershell
# Step 1: Connect to Exchange Online
Connect-ExchangeOnline

# Step 2: Create a service principal pointer to your Entra app
# AppId = Application (client) ID from Entra App Registration
# ObjectId = Enterprise Application Object ID (NOT App Registration Object ID)
New-ServicePrincipal `
  -AppId "your-app-client-id" `
  -ObjectId "your-enterprise-app-object-id" `
  -DisplayName "markdown-for-agents-mcp-connector"

# Step 3: Create a management scope (e.g., limit to specific department mailboxes)
New-ManagementScope `
  -Name "KnowledgeIndexMailboxes" `
  -RecipientRestrictionFilter "CustomAttribute1 -eq 'KnowledgeIndex'"

# Step 4: Create the role assignment scoped to those mailboxes
New-ManagementRoleAssignment `
  -App "your-enterprise-app-object-id" `
  -Role "Application Mail.Read" `
  -CustomResourceScope "KnowledgeIndexMailboxes"

# Test authorization
Test-ServicePrincipalAuthorization `
  -Identity "your-enterprise-app-object-id" `
  -Resource "targetmailbox@contoso.com"
```

**Important gotcha:** Permission changes are cached. Changes take effect:
- Apps with no recent API calls: cache cleared after 30 minutes
- Active apps: cache kept alive up to 2 hours

### 5.3 Alternative: Admin Unit Scoping

```powershell
# Scope by Microsoft Entra Administrative Unit (more flexible than custom attributes)
New-ManagementRoleAssignment `
  -App "your-enterprise-app-object-id" `
  -Role "Application Mail.Read" `
  -RecipientAdministrativeUnitScope "your-admin-unit-object-id"
```

### 5.4 Which Approach to Recommend

For the knowledge index connector:

- **For POC/onboarding:** Start with tenant-wide `Mail.Read` but document the risk clearly
- **For production:** Require RBAC scope assignment; provide a PowerShell setup script the customer runs
- **For compliance-sensitive tenants:** Hard requirement — refuse to operate without scoped access policy

---

## 6. Delta Sync — Incremental Indexing

Source: https://learn.microsoft.com/en-us/graph/delta-query-messages

### 6.1 How Delta Sync Works

Delta query enables incremental sync without re-fetching all messages. It is **per-folder** — you cannot delta sync across multiple folders in one call.

**Flow:**

1. Initial sync: `GET /mailFolders/{id}/messages/delta` — returns all messages + `@odata.nextLink` tokens
2. Page through `@odata.nextLink` URLs until you receive `@odata.deltaLink`
3. Store the `@odata.deltaLink` URL persistently (this is your state token)
4. Next sync: use the stored `@odata.deltaLink` — returns only changed/added/deleted messages

### 6.2 Initial Sync Example

```typescript
async function initialSync(userId: string, folderId: string): Promise<string> {
  let nextLink: string | undefined = 
    `/users/${userId}/mailFolders/${folderId}/messages/delta` +
    `?$select=id,subject,from,receivedDateTime,conversationId,bodyPreview,importance,hasAttachments,internetMessageId,parentFolderId`;
  
  let deltaLink: string | undefined;

  while (nextLink) {
    const response = await graphClient
      .api(nextLink)
      .header("Prefer", "odata.maxpagesize=50")
      .get();

    // Process messages
    for (const message of response.value) {
      if (message["@removed"]) {
        await deleteFromIndex(message.id);
      } else {
        await upsertToIndex(message);
      }
    }

    if (response["@odata.nextLink"]) {
      nextLink = response["@odata.nextLink"];
      deltaLink = undefined;
    } else if (response["@odata.deltaLink"]) {
      deltaLink = response["@odata.deltaLink"];
      nextLink = undefined;
    }
  }

  // Return the deltaLink to store persistently
  return deltaLink!;
}
```

### 6.3 Subsequent Incremental Sync

```typescript
async function incrementalSync(storedDeltaLink: string): Promise<string> {
  let nextLink: string | undefined = storedDeltaLink;
  let newDeltaLink: string | undefined;

  while (nextLink) {
    const response = await graphClient
      .api(nextLink)
      .header("Prefer", "odata.maxpagesize=50")
      .get();

    for (const message of response.value) {
      if (message["@removed"]) {
        // message.id exists, message was deleted
        await deleteFromIndex(message.id);
      } else {
        // New or updated message
        await upsertToIndex(message);
      }
    }

    nextLink = response["@odata.nextLink"];
    if (response["@odata.deltaLink"]) {
      newDeltaLink = response["@odata.deltaLink"];
      nextLink = undefined;
    }
  }

  return newDeltaLink ?? storedDeltaLink; // Store updated delta link
}
```

### 6.4 Filtering in Delta Queries

Delta query supports limited filtering. These are the only supported `$filter` expressions:

```
$filter=receivedDateTime+ge+{value}
$filter=receivedDateTime+gt+{value}

# IMPORTANT: Applying $filter limits results to max 5,000 messages
# Use for date-bounded initial sync of large mailboxes
```

### 6.5 Change Type Filtering

```typescript
// Only return newly created messages (ignore updates and deletes)
GET /users/{id}/mailFolders/{folderId}/messages/delta?changeType=created

// Only return updated messages
GET /users/{id}/mailFolders/{folderId}/messages/delta?changeType=updated

// Only return deleted messages
GET /users/{id}/mailFolders/{folderId}/messages/delta?changeType=deleted
```

This is useful for the knowledge index: only process `created` messages during normal sync, and separately handle `deleted` for cleanup.

### 6.6 Delta Sync State Storage

Store one delta link per (userId, folderId) tuple:

```typescript
interface DeltaSyncState {
  userId: string;
  folderId: string;          // Folder ID or well-known name resolved to ID
  deltaLink: string;         // @odata.deltaLink URL to use on next sync
  lastSyncAt: string;        // ISO 8601 timestamp
  totalMessagesSynced: number;
}
```

Persist in SQLite or the same KV store used for the knowledge index.

### 6.7 Which Folders to Sync

Recommended folders for knowledge extraction:

| Folder | Value | Notes |
|--------|-------|-------|
| `Inbox` | High | Incoming decisions, requests, FYIs |
| `SentItems` | High | Context on decisions made, commitments sent |
| `Archive` | Medium | Historical context |
| `Drafts` | Low/Skip | Incomplete thoughts; not authoritative |
| `JunkEmail` | Skip | Noise |
| `DeletedItems` | Skip | User explicitly removed |

---

## 7. Message Schema — All Fields

Source: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0

### 7.1 Core Properties

```typescript
interface GraphMessage {
  // Identity
  id: string;                    // Graph-internal ID (changes on move)
  internetMessageId: string;     // RFC 2822 Message-ID header (stable across systems)
  changeKey: string;             // Version key for ETag/optimistic concurrency
  
  // Threading
  conversationId: string;        // Stable across replies/forwards in same thread
  conversationIndex: string;     // Binary blob — position within conversation tree (base64)
  
  // Timestamps
  createdDateTime: string;       // ISO 8601, UTC
  lastModifiedDateTime: string;  // ISO 8601, UTC
  receivedDateTime: string;      // When the message arrived in this mailbox
  sentDateTime: string;          // When sender sent it
  
  // Participants
  from: Recipient;               // Mailbox that generated the message
  sender: Recipient;             // Account used to send (differs in delegate scenarios)
  toRecipients: Recipient[];
  ccRecipients: Recipient[];
  bccRecipients: Recipient[];    // Note: BCC not visible to recipients
  replyTo: Recipient[];
  
  // Content
  subject: string;
  body: ItemBody;                // { contentType: 'html'|'text', content: string }
  bodyPreview: string;           // First 255 characters, plain text
  uniqueBody?: ItemBody;         // Only the current message (strips quoted reply) — $select required
  
  // State flags
  isRead: boolean;
  isDraft: boolean;
  hasAttachments: boolean;       // NOTE: does NOT include inline attachments
  importance: 'low'|'normal'|'high';
  
  // Organization
  parentFolderId: string;
  inferenceClassification: 'focused'|'other';  // Focused Inbox classification
  categories: string[];          // User-assigned Outlook categories
  flag: FollowupFlag;
  
  // Headers
  internetMessageHeaders?: InternetMessageHeader[];  // RFC 5322 headers — $select required
  
  // Navigation
  webLink: string;               // Outlook on the web URL for the message
}

interface Recipient {
  emailAddress: {
    name: string;
    address: string;
  };
}

interface ItemBody {
  contentType: 'html'|'text';
  content: string;
}
```

### 7.2 Recommended $select for Knowledge Index

```typescript
const SELECT_FIELDS = [
  'id',
  'internetMessageId',
  'conversationId', 
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'importance',
  'parentFolderId',
  'isRead',
  'isDraft',
  'categories',
  'webLink',
].join(',');

// When you need the full body (for content extraction):
const SELECT_FULL = [...SELECT_FIELDS.split(','), 'body', 'uniqueBody'].join(',');
```

**Note:** Do NOT include `internetMessageHeaders` in the default select — it requires a separate fetch and returns many headers irrelevant to knowledge extraction. Only fetch when you need routing metadata.

### 7.3 JSON Representation (Actual API Response)

```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#...",
  "@odata.etag": "W/\"CQAAABYAAAC4ofQHEIqCSbQPot83AFcbAAAnjjuZ\"",
  "id": "AAMkADhMGAAA=",
  "createdDateTime": "2026-08-01T09:15:05Z",
  "lastModifiedDateTime": "2026-08-01T09:15:08Z",
  "receivedDateTime": "2026-08-01T09:15:08Z",
  "sentDateTime": "2026-08-01T09:15:06Z",
  "hasAttachments": false,
  "internetMessageId": "<MWHPR6E1BE060@MWHPR1120.namprd22.prod.outlook.com>",
  "subject": "Budget approval — Q3 capex",
  "bodyPreview": "Hi team, please see the attached budget proposal for Q3...",
  "importance": "normal",
  "parentFolderId": "AAMkADcbAAAAAAEJAAA=",
  "conversationId": "AAQkADOUpag6yWs=",
  "isDeliveryReceiptRequested": false,
  "isReadReceiptRequested": false,
  "isRead": true,
  "isDraft": false,
  "webLink": "https://outlook.office365.com/owa/?ItemID=AAMkADMGAAA%3D&exvsurl=1",
  "inferenceClassification": "focused",
  "body": {
    "contentType": "html",
    "content": "<html><body>Hi team, ...</body></html>"
  },
  "from": {
    "emailAddress": { "name": "Alice Foulds", "address": "alice@contoso.com" }
  },
  "toRecipients": [
    { "emailAddress": { "name": "Bob Smith", "address": "bob@contoso.com" } }
  ],
  "ccRecipients": [],
  "bccRecipients": [],
  "replyTo": [],
  "flag": { "flagStatus": "notFlagged" }
}
```

---

## 8. Attachments

Source: https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0

### 8.1 Attachment Types

| Type | Resource | Use case |
|------|----------|---------|
| File attachment | `fileAttachment` | Binary files (PDF, DOCX, images, etc.) |
| Item attachment | `itemAttachment` | Embedded Outlook items (emails, calendar events, contacts) |
| Reference attachment | `referenceAttachment` | Links to OneDrive/SharePoint files (no binary content) |

### 8.2 Base Attachment Properties

```typescript
interface Attachment {
  id: string;
  name: string;          // Filename
  contentType: string;   // MIME type (e.g., "application/pdf")
  size: number;          // Size in bytes
  isInline: boolean;     // true = embedded in HTML body (e.g., images in signatures)
  lastModifiedDateTime: string;
}

interface FileAttachment extends Attachment {
  contentBytes: string;   // Base64-encoded file content
  contentId?: string;     // Present when isInline=true — matches HTML src="cid:..."
}
```

### 8.3 Attachment Size Limits

| Scenario | Limit |
|----------|-------|
| Standard attachment (file, item, reference) | 3 MB |
| Large file attachment via upload session | Up to 150 MB |
| Group post attachment | 3 MB only |

### 8.4 Listing and Downloading Attachments

```typescript
// List all attachments on a message (metadata only — no contentBytes by default)
const attachments = await graphClient
  .api(`/users/${userId}/messages/${messageId}/attachments`)
  .get();

// Download a specific attachment's content
const attachment = await graphClient
  .api(`/users/${userId}/messages/${messageId}/attachments/${attachmentId}`)
  .get();
// attachment.contentBytes is base64-encoded

// Inline expansion — get attachments with message in one request
const messageWithAttachments = await graphClient
  .api(`/users/${userId}/messages/${messageId}`)
  .select('id,subject,body')
  .expand('attachments')
  .get();
```

### 8.5 Inline Attachments Gotcha

`hasAttachments: false` does NOT mean no attachments when a message has inline images. The property only tracks non-inline (proper) attachments.

To detect inline attachments, parse the HTML body for `src="cid:..."` attributes:

```typescript
function hasInlineAttachments(bodyHtml: string): boolean {
  return /src\s*=\s*["']cid:/i.test(bodyHtml);
}
```

### 8.6 Knowledge Index Recommendation for Attachments

For the knowledge index, the approach should be:

1. **Skip binary attachments** (images, ZIP, executables) — no text content
2. **Extract text from PDF, DOCX, XLSX** — use the same pipeline as SharePoint connector
3. **Process embedded email attachments** (itemAttachment) — these are conversation artifacts
4. **Skip inline images** (signatures, company logos)
5. **Follow reference attachments** to SharePoint/OneDrive and index the file content instead

```typescript
const INDEXABLE_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'message/rfc822',  // Embedded email
]);

function shouldIndexAttachment(attachment: Attachment): boolean {
  if (attachment.isInline) return false;
  if (attachment.size > 10 * 1024 * 1024) return false; // Skip files > 10MB
  return INDEXABLE_CONTENT_TYPES.has(attachment.contentType);
}
```

---

## 9. MIME Content Retrieval

Source: https://learn.microsoft.com/en-us/graph/outlook-get-mime-message

### 9.1 Why MIME

The Graph API normally returns message bodies in HTML format. Getting the raw MIME gives you:
- Plain text part directly (no HTML parsing needed)
- Access to raw email headers
- Full attachment data as-embedded
- S/MIME encrypted/signed message detection

### 9.2 MIME Endpoint

```typescript
// Append $value to get raw MIME (returns string, not JSON)
const mimeContent = await graphClient
  .api(`/users/${userId}/messages/${messageId}/$value`)
  .get();

// mimeContent is a raw string starting with MIME headers
// e.g.: "MIME-Version: 1.0\r\nContent-Type: multipart/mixed..."
```

### 9.3 MIME Structure

```
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary_string"

--boundary_string
Content-Type: multipart/alternative; boundary="inner_boundary"

--inner_boundary
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Plain text content here.

--inner_boundary
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

<html><body>HTML content here.</body></html>

--inner_boundary--

--boundary_string
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQ...
--boundary_string--
```

### 9.4 When to Use MIME vs. Graph JSON

| Scenario | Recommendation |
|----------|---------------|
| Basic message indexing (subject, from, body text) | Use Graph JSON — simpler |
| Need plain text without HTML parsing | Use MIME — has `text/plain` part directly |
| Need to detect S/MIME encryption | Use MIME — check Content-Type |
| Need to save message as .eml file | Use MIME |
| Need all attachment content in one request | Use MIME |
| High-throughput indexing | Use Graph JSON — smaller payloads |

---

## 10. Thread Reconstruction via conversationId

### 10.1 How conversationId Works

Every email in Microsoft 365 belongs to a conversation thread identified by `conversationId`. When you reply or forward, the new message gets the same `conversationId`.

Properties for threading:
- `conversationId` (String) — Groups all messages in a thread, stable across the mailbox
- `conversationIndex` (binary blob) — Encodes the tree position within the conversation. Messages from the same thread with the same `conversationId` can be ordered and nested using this.

### 10.2 Fetching All Messages in a Thread

```typescript
// Fetch all messages in a conversation by conversationId
// Note: this searches across the entire mailbox, not just one folder
async function fetchThread(userId: string, conversationId: string): Promise<GraphMessage[]> {
  const result = await graphClient
    .api(`/users/${userId}/messages`)
    .filter(`conversationId eq '${conversationId}'`)
    .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,conversationIndex,parentFolderId')
    .orderby('receivedDateTime asc')
    .get();
  
  return result.value;
}
```

### 10.3 Thread Reconstruction Algorithm

```typescript
interface ThreadMessage {
  id: string;
  internetMessageId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  receivedDateTime: string;
  body: string;          // Cleaned plain text (stripped of HTML and quoted replies)
  rawBody: string;       // Original HTML
  conversationIndex: Buffer;
  children: ThreadMessage[];
}

interface EmailThread {
  conversationId: string;
  subject: string;          // Normalized (strip Re: Fwd: prefixes)
  participants: string[];   // Unique email addresses across all messages
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  messages: ThreadMessage[]; // Sorted by receivedDateTime asc
  markdown: string;          // Compiled thread as markdown document
}

function reconstructThread(messages: GraphMessage[]): EmailThread {
  const sorted = messages.sort(
    (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime()
  );

  const participants = new Set<string>();
  for (const msg of sorted) {
    participants.add(msg.from.emailAddress.address);
    for (const r of msg.toRecipients) participants.add(r.emailAddress.address);
    for (const r of msg.ccRecipients) participants.add(r.emailAddress.address);
  }

  const subject = normalizeSubject(sorted[0].subject);
  const threadMessages = sorted.map(msg => ({
    id: msg.id,
    from: msg.from.emailAddress.address,
    fromName: msg.from.emailAddress.name,
    to: msg.toRecipients.map(r => r.emailAddress.address),
    receivedDateTime: msg.receivedDateTime,
    subject: msg.subject,
    body: extractTextFromHtml(msg.body?.content ?? ''),
    uniqueBody: extractTextFromHtml(msg.uniqueBody?.content ?? msg.body?.content ?? ''),
  }));

  return {
    conversationId: messages[0].conversationId,
    subject,
    participants: Array.from(participants),
    firstMessageAt: sorted[0].receivedDateTime,
    lastMessageAt: sorted[sorted.length - 1].receivedDateTime,
    messageCount: sorted.length,
    messages: threadMessages,
    markdown: buildThreadMarkdown(subject, threadMessages),
  };
}

function normalizeSubject(subject: string): string {
  // Strip Re:, Fwd:, RE:, FW:, etc. recursively
  return subject.replace(/^(Re:|Fwd:|RE:|FW:|AW:|回复:|回覆:)\s*/gi, '').trim();
}

function buildThreadMarkdown(subject: string, messages: ThreadMessage[]): string {
  const lines = [
    `# Email Thread: ${subject}`,
    ``,
    `**Participants:** ${messages.map(m => m.from).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
    `**Messages:** ${messages.length}`,
    `**Date range:** ${messages[0].receivedDateTime} — ${messages[messages.length-1].receivedDateTime}`,
    ``,
    `---`,
  ];

  for (const msg of messages) {
    lines.push(`## ${msg.receivedDateTime} — From: ${msg.fromName} <${msg.from}>`);
    lines.push(`**To:** ${msg.to.join(', ')}`);
    lines.push(``);
    // Use uniqueBody if available (strips quoted replies), else full body
    lines.push(msg.uniqueBody || msg.body);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  return lines.join('\n');
}
```

### 10.4 Deduplication Across Folders

The same email often appears in multiple folders (e.g., a reply is in Inbox for recipient AND SentItems for sender). Use `internetMessageId` (the RFC 2822 Message-ID) for deduplication:

```typescript
const seen = new Set<string>();

function isDuplicate(message: GraphMessage): boolean {
  const key = message.internetMessageId;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
```

Note: `id` (Graph internal ID) changes when a message is moved between folders. `internetMessageId` is stable.

---

## 11. HTML to Markdown / Text Extraction

### 11.1 The Problem with Email HTML

Email HTML is notoriously dirty:
- Nested `<blockquote>` elements for quoted replies (Outlook wraps in `<div class="OutlookMessageHeader">` etc.)
- Inline styles that override semantic markup
- Broken HTML from non-standard clients (Lotus Notes, old IBM systems)
- 3x-nested table layouts from marketing emails
- Tracking pixels (`<img>` 1x1 invisible)
- Signature blocks (legal disclaimers, logos, contact info)

### 11.2 Extracting Unique Content vs. Full Thread

Use Graph's `uniqueBody` property — it contains only the new content added in this message, stripping the quoted reply chain. This is ideal for per-message indexing.

```typescript
// Request uniqueBody alongside body
const message = await graphClient
  .api(`/users/${userId}/messages/${messageId}`)
  .select('id,subject,body,uniqueBody,from,receivedDateTime,conversationId')
  .get();

// uniqueBody is only available for individual message fetch (not list)
// It is NOT included in delta query responses
```

### 11.3 HTML-to-Text Library Recommendations

```typescript
// Option 1: htmlparser2 + domutils (low-level, full control)
// npm install htmlparser2 domutils dom-serializer

import { parseDocument } from 'htmlparser2';
import { textContent } from 'domutils';

function htmlToText(html: string): string {
  const dom = parseDocument(html);
  return textContent(dom).replace(/\s+/g, ' ').trim();
}

// Option 2: node-html-parser (fast, lightweight)
// npm install node-html-parser

import { parse } from 'node-html-parser';

function htmlToText(html: string): string {
  const root = parse(html);
  // Remove script, style, and invisible elements
  root.querySelectorAll('script, style, head').forEach(el => el.remove());
  return root.text.replace(/\s{3,}/g, '\n\n').trim();
}

// Option 3: turndown (HTML to Markdown — preserves structure)
// npm install turndown

import TurndownService from 'turndown';
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

function htmlToMarkdown(html: string): string {
  return td.turndown(html);
}
```

### 11.4 Stripping Quoted Replies

When `uniqueBody` is not available (e.g., in delta sync responses), strip quoted replies manually:

```typescript
function stripQuotedReply(html: string): string {
  const root = parse(html);
  
  // Outlook quoted content markers
  const selectors = [
    'div.gmail_quote',           // Gmail
    'div.OutlookMessageHeader',  // Outlook
    'blockquote[type="cite"]',   // Apple Mail, Thunderbird
    '#divRplyFwdMsg',            // Outlook Web App reply marker
    'hr[id]',                    // Outlook separator line (before "From: ...")
    '.WordSection1',             // Word-generated email separator
  ];
  
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach(el => el.remove());
  }
  
  // Remove everything after "From: ... Sent: ... To: ..." pattern (text-only fallback)
  const text = root.text;
  const replyPattern = /\n[-]+\s*Original Message\s*[-]+/i;
  const match = replyPattern.exec(text);
  if (match) return text.substring(0, match.index).trim();
  
  return root.text.replace(/\s{3,}/g, '\n\n').trim();
}
```

### 11.5 Signature Detection and Removal

```typescript
const SIGNATURE_MARKERS = [
  /^--\s*$/m,                    // "-- " (IETF RFC 3676 signature delimiter)
  /^Sent from my (iPhone|iPad|Android|Galaxy)/im,
  /^Get Outlook for/im,
  /^This email (and any attachments)? (is|are) confidential/im,
  /\bKind regards\b.*$/im,
  /\bBest regards\b.*$/im,
  /\bMany thanks\b.*$/im,
];

function removeSignature(text: string): string {
  for (const marker of SIGNATURE_MARKERS) {
    const match = marker.exec(text);
    if (match) {
      return text.substring(0, match.index).trim();
    }
  }
  return text;
}
```

---

## 12. IMAP Connector Path

Source: https://www.npmjs.com/package/imapflow, https://www.npmjs.com/package/mailparser

### 12.1 When to Use IMAP Instead of Graph

| Scenario | Use IMAP |
|----------|----------|
| Non-M365 email (Google Workspace, self-hosted) | Yes |
| Exchange On-Premises (not Exchange Online) | Yes, or use EWS |
| Customer refuses to grant app registration | Yes (IMAP + OAuth possible) |
| Exchange Online | No — use Graph API |

### 12.2 ImapFlow Library

ImapFlow is the modern, well-maintained IMAP client for Node.js. MIT licensed, 1.6M weekly downloads, TypeScript support included.

```
npm install imapflow postal-mime
```

`mailparser` is in maintenance mode — the maintainer recommends `postal-mime` for new projects. Both come from the same author (Andris Reinman / Postal Systems).

### 12.3 ImapFlow with OAuth2 (Exchange Online IMAP)

Exchange Online requires OAuth 2.0 for IMAP. Basic auth is permanently disabled. The OAuth token for IMAP uses the same scope as the Graph API token but is passed via XOAUTH2.

```typescript
import { ImapFlow } from 'imapflow';

async function createImapClient(email: string, accessToken: string): Promise<ImapFlow> {
  return new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: {
      user: email,
      accessToken: accessToken,  // OAuth 2.0 access token (XOAUTH2)
    },
    logger: false,  // Set to true for debugging
  });
}

async function syncInbox(email: string, accessToken: string): Promise<void> {
  const client = await createImapClient(email, accessToken);
  
  await client.connect();
  
  const lock = await client.getMailboxLock('INBOX');
  try {
    // List all messages with envelope metadata
    for await (const message of client.fetch('1:*', {
      envelope: true,
      flags: true,
      uid: true,
      internalDate: true,
      bodyStructure: true,
    })) {
      console.log({
        uid: message.uid,
        subject: message.envelope.subject,
        from: message.envelope.from,
        date: message.envelope.date,
        messageId: message.envelope.messageId,
        hasAttachments: hasAttachments(message.bodyStructure),
      });
    }
  } finally {
    lock.release();
  }
  
  await client.logout();
}

function hasAttachments(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some((child: any) => hasAttachments(child));
  }
  return false;
}
```

### 12.4 Incremental Sync with IMAP CONDSTORE/QRESYNC

IMAP has native incremental sync mechanisms when the server supports CONDSTORE/QRESYNC extensions (Exchange Online supports both):

```typescript
import { ImapFlow } from 'imapflow';

interface ImapSyncState {
  uidValidity: number;     // UIDVALIDITY — if this changes, full re-sync needed
  highestModSeq: bigint;   // MODSEQ from last sync (CONDSTORE extension)
  lastUid: number;         // Highest UID processed
}

async function incrementalImapSync(
  client: ImapFlow, 
  folderName: string,
  state: ImapSyncState
): Promise<ImapSyncState> {
  await client.mailboxOpen(folderName, { readOnly: true });
  const mailbox = client.mailbox;
  
  // Check if UIDVALIDITY changed (full re-sync required)
  if (mailbox.uidValidity !== BigInt(state.uidValidity)) {
    console.warn('UIDVALIDITY changed — full re-sync required');
    // Fall back to full sync
    return performFullSync(client, folderName);
  }
  
  // CONDSTORE: fetch only messages modified since last sync
  // UID FETCH 1:* (FLAGS) (CHANGEDSINCE highestModSeq)
  const changedMessages = [];
  for await (const message of client.fetch(
    `1:*`,
    { flags: true, uid: true, envelope: true, source: true },
    { changedSince: state.highestModSeq }
  )) {
    if (message.flags.has('\\Deleted')) {
      await deleteFromIndex(message.uid.toString());
    } else {
      changedMessages.push(message);
    }
  }
  
  return {
    uidValidity: Number(mailbox.uidValidity),
    highestModSeq: mailbox.highestModseq ?? state.highestModSeq,
    lastUid: mailbox.uidNext ? mailbox.uidNext - 1 : state.lastUid,
  };
}
```

### 12.5 IMAP IDLE for Real-Time Notification

If real-time indexing is needed (not just scheduled sync):

```typescript
// IMAP IDLE — server pushes notifications when new mail arrives
async function watchInbox(client: ImapFlow): Promise<void> {
  await client.mailboxOpen('INBOX');
  
  client.on('exists', async (data) => {
    // New messages arrived: data.count is new message count
    const newCount = data.count - (previousCount ?? 0);
    if (newCount > 0) {
      console.log(`${newCount} new message(s) arrived`);
      await procesNewMessages(client, newCount);
    }
  });
  
  // Activate IDLE
  const idleState = await client.idle();
  // idleState.destroy() to stop IDLE
}
```

**Note:** IMAP IDLE ties up one connection per mailbox indefinitely. For a knowledge index, scheduled sync every 15-30 minutes is simpler and more robust.

### 12.6 Parsing MIME with postal-mime

```typescript
import { PostalMime } from 'postal-mime';

async function parseEmail(rawMimeBuffer: Buffer): Promise<ParsedEmail> {
  const parser = new PostalMime();
  const email = await parser.parse(rawMimeBuffer);
  
  return {
    messageId: email.messageId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    text: email.text,          // Plain text part (already extracted)
    html: email.html,          // HTML part
    date: email.date,
    inReplyTo: email.inReplyTo,
    references: email.references,
    attachments: email.attachments.map(a => ({
      filename: a.filename,
      contentType: a.mimeType,
      size: a.content.byteLength,
      content: Buffer.from(a.content),
    })),
  };
}
```

---

## 13. Rate Limits and Throttling

Source: https://learn.microsoft.com/en-us/graph/throttling-limits

### 13.1 Outlook Service Limits (Graph Mail API)

These limits apply per **app ID + mailbox** combination. Exceeding the limit for one mailbox does NOT affect other mailboxes.

| Limit | Value | Applies to |
|-------|-------|-----------|
| API requests per mailbox | **10,000 requests / 10 minutes** | v1.0 and beta |
| Concurrent requests per mailbox | **4 concurrent** | v1.0 and beta |
| Upload (PATCH/POST/PUT) per mailbox | **150 MB / 5 minutes** | v1.0 and beta |

**Global limit (all services):**

| Limit | Value |
|-------|-------|
| All API requests | 130,000 requests / 10 seconds per app across all tenants |

### 13.2 Practical Throughput Math

For the knowledge index:
- 10,000 req / 600 seconds = **~16.7 requests/second per mailbox**
- With 4 concurrent requests and per-mailbox isolation: indexing 100 mailboxes = effectively 100 × 16.7 = 1,670 req/sec throughput total
- A request fetching 100 messages (with `$top=100`) counts as 1 request
- 10,000 req × 100 messages/req = **1,000,000 messages per 10 minutes per mailbox** before throttling

In practice, initial sync of large mailboxes (50K+ messages) with full body fetch will hit limits. Use `changeType=created` delta queries and batch processing.

### 13.3 Handling 429 (Throttled) Responses

```typescript
async function fetchWithRetry<T>(
  requestFn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  let attempt = 0;
  
  while (attempt <= maxRetries) {
    try {
      return await requestFn();
    } catch (error: any) {
      if (error.statusCode === 429) {
        const retryAfter = parseInt(error.headers?.['retry-after'] ?? '60', 10);
        const waitMs = (retryAfter + 1) * 1000; // Add 1s buffer
        
        console.warn(`Throttled (429). Retry-After: ${retryAfter}s. Waiting ${waitMs}ms...`);
        await sleep(waitMs);
        attempt++;
      } else if (error.statusCode === 503 || error.statusCode === 504) {
        // Transient server errors — exponential backoff
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 30000);
        console.warn(`Server error ${error.statusCode}. Retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        attempt++;
      } else {
        throw error; // Non-retryable error
      }
    }
  }
  
  throw new Error(`Max retries (${maxRetries}) exceeded`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 13.4 JSON Batching

Graph supports batching up to 20 requests in a single HTTP call. For Outlook, batching sends up to 4 sub-requests at a time to the Outlook service (respecting concurrent limits):

```typescript
// Batch example: fetch full body for multiple messages simultaneously
async function batchFetchBodies(
  userId: string, 
  messageIds: string[]
): Promise<Map<string, string>> {
  const batches: string[][] = [];
  for (let i = 0; i < messageIds.length; i += 20) {
    batches.push(messageIds.slice(i, i + 20));
  }
  
  const results = new Map<string, string>();
  
  for (const batch of batches) {
    const batchRequests = batch.map((id, index) => ({
      id: String(index),
      method: 'GET',
      url: `/users/${userId}/messages/${id}?$select=id,body`,
    }));
    
    const batchResponse = await graphClient
      .api('/$batch')
      .post({ requests: batchRequests });
    
    for (const response of batchResponse.responses) {
      if (response.status === 200) {
        results.set(response.body.id, response.body.body?.content ?? '');
      }
    }
    
    // Add small delay between batches to avoid throttling
    await sleep(500);
  }
  
  return results;
}
```

---

## 14. Sensitivity Labels and Privacy Filtering

Source: https://learn.microsoft.com/en-us/graph/api/resources/informationprotectionlabel?view=graph-rest-1.0

### 14.1 M365 Sensitivity Labels

Microsoft 365 supports sensitivity labels (e.g., Public, Internal, Confidential, Highly Confidential). These are set by users or auto-labeling policies.

**Important:** The `informationProtectionLabel` API is deprecated (stopped returning data Jan 1, 2023). The current API is under `/informationProtection/sensitivityLabels` (beta endpoint).

### 14.2 Reading Sensitivity Labels on Messages

Sensitivity labels on emails are carried in the message's MIME headers:

```
x-ms-exchange-organizationflag-information-protection-label: Confidential
msip_labels: MSIP_Label_GUID_Enabled=True;MSIP_Label_GUID_SetDate=2026-08-01T...;
```

To read these from the Graph API:

```typescript
// Get internet message headers for sensitivity label detection
const message = await graphClient
  .api(`/users/${userId}/messages/${messageId}`)
  .select('id,subject,internetMessageHeaders')
  .get();

function getSensitivityLabel(headers: InternetMessageHeader[]): string | null {
  const msipHeader = headers.find(h => 
    h.name.toLowerCase() === 'msip_labels'
  );
  if (!msipHeader) return null;
  
  // Parse MSIP_Labels format: MSIP_Label_{GUID}_Name=VALUE
  const nameMatch = msipHeader.value.match(/MSIP_Label_[^_]+_Name=([^;]+)/);
  return nameMatch ? nameMatch[1] : null;
}

// Alternative: check the x-microsoft-antispam header for SCL (Spam Confidence Level)
// or look for x-ms-exchange-organization-messagedirectionality
```

### 14.3 Sensitivity Label Filtering Strategy

For the knowledge index, implement this tiered approach:

```typescript
type SensitivityLevel = 'public' | 'internal' | 'confidential' | 'highly_confidential' | 'unknown';

interface SensitivityPolicy {
  skipLabels: string[];          // Label names that should never be indexed
  requireConfirmation: string[]; // Labels that require explicit opt-in
  defaultAllow: boolean;         // Index messages with unknown/no label
}

const DEFAULT_POLICY: SensitivityPolicy = {
  skipLabels: ['Highly Confidential', 'Confidential', 'Personal', 'Private'],
  requireConfirmation: ['Internal'],
  defaultAllow: true,  // Index unlabeled messages (most business email)
};

function shouldIndexMessage(
  message: GraphMessage, 
  policy: SensitivityPolicy
): boolean {
  // Always skip drafts
  if (message.isDraft) return false;
  
  // Get sensitivity label from headers
  const label = getSensitivityLabel(message.internetMessageHeaders ?? []);
  
  if (label) {
    // Check skip list first
    if (policy.skipLabels.some(skip => 
      label.toLowerCase().includes(skip.toLowerCase())
    )) {
      return false;
    }
    
    // Check confirmation required
    if (policy.requireConfirmation.some(req => 
      label.toLowerCase().includes(req.toLowerCase())
    )) {
      return false; // Conservative: skip unless explicitly included
    }
  }
  
  return policy.defaultAllow;
}
```

---

## 15. What NOT to Index

This is as important as what TO index. For enterprise compliance:

### 15.1 Hard Exclusions (Never Index)

| Category | Reason | Detection method |
|----------|--------|-----------------|
| Messages in `JunkEmail` / `Clutter` | Noise; no business value | Folder check |
| `DeletedItems` | User explicitly removed | Folder check |
| Draft messages | Incomplete, not authoritative | `isDraft === true` |
| Sensitivity label: Confidential+ | Compliance/POPIA | MSIP header |
| Personal email folders (HR, Payroll, Legal comms) | Privacy law | Folder name patterns |
| Password reset / MFA emails | Security credentials | Subject pattern |
| Calendar invitation boilerplate | Duplication with calendar connector | Content-Type detection |
| Mailing list unsubscribe, marketing | Noise | From domain patterns |
| NDRs (Non-Delivery Reports) | Technical noise | Message class `REPORT.IPM.Note.NDR` |

### 15.2 POPIA / GDPR Considerations (South Africa / EU)

For South African enterprises subject to POPIA (Protection of Personal Information Act):

- **Personal information in email bodies** must be handled as personal information
- The knowledge index must NOT index emails containing medical, financial, or biometric data unless the data subject has consented
- Implement a **category-based exclusion list**: if an email is to/from HR, Legal, or Payroll addresses, skip it
- Retain the right to be forgotten: if a data subject requests removal, the knowledge index must be able to delete all indexed content involving that person

```typescript
const EXCLUDED_ADDRESS_PATTERNS = [
  /hr@/i,
  /payroll@/i,
  /legal@/i,
  /medical@/i,
  /compliance@/i,
];

const EXCLUDED_SUBJECT_PATTERNS = [
  /password|reset|OTP|verification code/i,
  /salary|payslip|remuneration/i,
  /disciplinary|grievance/i,
  /health|medical|leave application/i,
];

function isPersonalOrSensitive(message: GraphMessage): boolean {
  // Check participants
  const allAddresses = [
    message.from.emailAddress.address,
    ...message.toRecipients.map(r => r.emailAddress.address),
    ...message.ccRecipients.map(r => r.emailAddress.address),
  ];
  
  for (const address of allAddresses) {
    if (EXCLUDED_ADDRESS_PATTERNS.some(p => p.test(address))) return true;
  }
  
  // Check subject
  if (EXCLUDED_SUBJECT_PATTERNS.some(p => p.test(message.subject ?? ''))) return true;
  
  return false;
}
```

### 15.3 Volume Management

Email is high-volume. Implement these limits:

```typescript
interface IndexingConfig {
  maxAgeDays: number;          // Don't index emails older than N days
  maxBodyTokens: number;       // Truncate extracted text at N tokens
  minBodyLength: number;       // Skip empty/trivial messages
  excludeFolders: string[];    // Folder names to skip
  excludeAddressPatterns: RegExp[];
  excludeSubjectPatterns: RegExp[];
}

const DEFAULT_CONFIG: IndexingConfig = {
  maxAgeDays: 365,             // 1 year rolling window
  maxBodyTokens: 4000,         // ~3000 words
  minBodyLength: 50,           // Skip 1-liner acknowledgements
  excludeFolders: ['JunkEmail', 'DeletedItems', 'Clutter', 'Outbox'],
  excludeAddressPatterns: EXCLUDED_ADDRESS_PATTERNS,
  excludeSubjectPatterns: EXCLUDED_SUBJECT_PATTERNS,
};
```

---

## 16. Exchange Web Services (EWS) — Deprecated

### 16.1 Deprecation Status

Microsoft announced the decommissioning of EWS in Exchange Online. The original announcement targeted October 2026 for decommissioning. Key facts:

- EWS has been in maintenance mode since 2018 (no new features)
- Microsoft considers it "end of life" for Exchange Online
- New app development on EWS is actively discouraged
- Graph API has full feature parity for all common EWS scenarios

### 16.2 When EWS Is Still Needed

| Scenario | EWS needed? | Alternative |
|----------|-------------|------------|
| Exchange Online / M365 | No — use Graph | Graph API |
| Exchange Server 2019/2016 on-premises | Yes | Graph API covers if Hybrid is configured |
| Exchange Server 2013 or older | Yes, EWS only option | Upgrade to modern Exchange or use IMAP |
| Server-side streaming notifications | Graph Change Notifications replace this | Graph webhooks |
| Folder-level sync with hierarchy | Graph delta handles this | Graph delta |
| Public folders | Partial via Graph, EWS for edge cases | Graph API for most scenarios |

### 16.3 EWS Architecture (for Reference)

EWS is a SOAP-based XML API. An EWS request looks like:

```xml
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FindItem xmlns="http://schemas.microsoft.com/exchange/services/2006/messages">
      <Traversal>Shallow</Traversal>
      <ItemShape>
        <BaseShape>IdOnly</BaseShape>
      </ItemShape>
      <ParentFolderIds>
        <DistinguishedFolderId Id="inbox"/>
      </ParentFolderIds>
    </FindItem>
  </soap:Body>
</soap:Envelope>
```

This is verbose, brittle, and tied to WS-* standards that have no modern tooling support. Do not build on this.

### 16.4 Decision

**Do not implement an EWS connector.** Customers on Exchange Online should use Graph. Customers on legacy on-premises Exchange should use IMAP if they cannot upgrade. The EWS maintenance and XML parsing burden is not justified.

---

## 17. Complete TypeScript Connector Implementation

### 17.1 Dependencies

```json
{
  "dependencies": {
    "@azure/identity": "^4.x",
    "@microsoft/microsoft-graph-client": "^3.x",
    "@microsoft/microsoft-graph-client-msal-node": "^1.x",
    "node-html-parser": "^6.x",
    "turndown": "^7.x",
    "imapflow": "^1.x"
  },
  "devDependencies": {
    "@types/turndown": "^5.x",
    "typescript": "^5.x"
  }
}
```

### 17.2 Configuration Interface

```typescript
// src/connectors/email/types.ts

export interface ExchangeConnectorConfig {
  // Azure App Registration
  tenantId: string;
  clientId: string;
  clientSecret: string;
  
  // Which mailboxes to index
  mailboxes: MailboxConfig[];
  
  // Indexing behavior
  foldersToSync: string[];         // Well-known folder names or IDs
  maxAgeDays: number;
  batchSize: number;               // Messages per delta page
  fullBodySync: boolean;           // Fetch full body or bodyPreview only
  
  // Privacy
  excludeAddressPatterns: string[]; // Regex patterns for exclusion
  excludeSubjectPatterns: string[];
  skipSensitivityLabels: string[];
}

export interface MailboxConfig {
  email: string;          // user@contoso.com or shared@contoso.com
  displayName?: string;
  type: 'user' | 'shared';
}

export interface MessageDocument {
  // Identity
  id: string;                   // Graph message ID (used for updates/deletes)
  internetMessageId: string;    // RFC 2822 Message-ID (for deduplication)
  conversationId: string;
  
  // Content
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  receivedDateTime: string;
  bodyMarkdown: string;         // Cleaned, converted to markdown
  bodyPreview: string;
  
  // Metadata
  mailbox: string;
  folder: string;
  hasAttachments: boolean;
  importance: string;
  webLink: string;
  
  // Indexing metadata
  indexedAt: string;
  connectorType: 'exchange-graph';
}

export interface ThreadDocument {
  conversationId: string;
  subject: string;
  participants: string[];
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
  markdown: string;             // Full thread as markdown
  mailbox: string;
  webLink?: string;
  
  indexedAt: string;
  connectorType: 'exchange-thread';
}

export interface DeltaSyncState {
  mailbox: string;
  folderId: string;
  deltaLink: string;
  lastSyncAt: string;
  messageCount: number;
}
```

### 17.3 Core Connector Class

```typescript
// src/connectors/email/ExchangeGraphConnector.ts

import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { parse as parseHtml } from 'node-html-parser';
import TurndownService from 'turndown';

import type {
  ExchangeConnectorConfig,
  MessageDocument,
  ThreadDocument,
  DeltaSyncState,
} from './types';

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

export class ExchangeGraphConnector {
  private graphClient: Client;
  private config: ExchangeConnectorConfig;

  constructor(config: ExchangeConnectorConfig) {
    this.config = config;
    
    const credential = new ClientSecretCredential(
      config.tenantId,
      config.clientId,
      config.clientSecret
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this.graphClient = Client.initWithMiddleware({ authProvider });
  }

  // -------------------------------------------------------------------------
  // Folder discovery
  // -------------------------------------------------------------------------

  async listFolders(mailbox: string): Promise<Array<{ id: string; name: string; displayName: string }>> {
    const response = await this.graphClient
      .api(`/users/${mailbox}/mailFolders`)
      .select('id,displayName,childFolderCount,totalItemCount')
      .top(50)
      .get();
    
    return response.value.map((f: any) => ({
      id: f.id,
      name: f.displayName,
      displayName: f.displayName,
    }));
  }

  // -------------------------------------------------------------------------
  // Delta sync
  // -------------------------------------------------------------------------

  async syncMailbox(
    mailbox: string,
    storedState: Map<string, DeltaSyncState>,
    onMessage: (doc: MessageDocument) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<Map<string, DeltaSyncState>> {
    const newState = new Map(storedState);
    
    for (const folderName of this.config.foldersToSync) {
      const folderId = await this.resolveFolderId(mailbox, folderName);
      const stateKey = `${mailbox}:${folderId}`;
      const existing = storedState.get(stateKey);
      
      let deltaLink: string;
      
      if (existing?.deltaLink) {
        // Incremental sync
        deltaLink = await this.runDeltaSync(
          mailbox, folderId, existing.deltaLink, onMessage, onDelete
        );
      } else {
        // Initial sync — filter by date
        const since = new Date();
        since.setDate(since.getDate() - this.config.maxAgeDays);
        const sinceIso = since.toISOString();
        
        deltaLink = await this.runInitialSync(
          mailbox, folderId, sinceIso, onMessage, onDelete
        );
      }
      
      newState.set(stateKey, {
        mailbox,
        folderId,
        deltaLink,
        lastSyncAt: new Date().toISOString(),
        messageCount: (existing?.messageCount ?? 0),
      });
    }
    
    return newState;
  }

  private async resolveFolderId(mailbox: string, folderName: string): Promise<string> {
    // Well-known folder names work directly
    const wellKnown = ['Inbox', 'SentItems', 'Drafts', 'DeletedItems', 'Archive', 'JunkEmail'];
    if (wellKnown.includes(folderName)) return folderName;
    
    // Otherwise look up by display name
    const folders = await this.listFolders(mailbox);
    const folder = folders.find(f => f.displayName === folderName);
    if (!folder) throw new Error(`Folder not found: ${folderName} in ${mailbox}`);
    return folder.id;
  }

  private async runDeltaSync(
    mailbox: string,
    folderId: string,
    deltaLink: string,
    onMessage: (doc: MessageDocument) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<string> {
    let nextLink: string | undefined = deltaLink;
    let newDeltaLink = deltaLink;

    while (nextLink) {
      const response = await this.fetchWithRetry(() =>
        this.graphClient
          .api(nextLink!)
          .header('Prefer', `odata.maxpagesize=${this.config.batchSize}`)
          .get()
      );

      await this.processMessages(response.value, mailbox, onMessage, onDelete);

      if (response['@odata.nextLink']) {
        nextLink = response['@odata.nextLink'];
      } else if (response['@odata.deltaLink']) {
        newDeltaLink = response['@odata.deltaLink'];
        nextLink = undefined;
      } else {
        nextLink = undefined;
      }
    }

    return newDeltaLink;
  }

  private async runInitialSync(
    mailbox: string,
    folderId: string,
    since: string,
    onMessage: (doc: MessageDocument) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<string> {
    const select = [
      'id', 'internetMessageId', 'conversationId', 'subject', 'body', 'bodyPreview',
      'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'sentDateTime',
      'hasAttachments', 'importance', 'parentFolderId', 'isDraft', 'isRead', 'webLink',
    ].join(',');

    let nextLink: string | undefined =
      `/users/${mailbox}/mailFolders/${folderId}/messages/delta` +
      `?$select=${select}` +
      `&$filter=receivedDateTime+ge+${since}`;
    
    let deltaLink = nextLink;

    while (nextLink) {
      const response = await this.fetchWithRetry(() =>
        this.graphClient
          .api(nextLink!)
          .header('Prefer', `odata.maxpagesize=${this.config.batchSize}`)
          .get()
      );

      await this.processMessages(response.value, mailbox, onMessage, onDelete);

      nextLink = response['@odata.nextLink'];
      if (response['@odata.deltaLink']) {
        deltaLink = response['@odata.deltaLink'];
        nextLink = undefined;
      }
    }

    return deltaLink;
  }

  // -------------------------------------------------------------------------
  // Message processing
  // -------------------------------------------------------------------------

  private async processMessages(
    messages: any[],
    mailbox: string,
    onMessage: (doc: MessageDocument) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<void> {
    for (const message of messages) {
      // Handle deletions
      if (message['@removed']) {
        await onDelete(message.id);
        continue;
      }

      // Skip filtered messages
      if (this.shouldSkip(message)) continue;

      const doc = this.buildMessageDocument(message, mailbox);
      await onMessage(doc);
    }
  }

  private shouldSkip(message: any): boolean {
    // Skip drafts
    if (message.isDraft) return false;  // isDraft === true → skip
    
    // Skip old messages
    if (this.config.maxAgeDays > 0) {
      const msgDate = new Date(message.receivedDateTime);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.config.maxAgeDays);
      if (msgDate < cutoff) return true;
    }

    // Check subject exclusions
    const subject = message.subject ?? '';
    for (const pattern of this.config.excludeSubjectPatterns) {
      if (new RegExp(pattern, 'i').test(subject)) return true;
    }

    // Check address exclusions
    const addresses = [
      message.from?.emailAddress?.address ?? '',
      ...(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
      ...(message.ccRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
    ];

    for (const addr of addresses) {
      for (const pattern of this.config.excludeAddressPatterns) {
        if (new RegExp(pattern, 'i').test(addr)) return true;
      }
    }

    return false;
  }

  private buildMessageDocument(message: any, mailbox: string): MessageDocument {
    const bodyHtml = message.body?.content ?? '';
    const bodyMarkdown = this.config.fullBodySync
      ? this.htmlToMarkdown(bodyHtml)
      : message.bodyPreview ?? '';

    return {
      id: message.id,
      internetMessageId: message.internetMessageId ?? '',
      conversationId: message.conversationId ?? '',
      subject: message.subject ?? '(no subject)',
      from: message.from?.emailAddress?.address ?? '',
      fromName: message.from?.emailAddress?.name ?? '',
      to: (message.toRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
      cc: (message.ccRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
      receivedDateTime: message.receivedDateTime,
      bodyMarkdown,
      bodyPreview: message.bodyPreview ?? '',
      mailbox,
      folder: message.parentFolderId ?? '',
      hasAttachments: message.hasAttachments ?? false,
      importance: message.importance ?? 'normal',
      webLink: message.webLink ?? '',
      indexedAt: new Date().toISOString(),
      connectorType: 'exchange-graph',
    };
  }

  // -------------------------------------------------------------------------
  // Thread reconstruction
  // -------------------------------------------------------------------------

  async fetchThread(mailbox: string, conversationId: string): Promise<ThreadDocument> {
    const response = await this.fetchWithRetry(() =>
      this.graphClient
        .api(`/users/${mailbox}/messages`)
        .filter(`conversationId eq '${conversationId}'`)
        .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,uniqueBody,webLink')
        .orderby('receivedDateTime asc')
        .top(100)
        .get()
    );

    const messages: any[] = response.value;
    if (messages.length === 0) {
      throw new Error(`No messages found for conversationId: ${conversationId}`);
    }

    const participants = new Set<string>();
    for (const msg of messages) {
      participants.add(msg.from?.emailAddress?.address ?? '');
      for (const r of msg.toRecipients ?? []) participants.add(r.emailAddress?.address ?? '');
    }

    const subject = this.normalizeSubject(messages[0].subject ?? '');
    const markdownParts = [`# ${subject}\n`];
    markdownParts.push(`**Participants:** ${[...participants].filter(Boolean).join(', ')}\n`);
    markdownParts.push(`**Messages:** ${messages.length}\n\n---\n`);

    for (const msg of messages) {
      const bodyHtml = msg.uniqueBody?.content ?? msg.body?.content ?? '';
      const bodyMd = this.htmlToMarkdown(bodyHtml);
      const from = msg.from?.emailAddress;
      
      markdownParts.push(`## ${msg.receivedDateTime}`);
      markdownParts.push(`**From:** ${from?.name ?? ''} <${from?.address ?? ''}>`);
      markdownParts.push(`**To:** ${(msg.toRecipients ?? []).map((r: any) => r.emailAddress?.address).join(', ')}\n`);
      markdownParts.push(bodyMd);
      markdownParts.push('\n---\n');
    }

    return {
      conversationId,
      subject,
      participants: [...participants].filter(Boolean),
      firstMessageAt: messages[0].receivedDateTime,
      lastMessageAt: messages[messages.length - 1].receivedDateTime,
      messageCount: messages.length,
      markdown: markdownParts.join('\n'),
      mailbox,
      webLink: messages[messages.length - 1].webLink ?? undefined,
      indexedAt: new Date().toISOString(),
      connectorType: 'exchange-thread',
    };
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private htmlToMarkdown(html: string): string {
    if (!html) return '';
    
    // Parse and clean the HTML
    const root = parseHtml(html);
    root.querySelectorAll('script, style, head').forEach(el => el.remove());
    root.querySelectorAll('img[src^="cid:"]').forEach(el => el.remove()); // Inline images
    
    const cleanHtml = root.outerHTML;
    
    try {
      return td.turndown(cleanHtml).replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      // Fallback to plain text extraction
      return root.text.replace(/\s{3,}/g, '\n\n').trim();
    }
  }

  private normalizeSubject(subject: string): string {
    return subject.replace(/^(Re:|Fwd:|RE:|FW:|AW:|回复:|回覆:)\s*/gi, '').trim();
  }

  private async fetchWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 5
  ): Promise<T> {
    let attempt = 0;
    
    while (attempt <= maxRetries) {
      try {
        return await fn();
      } catch (error: any) {
        if (error.statusCode === 429) {
          const retryAfter = parseInt(error.responseHeaders?.['retry-after'] ?? '60', 10);
          const waitMs = (retryAfter + 1) * 1000;
          await this.sleep(waitMs);
          attempt++;
        } else if (error.statusCode === 503 || error.statusCode === 504) {
          const waitMs = Math.min(1000 * 2 ** attempt, 30_000);
          await this.sleep(waitMs);
          attempt++;
        } else {
          throw error;
        }
      }
    }
    
    throw new Error(`Max retries exceeded after ${maxRetries} attempts`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 17.4 Usage Example

```typescript
// src/connectors/email/index.ts

import { ExchangeGraphConnector } from './ExchangeGraphConnector';
import type { ExchangeConnectorConfig } from './types';

const config: ExchangeConnectorConfig = {
  tenantId: process.env.AZURE_TENANT_ID!,
  clientId: process.env.AZURE_CLIENT_ID!,
  clientSecret: process.env.AZURE_CLIENT_SECRET!,
  
  mailboxes: [
    { email: 'project-alpha@contoso.com', type: 'shared', displayName: 'Project Alpha' },
    { email: 'support@contoso.com', type: 'shared', displayName: 'Support Inbox' },
  ],
  
  foldersToSync: ['Inbox', 'SentItems'],
  maxAgeDays: 365,
  batchSize: 50,
  fullBodySync: true,
  
  excludeAddressPatterns: [
    'hr@', 'payroll@', 'legal@', 'noreply@', 'no-reply@',
  ],
  excludeSubjectPatterns: [
    'password|reset|OTP|verification',
    'unsubscribe|newsletter',
  ],
  skipSensitivityLabels: ['Confidential', 'Highly Confidential'],
};

const connector = new ExchangeGraphConnector(config);

// Load stored delta states from your persistence layer
const storedStates = await loadDeltaStates();

// Run sync for each mailbox
for (const mailbox of config.mailboxes) {
  const newStates = await connector.syncMailbox(
    mailbox.email,
    storedStates,
    async (doc) => {
      // Upsert to knowledge index
      await knowledgeIndex.upsert({
        id: doc.internetMessageId,  // Use stable RFC 2822 ID
        type: 'email',
        title: doc.subject,
        content: doc.bodyMarkdown,
        metadata: {
          from: doc.from,
          to: doc.to,
          conversationId: doc.conversationId,
          receivedDateTime: doc.receivedDateTime,
          mailbox: mailbox.displayName,
          webLink: doc.webLink,
        },
      });
    },
    async (id) => {
      // Remove from index
      await knowledgeIndex.delete(id);
    }
  );

  // Save updated delta states
  await saveDeltaStates(newStates);
}
```

### 17.5 MCP Tool Definitions

```typescript
// Tools to expose via the MCP server

export const emailTools = [
  {
    name: 'search_email',
    description: 'Search indexed email threads and messages from connected Exchange/Outlook mailboxes',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        mailbox: { type: 'string', description: 'Filter by mailbox email address' },
        fromDate: { type: 'string', description: 'ISO 8601 date — only messages on or after' },
        toDate: { type: 'string', description: 'ISO 8601 date — only messages on or before' },
        from: { type: 'string', description: 'Filter by sender email address' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email_thread',
    description: 'Get the full reconstructed thread for a given conversationId',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        mailbox: { type: 'string' },
      },
      required: ['conversationId', 'mailbox'],
    },
  },
  {
    name: 'list_email_mailboxes',
    description: 'List connected email mailboxes and their sync status',
    inputSchema: { type: 'object', properties: {} },
  },
];
```

---

## 18. Production Checklist

### 18.1 Azure App Registration Setup

```
[ ] Register app in Azure Entra (formerly AAD)
[ ] Set application permissions: Mail.Read (or Mail.ReadBasic.All for metadata-only)
[ ] Admin consent granted by tenant admin
[ ] Configure RBAC for Applications in Exchange Online to scope to specific mailboxes
[ ] Store client_secret in Azure Key Vault / secrets manager (NOT in code or env file)
[ ] Set token cache (MSAL in-memory or Redis) to avoid re-authenticating every request
```

### 18.2 Connector Configuration

```
[ ] Start with SentItems and Inbox only — expand after validating quality
[ ] Set maxAgeDays = 365 for initial deployment; tune based on knowledge value
[ ] Implement exclude lists for HR/Legal/Payroll addresses before going live
[ ] Test with a shared mailbox first (lower risk than user mailboxes)
[ ] Validate sensitivity label detection with a test message labeled Confidential
[ ] Test delta sync state persistence — verify incremental sync works after restart
```

### 18.3 Operational

```
[ ] Rate limit handling with Retry-After header support
[ ] Delta link persistence — store in durable storage, not in-memory
[ ] UIDVALIDITY handling for IMAP (triggers full re-sync)
[ ] Scheduled sync interval: 15-30 minutes for near-real-time, hourly for batch
[ ] Dead-letter queue for messages that fail processing after max retries
[ ] Metrics: messages indexed per run, errors, sync lag
[ ] Alert on delta link expiry (if a delta link goes unused for too long, it expires)
```

### 18.4 Delta Link Expiry

Microsoft does not officially document how long delta links stay valid, but in practice:
- Delta links for mail folders remain valid for **at least 7 days** of inactivity
- For active sync (daily or more frequent), delta links reliably persist
- If a delta link returns a 410 Gone response, fall back to full re-sync

```typescript
async function syncWithFallback(
  connector: ExchangeGraphConnector,
  mailbox: string,
  state: DeltaSyncState | undefined,
  ...callbacks
): Promise<DeltaSyncState> {
  try {
    if (state) {
      return await connector.syncMailbox(mailbox, state, ...callbacks);
    }
  } catch (error: any) {
    if (error.statusCode === 410) {
      // Delta link expired — clear state and do full re-sync
      console.warn(`Delta link expired for ${mailbox}. Performing full re-sync.`);
      return await connector.syncMailbox(mailbox, undefined, ...callbacks);
    }
    throw error;
  }
  return await connector.syncMailbox(mailbox, undefined, ...callbacks);
}
```

---

## Sources

- https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview (Graph Mail overview)
- https://learn.microsoft.com/en-us/graph/delta-query-messages (Delta sync)
- https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0 (List messages)
- https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0 (Message schema)
- https://learn.microsoft.com/en-us/graph/api/resources/attachment?view=graph-rest-1.0 (Attachments)
- https://learn.microsoft.com/en-us/graph/outlook-get-mime-message (MIME retrieval)
- https://learn.microsoft.com/en-us/graph/throttling-limits (Rate limits)
- https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access (RBAC for Applications / scoping)
- https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online (Basic auth deprecation)
- https://learn.microsoft.com/en-us/graph/api/resources/informationprotectionlabel?view=graph-rest-1.0 (Sensitivity labels — deprecated API)
- https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/ews-application-types (EWS overview)
- https://www.npmjs.com/package/imapflow (ImapFlow — IMAP client, 1.6M weekly downloads, MIT)
- https://www.npmjs.com/package/mailparser (mailparser — maintenance mode, 3.6M weekly downloads)
- https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview (Outlook Mail API overview)
