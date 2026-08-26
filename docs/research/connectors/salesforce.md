# Salesforce Connector: Production Implementation Research

**Project:** markdown-for-agents-mcp  
**Phase:** Phase 2 — Enterprise Knowledge Index  
**Date:** 2026-08-26  
**Sources:** jsforce v3 source (github.com/jsforce/jsforce), EncludeLtd/sf-jwt-flow, advancedcommunities/salesforce-mcp-server, jaworjar95/salesforce-mcp-server, simple-salesforce README, Force.com Toolkit for .NET README, Salesforce developer docs (partial), RapidoCloud/mcp-force

---

## Table of Contents

1. [Executive Summary and Recommendations](#1-executive-summary-and-recommendations)
2. [Connected App and JWT Bearer Flow](#2-connected-app-and-jwt-bearer-flow)
3. [SOQL: Complete Syntax Reference](#3-soql-complete-syntax-reference)
4. [SOSL: Full-Text Search Syntax](#4-sosl-full-text-search-syntax)
5. [Knowledge Base: KnowledgeArticleVersion Object](#5-knowledge-base-knowledgearticleversion-object)
6. [ContentDocument and ContentVersion: File Attachments](#6-contentdocument-and-contentversion-file-attachments)
7. [Chatter: FeedItem, FeedComment, and Group Feeds](#7-chatter-feeditem-feedcomment-and-group-feeds)
8. [Bulk API v2: Large Export Job Lifecycle](#8-bulk-api-v2-large-export-job-lifecycle)
9. [Change Data Capture: Streaming API Real-Time Updates](#9-change-data-capture-streaming-api-real-time-updates)
10. [Field-Level Security and Record-Level Sharing](#10-field-level-security-and-record-level-sharing)
11. [Incremental Sync Patterns](#11-incremental-sync-patterns)
12. [Governor Limits and API Call Budget Management](#12-governor-limits-and-api-call-budget-management)
13. [Complete TypeScript Salesforce Connector](#13-complete-typescript-salesforce-connector)
14. [Limitations, Edge Cases, and Gotchas](#14-limitations-edge-cases-and-gotchas)
15. [What to Build, What to Skip](#15-what-to-build-what-to-skip)

---

## 1. Executive Summary and Recommendations

Salesforce is the dominant enterprise CRM and knowledge platform. For the markdown-for-agents-mcp enterprise knowledge index, it provides three extremely high-value content sources:

- **Knowledge Base** (`KnowledgeArticleVersion`): Structured support/product articles with categories, rich HTML body, versioning, and publication lifecycle. This is the highest-signal content in any support-heavy org.
- **Chatter** (`FeedItem`, `FeedComment`): Conversational knowledge — decisions, rationale, informal product discussions stored as social feeds attached to records.
- **Cases + Case Comments** (`Case`, `CaseComment`): Actual customer problem/resolution pairs, extremely valuable for support agent RAG.

Key decisions up front:

| Decision | Recommendation |
|---|---|
| Auth model | JWT Bearer (server-to-server) — no interactive login, no refresh token rotation issues |
| Node.js library | `jsforce` v3 (latest: 3.10.23) — TypeScript types built-in, covers all APIs |
| Query method (< 2000 rows) | REST API SOQL via `conn.query()` with cursor pagination |
| Query method (> 2000 rows) | Bulk API v2 query job — avoid governor limit exhaustion |
| Real-time sync | Change Data Capture (CDC) via Streaming API (CometD/Faye) |
| Incremental sync | `WHERE LastModifiedDate >= :cursor` on all standard objects |
| Knowledge body format | `Knowledge__kav` custom fields (HTML) — strip to markdown |
| File attachments | ContentVersion + ContentDocumentLink — index text/PDF only |
| Chatter as knowledge | FeedItem WHERE Type IN ('TextPost','RichTextPost') linked to KnowledgeArticleVersion or Opportunity/Case |

**Build priority:**
1. JWT auth + connection management (unlock everything)
2. Knowledge articles (highest information density)
3. Cases + CaseComments (support RAG)
4. Bulk API v2 query jobs (needed to export without hitting limits)
5. Chatter feeds (secondary, high org-specific value)
6. CDC streaming (incremental updates at scale)

---

## 2. Connected App and JWT Bearer Flow

### 2.1 Why JWT Bearer (Not Username/Password)

For server-to-server integrations, Salesforce supports three auth flows. Use **JWT Bearer** (OAuth 2.0 JWT Bearer Token Flow), not username/password:

| Flow | Refresh Required | MFA Compatible | Recommended For |
|---|---|---|---|
| Username + Password | Yes (session expires) | No (blocked by MFA) | Dev/test only |
| OAuth 2.0 Web Server | Yes (refresh token) | Yes | Interactive apps |
| JWT Bearer | No (re-issue at will) | Yes | Server-to-server, MCP connectors |

JWT Bearer issues access tokens on demand with no user interaction. The token does expire (typically 2 hours, configurable by Salesforce admin), so your connector must re-issue rather than refresh.

**Source:** `https://github.com/EncludeLtd/sf-jwt-flow` (working Node.js demo)

### 2.2 One-Time Setup: Create a Connected App

In Salesforce Setup:
1. Navigate to **Setup → App Manager → New Connected App**
2. Enable OAuth settings
3. Set callback URL to `http://localhost:3000/callback` (required even for JWT)
4. Scopes: `api`, `refresh_token`, `offline_access` (add `chatter_api` if needed)
5. Enable **Use Digital Signatures**
6. Upload the **public certificate** (X.509 PEM format)
7. Save — note the **Consumer Key** (= `clientId`)
8. In **Manage Connected Apps → Edit Policies**: set Permitted Users to "Admin approved users are pre-authorized"
9. Under **Profile/Permission Set**: pre-authorize the integration user profile

### 2.3 Generate the Certificate and Private Key

```bash
# Generate private key
openssl genrsa -out private.pem 2048

# Generate self-signed certificate (valid 10 years)
openssl req -new -x509 -key private.pem -out certificate.crt -days 3650 \
  -subj "/CN=salesforce-connector"

# Upload certificate.crt to the Connected App in Salesforce
# Keep private.pem as SF_PRIVATE_KEY in your secrets manager
```

### 2.4 JWT Bearer Token Flow — Step by Step

```typescript
// deps: jsonwebtoken, axios (or native fetch)
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';

interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: 'Bearer';
  issued_at: string;
  signature: string;
  scope?: string;
}

async function getSalesforceAccessToken(config: {
  clientId: string;       // Consumer Key from Connected App
  username: string;       // Integration user's Salesforce username
  privateKey: string;     // PEM private key (from file or secret)
  loginUrl?: string;      // https://login.salesforce.com (prod) or https://test.salesforce.com (sandbox)
}): Promise<SalesforceTokenResponse> {
  const { clientId, username, privateKey, loginUrl = 'https://login.salesforce.com' } = config;

  // Build JWT claim set — expiry must be within 3 minutes of SF server time
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: now + 180,  // 3 minutes; Salesforce rejects > 3 min
  };

  // Sign with RS256 using private key
  const assertion = jwt.sign(claim, privateKey, { algorithm: 'RS256' });

  // Exchange JWT for access token
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`JWT bearer token exchange failed: ${error}`);
  }

  return response.json() as Promise<SalesforceTokenResponse>;
}
```

### 2.5 jsforce Connection with JWT

```typescript
import * as jsforce from 'jsforce';
import * as jwt from 'jsonwebtoken';

export class SalesforceConnection {
  private conn: jsforce.Connection | null = null;
  private tokenExpiry = 0;
  private readonly TOKEN_LIFETIME_MS = 90 * 60 * 1000; // 90 min, re-issue before 2h expiry

  constructor(
    private readonly clientId: string,
    private readonly username: string,
    private readonly privateKey: string,
    private readonly loginUrl = 'https://login.salesforce.com',
    private readonly apiVersion = '61.0',
  ) {}

  async getConnection(): Promise<jsforce.Connection> {
    if (this.conn && Date.now() < this.tokenExpiry) {
      return this.conn;
    }
    return this.connect();
  }

  private async connect(): Promise<jsforce.Connection> {
    const token = await getSalesforceAccessToken({
      clientId: this.clientId,
      username: this.username,
      privateKey: this.privateKey,
      loginUrl: this.loginUrl,
    });

    this.conn = new jsforce.Connection({
      instanceUrl: token.instance_url,
      accessToken: token.access_token,
      version: this.apiVersion,
    });

    this.tokenExpiry = Date.now() + this.TOKEN_LIFETIME_MS;
    return this.conn;
  }
}
```

### 2.6 Environment Variables

```bash
SF_CLIENT_ID=3MVG9...          # Consumer Key
SF_USERNAME=integration@org.com
SF_PRIVATE_KEY_PATH=/secrets/private.pem  # or SF_PRIVATE_KEY as multiline string
SF_LOGIN_URL=https://login.salesforce.com  # use test.salesforce.com for sandbox
SF_INSTANCE_URL=https://myorg.my.salesforce.com  # set after first auth
SF_API_VERSION=61.0
```

### 2.7 Sandbox vs Production

- Production: `aud = https://login.salesforce.com`
- Sandbox: `aud = https://test.salesforce.com`
- My Domain: `aud` can also be the org's My Domain URL (e.g. `https://myorg.my.salesforce.com`), but Salesforce recommends using login.salesforce.com

### 2.8 Error Codes

| Error | Cause | Fix |
|---|---|---|
| `invalid_grant` | JWT expired or clock skew > 3 min | Use `exp = now + 180` exactly; sync server clock |
| `invalid_client_id` | Wrong Consumer Key | Check Connected App; sandbox has different key |
| `ip restricted` | IP allow-listing on Connected App | Add server IP to allowed IPs |
| `user is inactive` | Integration user deactivated | Re-activate the user |
| `invalid_app_access` | User profile not pre-authorized | Add profile to "Permitted Users" in Connected App |

---

## 3. SOQL: Complete Syntax Reference

SOQL (Salesforce Object Query Language) is a SELECT-only language for querying SObjects. It maps directly to a REST call:

```
GET /services/data/v61.0/query?q=SELECT+Id+FROM+Account
```

### 3.1 Basic SELECT Syntax

```sql
SELECT field1, field2, ..., fieldN
FROM ObjectName
[WHERE condition]
[WITH [DATA CATEGORY | SECURITY_ENFORCED | USER_MODE]]
[GROUP BY [ROLLUP | CUBE] field1, ...]
[HAVING aggregateCondition]
[ORDER BY field1 [ASC|DESC] [NULLS FIRST|LAST]]
[LIMIT n]
[OFFSET n]
[FOR [VIEW | REFERENCE | UPDATE]]
```

**Query all fields (describe-first pattern):**
```sql
-- SOQL has no SELECT *. Use FIELDS(ALL) (API v51+):
SELECT FIELDS(ALL) FROM Account LIMIT 200
-- Or query the specific fields after a describe call
```

### 3.2 WHERE Clause Operators

| Operator | Example | Notes |
|---|---|---|
| `=` | `WHERE Status = 'Active'` | Exact match |
| `!=` | `WHERE Stage != 'Closed Won'` | Not equal |
| `>`, `<`, `>=`, `<=` | `WHERE Amount > 10000` | Numeric and date comparison |
| `LIKE` | `WHERE Name LIKE '%Corp%'` | Case-insensitive, `%` = any chars, `_` = single char |
| `NOT LIKE` | `WHERE Name NOT LIKE 'Test%'` | |
| `IN` | `WHERE Stage IN ('Prospecting', 'Qualification')` | |
| `NOT IN` | `WHERE Type NOT IN ('Prospect')` | |
| `INCLUDES` | `WHERE LeadSource INCLUDES ('Web', 'Phone')` | Multi-select picklists only |
| `EXCLUDES` | `WHERE LeadSource EXCLUDES ('Web')` | Multi-select picklists only |
| `= null` | `WHERE CloseDate = null` | NULL check (not IS NULL) |
| `!= null` | `WHERE Email != null` | NOT NULL check |

**Logical operators:** `AND`, `OR`, `NOT` with standard parenthesization.

### 3.3 Date and DateTime Literals

```sql
-- Date literals (no quotes)
WHERE CloseDate = TODAY
WHERE CreatedDate = YESTERDAY
WHERE LastModifiedDate >= LAST_N_DAYS:7
WHERE CloseDate = THIS_MONTH
WHERE CreatedDate = LAST_MONTH
WHERE SystemModstamp >= LAST_N_HOURS:24
WHERE CreatedDate >= LAST_QUARTER
WHERE CloseDate > NEXT_N_MONTHS:3

-- Explicit DateTime (ISO 8601, must include Z or timezone offset)
WHERE LastModifiedDate >= 2026-01-01T00:00:00Z
WHERE CreatedDate > 2026-08-01T00:00:00.000+00:00
```

**Gotcha:** Date fields use `YYYY-MM-DD`, DateTime fields use ISO 8601. Mixing them causes query errors.

### 3.4 Aggregate Functions

```sql
SELECT COUNT(), COUNT(Id), COUNT(DISTINCT Email),
       SUM(Amount), AVG(Amount), MIN(Amount), MAX(Amount),
       MIN(CloseDate), MAX(LastModifiedDate)
FROM Opportunity
WHERE StageName = 'Closed Won'
GROUP BY AccountId
HAVING COUNT(Id) > 5
ORDER BY SUM(Amount) DESC
LIMIT 20
```

- `COUNT()` with no argument = count all rows (returns integer, not field)
- `COUNT(fieldName)` = count non-null values of that field
- `GROUP BY ROLLUP(...)` and `GROUP BY CUBE(...)` for multi-dimensional aggregations

### 3.5 Relationship Queries (Parent and Child)

```sql
-- Parent-to-child (traverse up): dot notation
SELECT Id, Name, Account.Name, Account.BillingCity, Owner.Email
FROM Contact
WHERE Account.Industry = 'Technology'

-- Child-to-parent (traverse down): nested subquery in SELECT
SELECT Id, Name,
  (SELECT Id, Subject, Status FROM Cases ORDER BY CreatedDate DESC LIMIT 5),
  (SELECT Id, ContentDocumentId FROM ContentDocumentLinks LIMIT 10)
FROM Account
WHERE LastModifiedDate >= LAST_N_DAYS:30

-- Semi-join: WHERE field IN (subquery)
SELECT Id, Name FROM Contact
WHERE AccountId IN (SELECT Id FROM Account WHERE Industry = 'Technology')

-- Anti-join: WHERE field NOT IN (subquery)
SELECT Id, Name FROM Lead
WHERE ConvertedAccountId NOT IN (SELECT AccountId FROM Contact WHERE HasOptedOutOfEmail = true)
```

### 3.6 Knowledge-Specific SOQL

```sql
-- Query published Knowledge articles (Lightning Knowledge)
SELECT Id, KnowledgeArticleId, ArticleNumber, Title, UrlName,
       Summary, Language, PublishStatus, VersionNumber,
       IsLatestVersion, CreatedDate, LastModifiedDate,
       LastPublishedDate, IsDeleted
FROM Knowledge__kav          -- "__kav" suffix = KnowledgeArticleVersion
WHERE PublishStatus = 'Online'
AND Language = 'en_US'
AND IsLatestVersion = true
ORDER BY LastModifiedDate DESC
LIMIT 2000

-- Fetch article body (requires data category field if configured)
SELECT Id, Title, Knowledge__c, Body__c  -- custom body field names vary per org
FROM Knowledge__kav
WHERE Id = '0124000000XXXXX'

-- Query with data categories
SELECT Id, Title
FROM Knowledge__kav
WHERE PublishStatus = 'Online'
AND IsLatestVersion = true
WITH DATA CATEGORY Products__c ABOVE_OR_SAME Software__c
```

### 3.7 Query Pagination

```typescript
import { Connection } from 'jsforce';

async function queryAll<T>(conn: Connection, soql: string): Promise<T[]> {
  const records: T[] = [];
  let result = await conn.query<T>(soql);
  records.push(...result.records);

  // Paginate while more records exist
  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore<T>(result.nextRecordsUrl);
    records.push(...result.records);
  }

  return records;
}

// Or use jsforce's built-in queryAll (materializes everything)
const allRecords = await conn.queryAll<KnowledgeArticle>(
  `SELECT Id, Title FROM Knowledge__kav WHERE PublishStatus = 'Online'`
);
```

**Gotcha:** Default page size is 2,000 records. Do not use `queryAll` for millions of records — it loads everything into memory. For large datasets, use Bulk API v2 instead.

### 3.8 SOQL Query Plan and Index Hints

```sql
-- Explain query plan (returns JSON, not records)
GET /services/data/v61.0/query?explain=SELECT+Id+FROM+Account+WHERE+Name='Acme'

-- Leading operator types: 'Index' (fast), 'Other' (ok), 'Sharing' (can be slow), 'TableScan' (danger)
-- Always ensure WHERE conditions hit an indexed field for large objects
```

Indexed fields include: `Id`, `Name`, `OwnerId`, `CreatedDate`, `LastModifiedDate`, `SystemModstamp`, `RecordTypeId`, custom fields with "Indexed" option enabled, and any External ID field.

---

## 4. SOSL: Full-Text Search Syntax

SOSL (Salesforce Object Search Language) performs full-text search across multiple objects simultaneously.

**REST endpoint:**
```
GET /services/data/v61.0/search?q=FIND+%7BSearchTerm%7D+IN+ALL+FIELDS+RETURNING+Account%2C+Contact
```

### 4.1 SOSL Syntax

```
FIND {searchText} [IN searchGroup]
[RETURNING objectSpec [, objectSpec ...]]
[WITH clause [, WITH clause ...]]
[LIMIT n]
[OFFSET n]
[UPDATE TRACKING | UPDATE VIEWSTAT]
```

### 4.2 Search Text Escaping

```sql
-- Reserved chars: ? & | ! { } [ ] ( ) ^ ~ * : \ " ' + -
-- Escape with backslash inside {}

FIND {Hello World}              -- Finds Hello AND World
FIND {"Hello World"}            -- Phrase search (exact sequence)
FIND {Hello OR World}           -- Either term
FIND {Hello AND World}          -- Both terms (default)
FIND {Hello NOT World}          -- Hello without World
FIND {Hel*}                     -- Wildcard suffix (min 2 chars before *)
FIND {Hel?o}                    -- Single char wildcard
```

### 4.3 Search Groups

```sql
FIND {Salesforce} IN ALL FIELDS       -- All text fields (default)
FIND {Salesforce} IN NAME FIELDS      -- Name, Subject, title fields
FIND {Salesforce} IN EMAIL FIELDS     -- Email fields
FIND {Salesforce} IN PHONE FIELDS     -- Phone fields
FIND {Salesforce} IN SIDEBAR FIELDS   -- Fields shown in Search sidebar
```

### 4.4 RETURNING Clause

```sql
FIND {knowledge base} IN ALL FIELDS
RETURNING
  Knowledge__kav(Id, Title, Summary, PublishStatus
    WHERE PublishStatus = 'Online' AND IsLatestVersion = true
    ORDER BY LastModifiedDate DESC LIMIT 10),
  Case(Id, Subject, Description, Status
    WHERE Status != 'Closed'
    ORDER BY CreatedDate DESC LIMIT 10),
  Account(Id, Name, Industry LIMIT 5)
LIMIT 200   -- Total across all objects; per-object LIMIT in RETURNING
```

### 4.5 WITH Clause Filters

```sql
-- Data category filter for Knowledge
FIND {upgrade procedure} IN ALL FIELDS
RETURNING Knowledge__kav(Id, Title WHERE PublishStatus = 'Online')
WITH DATA CATEGORY Products__c AT Release_Notes__c

-- Network context (Experience Cloud communities)
FIND {issue} IN ALL FIELDS
WITH NETWORK = ['networkId1', 'networkId2']

-- Snippet extraction (returns highlighted matches)
FIND {upgrade} IN ALL FIELDS
RETURNING Knowledge__kav(Id, Title, Summary)
WITH SNIPPET (target_length=120)

-- Spell correction
FIND {knowlege} IN ALL FIELDS  -- typo
WITH SPELL_CORRECTION = true
```

### 4.6 jsforce SOSL Example

```typescript
const result = await conn.search(
  `FIND {*knowledge*} IN NAME FIELDS ` +
  `RETURNING Knowledge__kav(Id, Title, Summary, PublishStatus ` +
  `WHERE PublishStatus = 'Online') ` +
  `LIMIT 50`
);

for (const record of result.searchRecords) {
  console.log(record.Id, record.Title);
}
```

**When to use SOSL vs SOQL:**
- SOSL: User-typed search terms, cross-object full-text lookup, relevance-ranked results
- SOQL: Structured data retrieval, known field values, bulk exports, incremental sync

---

## 5. Knowledge Base: KnowledgeArticleVersion Object

### 5.1 Lightning Knowledge Architecture

Lightning Knowledge uses a single `Knowledge__kav` SObject (the `__kav` suffix means KnowledgeArticleVersion). Each article version is a separate row. Classic Knowledge used multiple SObjects per article type — avoid for new implementations.

**Article lifecycle:**

```
Draft → (submit for review) → Online (published) → (archive) → Archived
                                     ↑
                              (restore from archived)
```

### 5.2 KnowledgeArticleVersion Field Reference

| Field | Type | Description |
|---|---|---|
| `Id` | ID | Version record ID (changes per version) |
| `KnowledgeArticleId` | ID | Stable article ID (consistent across versions) |
| `ArticleNumber` | String | Human-readable article number (e.g. "000001234") |
| `Title` | String | Article title |
| `UrlName` | String | URL-safe slug for the article |
| `Summary` | String(255) | Short description / meta description |
| `PublishStatus` | Picklist | `Online`, `Draft`, `Archived` |
| `VersionNumber` | Integer | Version counter |
| `IsLatestVersion` | Boolean | True if this is the current version |
| `Language` | Picklist | e.g. `en_US`, `fr`, `de` |
| `IsDeleted` | Boolean | True if soft-deleted (use `queryAll` to see deleted) |
| `CreatedDate` | DateTime | Article version creation timestamp |
| `LastModifiedDate` | DateTime | Last modification timestamp |
| `LastPublishedDate` | DateTime | When it was last published to Online |
| `LastModifiedById` | ID | User who last modified |
| `CreatedById` | ID | User who created |
| `OwnerId` | ID | Current owner |
| `RecordTypeId` | ID | Article type (for multi-type orgs) |
| `ValidationStatus` | Picklist | `Not Validated`, `Validated` |

**Body field (custom per org):**

Lightning Knowledge stores the article body in custom fields added to the `Knowledge__kav` object. Common patterns:

```sql
-- Discover field names for your org:
SELECT QualifiedApiName, Label, DataType
FROM FieldDefinition
WHERE EntityDefinition.QualifiedApiName = 'Knowledge__kav'
AND DataType IN ('RichTextArea', 'TextArea', 'LongTextArea')

-- Typical body field names:
-- Knowledge__c  (org default)
-- Body__c
-- Answer__c
-- Content__c
```

### 5.3 Data Categories

Articles can be classified with hierarchical Data Categories for filtering and permissions.

```sql
-- Query data category selections for articles
SELECT Id, KnowledgeArticleId, DataCategoryGroupName, DataCategoryName
FROM KnowledgeArticleVersionDataCategorySelection
WHERE ParentId IN (SELECT Id FROM Knowledge__kav WHERE PublishStatus = 'Online')

-- Or use SOSL WITH DATA CATEGORY
FIND {api limits} IN ALL FIELDS
RETURNING Knowledge__kav(Id, Title)
WITH DATA CATEGORY Products__c ABOVE API__c
```

Data Category operators: `AT`, `ABOVE`, `BELOW`, `ABOVE_OR_SAME`, `BELOW_OR_SAME`

### 5.4 Article Types (Multi-Type Orgs)

Classic Knowledge (legacy) had separate SObjects per type (e.g. `FAQ__kav`, `How_To__kav`). Lightning Knowledge consolidates all into `Knowledge__kav` with RecordType differentiation. If the org has multiple record types:

```sql
SELECT Id, RecordType.Name, RecordType.DeveloperName, Title
FROM Knowledge__kav
WHERE PublishStatus = 'Online'
AND RecordType.DeveloperName IN ('FAQ', 'How_To', 'Reference')
```

### 5.5 Querying Article Body Content

```typescript
interface KnowledgeArticle {
  Id: string;
  KnowledgeArticleId: string;
  ArticleNumber: string;
  Title: string;
  UrlName: string;
  Summary: string;
  PublishStatus: 'Online' | 'Draft' | 'Archived';
  IsLatestVersion: boolean;
  Language: string;
  LastModifiedDate: string;
  LastPublishedDate: string;
  // Body field — name varies per org, discover at runtime
  Knowledge__c?: string;  // HTML content
  Body__c?: string;
}

async function fetchKnowledgeArticles(
  conn: jsforce.Connection,
  bodyField = 'Knowledge__c',
  cursor?: string,
): Promise<KnowledgeArticle[]> {
  const where = cursor
    ? `AND LastModifiedDate >= ${cursor}`
    : '';

  const soql = `
    SELECT Id, KnowledgeArticleId, ArticleNumber, Title, UrlName,
           Summary, Language, PublishStatus, IsLatestVersion,
           LastModifiedDate, LastPublishedDate, ${bodyField}
    FROM Knowledge__kav
    WHERE PublishStatus = 'Online'
    AND IsLatestVersion = true
    ${where}
    ORDER BY LastModifiedDate DESC
  `;

  return queryAll<KnowledgeArticle>(conn, soql);
}
```

### 5.6 Article Visibility and Guest Access

- By default, Knowledge articles respects Data Category visibility rules and user profile permissions
- For a service account (JWT integration user), ensure the profile has "Read" on `KnowledgeArticleVersion` and the relevant data categories are visible
- Articles not visible to the querying user are silently omitted from results (no error, just missing rows)

---

## 6. ContentDocument and ContentVersion: File Attachments

Files in Salesforce are stored as `ContentDocument` (the container) → `ContentVersion` (specific version) → `ContentDocumentLink` (association to records).

### 6.1 Object Relationship

```
ContentDocument (Id, Title, LatestPublishedVersionId, FileExtension)
    ↓ one-to-many versions
ContentVersion (Id, ContentDocumentId, VersionData [base64], FileType, ContentSize, Title)
    
ContentDocumentLink (ContentDocumentId, LinkedEntityId, ShareType)
    ← links ContentDocument to any SObject (Account, Case, KnowledgeArticleVersion, etc.)
```

### 6.2 Key Fields

**ContentDocument:**

| Field | Type | Description |
|---|---|---|
| `Id` | ID | Document ID |
| `Title` | String | File name |
| `LatestPublishedVersionId` | ID | ID of the latest published version |
| `FileExtension` | String | e.g. `pdf`, `docx`, `png` |
| `FileType` | String | e.g. `PDF`, `WORD`, `IMAGE` |
| `ContentSize` | Integer | Size in bytes |
| `CreatedDate` | DateTime | When uploaded |
| `LastModifiedDate` | DateTime | Last modified |
| `SharingOption` | Picklist | `Allowed`, `Restricted` |

**ContentVersion:**

| Field | Type | Description |
|---|---|---|
| `Id` | ID | Version ID |
| `ContentDocumentId` | ID | Parent document |
| `VersionData` | base64 | Actual file content (only via REST, not SOQL stream) |
| `ContentUrl` | URL | Download URL |
| `Title` | String | Version title |
| `FileType` | String | `PDF`, `WORD`, `EXCEL`, `TEXT`, `IMAGE`, etc. |
| `ContentSize` | Integer | Size in bytes |
| `IsLatest` | Boolean | True for current published version |
| `TextPreview` | String | First 1000 chars of text content (auto-extracted by Salesforce) |
| `Checksum` | String | MD5 hash of the file |

**ContentDocumentLink:**

| Field | Type | Description |
|---|---|---|
| `Id` | ID | Link ID |
| `ContentDocumentId` | ID | Document |
| `LinkedEntityId` | ID | Target record (any SObject) |
| `ShareType` | Picklist | `V` = Viewer, `C` = Collaborator, `I` = Inferred |
| `Visibility` | Picklist | `AllUsers`, `InternalUsers`, `SharedUsers` |

### 6.3 Querying Files Linked to Records

```sql
-- Files linked to Knowledge articles
SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension,
       ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId
FROM ContentDocumentLink
WHERE LinkedEntityId IN (
  SELECT Id FROM Knowledge__kav WHERE PublishStatus = 'Online'
)
AND ContentDocument.FileType IN ('PDF', 'WORD', 'EXCEL', 'TEXT', 'CSV')

-- Get the actual text preview (no download needed for text)
SELECT Id, Title, TextPreview, FileType, ContentSize
FROM ContentVersion
WHERE IsLatest = true
AND ContentDocumentId IN (...)
AND ContentSize < 10000000  -- skip files > 10 MB
```

### 6.4 Downloading File Content

```typescript
async function downloadContentVersion(
  conn: jsforce.Connection,
  contentVersionId: string
): Promise<string | null> {
  // Fetch the download URL
  const version = await conn.sobject('ContentVersion').retrieve(contentVersionId);
  
  // Download via REST (returns raw binary/text)
  const url = `${conn.instanceUrl}/services/data/v${conn.version}/sobjects/ContentVersion/${contentVersionId}/VersionData`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${conn.accessToken}` },
  });

  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text') || contentType.includes('json')) {
    return response.text();
  }

  // For binary (PDF, DOCX), return base64 for downstream text extraction
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
```

**Index strategy for files:**
- Use `TextPreview` field directly for text/HTML files (no download needed)
- Download and extract PDF/DOCX (use `pdf-parse`, `mammoth`) for rich documents
- Skip IMAGE, VIDEO, AUDIO, FLASH file types
- Enforce `ContentSize < 20_000_000` (20 MB) hard limit

---

## 7. Chatter: FeedItem, FeedComment, and Group Feeds

Chatter is Salesforce's internal social network. For knowledge indexing, it captures informal institutional knowledge: decisions, rationale, discussions attached to records.

### 7.1 Chatter Data Model

```
FeedItem (Id, Type, ParentId, Body, LinkUrl, Title, CreatedDate, CreatedById)
  ↓ one-to-many
FeedComment (Id, FeedItemId, CommentBody, CreatedDate, CreatedById)

FeedTrackedChange (Id, FeedItemId, FieldName, OldValue, NewValue)
  → linked to FeedItem.Type = 'TrackedChange'
```

`ParentId` on `FeedItem` links to the record being discussed — can be a `Case`, `Opportunity`, `Account`, `KnowledgeArticleVersion`, `CollaborationGroup`, or `User` (user profile feed).

### 7.2 FeedItem Key Fields

| Field | Type | Description |
|---|---|---|
| `Id` | ID | Feed item ID |
| `Type` | Picklist | See below |
| `ParentId` | ID | The record this feed item is on |
| `Parent.Name` | String | Name of parent record (via relationship query) |
| `Body` | String | Text content of the post |
| `Title` | String | Title (for link/content posts) |
| `LinkUrl` | URL | For LinkPost type |
| `ContentSize` | Integer | Attached file size |
| `ContentType` | String | MIME type if file attached |
| `NetworkScope` | Picklist | For Experience Cloud scope |
| `CreatedDate` | DateTime | Post timestamp |
| `CreatedById` | ID | Poster |
| `CreatedBy.Name` | String | Poster name (via relationship) |
| `IsDeleted` | Boolean | Soft delete flag |
| `LikeCount` | Integer | Number of likes |
| `CommentCount` | Integer | Number of comments |

**FeedItem.Type values for knowledge indexing:**

| Type | Meaning |
|---|---|
| `TextPost` | Plain text post — highest value for knowledge |
| `RichTextPost` | Rich text (HTML) post — high value |
| `LinkPost` | URL with title and description |
| `ContentPost` | File attachment post |
| `AdvancedTextPost` | Mentions and topics included |
| `TrackedChange` | Field change notification — skip for knowledge |
| `CreateRecordEvent` | Record creation — skip |
| `ActivityEvent` | Task/event completion — skip |

### 7.3 SOQL for Chatter

```sql
-- Get knowledge-relevant posts from Case and Knowledge parent records
SELECT Id, Type, Body, Title, LinkUrl, CreatedDate,
       CreatedBy.Name, Parent.Name, CommentCount, LikeCount
FROM FeedItem
WHERE Type IN ('TextPost', 'RichTextPost', 'LinkPost', 'AdvancedTextPost')
AND ParentId IN (
  SELECT Id FROM Case WHERE Status != 'Closed'
  LIMIT 500
)
AND Body != null
AND CreatedDate >= LAST_N_DAYS:180
ORDER BY CreatedDate DESC

-- Get comments on those posts
SELECT Id, FeedItemId, CommentBody, CreatedDate, CreatedBy.Name
FROM FeedComment
WHERE FeedItemId IN (
  SELECT Id FROM FeedItem
  WHERE ParentId IN (SELECT Id FROM Case WHERE Status != 'Closed')
  AND Type IN ('TextPost', 'RichTextPost')
  AND CreatedDate >= LAST_N_DAYS:180
)
ORDER BY CreatedDate ASC
```

### 7.4 Chatter REST API (Non-SOQL)

jsforce wraps the Chatter REST API at `/services/data/vXX.0/chatter/`:

```typescript
const conn = await salesforce.getConnection();

// Feeds for a specific record
const feed = await conn.chatter.resource(`/feeds/record/${recordId}/feed-elements`).retrieve();

// All company-wide feeds
const companyFeed = await conn.chatter.resource('/feeds/company/feed-elements', {
  pageSize: 100,
  sort: 'CreatedDateDesc',
}).retrieve();

// Collaboration Group feeds (team/project channels)
const groups = await conn.chatter.resource('/groups').retrieve();
const groupFeed = await conn.chatter.resource(`/feeds/record/${groups.groups[0].id}/feed-elements`).retrieve();
```

**Verdict:** Use SOQL (`FeedItem`, `FeedComment`) for bulk indexing. Use the Chatter REST API only when you need rich metadata (media attachments, mentions list, etc.) that SOQL doesn't expose.

---

## 8. Bulk API v2: Large Export Job Lifecycle

For large datasets (> 2,000 records or > 5 MB), use Bulk API v2 Query jobs to avoid exhausting SOQL governor limits and memory.

### 8.1 Bulk API v2 vs v1

| Feature | Bulk API v1 | Bulk API v2 |
|---|---|---|
| Format | XML job + CSV batches | Pure CSV with JSON metadata |
| Max records per job | 10M | 100M (practical limit) |
| Parallel batches | Up to 5 | Single stream (simpler) |
| Query support | Yes | Yes |
| Async | Yes | Yes |
| TypeScript types | In jsforce | In jsforce (v3) |
| **Recommendation** | Legacy | **Use v2** |

### 8.2 Job State Machine

```
Create Job (POST /jobs/query)
    ↓
JobCreated (state: Open) — Salesforce auto-transitions for query jobs
    ↓
InProgress — Salesforce processing the query
    ↓
JobComplete — Results ready for download
    or
Failed — Job failed (check errorMessage)
    or
Aborted — You cancelled it
```

For query jobs, you do **not** need to upload CSV or call "UploadComplete" — just create the job and poll.

### 8.3 REST Endpoints

```
POST   /services/data/v61.0/jobs/query        Create query job
GET    /services/data/v61.0/jobs/query/{id}   Poll job status
GET    /services/data/v61.0/jobs/query/{id}/results   Download CSV results
DELETE /services/data/v61.0/jobs/query/{id}   Abort/delete job
```

### 8.4 Complete TypeScript Implementation

```typescript
interface BulkJobRequest {
  operation: 'query' | 'queryAll';
  query: string;
  columnDelimiter?: 'COMMA' | 'TAB' | 'PIPE' | 'SEMICOLON';
  lineEnding?: 'LF' | 'CRLF';
}

interface BulkJobInfo {
  id: string;
  state: 'Open' | 'UploadComplete' | 'InProgress' | 'JobComplete' | 'Failed' | 'Aborted';
  object: string;
  operation: string;
  errorMessage?: string;
  numberRecordsProcessed?: number;
  createdDate: string;
  systemModstamp: string;
}

async function bulkQuery(
  conn: jsforce.Connection,
  soql: string,
  options: { pollInterval?: number; pollTimeout?: number } = {},
): Promise<string[]> {  // returns array of CSV chunks
  const { pollInterval = 5000, pollTimeout = 600_000 } = options;
  const baseUrl = `${conn.instanceUrl}/services/data/v${conn.version}`;
  const headers = {
    Authorization: `Bearer ${conn.accessToken}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Create query job
  const createRes = await fetch(`${baseUrl}/jobs/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operation: 'query',
      query: soql,
      columnDelimiter: 'COMMA',
      lineEnding: 'LF',
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create bulk job: ${await createRes.text()}`);
  }

  const job: BulkJobInfo = await createRes.json();
  const jobId = job.id;

  // Step 2: Poll until complete
  const deadline = Date.now() + pollTimeout;
  let jobInfo: BulkJobInfo;

  while (true) {
    if (Date.now() > deadline) {
      // Abort the job and throw
      await fetch(`${baseUrl}/jobs/query/${jobId}`, {
        method: 'DELETE',
        headers,
      });
      throw new Error(`Bulk query job ${jobId} timed out after ${pollTimeout}ms`);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const pollRes = await fetch(`${baseUrl}/jobs/query/${jobId}`, { headers });
    jobInfo = await pollRes.json();

    if (jobInfo.state === 'JobComplete') break;
    if (jobInfo.state === 'Failed') {
      throw new Error(`Bulk job failed: ${jobInfo.errorMessage}`);
    }
    if (jobInfo.state === 'Aborted') {
      throw new Error(`Bulk job was aborted`);
    }
  }

  // Step 3: Download results (paginated via locator)
  const csvChunks: string[] = [];
  let locator: string | null = null;

  do {
    const url = locator
      ? `${baseUrl}/jobs/query/${jobId}/results?locator=${locator}&maxRecords=50000`
      : `${baseUrl}/jobs/query/${jobId}/results?maxRecords=50000`;

    const resultsRes = await fetch(url, { headers });
    if (!resultsRes.ok) break;

    csvChunks.push(await resultsRes.text());
    locator = resultsRes.headers.get('Sforce-Locator');

    // 'null' string means no more pages
    if (locator === 'null') locator = null;
  } while (locator);

  // Step 4: Clean up job
  await fetch(`${baseUrl}/jobs/query/${jobId}`, {
    method: 'DELETE',
    headers,
  });

  return csvChunks;
}
```

### 8.5 Parsing the CSV Response

```typescript
import { parse } from 'csv-parse/sync';

function parseBulkCsvChunks(chunks: string[]): Record<string, string>[] {
  const records: Record<string, string>[] = [];
  let headers: string[] | null = null;

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;

    const parsed = parse(chunk, {
      columns: headers ? false : true,
      skip_empty_lines: true,
    });

    if (!headers) {
      headers = Object.keys(parsed[0] || {});
      records.push(...parsed);
    } else {
      // Subsequent chunks have no header row — parse as array and zip
      const rows = parse(chunk, { columns: false, skip_empty_lines: true });
      for (const row of rows.slice(1)) { // skip header line in subsequent chunks
        const record: Record<string, string> = {};
        headers.forEach((h, i) => (record[h] = row[i]));
        records.push(record);
      }
    }
  }

  return records;
}
```

**When to use Bulk API v2:**
- Any export query expected to return > 2,000 records
- Full initial sync of `Case`, `KnowledgeArticleVersion`, `FeedItem`
- Scheduled nightly refresh exports

---

## 9. Change Data Capture: Streaming API Real-Time Updates

Salesforce Change Data Capture (CDC) sends real-time change events when records are created, updated, deleted, or undeleted. This powers incremental updates without polling.

### 9.1 Architecture

CDC events are delivered via the Streaming API (CometD protocol, implemented in jsforce via Faye):

```
Salesforce Record Change
    ↓
Platform Event Bus
    ↓ CometD/Bayeux long-polling
Your Server Subscription
    ↓
Index Update
```

**Retention:** CDC events are retained for **3 days**. Use Replay ID to replay missed events after reconnection.

### 9.2 Channel Names

```
/data/KnowledgeArticleVersionChangeEvent   -- Knowledge articles
/data/CaseChangeEvent                       -- Cases
/data/CaseCommentChangeEvent               -- Case comments
/data/FeedItemChangeEvent                  -- Chatter posts
/data/AccountChangeEvent                   -- Accounts
/data/ContactChangeEvent                   -- Contacts
/data/AllChangeEvents                       -- All objects (requires setup, expensive)
```

### 9.3 CDC Event Schema

```json
{
  "schema": "...",
  "payload": {
    "ChangeEventHeader": {
      "entityName": "KnowledgeArticleVersion",
      "recordIds": ["0224000000XXXXX"],
      "changeType": "UPDATE",
      "changeOrigin": "com/salesforce/api/rest/60.0",
      "transactionKey": "...",
      "sequenceNumber": 1,
      "commitTimestamp": 1690000000000,
      "commitNumber": 12345,
      "commitUser": "0054000000YYYYY",
      "nulledFields": ["Summary"],
      "diffFields": ["Title", "LastModifiedDate"],
      "changedFields": ["Title", "LastModifiedDate", "Summary"]
    },
    "Title": "New Article Title",
    "LastModifiedDate": "2026-08-26T10:00:00.000Z"
  },
  "event": {
    "replayId": 98765
  }
}
```

**changeType values:** `CREATE`, `UPDATE`, `DELETE`, `UNDELETE`

**Important:** For `UPDATE` events, only changed fields are included in the payload. Missing fields in payload = unchanged (not null).

### 9.4 jsforce CDC Subscription

```typescript
import * as jsforce from 'jsforce';
import { StreamingExtension } from 'jsforce/api/streaming';

interface ChangeEventMessage {
  event: { replayId: number };
  payload: {
    ChangeEventHeader: {
      entityName: string;
      recordIds: string[];
      changeType: 'CREATE' | 'UPDATE' | 'DELETE' | 'UNDELETE';
      changedFields: string[];
      nulledFields: string[];
      commitTimestamp: number;
      commitUser: string;
    };
    [field: string]: any;
  };
}

class SalesforceCDCListener {
  private replayId: number;

  constructor(
    private readonly conn: jsforce.Connection,
    private readonly channel: string,
    private readonly onEvent: (msg: ChangeEventMessage) => Promise<void>,
    startReplayId = -1,  // -1 = new events only, -2 = all retained (3 days)
  ) {
    this.replayId = startReplayId;
  }

  subscribe(): void {
    const authFailureExt = new StreamingExtension.AuthFailure(() => {
      console.error('Streaming auth failed, reconnecting...');
      // Re-authenticate and re-subscribe
    });

    const replayExt = new StreamingExtension.Replay(this.channel, this.replayId);

    const fayeClient = this.conn.streaming.createClient([
      authFailureExt,
      replayExt,
    ]);

    const subscription = fayeClient.subscribe(
      this.channel,
      async (data: ChangeEventMessage) => {
        try {
          // Persist replay ID for reconnection
          this.replayId = data.event.replayId;
          await this.onEvent(data);
        } catch (err) {
          console.error('CDC handler error:', err);
        }
      },
    );

    console.log(`Subscribed to ${this.channel} from replayId ${this.replayId}`);
  }
}

// Usage
const listener = new SalesforceCDCListener(
  await salesforce.getConnection(),
  '/data/KnowledgeArticleVersionChangeEvent',
  async (msg) => {
    const { changeType, recordIds, changedFields } = msg.payload.ChangeEventHeader;
    
    if (changeType === 'DELETE') {
      await knowledgeIndex.removeArticle(recordIds[0]);
    } else if (changeType === 'UPDATE' && changedFields.length > 0) {
      // Re-fetch the full record and re-index
      await knowledgeIndex.reindexArticle(recordIds[0]);
    } else if (changeType === 'CREATE') {
      await knowledgeIndex.indexArticle(recordIds[0]);
    }
  },
  -2,  // Replay all events from last 3 days on startup
);

listener.subscribe();
```

### 9.5 CDC Enablement Requirements

CDC must be explicitly enabled for each object in Salesforce Setup:

- **Setup → Integrations → Change Data Capture**
- Select the objects you want (Knowledge, Case, etc.)
- **Platform: Enterprise, Unlimited, Performance** editions only — not Professional/Essentials

**Gotcha:** Enabling CDC on Knowledge counts against your total CDC entity allowance. Check your org's CDC limits before enabling too many objects.

### 9.6 Streaming API Limits

| Resource | Limit |
|---|---|
| Concurrent CometD clients | 1,000 per org |
| Events per hour (retained) | 100,000 |
| Max stored event retention | 3 days |
| Max subscriptions per client | 1,000 channels |

---

## 10. Field-Level Security and Record-Level Sharing

### 10.1 How Salesforce Security Works

Every API call executes in the context of the **authenticated user's permissions**:

1. **Object-level security (OLS):** Can the user see/edit this SObject type at all?
2. **Field-level security (FLS):** Can the user see each field?
3. **Record-level sharing:** Which specific records can the user see?

For a JWT integration user (service account), the profile and permission sets determine all three.

### 10.2 FLS Behavior in Queries

Fields not visible to the querying user are **silently omitted** from SOQL results — no error. This is a critical source of silent data loss.

```sql
-- Enforce FLS (throws FIELD_INTEGRITY_EXCEPTION on FLS violation instead of silent omit)
SELECT Id, Name, Email
FROM Contact
WITH SECURITY_ENFORCED

-- User mode (introduced API v56) — enforce all sharing, FLS, CRUD
SELECT Id, Name FROM Account
WITH USER_MODE
```

**Recommendation for MCP connector:** Use `WITH USER_MODE` or `WITH SECURITY_ENFORCED` in SOQL that will be executed in user context. For the service account (background sync), omit these clauses and ensure the integration user has full read access.

### 10.3 Integration User Setup Best Practices

The JWT integration user should have:
- A dedicated Profile with "Modify All Data" permission OR explicit object-level read permissions
- Disable "Two-Factor Authentication" for API logins on the profile
- Set "Session Timeout" to Never (prevent auto-expiry)
- IP restrictions: lock to your server IP(s)
- Enable "API Enabled" on the profile

### 10.4 Record Sharing for Per-User Context

If the MCP server needs to enforce per-user record-level security (e.g. "show this user only the articles they can see"), you have two options:

**Option A: User-specific OAuth tokens (not viable for background sync):**
- User logs in via OAuth 2.0, gets their own access_token
- Execute queries with that token — Salesforce enforces their sharing rules

**Option B: SOSL WITH NETWORK + Data Category visibility:**
- Restrict via structural filters (data categories, record types, sharing)
- Cannot fully replicate row-level sharing rules without user context

**Recommendation:** For Phase 2 MCP enterprise knowledge index, use the integration service account for bulk sync (reads everything), then enforce visibility at search time using the user's Salesforce identity (via Entra ID / SSO linkage). This mirrors how the SharePoint connector works.

---

## 11. Incremental Sync Patterns

### 11.1 Standard Timestamp Fields

Every standard Salesforce SObject has these system fields:

| Field | Description | Indexed |
|---|---|---|
| `CreatedDate` | When record was created | Yes |
| `LastModifiedDate` | Last time any field was modified | Yes |
| `SystemModstamp` | Last modified by system OR user (includes automation) | Yes |

For incremental sync, use `SystemModstamp` (not `LastModifiedDate`) because it captures changes made by workflows, triggers, and automation that don't update `LastModifiedDate`.

### 11.2 Cursor-Based Incremental Sync

```typescript
class SalesforceIncrementalSync {
  private cursor: Date | null = null;

  async syncKnowledgeArticles(conn: jsforce.Connection): Promise<void> {
    const since = this.cursor
      ? this.cursor.toISOString()
      : new Date(0).toISOString();

    const soql = `
      SELECT Id, KnowledgeArticleId, Title, Summary, PublishStatus,
             IsLatestVersion, Language, LastModifiedDate, SystemModstamp,
             Knowledge__c
      FROM Knowledge__kav
      WHERE SystemModstamp >= ${since}
      AND IsLatestVersion = true
      ORDER BY SystemModstamp ASC
    `;

    const articles = await queryAll<KnowledgeArticle>(conn, soql);

    for (const article of articles) {
      if (article.PublishStatus === 'Archived' || article.IsDeleted) {
        await this.removeFromIndex(article.Id);
      } else if (article.PublishStatus === 'Online') {
        await this.upsertToIndex(article);
      }
      // Track cursor as max seen SystemModstamp
      const ts = new Date(article.SystemModstamp ?? article.LastModifiedDate);
      if (!this.cursor || ts > this.cursor) {
        this.cursor = ts;
      }
    }

    await this.persistCursor(this.cursor!);
  }
}
```

### 11.3 Deletion Detection

**The hard problem:** SOQL cannot query deleted records by default. `queryAll` (using `ALL ROWS` in SOQL or `scanAll: true` in jsforce) returns deleted and archived records, but Knowledge's behavior differs:

```sql
-- Query deleted records (including soft-deleted)
SELECT Id, IsDeleted, LastModifiedDate
FROM Knowledge__kav
WHERE SystemModstamp >= 2026-08-01T00:00:00Z
  ALL ROWS   -- SOQL keyword to include deleted
```

```typescript
// jsforce: use scanAll option
const result = await conn.query<KnowledgeArticle>(soql, { scanAll: true });
// scanAll: true includes records in the Recycle Bin
```

**Alternative deletion detection:** Use CDC (`/data/KnowledgeArticleVersionChangeEvent`) to catch DELETE events in real-time. Fall back to periodic full-sync diff for hard deletes that pre-date CDC retention (3 days).

### 11.4 Deleted Records API

```typescript
// Get IDs of records deleted in a time window
const deleted = await conn.sobject('Knowledge__kav').deleted(
  new Date('2026-08-19T00:00:00Z'),
  new Date('2026-08-26T00:00:00Z'),
);
// Returns: { deletedRecords: [{id: '...', deletedDate: '...'}], earliestDateAvailable: '...', latestDateCovered: '...' }
```

---

## 12. Governor Limits and API Call Budget Management

### 12.1 Salesforce API Daily Limits

| Edition | API Calls per Day |
|---|---|
| Developer Edition | 15,000 |
| Essentials | 100 × user licenses |
| Professional | 1,000 × user licenses |
| Enterprise | 1,000 × user licenses |
| Unlimited | 5,000 × user licenses |
| Performance | 5,000 × user licenses |

Additional: Bulk API v2 query jobs use separate "Bulk API Query" limits (500 jobs per 24 hours, not counted against REST API limits).

**Example:** An Enterprise org with 100 users = 100,000 API calls/day. A single SOQL query returning 10 pages = 10 API calls.

### 12.2 Check Remaining Limits at Runtime

```typescript
// GET /services/data/v61.0/limits
const limits = await conn.request('/services/data/v61.0/limits');
console.log({
  dailyApiRequests: limits.DailyApiRequests,
  dailyBulkApiRequests: limits.DailyBulkApiRequests,
  massEmailsPerDay: limits.MassEmail,
  streamingApiConcurrentClients: limits.StreamingApiConcurrentClients,
});

// LimitInfo header on every REST response
// X-Salesforce-Limits: api-usage=1234/100000
conn.on('response', (res: HttpResponse) => {
  const limitHeader = res.headers?.['sforce-limit-info'];
  if (limitHeader) {
    // "api-usage=1234/100000"
    const match = limitHeader.match(/api-usage=(\d+)\/(\d+)/);
    if (match) {
      const used = parseInt(match[1]);
      const max = parseInt(match[2]);
      if (used / max > 0.8) {
        console.warn(`API limit warning: ${used}/${max} (${Math.round(used/max*100)}%)`);
      }
    }
  }
});
```

### 12.3 Rate Limiting Strategies

```typescript
class SalesforceRateLimiter {
  private requestQueue: Array<() => Promise<any>> = [];
  private inFlight = 0;
  private readonly maxConcurrent = 5;  // Stay well under concurrent call limits
  private requestsThisMinute = 0;
  private minuteWindow = Date.now();

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Reset per-minute counter
    if (Date.now() - this.minuteWindow > 60_000) {
      this.requestsThisMinute = 0;
      this.minuteWindow = Date.now();
    }

    // Throttle to ~60 requests/minute (conservative)
    if (this.requestsThisMinute >= 60) {
      const wait = 60_000 - (Date.now() - this.minuteWindow);
      await new Promise(r => setTimeout(r, wait));
    }

    this.requestsThisMinute++;
    return fn();
  }
}
```

**Budget rules for the MCP connector:**
1. **Full initial sync:** Use Bulk API v2 for any object with > 10,000 records (does not count against REST limits)
2. **Incremental polling:** Poll no more than once every 5 minutes for most objects
3. **Real-time updates:** Prefer CDC (Streaming API) — it uses a persistent connection, not per-record API calls
4. **Search queries:** SOSL counts as 1 API call regardless of result count — use for agent queries
5. **Metadata/describe calls:** Cache aggressively (1 hour TTL) — describe calls are expensive

### 12.4 SOQL Query Governor Limits

Beyond daily API limits, individual SOQL queries have their own limits:

| Resource | Limit |
|---|---|
| Total records returned per query | 50,000 (synchronous SOQL) |
| Rows scanned per query (large objects) | 200,000 |
| SOQL queries in one transaction | 100 |
| SOSL searches per transaction | 20 |
| Subquery levels | 5 |
| Fields per SOQL query | 200 |
| Characters in SOQL query string | 100,000 |

Use Bulk API v2 for any query expected to return > 50,000 records.

---

## 13. Complete TypeScript Salesforce Connector

```typescript
/**
 * SalesforceConnector: Production implementation for markdown-for-agents-mcp
 * Covers: JWT auth, Knowledge articles, Cases, Chatter, bulk sync
 * 
 * Dependencies:
 *   npm install jsforce jsonwebtoken csv-parse
 *   npm install -D @types/jsforce @types/jsonwebtoken
 */

import * as jsforce from 'jsforce';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import { parse as parseCsv } from 'csv-parse/sync';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface SalesforceConfig {
  clientId: string;
  username: string;
  privateKeyPath?: string;
  privateKey?: string;
  loginUrl: string;
  apiVersion: string;
  knowledgeBodyField: string;  // org-specific: 'Knowledge__c', 'Body__c', etc.
}

// ─── Connection Manager ───────────────────────────────────────────────────────

export class SalesforceConnector {
  private conn: jsforce.Connection | null = null;
  private tokenExpiry = 0;
  private readonly TOKEN_GRACE_MS = 10 * 60 * 1000; // Re-auth 10 min before expiry

  constructor(private readonly config: SalesforceConfig) {}

  async getConnection(): Promise<jsforce.Connection> {
    if (this.conn && Date.now() < this.tokenExpiry - this.TOKEN_GRACE_MS) {
      return this.conn;
    }
    return this._authenticate();
  }

  private async _authenticate(): Promise<jsforce.Connection> {
    const privateKey = this.config.privateKey
      || fs.readFileSync(this.config.privateKeyPath!, 'utf8');

    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: this.config.clientId,
      sub: this.config.username,
      aud: this.config.loginUrl,
      exp: now + 180,
    };

    const assertion = jwt.sign(claim, privateKey, { algorithm: 'RS256' });

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const res = await fetch(`${this.config.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`Salesforce JWT auth failed: ${await res.text()}`);
    }

    const token = await res.json() as {
      access_token: string;
      instance_url: string;
    };

    this.conn = new jsforce.Connection({
      instanceUrl: token.instance_url,
      accessToken: token.access_token,
      version: this.config.apiVersion,
    });

    this.tokenExpiry = Date.now() + 2 * 60 * 60 * 1000; // Tokens valid for 2h
    return this.conn;
  }

  // ─── Pagination Helper ────────────────────────────────────────────────────

  async queryAll<T>(soql: string): Promise<T[]> {
    const conn = await this.getConnection();
    const records: T[] = [];
    let result = await conn.query<T>(soql);
    records.push(...result.records);
    while (!result.done && result.nextRecordsUrl) {
      result = await conn.queryMore<T>(result.nextRecordsUrl);
      records.push(...result.records);
    }
    return records;
  }

  // ─── Knowledge Articles ───────────────────────────────────────────────────

  async getKnowledgeArticles(options: {
    cursor?: string;
    language?: string;
    limit?: number;
  } = {}): Promise<KnowledgeArticle[]> {
    const { cursor, language = 'en_US', limit = 2000 } = options;
    const bodyField = this.config.knowledgeBodyField;

    const whereClause = [
      `PublishStatus = 'Online'`,
      `IsLatestVersion = true`,
      language ? `Language = '${language}'` : '',
      cursor ? `SystemModstamp >= ${cursor}` : '',
    ].filter(Boolean).join(' AND ');

    const soql = `
      SELECT Id, KnowledgeArticleId, ArticleNumber, Title, UrlName, Summary,
             Language, PublishStatus, VersionNumber, IsLatestVersion,
             LastModifiedDate, LastPublishedDate, SystemModstamp,
             ${bodyField}
      FROM Knowledge__kav
      WHERE ${whereClause}
      ORDER BY SystemModstamp ASC
      LIMIT ${limit}
    `;

    const records = await this.queryAll<any>(soql);
    return records.map(r => ({
      id: r.Id,
      articleId: r.KnowledgeArticleId,
      articleNumber: r.ArticleNumber,
      title: r.Title,
      urlName: r.UrlName,
      summary: r.Summary ?? '',
      language: r.Language,
      publishStatus: r.PublishStatus,
      body: r[bodyField] ?? '',
      lastModified: r.SystemModstamp ?? r.LastModifiedDate,
      lastPublished: r.LastPublishedDate,
    }));
  }

  async discoverKnowledgeBodyField(): Promise<string> {
    const conn = await this.getConnection();
    const desc = await conn.sobject('Knowledge__kav').describe();
    const bodyField = desc.fields.find(f =>
      (f.type === 'textarea' || f.type === 'richTextArea') &&
      (f.name.toLowerCase().includes('body') ||
       f.name.toLowerCase().includes('knowledge') ||
       f.name.toLowerCase().includes('answer') ||
       f.name.toLowerCase().includes('content'))
    );
    return bodyField?.name ?? 'Knowledge__c';
  }

  // ─── Cases ────────────────────────────────────────────────────────────────

  async getCases(cursor?: string): Promise<Case[]> {
    const whereClause = cursor
      ? `SystemModstamp >= ${cursor}`
      : `CreatedDate >= LAST_N_DAYS:365`;

    const soql = `
      SELECT Id, CaseNumber, Subject, Description, Status, Priority, Type,
             Origin, AccountId, Account.Name, ContactId, Contact.Name,
             OwnerId, Owner.Name, CreatedDate, LastModifiedDate, SystemModstamp,
             IsClosed, IsEscalated, ClosedDate,
             (SELECT Id, CommentBody, CreatedDate, CreatedBy.Name
              FROM CaseComments
              ORDER BY CreatedDate ASC LIMIT 50)
      FROM Case
      WHERE ${whereClause}
      ORDER BY SystemModstamp ASC
    `;

    return this.queryAll<Case>(soql);
  }

  // ─── Chatter FeedItems ────────────────────────────────────────────────────

  async getChatterFeed(options: {
    parentIds?: string[];
    cursor?: string;
    types?: string[];
  } = {}): Promise<ChatterPost[]> {
    const { cursor, types = ['TextPost', 'RichTextPost', 'AdvancedTextPost'] } = options;
    const typeList = types.map(t => `'${t}'`).join(', ');

    let parentFilter = '';
    if (options.parentIds?.length) {
      const ids = options.parentIds.map(id => `'${id}'`).join(', ');
      parentFilter = `AND ParentId IN (${ids})`;
    }

    const dateFilter = cursor
      ? `AND SystemModstamp >= ${cursor}`
      : `AND CreatedDate >= LAST_N_DAYS:90`;

    const soql = `
      SELECT Id, Type, Body, Title, LinkUrl, CreatedDate, SystemModstamp,
             CreatedBy.Name, Parent.Name, CommentCount, LikeCount,
             (SELECT Id, CommentBody, CreatedDate, CreatedBy.Name
              FROM FeedComments ORDER BY CreatedDate ASC LIMIT 20)
      FROM FeedItem
      WHERE Type IN (${typeList})
      ${parentFilter}
      ${dateFilter}
      AND Body != null
      ORDER BY SystemModstamp ASC
      LIMIT 2000
    `;

    return this.queryAll<ChatterPost>(soql);
  }

  // ─── Bulk Export ──────────────────────────────────────────────────────────

  async bulkQuery(soql: string): Promise<Record<string, string>[]> {
    const conn = await this.getConnection();
    const baseUrl = `${conn.instanceUrl}/services/data/v${conn.version}`;
    const headers = {
      Authorization: `Bearer ${conn.accessToken}`,
      'Content-Type': 'application/json',
    };

    const createRes = await fetch(`${baseUrl}/jobs/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation: 'query', query: soql, columnDelimiter: 'COMMA', lineEnding: 'LF' }),
    });

    if (!createRes.ok) {
      throw new Error(`Bulk job create failed: ${await createRes.text()}`);
    }

    const { id: jobId } = await createRes.json();

    // Poll job
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch(`${baseUrl}/jobs/query/${jobId}`, { headers });
      const info = await pollRes.json();
      if (info.state === 'JobComplete') break;
      if (info.state === 'Failed') throw new Error(`Bulk job failed: ${info.errorMessage}`);
    }

    // Download results
    const allRecords: Record<string, string>[] = [];
    let locator: string | null = null;
    let firstChunk = true;

    do {
      const url = `${baseUrl}/jobs/query/${jobId}/results?maxRecords=50000${locator ? `&locator=${locator}` : ''}`;
      const res = await fetch(url, { headers });
      const csv = await res.text();
      const rows = parseCsv(csv, {
        columns: firstChunk,
        skip_empty_lines: true,
      }) as Record<string, string>[];
      allRecords.push(...rows);
      firstChunk = false;
      locator = res.headers.get('Sforce-Locator');
      if (locator === 'null') locator = null;
    } while (locator);

    // Cleanup
    await fetch(`${baseUrl}/jobs/query/${jobId}`, { method: 'DELETE', headers });
    return allRecords;
  }

  // ─── SOSL Search ─────────────────────────────────────────────────────────

  async search(query: string, options: {
    objects?: string[];
    limit?: number;
  } = {}): Promise<SearchResult[]> {
    const conn = await this.getConnection();
    const { objects = ['Knowledge__kav', 'Case'], limit = 50 } = options;

    const returning = objects.map(obj => {
      if (obj === 'Knowledge__kav') {
        return `Knowledge__kav(Id, Title, Summary, UrlName WHERE PublishStatus = 'Online' LIMIT ${limit})`;
      }
      if (obj === 'Case') {
        return `Case(Id, CaseNumber, Subject, Status LIMIT ${limit})`;
      }
      return `${obj}(Id, Name LIMIT ${limit})`;
    }).join(', ');

    // Escape special SOSL characters
    const escaped = query.replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, '\\$&');
    const sosl = `FIND {${escaped}} IN ALL FIELDS RETURNING ${returning}`;

    const result = await conn.search(sosl);
    return result.searchRecords as SearchResult[];
  }
}

// ─── Type Definitions ──────────────────────────────────────────────────────

export interface KnowledgeArticle {
  id: string;
  articleId: string;
  articleNumber: string;
  title: string;
  urlName: string;
  summary: string;
  language: string;
  publishStatus: string;
  body: string;
  lastModified: string;
  lastPublished: string;
}

export interface Case {
  Id: string;
  CaseNumber: string;
  Subject: string;
  Description: string | null;
  Status: string;
  Priority: string;
  Account?: { Name: string };
  CaseComments?: { records: CaseComment[] };
  LastModifiedDate: string;
  SystemModstamp: string;
}

export interface CaseComment {
  Id: string;
  CommentBody: string;
  CreatedDate: string;
  CreatedBy: { Name: string };
}

export interface ChatterPost {
  Id: string;
  Type: string;
  Body: string | null;
  Title: string | null;
  CreatedDate: string;
  SystemModstamp: string;
  CreatedBy: { Name: string };
  Parent: { Name: string };
  FeedComments?: { records: Array<{ CommentBody: string; CreatedDate: string; CreatedBy: { Name: string } }> };
}

export interface SearchResult {
  Id: string;
  [field: string]: any;
}
```

---

## 14. Limitations, Edge Cases, and Gotchas

### 14.1 Critical Gotchas

**1. Knowledge body field is not standard**
The Knowledge article body is stored in a custom field unique to each org. The field name is NOT `Body`, it's something like `Knowledge__c`, `Body__c`, or `Answer__c`. You MUST call `describe()` on `Knowledge__kav` to discover it before querying.

**2. Classic Knowledge vs Lightning Knowledge**
Classic Knowledge (legacy) has multiple SObjects: `FAQ__kav`, `How_To__kav`, etc. You must query each separately. Lightning Knowledge consolidates all into `Knowledge__kav`. Use `describeGlobal()` to detect which model the org uses:
```typescript
const globals = await conn.describeGlobal();
const isLightningKnowledge = globals.sobjects.some(s => s.name === 'Knowledge__kav');
const isClassicKnowledge = globals.sobjects.some(s => s.name.endsWith('__kav') && s.name !== 'Knowledge__kav');
```

**3. FLS silently drops fields**
If the integration user lacks FLS access to a field, SOQL results simply omit that field. There is no error. Always test with `WITH SECURITY_ENFORCED` in dev to catch FLS issues.

**4. JWT expiry is 3-minute maximum**
JWT `exp` must be within 3 minutes of Salesforce's server clock. If your server clock drifts (NTP issues), you'll get `invalid_grant` errors. Use `exp = Math.floor(Date.now()/1000) + 180` exactly.

**5. Sandbox vs Production consumer keys differ**
A Connected App created in sandbox has a different Consumer Key than production. Production and sandbox orgs are completely independent Salesforce instances.

**6. Bulk API v2 CSV Sforce-Locator header**
The Sforce-Locator header value is `'null'` (the string "null") when there are no more pages, not `null`. Check `locator === 'null'` to stop pagination.

**7. Knowledge articles need `WITH DATA CATEGORY` filter for category-gated articles**
Articles protected by Data Category visibility rules are invisible to users without those categories. The integration user's profile must have the appropriate Data Category Group Visibility settings.

**8. SOQL LIMIT 50000 is a hard ceiling for synchronous queries**
Trying to fetch > 50,000 records in a single synchronous SOQL query throws `TOO_MANY_ROWS`. Use Bulk API v2 or paginate with `nextRecordsUrl`.

**9. FeedItem does not support `queryAll` with `ALL ROWS`**
The Chatter FeedItem SObject does not support the `ALL ROWS` SOQL keyword to retrieve deleted items. Use the `getDeleted` REST endpoint instead.

**10. Connected App pre-authorization is required for JWT flow**
After enabling "Use Digital Signatures" on the Connected App, you MUST navigate to **Manage → Edit Policies** and set "Permitted Users" to "Admin approved users are pre-authorized", then explicitly add the integration user's profile or permission set. Failing to do this produces `invalid_app_access` errors.

### 14.2 Performance Pitfalls

**Long-running SOQL on FeedItem:** The `FeedItem` object can have tens of millions of rows in a busy org. Always include a date filter (`CreatedDate >= LAST_N_DAYS:n`) to avoid full table scans.

**Subquery row limits:** A nested SELECT (child relationship) can return a maximum of 200 rows. If cases have more than 200 comments, paginate the comments separately.

**ContentVersion.VersionData:** Downloading file content (the `VersionData` field) is NOT available via standard SOQL. You must make a separate REST call to `/services/data/vXX.0/sobjects/ContentVersion/{id}/VersionData`. Each download = 1 API call.

**Streaming API reconnection:** The Faye/CometD connection drops after 30 minutes of inactivity (Salesforce's keepalive timeout). Implement reconnection logic with replay ID persistence.

### 14.3 Data Quality Issues

- **Rich text / HTML in article body:** Lightning Knowledge bodies are HTML (stored as rich text area). Strip HTML before indexing — use `html-to-text` or `turndown` (HTML to Markdown).
- **Duplicate records:** Salesforce orgs frequently have duplicate accounts/contacts. Use `ArticleNumber` (not `Id`) as the stable identifier for deduplication in the index.
- **Multilingual articles:** The same article can exist in multiple languages as separate rows with different `Language` values but the same `KnowledgeArticleId`. Index all languages, tag by language in metadata.

---

## 15. What to Build, What to Skip

### 15.1 Build in Phase 2

| Feature | Why | Priority |
|---|---|---|
| JWT Bearer auth | Required for everything else | P0 |
| `Knowledge__kav` sync | Highest information density | P0 |
| Bulk API v2 query jobs | Scale past 50K records without burning limits | P0 |
| `Case` + `CaseComment` sync | Problem/resolution pairs for support RAG | P1 |
| Incremental sync via `SystemModstamp` | Daily refresh without full scans | P1 |
| SOSL search endpoint | Agent-facing MCP tool (cross-object search) | P1 |
| Field discovery (`describeGlobal` + `describe`) | Knowledge body field detection | P1 |
| `FeedItem` Chatter sync (filtered) | Institutional knowledge in conversations | P2 |
| ContentDocument/ContentVersion (text files) | Supporting documents linked to articles/cases | P2 |
| CDC Streaming subscription | Real-time index updates | P2 |

### 15.2 Skip for Now

| Feature | Why to Skip |
|---|---|
| Metadata API (deployments) | Not relevant to knowledge indexing |
| Apex REST / Apex triggers | Requires org customization, not self-serve |
| Tooling API | Code and test management — out of scope |
| Analytics / Reports API | Different use case, handled separately |
| CPQ / Industries clouds | Too org-specific |
| Classic Knowledge (`FAQ__kav` etc.) | Deprecated; Lightning migration path required |
| Salesforce GraphQL API | Beta, limited coverage vs SOQL; adds complexity with no clear win |
| Salesforce Data Cloud / CDP | Different product, separate auth model |
| Community/Experience Cloud feeds | Requires separate network context; niche use case |
| Email-to-Case threads | High noise, low signal |

### 15.3 MCP Tool Design for Salesforce

For the markdown-for-agents-mcp MCP server, expose these as callable tools:

```typescript
// Tool: salesforce_search
// Input: { query: string, objects?: string[], limit?: number }
// Output: ranked results from SOSL across Knowledge + Cases

// Tool: salesforce_get_article
// Input: { articleId: string }  (KnowledgeArticleId — stable across versions)
// Output: full article with body converted to markdown

// Tool: salesforce_get_case
// Input: { caseId: string } or { caseNumber: string }
// Output: case + comments thread

// Tool: salesforce_get_related_cases
// Input: { accountId: string } or { contactId: string }
// Output: list of cases with status and subject

// Internal (sync, not agent-facing):
// - bulkExportKnowledge()
// - syncKnowledgeIncremental(cursor)
// - syncCasesIncremental(cursor)
// - subscribeToChanges()
```

### 15.4 HTML Body to Markdown Pipeline

```typescript
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Remove Salesforce-specific markup
turndown.addRule('salesforce-component', {
  filter: ['c-rich-text-format', 'lightning-formatted-rich-text'],
  replacement: (content: string) => content,
});

function articleBodyToMarkdown(html: string): string {
  if (!html) return '';
  return turndown.turndown(html).trim();
}
```

### 15.5 Index Schema Recommendation

```typescript
// Unified document schema for Salesforce content
interface SalesforceIndexDocument {
  id: string;                    // Salesforce record ID
  externalId: string;            // Stable: KnowledgeArticleId, CaseNumber
  source: 'salesforce';
  type: 'knowledge_article' | 'case' | 'chatter_post' | 'case_comment';
  title: string;
  body: string;                  // Markdown-converted
  url: string;                   // Deep link to Salesforce record
  metadata: {
    articleNumber?: string;
    caseNumber?: string;
    status?: string;
    language?: string;
    categories?: string[];
    createdAt: string;
    updatedAt: string;
    author?: string;
    parentId?: string;           // For comments/chatter: parent record ID
    parentName?: string;
  };
  // For ACL enforcement (Phase 2)
  dataCategories?: string[];     // Data category paths for visibility
  ownerProfileId?: string;
}
```

---

## Appendix: Quick Reference

### API Endpoints Summary

```
# REST API base
https://{instanceUrl}/services/data/v{version}/

# SOQL query
GET  /query?q={SOQL}
GET  /queryMore/{locator}

# SOSL search
GET  /search?q={SOSL}

# SObject CRUD
GET  /sobjects/{Object}/{id}
POST /sobjects/{Object}/
PATCH /sobjects/{Object}/{id}
DELETE /sobjects/{Object}/{id}

# Describe
GET  /sobjects/
GET  /sobjects/{Object}/describe/

# Limits
GET  /limits/

# Bulk API v2
POST   /jobs/query
GET    /jobs/query/{id}
GET    /jobs/query/{id}/results
DELETE /jobs/query/{id}

# OAuth
POST https://login.salesforce.com/services/oauth2/token

# Streaming (CometD)
POST https://{instanceUrl}/cometd/{version}
```

### SOQL Date Literals Quick Reference

```
TODAY  YESTERDAY  TOMORROW
THIS_WEEK  LAST_WEEK  NEXT_WEEK
THIS_MONTH  LAST_MONTH  NEXT_MONTH
THIS_QUARTER  LAST_QUARTER  NEXT_QUARTER
THIS_YEAR  LAST_YEAR  NEXT_YEAR
LAST_N_DAYS:n  NEXT_N_DAYS:n
LAST_N_WEEKS:n  NEXT_N_WEEKS:n
LAST_N_MONTHS:n  NEXT_N_MONTHS:n
LAST_N_QUARTERS:n  NEXT_N_QUARTERS:n
LAST_N_YEARS:n  NEXT_N_YEARS:n
LAST_N_HOURS:n  NEXT_N_HOURS:n (DateTime only)
```

### jsforce npm

```bash
npm install jsforce
npm install -D @types/jsforce
# Current stable: 3.10.23 (as of Aug 2026)
# TypeScript built-in: yes (v2.0+)
# Supports: REST, SOQL, SOSL, Bulk v1 & v2, Chatter, Streaming, Metadata, Tooling
```
