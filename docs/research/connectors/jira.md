# Jira Connector Research

**Purpose:** Implementation guide for a Jira connector in markdown-for-agents-mcp  
**Scope:** REST API v3, JQL mastery, all issue types, incremental sync, TypeScript  
**Last updated:** 2026-08-26  
**Sources:** Atlassian developer docs, API reference pages fetched directly

---

## Table of Contents

1. [Platform Landscape](#1-platform-landscape)
2. [Authentication](#2-authentication)
3. [API Structure Overview](#3-api-structure-overview)
4. [Issue Search — The Core Endpoint](#4-issue-search--the-core-endpoint)
5. [JQL Reference](#5-jql-reference)
6. [Issue Fields and Schema](#6-issue-fields-and-schema)
7. [Issue Subtypes and Hierarchy](#7-issue-subtypes-and-hierarchy)
8. [Attachments](#8-attachments)
9. [Comments](#9-comments)
10. [Worklogs](#10-worklogs)
11. [Issue History / Changelog](#11-issue-history--changelog)
12. [Project Structure](#12-project-structure)
13. [Permissions and ACL Enforcement](#13-permissions-and-acl-enforcement)
14. [Webhooks](#14-webhooks)
15. [Incremental Sync Strategy](#15-incremental-sync-strategy)
16. [Jira Cloud vs Data Center Differences](#16-jira-cloud-vs-data-center-differences)
17. [Rate Limits and Error Handling](#17-rate-limits-and-error-handling)
18. [Complete TypeScript Connector Implementation](#18-complete-typescript-connector-implementation)
19. [What to Build and What to Skip](#19-what-to-build-and-what-to-skip)
20. [Failure Modes and Gotchas](#20-failure-modes-and-gotchas)

---

## 1. Platform Landscape

### Deployment Models (2026)

Jira has three deployment models with meaningfully different API surfaces:

| Deployment | API Base URL | Auth Methods | Notes |
|---|---|---|---|
| **Jira Cloud** | `https://{domain}.atlassian.net/rest/api/3/` | API Token, OAuth 2.0 (3LO) | All new features land here first |
| **Jira Data Center** | `https://{host}/rest/api/2/` or `/3/` | PAT, OAuth 1.0a, Basic | DC enters read-only shutdown March 2029 |
| **Jira Server** | `https://{host}/rest/api/2/` | Basic auth, OAuth 1.0a | End-of-life Feb 2024, no new installs |

**Decision for this connector:** Build Cloud-first using API v3. Provide a compatibility shim for Data Center since many enterprise clients still run it (the shutdown deadline is March 2029). Skip Server.

### API Version Differences: v2 vs v3

The official position from Atlassian (source: `developer.atlassian.com/cloud/jira/platform/rest/v3/`):

> Version 2 and version 3 of the API offer the same collection of operations. However, version 3 provides support for the Atlassian Document Format (ADF) in: body in comments, description fields, and worklog comments.

**Always use v3 for Cloud.** The ADF format is what Jira Cloud actually stores — v2 returns a stripped plain-text fallback. For Data Center, v3 may not be available; use v2 and handle plain text strings.

---

## 2. Authentication

### 2.1 API Token (Cloud — Server-to-Server)

The simplest method for service accounts and connectors. Tokens are scoped to the user account that creates them.

**How it works:**
1. User logs into `id.atlassian.com` and generates an API token.
2. Token is used with Basic auth: `username:token` encoded as Base64.
3. No expiry on tokens unless the user revokes them.

```typescript
import fetch from 'node-fetch';

const JIRA_HOST = 'https://your-domain.atlassian.net';
const JIRA_EMAIL = 'bot@example.com';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;

const headers = {
  'Authorization': `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

async function jiraGet(path: string): Promise<unknown> {
  const res = await fetch(`${JIRA_HOST}/rest/api/3${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status}: ${body}`);
  }
  return res.json();
}
```

**Gotcha:** API tokens are tied to the creating user. If that user is deprovisioned (e.g., employee leaves), all tokens die. Use a dedicated service account with a permanent license.

### 2.2 OAuth 2.0 (3LO) — Cloud, User-delegated

Use when you need to act on behalf of end users (e.g., returning only issues the user can see).

**Flow:**
1. Register an app in the Atlassian Developer Console.
2. Redirect user to Atlassian's OAuth 2.0 authorization URL.
3. Exchange the authorization code for access/refresh tokens.
4. Use Bearer token in requests.

```typescript
// OAuth 2.0 token exchange
const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code',
    client_id: process.env.ATLASSIAN_CLIENT_ID,
    client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
    code: authorizationCode,
    redirect_uri: 'https://your-app.com/callback',
  }),
});

const { access_token, refresh_token, expires_in } = await tokenResponse.json();

// Use Bearer token
const headers = {
  'Authorization': `Bearer ${access_token}`,
  'Accept': 'application/json',
};
```

**OAuth Scopes needed for read-only connector:**
- `read:jira-work` — Classic scope covering all read operations
- Or granular scopes: `read:issue-details:jira`, `read:attachment:jira`, `read:comment:jira`, `read:issue-worklog:jira`

**Token expiry:** Access tokens expire after 1 hour. Use refresh token to get a new one.

```typescript
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.ATLASSIAN_CLIENT_ID,
      client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  return data.access_token;
}
```

### 2.3 Personal Access Tokens (Data Center)

Data Center uses PATs instead of API tokens. PATs are generated in the user's profile settings in Jira DC and are used with Basic auth (or Bearer).

```typescript
// Data Center with PAT
const DC_PAT = process.env.JIRA_DC_PAT!;

// Method 1: Bearer (preferred for DC)
const headers = { 'Authorization': `Bearer ${DC_PAT}` };

// Method 2: Basic auth with empty username (also supported)
const headers2 = {
  'Authorization': `Basic ${Buffer.from(`:${DC_PAT}`).toString('base64')}`,
};
```

**Source:** `confluence.atlassian.com/adminjiraserver/jira-oauth-2-0-provider-api-1115659070.html`

### 2.4 Cloud ID Discovery (OAuth 2.0)

After OAuth, you must discover the accessible resources (Jira sites) and their cloud IDs:

```typescript
const resourcesRes = await fetch(
  'https://api.atlassian.com/oauth/token/accessible-resources',
  { headers: { Authorization: `Bearer ${accessToken}` } }
);
const resources = await resourcesRes.json();
// [{ id: "abc-123", name: "My Site", url: "https://mysite.atlassian.net", ... }]

const cloudId = resources[0].id;
// API calls then use: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...
```

---

## 3. API Structure Overview

Base URL: `https://{domain}.atlassian.net/rest/api/3`

### Core API Groups

| Group | Path Prefix | Purpose |
|---|---|---|
| Issues | `/issue` | CRUD, transitions, changelogs |
| Issue Search | `/search`, `/search/jql` | JQL search |
| Issue Fields | `/field` | Discover system + custom fields |
| Issue Comments | `/issue/{key}/comment` | Comment CRUD |
| Issue Worklogs | `/issue/{key}/worklog` | Time tracking |
| Issue Attachments | `/attachment` | File metadata + content |
| Projects | `/project` | Project list and metadata |
| Project Components | `/project/{key}/components` | Component structure |
| Project Versions | `/project/{key}/versions` | Release versions |
| Permissions | `/mypermissions`, `/permissions` | ACL checks |
| Webhooks | `/webhook` | Dynamic webhook registration |
| JQL | `/jql/autocompletedata` | JQL field suggestions |

### Deprecation Alert (August 2025)

The old search endpoints were deprecated and removed after August 1, 2025:
- `GET /rest/api/3/search` — **being removed** (still labeled "currently being removed" in docs as of Aug 2026)
- `POST /rest/api/3/search` — **being removed**

**Use the new enhanced search endpoints:**
- `GET /rest/api/3/search/jql`
- `POST /rest/api/3/search/jql`

The new endpoints have the same parameters. The difference is improved response schema consistency and better pagination. Always use `/search/jql` for new code.

Source: `docs.adaptavist.com/sr4jc/latest/release-notes/breaking-changes/atlassian-rest-api-search-endpoints-deprecation`

---

## 4. Issue Search — The Core Endpoint

### 4.1 Enhanced JQL Search (Current)

**POST** `/rest/api/3/search/jql`

```typescript
interface JqlSearchRequest {
  jql: string;
  nextPageToken?: string;  // Cursor-based pagination (new)
  maxResults?: number;     // Default 50, max 100
  fields?: string[];       // Specific fields to return
  expand?: string[];       // Expand options
  properties?: string[];   // Entity properties to include
  fieldsByKeys?: boolean;  // Use field keys instead of IDs
  failFast?: boolean;      // Fail on first JQL error
}

interface JqlSearchResponse {
  issues: JiraIssue[];
  total?: number;
  isLast?: boolean;        // New cursor-based pagination
  nextPageToken?: string;  // Cursor for next page
}
```

**Request example:**
```typescript
const response = await fetch(`${JIRA_HOST}/rest/api/3/search/jql`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jql: 'project = MYPROJ AND updated >= "2026-01-01" ORDER BY updated ASC',
    maxResults: 100,
    fields: [
      'summary', 'description', 'status', 'assignee', 'reporter',
      'priority', 'issuetype', 'created', 'updated', 'labels',
      'components', 'fixVersions', 'attachment', 'comment',
      'parent', 'subtasks', 'issuelinks', 'worklog',
    ],
    expand: ['changelog', 'renderedFields'],
  }),
});
```

### 4.2 Pagination

The old offset-based `startAt/maxResults` pagination is being phased out in favor of cursor-based pagination in the new `/search/jql` endpoint.

**Old pattern (still works but being phased out):**
```typescript
async function* paginateSearchOld(jql: string) {
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const data = await jiraGet(`/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}`);
    yield* data.issues;
    if (startAt + data.issues.length >= data.total) break;
    startAt += maxResults;
  }
}
```

**New cursor pattern (preferred):**
```typescript
async function* paginateSearchJql(jql: string, fields: string[]) {
  let nextPageToken: string | undefined;
  do {
    const body: JqlSearchRequest = {
      jql,
      maxResults: 100,
      fields,
      ...(nextPageToken ? { nextPageToken } : {}),
    };
    const res = await fetch(`${JIRA_HOST}/rest/api/3/search/jql`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data: JqlSearchResponse = await res.json();
    yield* data.issues;
    nextPageToken = data.isLast ? undefined : data.nextPageToken;
  } while (nextPageToken);
}
```

**Important limitation:** The maximum `maxResults` per page is 100. The total issue count API (`POST /rest/api/3/search/approximate-count`) returns an approximate count without fetching issues — useful for estimating sync time.

### 4.3 Fields Parameter

Control which fields are returned. Always specify this explicitly to avoid fetching unnecessary data.

```typescript
// Minimal fields for index
const INDEX_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'reporter',
  'priority',
  'issuetype',
  'project',
  'created',
  'updated',
  'labels',
  'components',
  'fixVersions',
  'parent',
  'subtasks',
  'issuelinks',
];

// Add these for rich indexing
const RICH_FIELDS = [
  ...INDEX_FIELDS,
  'attachment',
  'comment',         // Returns up to 5 comments inline
  'worklog',         // Returns up to 20 worklogs inline
  'timetracking',
  'resolutiondate',
  'duedate',
  'environment',
  'security',        // Issue security level
  'votes',
  'watches',
];

// Wildcard (expensive - returns everything)
const ALL_FIELDS = ['*all'];
const NAVIGABLE_FIELDS = ['*navigable'];
```

### 4.4 Expand Parameter

The `expand` parameter requests additional nested data:

| Expand Value | What it Returns |
|---|---|
| `changelog` | Full changelog (field change history) |
| `renderedFields` | HTML-rendered versions of rich-text fields |
| `names` | Field display names keyed by field ID |
| `schema` | Field type schemas |
| `transitions` | Available workflow transitions |
| `operations` | Issue actions the current user can perform |
| `editmeta` | Fields editable in current context |
| `versionedRepresentations` | All versions of a field's representation |

**Performance warning:** `expand=changelog` can dramatically increase response size for issues with long histories. Fetch changelogs separately for bulk operations.

---

## 5. JQL Reference

JQL (Jira Query Language) is SQL-like syntax for filtering issues. It is the primary tool for incremental sync.

Source: `support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/`

### 5.1 Basic Syntax

```
FIELD OPERATOR VALUE [AND|OR|NOT FIELD OPERATOR VALUE] [ORDER BY FIELD [ASC|DESC]]
```

### 5.2 Comparison Operators

| Operator | Description | Example |
|---|---|---|
| `=` | Exact match | `status = "In Progress"` |
| `!=` | Not equal | `status != "Done"` |
| `>` | Greater than (dates, numbers) | `updated > "2026-01-01"` |
| `>=` | Greater than or equal | `updated >= "-1d"` |
| `<` | Less than | `priority < High` |
| `<=` | Less than or equal | `created <= "2026-08-01"` |
| `~` | Contains (text search) | `summary ~ "login error"` |
| `!~` | Does not contain | `description !~ "deprecated"` |
| `in` | In a list | `project in (PROJ, WEB)` |
| `not in` | Not in a list | `status not in ("Done", "Closed")` |
| `is` | Is empty / is not empty | `assignee is EMPTY` |
| `is not` | Opposite of is | `duedate is not EMPTY` |
| `was` | Historical value | `status was "In Progress"` |
| `was in` | Was one of these values | `status was in ("Review", "QA")` |
| `was not` | Was not this value | `status was not "Done"` |
| `was not in` | Was not any of these | `status was not in ("Done", "Closed")` |
| `changed` | Field was changed | `status changed` |
| `changed to` | Changed to value | `status changed to "Done"` |
| `changed from` | Changed from value | `status changed from "Backlog"` |
| `changed by` | Changed by user | `status changed by currentUser()` |
| `changed after` | Changed after date | `status changed after "2026-01-01"` |
| `changed before` | Changed before date | `priority changed before "-7d"` |
| `changed during` | Changed in a period | `status changed during ("2026-01-01", "2026-06-01")` |

### 5.3 Logical Keywords

```jql
-- AND (both conditions must be true)
project = MYPROJ AND status = "In Progress"

-- OR (either condition)
project = MYPROJ OR project = OTHER

-- NOT (negation)
NOT status = "Done"

-- Parentheses for grouping
(project = MYPROJ OR project = OTHER) AND status != "Done"
```

### 5.4 Built-in JQL Fields (System Fields)

| Field | Type | Description |
|---|---|---|
| `project` | String | Project key or ID |
| `issuetype` | String | Issue type name (Bug, Story, Task, etc.) |
| `status` | String | Workflow status name |
| `statusCategory` | String | To Do, In Progress, Done |
| `assignee` | User | Assigned user |
| `reporter` | User | Reporting user |
| `priority` | String | Priority level |
| `resolution` | String | Resolution (Fixed, Won't Fix, etc.) |
| `labels` | String list | Label values |
| `component` | String | Component name |
| `affectedVersion` | String | Affected version |
| `fixVersion` | String | Fix version |
| `sprint` | String | Sprint name or ID |
| `epic` | String | Epic link |
| `parent` | String | Parent issue key |
| `created` | DateTime | Creation timestamp |
| `updated` | DateTime | Last update timestamp |
| `resolutiondate` | DateTime | When the issue was resolved |
| `duedate` | Date | Due date |
| `lastViewed` | DateTime | When user last viewed |
| `key` | String | Issue key (e.g., PROJ-123) |
| `id` | Number | Issue ID |
| `summary` | String | Issue title (text search only) |
| `description` | String | Description body (text search only) |
| `comment` | String | Comment body (text search only) |
| `text` | String | Full-text search across summary, description, comments |
| `votes` | Number | Vote count |
| `watches` | Number | Watcher count |
| `timeoriginalestimate` | Duration | Original time estimate |
| `remainingEstimate` | Duration | Remaining estimate |
| `timespent` | Duration | Time logged |
| `cf[FIELD_ID]` | Varies | Custom field by ID |

### 5.5 JQL Functions

```jql
-- Date functions
created >= now()                        -- Current datetime
updated >= startOfDay()                 -- Start of today
created >= startOfWeek()                -- Start of current week  
duedate < endOfMonth()                  -- End of current month
updated >= "-1d"                        -- Relative: 1 day ago
updated >= "-2h"                        -- Relative: 2 hours ago
created >= "2026-01-01"                 -- Absolute date
created >= "2026-01-01 10:00"           -- Absolute datetime

-- User functions
assignee = currentUser()                -- Currently authenticated user
reporter in membersOf("jira-devs")      -- Members of a group
watcher = currentUser()                 -- Issues user is watching

-- Sprint functions
sprint in openSprints()                 -- All currently active sprints
sprint in closedSprints()               -- All closed sprints
sprint in futureSprints()               -- Sprints not yet started
sprint = "Sprint 42"                    -- Specific sprint by name

-- Version functions
fixVersion in unreleasedVersions()      -- Unreleased fix versions
fixVersion in releasedVersions()        -- Released fix versions
affectedVersion in latestReleasedVersion(PROJECT) -- Latest release

-- Issue functions
issueHistory()                          -- Issues user has viewed
linkedIssues("PROJ-1", "is blocked by") -- Issues with specific link type
votedIssues()                           -- Issues user has voted on
watchedIssues()                         -- Issues user is watching
```

### 5.6 Incremental Sync JQL Patterns

The most important JQL queries for our connector:

```jql
-- All issues updated since a given timestamp (use for incremental sync)
updated >= "2026-08-01 10:00" ORDER BY updated ASC

-- Newly created issues
created >= "2026-08-01" ORDER BY created ASC

-- Issues updated in last 5 minutes (near-real-time polling)
updated >= "-5m" ORDER BY updated ASC

-- Active issues only (exclude archived)
project = MYPROJ AND status != "Archived" ORDER BY updated ASC

-- Issues updated across all projects since a checkpoint
updated >= "${lastSyncTimestamp}" ORDER BY updated ASC

-- Combine with project filter for scoped connectors
project in (PROJ1, PROJ2) AND updated >= "${lastSyncTimestamp}" ORDER BY updated ASC
```

**Critical limitation:** JQL `updated` field has minute-level granularity. Using `updated >= "2026-08-01 10:00"` will catch all issues updated at any point in that minute. To avoid missing issues at boundary, overlap by 1 minute on each sync: set lastSyncTimestamp to `lastSync - 60 seconds`.

### 5.7 Date Format

Jira accepts several date formats in JQL:
- `"yyyy/MM/dd"` — date only
- `"yyyy-MM-dd"` — ISO date
- `"yyyy/MM/dd HH:mm"` — date and time
- `"-Nd"` — relative N days ago
- `"-Nh"` — relative N hours ago
- `"-Nw"` — relative N weeks ago
- `"-Nm"` — relative N minutes ago (NOT months — use `w` for weeks)

---

## 6. Issue Fields and Schema

### 6.1 Field Discovery

Discover all fields (system + custom) via:

```
GET /rest/api/3/field
```

Returns an array of `FieldDetails`:

```typescript
interface FieldDetails {
  id: string;           // "summary", "customfield_10001", etc.
  key: string;          // Same as id for most fields
  name: string;         // Display name: "Summary", "Story Points", etc.
  custom: boolean;      // true for custom fields
  navigable: boolean;   // Can be displayed in issue navigator
  searchable: boolean;  // Can be used in JQL
  clauseNames: string[]; // JQL clause names (e.g., ["cf[10001]", "Story Points"])
  schema: {
    type: string;       // "string", "number", "array", "user", "date", etc.
    items?: string;     // Item type for arrays
    system?: string;    // System field name
    custom?: string;    // Custom field type key
    customId?: number;  // Custom field ID
  };
}
```

**Response example for `GET /rest/api/3/field`:**
```json
[
  {
    "clauseNames": ["description"],
    "custom": false,
    "id": "description",
    "name": "Description",
    "navigable": true,
    "orderable": true,
    "schema": { "system": "description", "type": "string" },
    "searchable": true
  },
  {
    "clauseNames": ["cf[10016]", "Story Points", "Story point estimate"],
    "custom": true,
    "id": "customfield_10016",
    "name": "Story Points",
    "navigable": true,
    "schema": { "type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float", "customId": 10016 }
  }
]
```

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/`

### 6.2 Standard Issue Fields Schema

A typical issue response (from `GET /rest/api/3/issue/{key}` or search):

```typescript
interface JiraIssue {
  id: string;                    // "10001"
  key: string;                   // "PROJ-42"
  self: string;                  // API URL to this issue
  expand?: string;               // Which fields are expanded
  fields: {
    // Core identity
    summary: string;
    description: AdfDocument | null;  // v3 uses ADF; v2 returns string
    issuetype: {
      id: string;
      name: string;              // "Bug", "Story", "Task", "Subtask", "Epic"
      subtask: boolean;
      iconUrl: string;
    };
    project: {
      id: string;
      key: string;
      name: string;
    };

    // Status and workflow
    status: {
      id: string;
      name: string;              // "To Do", "In Progress", "Done"
      statusCategory: {
        id: number;
        key: string;             // "new", "indeterminate", "done"
        name: string;
      };
    };
    resolution: { id: string; name: string } | null;
    resolutiondate: string | null;  // ISO 8601

    // People
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    creator: JiraUser;
    watches: { watchCount: number; isWatching: boolean };
    votes: { votes: number; hasVoted: boolean };

    // Dates
    created: string;             // ISO 8601
    updated: string;             // ISO 8601
    duedate: string | null;      // "2026-12-31"
    lastViewed: string | null;

    // Classification
    priority: { id: string; name: string; iconUrl: string };
    labels: string[];
    components: Array<{ id: string; name: string }>;
    fixVersions: Array<VersionRef>;
    versions: Array<VersionRef>;  // Affected versions

    // Relations
    parent?: { id: string; key: string; fields: { summary: string; status: StatusRef; issuetype: IssueTypeRef } };
    subtasks: Array<{ id: string; key: string; fields: { summary: string; status: StatusRef; issuetype: IssueTypeRef } }>;
    issuelinks: Array<IssueLinkRef>;

    // Content
    attachment: AttachmentRef[];
    comment: { total: number; maxResults: number; startAt: number; comments: Comment[] };
    worklog: { total: number; maxResults: number; startAt: number; worklogs: Worklog[] };

    // Time tracking
    timetracking: {
      originalEstimate?: string;         // "3h"
      remainingEstimate?: string;
      timeSpent?: string;
      originalEstimateSeconds?: number;
      remainingEstimateSeconds?: number;
      timeSpentSeconds?: number;
    };

    // Environment (ADF in v3)
    environment: AdfDocument | null;

    // Security
    security: { id: string; name: string } | null;

    // Custom fields
    [key: `customfield_${number}`]: unknown;
  };
}

interface JiraUser {
  accountId: string;           // Stable ID (Cloud)
  displayName: string;
  emailAddress?: string;       // May be omitted if hidden
  active: boolean;
  accountType: 'atlassian' | 'app' | 'customer';
  avatarUrls: { '48x48': string; '32x32': string; '24x24': string; '16x16': string };
  self: string;
}
```

### 6.3 Atlassian Document Format (ADF)

v3 returns rich text as ADF JSON, not HTML. ADF is a document format used throughout Atlassian products.

```typescript
interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

type AdfNode =
  | { type: 'paragraph'; content: AdfInlineNode[] }
  | { type: 'heading'; attrs: { level: 1|2|3|4|5|6 }; content: AdfInlineNode[] }
  | { type: 'bulletList'; content: AdfListItem[] }
  | { type: 'orderedList'; content: AdfListItem[] }
  | { type: 'codeBlock'; attrs: { language?: string }; content: [{ type: 'text'; text: string }] }
  | { type: 'blockquote'; content: AdfNode[] }
  | { type: 'table'; content: AdfTableRow[] }
  | { type: 'rule' }
  | { type: 'panel'; attrs: { panelType: 'info'|'note'|'warning'|'error'|'success' }; content: AdfNode[] };

type AdfInlineNode =
  | { type: 'text'; text: string; marks?: AdfMark[] }
  | { type: 'mention'; attrs: { id: string; text: string } }
  | { type: 'emoji'; attrs: { shortName: string } }
  | { type: 'hardBreak' }
  | { type: 'inlineCard'; attrs: { url: string } };
```

**Converting ADF to Markdown for indexing:**

```typescript
function adfToMarkdown(node: AdfDocument | AdfNode | null): string {
  if (!node) return '';
  
  if (node.type === 'doc') {
    return node.content.map(adfToMarkdown).join('\n\n');
  }
  if (node.type === 'paragraph') {
    return node.content?.map(adfNodeToText).join('') ?? '';
  }
  if (node.type === 'heading') {
    const level = node.attrs.level;
    const text = node.content?.map(adfNodeToText).join('') ?? '';
    return `${'#'.repeat(level)} ${text}`;
  }
  if (node.type === 'bulletList') {
    return node.content.map(item => `- ${adfToMarkdown(item)}`).join('\n');
  }
  if (node.type === 'codeBlock') {
    const lang = node.attrs?.language ?? '';
    const code = node.content?.[0]?.text ?? '';
    return `\`\`\`${lang}\n${code}\n\`\`\``;
  }
  // ... handle other node types
  return '';
}

function adfNodeToText(node: AdfInlineNode): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'mention') return `@${node.attrs.text}`;
  if (node.type === 'hardBreak') return '\n';
  return '';
}
```

### 6.4 Custom Fields

Custom fields have IDs like `customfield_10001`. Common well-known ones:

| Custom Field | Typical ID | Type | Description |
|---|---|---|---|
| Story Points | `customfield_10016` | number | Agile story points |
| Epic Link | `customfield_10014` | string | Link to parent epic (old-style) |
| Epic Name | `customfield_10011` | string | Epic title |
| Sprint | `customfield_10020` | object/array | Sprint info |
| Team | `customfield_10002` | user/group | Team assignment |
| Rank | `customfield_10019` | string | Agile rank |

**Important:** Custom field IDs vary between Jira instances. Always discover via `GET /rest/api/3/field` and map by name at connection time.

```typescript
async function discoverCustomFields(client: JiraClient): Promise<Map<string, string>> {
  const fields = await client.get('/field');
  const fieldMap = new Map<string, string>();
  for (const field of fields) {
    if (field.custom) {
      fieldMap.set(field.name, field.id);
      // Also map by JQL clause name
      for (const clause of field.clauseNames) {
        fieldMap.set(clause, field.id);
      }
    }
  }
  return fieldMap;
}
```

---

## 7. Issue Subtypes and Hierarchy

### 7.1 Default Issue Types (Jira Software)

| Type | Hierarchy Level | Notes |
|---|---|---|
| Epic | Level 2 (parent of stories) | Has "Epic Name" and "Epic Color" |
| Story | Level 1 | Standard agile story |
| Bug | Level 1 | Defect report |
| Task | Level 1 | Generic work item |
| Sub-task | Level 0 | Child of any level-1 issue |

### 7.2 Next-gen / Team-managed Projects

In next-gen projects, the hierarchy is:
- **Epic** → **Story** → **Subtask** (no sub-tasks within subtasks)

In company-managed (classic) projects, any issue type can have sub-tasks.

### 7.3 Jira Service Management Issue Types

| Type | Description |
|---|---|
| Service Request | Customer-facing request |
| Incident | Service disruption |
| Problem | Root cause investigation |
| Change | Change management ticket |

### 7.4 Fetching Issue Type Metadata

```typescript
// All issue types in the instance
GET /rest/api/3/issuetype

// Issue types for a specific project
GET /rest/api/3/project/{projectIdOrKey}/statuses
```

### 7.5 Epic/Child Issue Navigation

```jql
-- Find all children of an epic (new parent-child model)
parent = PROJ-100

-- Find all epics in a project
project = PROJ AND issuetype = Epic

-- Find issues in a specific epic (old epic link field)
"Epic Link" = PROJ-100

-- Recursive: find all issues in epic hierarchy
issue in portfolioChildIssuesOf("PROJ-100")
```

---

## 8. Attachments

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/`

### 8.1 Listing Attachments

Attachments come inline when `attachment` is in the `fields` parameter:

```typescript
interface AttachmentRef {
  id: number;
  filename: string;
  author: JiraUser;
  created: string;       // ISO 8601
  size: number;          // bytes
  mimeType: string;      // "image/jpeg", "application/pdf", etc.
  content: string;       // URL to download content
  thumbnail?: string;    // URL for thumbnail (images only)
  self: string;          // URL to attachment metadata
}
```

### 8.2 Fetching Attachment Content

```
GET /rest/api/3/attachment/content/{id}
```

**Important:** This returns a redirect (303) to the actual file URL by default. To download inline, pass `?redirect=false`:

```typescript
async function downloadAttachment(attachmentId: string, headers: Headers): Promise<Buffer> {
  // Step 1: Get metadata
  const meta = await fetch(`${JIRA_HOST}/rest/api/3/attachment/${attachmentId}`, { headers });
  const metadata = await meta.json();
  
  // Step 2: Download content (disable redirect to get direct URL)
  const contentRes = await fetch(
    `${JIRA_HOST}/rest/api/3/attachment/content/${attachmentId}?redirect=false`,
    { headers }
  );
  
  if (contentRes.status === 303) {
    // Follow the redirect URL
    const redirectUrl = contentRes.headers.get('location')!;
    const fileRes = await fetch(redirectUrl);
    return Buffer.from(await fileRes.arrayBuffer());
  }
  
  return Buffer.from(await contentRes.arrayBuffer());
}
```

### 8.3 Attachment Metadata Endpoint

```
GET /rest/api/3/attachment/{id}
```

Returns:
```json
{
  "id": 10000,
  "filename": "architecture-diagram.png",
  "author": { "accountId": "...", "displayName": "Alice" },
  "created": "2026-01-15T10:30:00.000+0000",
  "size": 245120,
  "mimeType": "image/png",
  "content": "https://your-domain.atlassian.net/rest/api/3/attachment/content/10000",
  "thumbnail": "https://your-domain.atlassian.net/rest/api/3/attachment/thumbnail/10000",
  "self": "https://your-domain.atlassian.net/rest/api/3/attachment/10000"
}
```

### 8.4 For Indexing: What to Do with Attachments

For the knowledge index use case:
- **PDFs, DOCX, XLSX:** Extract text via `unstructured` or `pdf-parse` and index the content.
- **Images (PNG, JPEG):** Store reference; optionally run OCR or skip for v1.
- **Code files, text files:** Index content directly.
- **Archives (ZIP, etc.):** Skip or extract and process individual files.

```typescript
const INDEXABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

function shouldIndexAttachment(attachment: AttachmentRef): boolean {
  return (
    attachment.size < 50 * 1024 * 1024 &&  // < 50 MB
    INDEXABLE_MIME_TYPES.has(attachment.mimeType)
  );
}
```

---

## 9. Comments

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/`

### 9.1 Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/issue/{key}/comment` | List all comments (paginated) |
| `POST` | `/issue/{key}/comment` | Add a comment |
| `GET` | `/issue/{key}/comment/{id}` | Get single comment |
| `PUT` | `/issue/{key}/comment/{id}` | Update comment |
| `DELETE` | `/issue/{key}/comment/{id}` | Delete comment |
| `POST` | `/comment/list` | Get multiple comments by ID |

### 9.2 Comment Schema

```typescript
interface Comment {
  id: string;
  self: string;
  author: JiraUser;
  updateAuthor: JiraUser;
  body: AdfDocument;         // v3 ADF format
  created: string;           // ISO 8601
  updated: string;           // ISO 8601
  visibility?: {
    type: 'role' | 'group';
    value: string;           // e.g. "Service Desk Team" or "jira-software-users"
    identifier: string;      // Group/role ID
  };
  jsdPublic?: boolean;       // Jira Service Management: public vs internal
  properties?: unknown[];
}
```

### 9.3 Comment Visibility

Comments can be restricted to:
- **Roles:** e.g., "Service Desk Team" — only users with that project role can see it
- **Groups:** e.g., "jira-developers" — only members of that group can see it

**For ACL enforcement in our connector:** The `visibility` field tells you who can see a comment. If a user doesn't have that role/group membership, the comment should not appear in their search results.

The API already enforces this — when using user-scoped OAuth tokens, invisible comments simply won't appear. With a service account API token, you get everything and must enforce visibility rules yourself.

### 9.4 Inline Comments vs Separate Fetch

When searching issues, the `comment` field returns at most the first 5 comments. For issues with many comments, fetch them separately:

```typescript
async function* fetchAllComments(issueKey: string): AsyncGenerator<Comment> {
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const res = await jiraGet(
      `/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`
    );
    yield* res.comments;
    if (startAt + res.comments.length >= res.total) break;
    startAt += maxResults;
  }
}
```

---

## 10. Worklogs

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/`

### 10.1 Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/issue/{key}/worklog` | List worklogs (paginated) |
| `POST` | `/issue/{key}/worklog` | Add worklog |
| `GET` | `/issue/{key}/worklog/{id}` | Get single worklog |
| `PUT` | `/issue/{key}/worklog/{id}` | Update worklog |
| `DELETE` | `/issue/{key}/worklog/{id}` | Delete worklog |
| `GET` | `/worklog/updated` | Get IDs of recently updated worklogs |
| `GET` | `/worklog/deleted` | Get IDs of recently deleted worklogs |
| `POST` | `/worklog/list` | Bulk get worklogs by ID |

### 10.2 Worklog Schema

```typescript
interface Worklog {
  id: string;
  issueId: string;
  self: string;
  author: JiraUser;
  updateAuthor: JiraUser;
  comment?: AdfDocument;     // Optional comment on the worklog
  created: string;           // When the worklog was logged
  updated: string;           // When last edited
  started: string;           // When the work actually started
  timeSpent: string;         // "3h 20m"
  timeSpentSeconds: number;  // 12000
  visibility?: {
    type: 'group' | 'role';
    value: string;
    identifier: string;
  };
}
```

**Example response for `GET /rest/api/3/issue/{key}/worklog`:**
```json
{
  "maxResults": 1,
  "startAt": 0,
  "total": 1,
  "worklogs": [{
    "author": { "accountId": "5b10a2844c20165700ede21g", "displayName": "Mia Krystof" },
    "comment": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "I did some work here." }] }] },
    "id": "100028",
    "issueId": "10002",
    "started": "2021-01-17T12:34:00.000+0000",
    "timeSpent": "3h 20m",
    "timeSpentSeconds": 12000,
    "updated": "2021-01-18T23:45:00.000+0000",
    "visibility": { "identifier": "276f955c-...", "type": "group", "value": "jira-developers" }
  }]
}
```

### 10.3 Getting Changed Worklogs Since Last Sync

Jira provides a dedicated endpoint for this:

```typescript
// Get IDs of worklogs updated since a timestamp (Unix ms)
GET /rest/api/3/worklog/updated?since=1700000000000

// Get IDs of deleted worklogs since a timestamp
GET /rest/api/3/worklog/deleted?since=1700000000000
```

Returns a list of IDs and timestamps. Then bulk-fetch the changed worklogs:

```typescript
POST /rest/api/3/worklog/list
Body: { "ids": [10001, 10002, 10003] }
```

**Note:** Jira has a limit of 10,000 worklogs per issue. For high-activity issues, this matters.

---

## 11. Issue History / Changelog

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/`

### 11.1 Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/issue/{key}/changelog` | Get changelog paginated (oldest first) |
| `POST` | `/issue/{key}/changelog/list` | Get changelogs by IDs |
| `POST` | `/changelog/bulkfetch` | Bulk fetch changelogs for multiple issues |

### 11.2 Changelog Schema

```typescript
interface ChangeHistory {
  id: string;
  author: JiraUser;
  created: number;           // Unix timestamp in milliseconds (NOT ISO string!)
  items: ChangeItem[];
}

interface ChangeItem {
  field: string;             // Field display name: "Status", "Assignee"
  fieldId: string;           // Field ID: "status", "assignee"
  fieldtype: string;         // "jira" for system, "custom" for custom fields
  from: string | null;       // Previous value ID/key
  fromString: string | null; // Previous value display name
  to: string | null;         // New value ID/key
  toString: string | null;   // New value display name
}
```

**Changelog `created` is a Unix timestamp in milliseconds, not an ISO string.** This is a gotcha — be careful parsing it.

### 11.3 Expand vs Direct Fetch

Getting changelog via expand in search:
```typescript
// Returns up to 100 changelog entries per issue inline
expand: ['changelog']
```

Getting changelog directly (paginated, no limit):
```typescript
GET /rest/api/3/issue/{key}/changelog?maxResults=100&startAt=0
```

### 11.4 Bulk Changelog Fetch

For indexing many issues efficiently, use the bulk endpoint (introduced recently):

```typescript
POST /rest/api/3/changelog/bulkfetch

Body:
{
  "issueIdsOrKeys": ["PROJ-1", "PROJ-2", "PROJ-100"],
  "fieldIds": ["status", "assignee"],  // Optional: filter to specific fields
  "maxResults": 1000,
  "nextPageToken": "cursor-from-previous-response"
}
```

**Note:** Can request changelogs for up to 1000 issues per call, filtered by up to 10 field IDs.

---

## 12. Project Structure

### 12.1 Project Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/project/search` | Paginated list of projects |
| `GET` | `/project/{key}` | Single project details |
| `GET` | `/project/{key}/statuses` | All statuses in a project |
| `GET` | `/project/{key}/components` | Components |
| `GET` | `/project/{key}/versions` | Versions |
| `GET` | `/project/{id}/hierarchy` | Issue type hierarchy |

### 12.2 Projects List (Paginated)

Always use the paginated endpoint, not the deprecated `GET /project`:

```typescript
GET /rest/api/3/project/search?startAt=0&maxResults=50&expand=description,lead,issueTypes
```

**Expand options for projects:**
- `description` — project description text
- `lead` — project lead user object
- `issueTypes` — issue types available in this project
- `insight` — total issue count and last update time
- `projectKeys` — historical project keys

### 12.3 Project Schema

```typescript
interface JiraProject {
  id: string;
  key: string;             // "MYPROJ"
  name: string;
  description?: string;
  lead?: JiraUser;
  style: 'classic' | 'next-gen';
  isPrivate: boolean;
  projectTypeKey: 'software' | 'service_desk' | 'business';
  simplified: boolean;     // true for team-managed (next-gen)
  insight?: {
    lastIssueUpdateTime: string;
    totalIssueCount: number;
  };
  issueTypes?: IssueTypeRef[];
  avatarUrls: Record<string, string>;
  self: string;
}
```

### 12.4 Components

Components group issues within a project (e.g., "Frontend", "API", "Database"):

```typescript
GET /rest/api/3/project/{key}/components

interface Component {
  id: string;
  name: string;
  description?: string;
  lead?: JiraUser;
  assigneeType: 'PROJECT_DEFAULT' | 'COMPONENT_LEAD' | 'PROJECT_LEAD' | 'UNASSIGNED';
  realAssignee?: JiraUser;
  isAssigneeTypeValid: boolean;
  project: string;
  projectId: number;
  self: string;
}
```

### 12.5 Versions (Releases)

Versions represent releases/milestones within a project:

```typescript
GET /rest/api/3/project/{key}/versions

interface Version {
  id: string;
  name: string;
  description?: string;
  archived: boolean;
  released: boolean;
  startDate?: string;
  releaseDate?: string;
  overdue: boolean;
  userStartDate?: string;
  userReleaseDate?: string;
  projectId: number;
  self: string;
}
```

---

## 13. Permissions and ACL Enforcement

Source: `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/`

### 13.1 Permission Model

Jira has three permission layers:

1. **Global permissions** — site-wide (e.g., Administer Jira, Create Shared Objects)
2. **Project permissions** — per-project (e.g., Browse Projects, Create Issues, Resolve Issues)
3. **Issue security levels** — per-issue, restricts who can view specific issues

### 13.2 Key Permissions for Indexing

```
BROWSE_PROJECTS         — Can see the project and its issues
CREATE_ISSUES           — Not needed for read-only
EDIT_ISSUES             — Not needed for read-only
ADD_COMMENTS            — Not needed for read-only
VIEW_WORKFLOW_READONLY  — Can see workflow states
```

### 13.3 Checking Permissions via API

```typescript
// Check if the current user has specific permissions for a project
GET /rest/api/3/mypermissions?projectKey=MYPROJ&permissions=BROWSE_PROJECTS

// Check permissions for a specific issue
GET /rest/api/3/mypermissions?issueKey=MYPROJ-42&permissions=BROWSE_PROJECTS

// Bulk check: get all projects the user can browse
POST /rest/api/3/permissions/project
Body: { "permissions": ["BROWSE_PROJECTS"] }
```

### 13.4 Issue Security Schemes

Issue security levels restrict which users/groups can view specific issues:

```typescript
// Get security scheme for a project
GET /rest/api/3/project/{key}/issuesecurityscheme

// Get all security levels
GET /rest/api/3/issuesecurityschemes/{schemeId}/members
```

**For our connector (Phase 2 ACL enforcement):**

The approach depends on auth method:

**Approach A: User-scoped OAuth tokens (recommended)**
- Index using each user's own OAuth token
- Jira's API automatically filters to what that user can see
- No ACL logic needed in connector code
- Downside: requires OAuth 2.0 (3LO) per user, not a shared service account

**Approach B: Service account + permission checks**
- Index with a service account (admin token)
- On query, check `GET /mypermissions` for the requesting user
- Compare against permission scheme to determine which issues to return
- More complex, requires caching permission data

**Approach C: Tag-based (practical for v1)**
- On index, tag each issue with: project key + security level ID
- On query, call `GET /mypermissions` to get allowed project keys + security levels
- Filter index results by tags
- This is roughly how Confluence Cloud does it

```typescript
interface JiraDocumentMetadata {
  issueKey: string;
  projectKey: string;
  securityLevelId: string | null;  // null = no restriction
  isPrivateProject: boolean;
  allowedRoles: string[];          // Role IDs that can view this issue
}
```

### 13.5 Project Roles

Project roles are named sets of users/groups assigned at project level:

```typescript
// Get roles for a project
GET /rest/api/3/project/{key}/role

// Get role members
GET /rest/api/3/project/{key}/role/{roleId}
```

Common built-in roles: `Administrators`, `Developers`, `Viewers`, `Service Desk Team`

---

## 14. Webhooks

Source: `developer.atlassian.com/cloud/jira/platform/webhooks/`

### 14.1 Available Webhook Events

**Issue events:**
- `jira:issue_created`
- `jira:issue_updated`
- `jira:issue_deleted`

**Comment events:**
- `comment_created`
- `comment_updated`
- `comment_deleted`

**Attachment events:**
- `attachment_created`
- `attachment_deleted`

**Worklog events:**
- `worklog_created`
- `worklog_updated`
- `worklog_deleted`

**Project events:**
- `project_created`
- `project_updated`
- `project_deleted`
- `project_archived`
- `project_restored_archived`

**Sprint events:**
- `sprint_created`, `sprint_deleted`, `sprint_updated`, `sprint_started`, `sprint_closed`

**Version events:**
- `jira:version_created`, `jira:version_updated`, `jira:version_released`, `jira:version_deleted`

**User events:**
- `user_created`, `user_updated`, `user_deleted`

### 14.2 Registering a Webhook

**Via Admin UI:** Jira Admin > System > Webhooks

**Via REST API:**
```typescript
POST /rest/api/3/webhook

Body:
{
  "url": "https://your-connector.example.com/webhooks/jira",
  "webhooks": [{
    "events": ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted"],
    "jqlFilter": "project = MYPROJ"  // Optional JQL to filter which issues trigger the webhook
  }]
}
```

**Note:** Webhook registration via REST API is only available for OAuth 2.0 apps and Connect apps, not plain API token authentication. For API token use, register webhooks through the admin UI.

### 14.3 Webhook Payload Structure

```typescript
interface JiraIssueWebhookPayload {
  timestamp: number;                    // Unix ms
  webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | 'jira:issue_deleted';
  issue_event_type_name: string;        // e.g. "issue_assigned", "issue_status_changed"
  user: JiraUser;                       // User who triggered the event
  issue: JiraIssue;                     // Full issue object
  changelog?: {
    id: string;
    items: ChangeItem[];
  };
  comment?: Comment;                    // Present if event was comment-related
}
```

**Example `jira:issue_updated` payload:**
```json
{
  "timestamp": 1699999999000,
  "webhookEvent": "jira:issue_updated",
  "issue_event_type_name": "issue_generic",
  "user": { "accountId": "5b10...", "displayName": "Alice" },
  "issue": {
    "id": "10042",
    "key": "PROJ-42",
    "fields": { "summary": "Updated title", "status": {...}, "updated": "..." }
  },
  "changelog": {
    "id": "13337",
    "items": [
      {
        "field": "status",
        "fieldId": "status",
        "fieldtype": "jira",
        "from": "3",
        "fromString": "In Progress",
        "to": "10000",
        "toString": "Done"
      }
    ]
  }
}
```

### 14.4 Webhook Reliability

From the official docs:
- Webhooks are delivered over HTTPS only (port 443 and others in an allowlist)
- Retry policy: up to 5 retries with randomized back-off (5–15 min intervals)
- Retries triggered on: 408, 409, 425, 429, 5xx, connection failure/timeout
- After 30 minutes of failure, only 1 attempt per webhook until success
- `X-Atlassian-Webhook-Identifier` header: unique ID per webhook, same across retries — use for deduplication
- `X-Atlassian-Webhook-Retry` header: present on retries with the retry count
- **Primary** vs **Secondary** flow: Primary must be delivered within 30s; Secondary (bulk operations) within 15 min
- Concurrency limit: 20 concurrent requests per tenant+host pair for Primary, 10 for Secondary

### 14.5 Webhook Processing Pattern

```typescript
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// Track processed webhook IDs to handle retries
const processedWebhooks = new Set<string>();

app.post('/webhooks/jira', async (req, res) => {
  const webhookId = req.headers['x-atlassian-webhook-identifier'] as string;
  
  // Idempotency: skip if already processed
  if (processedWebhooks.has(webhookId)) {
    return res.status(200).json({ status: 'duplicate_ignored' });
  }
  
  // Acknowledge immediately to avoid timeout
  res.status(200).json({ status: 'accepted' });
  
  // Process asynchronously
  setImmediate(async () => {
    const payload: JiraIssueWebhookPayload = req.body;
    
    try {
      switch (payload.webhookEvent) {
        case 'jira:issue_created':
        case 'jira:issue_updated':
          await indexIssue(payload.issue);
          break;
        case 'jira:issue_deleted':
          await removeIssueFromIndex(payload.issue.id);
          break;
      }
      processedWebhooks.add(webhookId);
    } catch (err) {
      console.error('Failed to process webhook', webhookId, err);
    }
  });
});
```

---

## 15. Incremental Sync Strategy

### 15.1 Sync Architecture

```
Phase 1: Full initial sync
  - Discover all accessible projects
  - For each project: paginate all issues via JQL, ordered by updated ASC
  - Index issue content, metadata, comments, attachments

Phase 2: Incremental sync (polling, every 5 minutes)
  - JQL: updated >= "${lastSyncTimestamp - 1min}" ORDER BY updated ASC
  - Re-index all returned issues (upsert by issue key)

Phase 3: Real-time sync (optional, via webhooks)
  - Register webhook for issue_created, issue_updated, issue_deleted
  - On event: immediately re-fetch and re-index the affected issue

Deletion handling:
  - Soft delete: issue status changes to "Archived" — tracked via JQL status filter
  - Hard delete: only detectable via webhook (issue_deleted) or periodic audit
```

### 15.2 Checkpoint Management

```typescript
interface SyncCheckpoint {
  lastSyncAt: string;           // ISO 8601 timestamp
  lastIssueKey?: string;        // For resuming interrupted syncs
  totalIndexed: number;
  projectCheckpoints: Map<string, string>;  // Per-project last sync timestamps
}

class JiraSyncManager {
  async getIncrementalJql(
    projects: string[],
    lastSync: Date
  ): Promise<string> {
    // Subtract 1 minute to handle boundary issues (JQL has minute granularity)
    const checkpointTime = new Date(lastSync.getTime() - 60000);
    const jqlDate = checkpointTime.toISOString().replace('T', ' ').slice(0, 16);
    
    const projectList = projects.map(p => `"${p}"`).join(', ');
    return `project in (${projectList}) AND updated >= "${jqlDate}" ORDER BY updated ASC`;
  }
  
  async runIncrementalSync(checkpoint: SyncCheckpoint): Promise<void> {
    const projects = await this.getAccessibleProjects();
    const jql = await this.getIncrementalJql(
      projects.map(p => p.key),
      new Date(checkpoint.lastSyncAt)
    );
    
    let count = 0;
    for await (const issue of paginateSearchJql(jql, RICH_FIELDS)) {
      await this.indexIssue(issue);
      count++;
    }
    
    // Update checkpoint
    checkpoint.lastSyncAt = new Date().toISOString();
    checkpoint.totalIndexed += count;
    await this.saveCheckpoint(checkpoint);
  }
}
```

### 15.3 Handling Deleted Issues

Hard deletions are invisible to JQL. Approaches:

**Approach A: Webhook (best)**
- Register `jira:issue_deleted` webhook
- On receipt, remove from index immediately
- Works for real-time deletion detection

**Approach B: Periodic audit**
- Every 24 hours, compare indexed issue keys to what JQL returns
- Remove from index any keys no longer returned
- Problem: for large instances this is expensive

**Approach C: Status-based approximation**
- Index only non-archived issues
- JQL: `updated >= lastSync AND status != "Archived"`
- Treat archived as logically deleted
- Caveat: hard deletes still leak into index until periodic audit

```typescript
async function detectDeletedIssues(
  projectKey: string,
  indexedKeys: Set<string>
): Promise<string[]> {
  // Get all current issue keys from Jira
  const currentKeys = new Set<string>();
  for await (const issue of paginateSearchJql(
    `project = ${projectKey} ORDER BY key ASC`,
    ['summary']  // Minimal fields
  )) {
    currentKeys.add(issue.key);
  }
  
  // Find issues that are indexed but no longer exist in Jira
  return [...indexedKeys].filter(k => !currentKeys.has(k));
}
```

### 15.4 Full Sync Strategy for Large Instances

For Jira instances with 100K+ issues:

```typescript
async function fullSyncProject(projectKey: string): Promise<void> {
  // Use ORDER BY key ASC for stable pagination
  // (ORDER BY updated ASC can re-page if issues update during sync)
  const jql = `project = "${projectKey}" ORDER BY key ASC`;
  
  let batchNumber = 0;
  for await (const batch of paginateSearchInBatches(jql, RICH_FIELDS, 100)) {
    await Promise.all(batch.map(issue => indexIssue(issue)));
    batchNumber++;
    
    if (batchNumber % 10 === 0) {
      // Save progress checkpoint for resume
      await saveProgressCheckpoint(projectKey, batch[batch.length - 1].key);
    }
    
    // Respect rate limits
    await sleep(50);
  }
}
```

---

## 16. Jira Cloud vs Data Center Differences

Source: `community.developer.atlassian.com/t/what-are-the-differences-in-rest-apis-between-jira-data-center-and-jira-cloud/78178`

### 16.1 API Version Availability

| Feature | Cloud | Data Center |
|---|---|---|
| REST API v3 | Available | Available in DC 9.0+ (ADF support) |
| REST API v2 | Available (deprecated for new code) | Available in all versions |
| `/search/jql` enhanced endpoint | Available | DC 9.0+ only |
| OAuth 2.0 (3LO) | Available | DC 10.0+ (limited) |
| Personal Access Tokens | Not available | Available |
| ADF in descriptions/comments | v3 returns ADF | v3 returns ADF (DC 9.0+) |
| Webhooks via REST | Available | Available |

### 16.2 Authentication Differences

| Auth Method | Cloud | Data Center |
|---|---|---|
| API Token (email + token) | Yes | No |
| Personal Access Token | No | Yes |
| OAuth 1.0a | No (deprecated) | Yes |
| OAuth 2.0 (3LO) | Yes | DC 10+ only |
| Basic auth (username/password) | Deprecated | Still works |

### 16.3 Base URL Structure

```typescript
// Cloud
const cloudBase = 'https://{domain}.atlassian.net/rest/api/3';

// Data Center
const dcBase = 'https://{dc-host}/rest/api/3';  // Or /rest/api/2 for older DC
```

### 16.4 Field Differences

| Field | Cloud | Data Center |
|---|---|---|
| User identifier | `accountId` (stable UUID) | `name` (username, can change) |
| User email | Sometimes hidden | Usually available |
| Sprint field | `customfield_10020` | May differ by instance |

**Critical:** Cloud uses `accountId` for user identification. Data Center uses `name` (the username). Adapt your user lookup logic accordingly.

### 16.5 Building a Multi-Platform Client

```typescript
type JiraPlatform = 'cloud' | 'datacenter';

interface JiraClientConfig {
  platform: JiraPlatform;
  host: string;  // For cloud: 'mysite.atlassian.net', for DC: 'jira.company.internal'
  auth: CloudAuth | DataCenterAuth;
}

interface CloudAuth {
  type: 'api-token';
  email: string;
  apiToken: string;
}

interface DataCenterAuth {
  type: 'pat' | 'basic';
  token?: string;    // For PAT
  username?: string; // For basic
  password?: string; // For basic
}

class JiraClient {
  private readonly apiVersion: '2' | '3';
  
  constructor(private config: JiraClientConfig) {
    // Use v3 for Cloud, v3 for DC 9+ (fall back to v2 for older DC)
    this.apiVersion = '3';
  }
  
  private get baseUrl(): string {
    return `https://${this.config.host}/rest/api/${this.apiVersion}`;
  }
  
  private buildHeaders(): Record<string, string> {
    const auth = this.config.auth;
    if (auth.type === 'api-token') {
      const credentials = Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64');
      return { Authorization: `Basic ${credentials}`, Accept: 'application/json' };
    }
    if (auth.type === 'pat') {
      return { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' };
    }
    if (auth.type === 'basic') {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${credentials}`, Accept: 'application/json' };
    }
    throw new Error(`Unsupported auth type`);
  }
  
  getUserId(user: JiraUser): string {
    // Cloud: accountId; DC: name (username)
    return this.config.platform === 'cloud' ? user.accountId : (user.name ?? user.accountId);
  }
  
  async search(jql: string, fields: string[]): Promise<JiraIssue[]> {
    // Use new endpoint for Cloud, fall back to old endpoint for older DC
    const endpoint = this.config.platform === 'cloud'
      ? '/search/jql'
      : '/search';
    
    // ...
  }
}
```

---

## 17. Rate Limits and Error Handling

### 17.1 Jira Cloud Rate Limits

Atlassian does not publish exact rate limit numbers but applies per-user, per-site throttling. Observed limits in practice:

- ~100 requests/10 seconds for authenticated users
- Rate limited requests receive HTTP 429 with `Retry-After` header
- OAuth 2.0 app limits are higher than personal API tokens

### 17.2 Retry Logic with Exponential Back-off

```typescript
class JiraRateLimiter {
  private readonly maxRetries = 5;
  private readonly baseDelay = 1000;  // 1 second
  
  async fetch(url: string, options: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await fetch(url, options);
      
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
        const delay = Math.max(retryAfter * 1000, this.baseDelay * Math.pow(2, attempt));
        await sleep(delay + Math.random() * 1000);  // Add jitter
        continue;
      }
      
      if (res.status === 503) {
        await sleep(this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000);
        continue;
      }
      
      return res;
    }
    throw new Error(`Exceeded max retries for ${url}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 17.3 Common Error Responses

| Status | Meaning | Action |
|---|---|---|
| 400 | Bad Request (malformed JQL or bad params) | Fix the query; log the error body |
| 401 | Unauthorized (invalid/expired token) | Refresh token or re-authenticate |
| 403 | Forbidden (no permission) | Check project permissions |
| 404 | Issue/resource not found | May have been deleted; remove from index |
| 429 | Rate limited | Respect `Retry-After`, back off |
| 503 | Service unavailable | Retry with back-off |

### 17.4 Concurrency Control

For bulk operations (full sync), limit parallel requests:

```typescript
import PLimit from 'p-limit';

const limit = PLimit(5);  // Max 5 concurrent Jira API requests

async function bulkIndexIssues(issueKeys: string[]): Promise<void> {
  await Promise.all(
    issueKeys.map(key => limit(() => indexIssue(key)))
  );
}
```

---

## 18. Complete TypeScript Connector Implementation

### 18.1 Client Class

```typescript
import fetch, { type RequestInit, type Response } from 'node-fetch';

export interface JiraConnectorConfig {
  platform: 'cloud' | 'datacenter';
  host: string;
  email?: string;        // Cloud API token auth
  apiToken?: string;     // Cloud API token
  pat?: string;          // DC Personal Access Token
  oauthToken?: string;   // OAuth 2.0 access token
}

export class JiraConnector {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  
  constructor(private config: JiraConnectorConfig) {
    this.baseUrl = `https://${config.host}/rest/api/3`;
    this.headers = this.buildHeaders();
  }
  
  private buildHeaders(): Record<string, string> {
    if (this.config.oauthToken) {
      return {
        Authorization: `Bearer ${this.config.oauthToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
    }
    if (this.config.pat) {
      return {
        Authorization: `Bearer ${this.config.pat}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
    }
    if (this.config.email && this.config.apiToken) {
      const credentials = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
      return {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
    }
    throw new Error('No valid auth configuration');
  }
  
  async get<T>(path: string): Promise<T> {
    const res = await this.request('GET', path);
    return res.json() as Promise<T>;
  }
  
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request('POST', path, body);
    return res.json() as Promise<T>;
  }
  
  private async request(
    method: string,
    path: string,
    body?: unknown,
    retries = 0
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    
    const res = await fetch(url, options);
    
    if (res.status === 429 && retries < 5) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '10', 10);
      await sleep(retryAfter * 1000 + Math.random() * 1000);
      return this.request(method, path, body, retries + 1);
    }
    
    if (res.status === 503 && retries < 3) {
      await sleep(2000 * Math.pow(2, retries) + Math.random() * 1000);
      return this.request(method, path, body, retries + 1);
    }
    
    if (!res.ok) {
      const errorBody = await res.text();
      throw new JiraApiError(res.status, `${method} ${path}: ${errorBody}`);
    }
    
    return res;
  }
  
  // --- Projects ---
  
  async *listProjects(): AsyncGenerator<JiraProject> {
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const data = await this.get<{ values: JiraProject[]; total: number; isLast: boolean }>(
        `/project/search?startAt=${startAt}&maxResults=${maxResults}&expand=description,insight`
      );
      yield* data.values;
      if (data.isLast || startAt + data.values.length >= data.total) break;
      startAt += maxResults;
    }
  }
  
  // --- Issues ---
  
  async *searchIssues(
    jql: string,
    fields: string[] = INDEX_FIELDS
  ): AsyncGenerator<JiraIssue> {
    let nextPageToken: string | undefined;
    const endpoint = this.config.platform === 'cloud' ? '/search/jql' : '/search';
    
    do {
      const body = {
        jql,
        maxResults: 100,
        fields,
        ...(nextPageToken ? { nextPageToken } : {}),
      };
      
      const data = this.config.platform === 'cloud'
        ? await this.post<JqlSearchResponse>(endpoint, body)
        : await this.get<JqlSearchResponse>(`${endpoint}?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields.join(',')}`);
      
      yield* data.issues;
      nextPageToken = data.isLast ? undefined : data.nextPageToken;
      
      if (!nextPageToken && this.config.platform === 'datacenter') {
        break;  // DC uses offset-based, handled differently
      }
    } while (nextPageToken);
  }
  
  async getIssue(keyOrId: string, fields: string[] = RICH_FIELDS): Promise<JiraIssue> {
    return this.get<JiraIssue>(
      `/issue/${keyOrId}?fields=${fields.join(',')}&expand=changelog,renderedFields`
    );
  }
  
  // --- Comments ---
  
  async *listComments(issueKey: string): AsyncGenerator<Comment> {
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const data = await this.get<{ comments: Comment[]; total: number }>(
        `/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`
      );
      yield* data.comments;
      if (startAt + data.comments.length >= data.total) break;
      startAt += maxResults;
    }
  }
  
  // --- Attachments ---
  
  async getAttachmentMetadata(attachmentId: string): Promise<AttachmentRef> {
    return this.get<AttachmentRef>(`/attachment/${attachmentId}`);
  }
  
  async downloadAttachment(attachmentId: string): Promise<Buffer> {
    const res = await this.request('GET', `/attachment/content/${attachmentId}?redirect=false`);
    return Buffer.from(await res.arrayBuffer());
  }
  
  // --- Fields Discovery ---
  
  async discoverFields(): Promise<Map<string, FieldDetails>> {
    const fields = await this.get<FieldDetails[]>('/field');
    const fieldMap = new Map<string, FieldDetails>();
    for (const field of fields) {
      fieldMap.set(field.id, field);
      for (const clause of field.clauseNames) {
        fieldMap.set(clause, field);
      }
    }
    return fieldMap;
  }
  
  // --- Permissions ---
  
  async checkProjectPermissions(projectKey: string): Promise<boolean> {
    const data = await this.get<{ permissions: Record<string, { havePermission: boolean }> }>(
      `/mypermissions?projectKey=${projectKey}&permissions=BROWSE_PROJECTS`
    );
    return data.permissions['BROWSE_PROJECTS']?.havePermission ?? false;
  }
}

export class JiraApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'JiraApiError';
  }
}
```

### 18.2 Incremental Sync Manager

```typescript
import { JiraConnector, type JiraConnectorConfig } from './jira-client';
import { type IndexStore } from '../index-store';

interface SyncState {
  lastSyncAt: string;  // ISO 8601
  indexedCount: number;
  projectStates: Record<string, { lastSyncAt: string; issueCount: number }>;
}

export class JiraIncrementalSyncManager {
  private connector: JiraConnector;
  
  constructor(
    config: JiraConnectorConfig,
    private store: IndexStore
  ) {
    this.connector = new JiraConnector(config);
  }
  
  async runSync(state: SyncState): Promise<SyncState> {
    const syncStart = new Date();
    
    // Get list of accessible projects
    const projects: JiraProject[] = [];
    for await (const project of this.connector.listProjects()) {
      projects.push(project);
    }
    
    let totalProcessed = 0;
    
    for (const project of projects) {
      const projectLastSync = state.projectStates[project.key]?.lastSyncAt;
      const isFirstSync = !projectLastSync;
      
      // Build JQL for this project
      const jql = isFirstSync
        ? `project = "${project.key}" ORDER BY key ASC`
        : this.buildIncrementalJql(project.key, new Date(projectLastSync));
      
      let projectCount = 0;
      for await (const issue of this.connector.searchIssues(jql, RICH_FIELDS)) {
        await this.indexIssue(issue, project);
        projectCount++;
        totalProcessed++;
      }
      
      // Update project-level checkpoint
      state.projectStates[project.key] = {
        lastSyncAt: syncStart.toISOString(),
        issueCount: (state.projectStates[project.key]?.issueCount ?? 0) + projectCount,
      };
    }
    
    return {
      lastSyncAt: syncStart.toISOString(),
      indexedCount: state.indexedCount + totalProcessed,
      projectStates: state.projectStates,
    };
  }
  
  private buildIncrementalJql(projectKey: string, since: Date): string {
    // Subtract 1 minute to handle JQL's minute-level timestamp granularity
    const checkpoint = new Date(since.getTime() - 60 * 1000);
    const jqlDate = formatJqlDate(checkpoint);
    return `project = "${projectKey}" AND updated >= "${jqlDate}" ORDER BY updated ASC`;
  }
  
  private async indexIssue(issue: JiraIssue, project: JiraProject): Promise<void> {
    // Convert ADF description to markdown
    const body = this.buildIssueMarkdown(issue);
    
    // Fetch additional comments if there are more than the 5 returned inline
    const commentCount = issue.fields.comment?.total ?? 0;
    const inlineComments = issue.fields.comment?.comments ?? [];
    const allComments = inlineComments.length < commentCount
      ? await this.fetchAllComments(issue.key)
      : inlineComments;
    
    const commentsText = allComments
      .map(c => `**${c.author.displayName}** (${c.created}):\n${adfToMarkdown(c.body)}`)
      .join('\n\n---\n\n');
    
    await this.store.upsert({
      id: `jira-${issue.key}`,
      type: 'jira_issue',
      title: `[${issue.key}] ${issue.fields.summary}`,
      content: [body, commentsText].filter(Boolean).join('\n\n---\n\n## Comments\n\n'),
      metadata: {
        issueKey: issue.key,
        issueId: issue.id,
        projectKey: project.key,
        projectName: project.name,
        status: issue.fields.status.name,
        statusCategory: issue.fields.status.statusCategory.key,
        issuetype: issue.fields.issuetype.name,
        assignee: issue.fields.assignee?.accountId,
        reporter: issue.fields.reporter?.accountId,
        priority: issue.fields.priority?.name,
        labels: issue.fields.labels,
        components: issue.fields.components.map(c => c.name),
        fixVersions: issue.fields.fixVersions?.map(v => v.name) ?? [],
        created: issue.fields.created,
        updated: issue.fields.updated,
        isPrivateProject: project.isPrivate,
        securityLevelId: issue.fields.security?.id ?? null,
        // For ACL: tags that control visibility
        _aclTags: [
          `project:${project.key}`,
          project.isPrivate ? `private` : `public`,
          ...(issue.fields.security ? [`security:${issue.fields.security.id}`] : []),
        ],
      },
      sourceUrl: `https://${this.connector['config'].host}/browse/${issue.key}`,
      updatedAt: issue.fields.updated,
    });
  }
  
  private buildIssueMarkdown(issue: JiraIssue): string {
    const fields = issue.fields;
    const lines: string[] = [
      `# [${issue.key}] ${fields.summary}`,
      '',
      `**Type:** ${fields.issuetype.name}`,
      `**Status:** ${fields.status.name}`,
      `**Priority:** ${fields.priority?.name ?? 'None'}`,
      fields.assignee ? `**Assignee:** ${fields.assignee.displayName}` : '**Assignee:** Unassigned',
      `**Reporter:** ${fields.reporter?.displayName ?? 'Unknown'}`,
      `**Created:** ${fields.created}`,
      `**Updated:** ${fields.updated}`,
      fields.duedate ? `**Due Date:** ${fields.duedate}` : null,
      fields.labels.length > 0 ? `**Labels:** ${fields.labels.join(', ')}` : null,
      fields.components.length > 0 ? `**Components:** ${fields.components.map(c => c.name).join(', ')}` : null,
      '',
    ].filter((l): l is string => l !== null);
    
    if (fields.description) {
      lines.push('## Description', '', adfToMarkdown(fields.description));
    }
    
    if (fields.parent) {
      lines.push('', `**Parent:** [${fields.parent.key}] ${fields.parent.fields.summary}`);
    }
    
    if (fields.subtasks?.length > 0) {
      lines.push('', '## Subtasks');
      for (const subtask of fields.subtasks) {
        lines.push(`- [${subtask.key}] ${subtask.fields.summary} (${subtask.fields.status.name})`);
      }
    }
    
    return lines.join('\n');
  }
  
  private async fetchAllComments(issueKey: string): Promise<Comment[]> {
    const comments: Comment[] = [];
    for await (const comment of this.connector.listComments(issueKey)) {
      comments.push(comment);
    }
    return comments;
  }
}

function formatJqlDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 16);
}
```

### 18.3 Webhook Handler

```typescript
import express from 'express';
import { JiraIncrementalSyncManager } from './jira-sync-manager';

export function createJiraWebhookRouter(
  connector: JiraConnector,
  store: IndexStore
): express.Router {
  const router = express.Router();
  const processedIds = new Map<string, number>();  // webhookId -> timestamp
  
  router.post('/jira', express.json(), async (req, res) => {
    const webhookId = req.headers['x-atlassian-webhook-identifier'] as string | undefined;
    
    // Acknowledge immediately (Jira requires fast response)
    res.status(200).send('OK');
    
    // Deduplicate
    if (webhookId && processedIds.has(webhookId)) return;
    if (webhookId) processedIds.set(webhookId, Date.now());
    
    // Cleanup old entries (keep last 1000)
    if (processedIds.size > 1000) {
      const sorted = [...processedIds.entries()].sort((a, b) => a[1] - b[1]);
      for (const [id] of sorted.slice(0, 100)) processedIds.delete(id);
    }
    
    const payload = req.body as JiraIssueWebhookPayload;
    
    setImmediate(async () => {
      try {
        if (payload.webhookEvent === 'jira:issue_deleted') {
          await store.delete(`jira-${payload.issue.key}`);
          return;
        }
        
        if (['jira:issue_created', 'jira:issue_updated'].includes(payload.webhookEvent)) {
          // Re-fetch full issue to get all fields (webhook payload may be partial)
          const fullIssue = await connector.getIssue(payload.issue.key, RICH_FIELDS);
          // ... index the issue
        }
      } catch (err) {
        console.error('[jira-webhook] Processing failed:', err);
      }
    });
  });
  
  return router;
}
```

### 18.4 Field Constants

```typescript
export const INDEX_FIELDS = [
  'summary',
  'description',
  'status',
  'assignee',
  'reporter',
  'priority',
  'issuetype',
  'project',
  'created',
  'updated',
  'labels',
  'components',
  'fixVersions',
  'parent',
  'subtasks',
  'issuelinks',
  'security',
] as const;

export const RICH_FIELDS = [
  ...INDEX_FIELDS,
  'attachment',
  'comment',
  'worklog',
  'timetracking',
  'resolutiondate',
  'duedate',
  'environment',
  'votes',
  'watches',
] as const;
```

---

## 19. What to Build and What to Skip

### Build (Phase 1 — Core connector)

- [x] API token auth for Cloud (simplest, used by most enterprise service accounts)
- [x] PAT auth for Data Center (DC still has years of runway)
- [x] `/search/jql` with cursor-based pagination
- [x] ADF to Markdown conversion for descriptions/comments
- [x] Custom field discovery via `GET /field`
- [x] Incremental sync via `updated >= lastSync` JQL with 1-minute overlap
- [x] Checkpoint persistence (per-project timestamps)
- [x] Basic attachment metadata indexing (filename, size, MIME type) — not content
- [x] Comment text extraction and inclusion in indexed document
- [x] Basic rate limit handling (429 retry with back-off)
- [x] Webhook receiver for `jira:issue_created/updated/deleted` events

### Build (Phase 2 — Enterprise / ACL)

- [ ] OAuth 2.0 (3LO) per-user auth for proper ACL enforcement
- [ ] Project role + issue security level metadata tagging
- [ ] `GET /mypermissions` call on query to filter results by user permissions
- [ ] Attachment content indexing (PDF text extraction, DOCX parsing)
- [ ] Worklog indexing (useful for time-tracking queries)
- [ ] Webhook for comment events (real-time comment indexing)
- [ ] Multi-site support (a user may have access to multiple Jira Cloud sites)

### Skip

- **Jira Server:** EOL February 2024. No new installs. Skip.
- **OAuth 1.0a:** Deprecated everywhere. Use API tokens or OAuth 2.0.
- **Subtask content expansion:** Subtasks are usually sparse; index them as separate issues, link to parent.
- **Sprint data via Boards API:** Sprint membership is on the issue via `customfield_10020`. No need to separately index sprint data.
- **Jira expressions API:** Complex server-side scripting. Not needed for indexing.
- **Worklog content extraction for v1:** Worklogs have comments but they are rarely substantive enough to justify the extra API calls at v1. Add in Phase 2.

---

## 20. Failure Modes and Gotchas

### 20.1 JQL Timestamp Granularity

**Problem:** JQL `updated >= "2026-08-01 10:00"` matches everything updated in that entire minute. If you set your checkpoint to exactly when sync ran, you may miss issues updated between the last check and when your checkpoint was recorded.

**Fix:** Always subtract 1–2 minutes from your checkpoint when building the incremental JQL.

### 20.2 Inline Comment/Worklog Truncation

**Problem:** The `comment` field in search results returns at most 5 comments, and `worklog` returns at most 20. If `comment.total > comment.maxResults`, you are missing data.

**Fix:** Always check `comment.total` vs `comment.maxResults`. If truncated, fetch full comments via `/issue/{key}/comment`.

### 20.3 ADF Parse Failures

**Problem:** Malformed or unexpected ADF document types can cause ADF-to-Markdown conversion to fail silently or throw.

**Fix:** Wrap ADF conversion in try/catch; fall back to extracting raw text from all `text` nodes if structured conversion fails.

```typescript
function safeAdfToMarkdown(adf: AdfDocument | null): string {
  if (!adf) return '';
  try {
    return adfToMarkdown(adf);
  } catch {
    // Fallback: extract all text nodes
    return extractAllText(adf);
  }
}

function extractAllText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  if ('text' in node && typeof node.text === 'string') return node.text;
  if ('content' in node && Array.isArray(node.content)) {
    return node.content.map(extractAllText).join(' ');
  }
  return '';
}
```

### 20.4 Changelog Timestamp Type

**Problem:** Changelog `created` is a Unix timestamp in milliseconds (a number), not an ISO string like every other date field.

```typescript
// WRONG: will give NaN
new Date(changeHistory.created)

// CORRECT: already Unix ms
new Date(changeHistory.created)  // Actually this works, but it's easy to confuse with a string
// Safer to be explicit:
new Date(Number(changeHistory.created))
```

### 20.5 Service Account User Deprovisioning

**Problem:** If the service account whose API token is used to index is removed (e.g., employee departure), all indexed data becomes stale and new syncs fail.

**Fix:** Use a dedicated non-human service account with a permanent license. Set up alerts if the API token fails (monitoring the 401 error rate).

### 20.6 Deleted Issues Not Detected by JQL

**Problem:** `updated >= lastSync` will never return deleted issues. They simply disappear from search results.

**Fix:** Register `jira:issue_deleted` webhook. Without webhooks, deleted issues will persist in your index until you run a full reconciliation audit.

### 20.7 Private Project Visibility

**Problem:** If your service account doesn't have Browse Projects permission on a project, issues from that project return 403 or are simply not included in search results. The total count will be off.

**Fix:** Request explicit access to all projects during setup. Or detect 403 per-project during discovery and skip those projects, logging a warning.

### 20.8 Large ADF Descriptions

**Problem:** Jira has an ADF content limit of 32KB per field. Complex descriptions with many tables, embedded images (as media nodes), or code blocks can approach this limit and cause odd rendering.

**Fix:** Truncate indexed content at a reasonable limit (e.g., 100KB raw text per issue) to prevent index bloat.

### 20.9 Custom Field Value Rendering

**Problem:** Custom fields like `customfield_10016` (Story Points) return raw values (a number). More complex custom fields (like multi-select option lists) return objects or arrays of objects. The schema varies by field type.

**Fix:** Use `GET /rest/api/3/field` to discover field types. For indexing purposes, a safe approach is to JSON.stringify unknown custom field values and include them as plain text.

### 20.10 The Old Search Endpoint Deprecation

**Problem:** `GET/POST /rest/api/3/search` are marked as "currently being removed." Code using these endpoints will break at an unspecified date.

**Fix:** Migrate all new code to `GET/POST /rest/api/3/search/jql`. Note that the new endpoint uses cursor-based pagination (`nextPageToken`) rather than offset-based (`startAt`).

### 20.11 Webhook Delivery to Non-HTTPS Endpoints

**Problem:** Jira Cloud webhooks require HTTPS with a valid certificate. You cannot send webhooks to HTTP or self-signed cert endpoints.

**Fix:** For local development, use ngrok or a similar tunneling tool. For production, ensure your webhook receiver has a valid cert.

### 20.12 Worklogs Limit per Issue

**Problem:** Jira has a hard limit of 10,000 worklogs per issue (increased from 5,000 in 2024). High-activity issues on long-running projects can hit this.

**Fix:** For indexing purposes, fetch only the most recent N worklogs (the API returns them ordered by `created` — use `startedBefore` parameter to page from most recent).

---

## Sources

| URL | Purpose |
|---|---|
| `developer.atlassian.com/cloud/jira/platform/rest/v3/` | REST API v3 reference home |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/` | Issue search endpoints |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/` | Issues CRUD and changelog |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/` | Attachments API |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/` | Comments API |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/` | Worklogs API |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/` | Fields API |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/` | Permissions API |
| `developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/` | Projects API |
| `developer.atlassian.com/cloud/jira/platform/webhooks/` | Webhooks documentation |
| `confluence.atlassian.com/adminjiraserver/jira-oauth-2-0-provider-api-1115659070.html` | DC OAuth 2.0 API |
| `docs.adaptavist.com/sr4jc/latest/release-notes/breaking-changes/atlassian-rest-api-search-endpoints-deprecation` | Search endpoint deprecation notice |
| `community.developer.atlassian.com/t/what-are-the-differences-in-rest-apis-between-jira-data-center-and-jira-cloud/78178` | Cloud vs DC API differences |
| `support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jira-query-language-jql/` | JQL reference |
