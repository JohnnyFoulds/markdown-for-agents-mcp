# Other Connectors: HubSpot, Linear, Teams, Intercom, Dropbox, Box, OneDrive, Figma

**Research date:** 2026-08-26
**Author:** Competitive intelligence research for markdown-for-agents-mcp Phase 2

---

## Table of Contents

1. [Research Scope and Methodology](#1-research-scope-and-methodology)
2. [HubSpot](#2-hubspot)
3. [Linear](#3-linear)
4. [Microsoft Teams](#4-microsoft-teams)
5. [Intercom](#5-intercom)
6. [Dropbox](#6-dropbox)
7. [Box](#7-box)
8. [OneDrive](#8-onedrive)
9. [Figma](#9-figma)
10. [Priority Ranking Table](#10-priority-ranking-table)
11. [Authentication Pattern Matrix](#11-authentication-pattern-matrix)
12. [Top 5 Connectors to Build After SharePoint + Confluence](#12-top-5-connectors-to-build-after-sharepoint--confluence)
13. [Common Implementation Patterns and Reusable Abstractions](#13-common-implementation-patterns-and-reusable-abstractions)
14. [Build vs Skip Verdicts](#14-build-vs-skip-verdicts)

---

## 1. Research Scope and Methodology

This document covers eight additional connector candidates for the markdown-for-agents-mcp enterprise knowledge index. The project context: we are building Phase 2 connectors after SharePoint and Confluence are shipped. All connectors must:

- Serve read-only knowledge indexing (not write operations)
- Support per-user ACL enforcement where possible (Entra ID `transitiveMemberOf` pattern)
- Return markdown-ready content to agents
- Fit within a self-hosted MIT-licensed MCP server

**Sources consulted:**
- `https://appnigma.ai/blogs/hubspot-api-complete-builders-guide/` (HubSpot API complete guide 2026)
- `https://linear.app/developers/graphql` (Linear GraphQL getting started)
- `https://linear.app/developers/pagination` (Linear pagination)
- `https://linear.app/developers/rate-limiting` (Linear rate limits)
- `https://learn.microsoft.com/en-us/graph/teams-concept-overview` (Teams Graph API overview)
- `https://learn.microsoft.com/en-us/graph/teams-messaging-overview` (Teams messaging schema)
- `https://syncrivo.ai/en/blog/microsoft-teams-graph-api-deep-dive-interoperability` (Teams deep dive)
- `https://developers.intercom.com/docs/guides/help-center` (Intercom Articles API)
- `https://developers.intercom.com/docs/references/rest-api/api.intercom.io` (Intercom API reference v2.16)
- `https://truto.one/blog/how-do-i-integrate-with-the-intercom-api-2026-architecture-guide` (Intercom 2026 architecture guide)
- `https://developers.dropbox.com/dbx-file-access-guide` (Dropbox file access guide)
- `https://developer.box.com/guides/metadata` + `https://developer.box.com/reference` (Box API reference)
- `https://developers.figma.com/docs/rest-api/` (Figma REST API intro)
- `https://developers.figma.com/docs/rest-api/comments-types/` (Figma comments schema)
- DuckDuckGo searches for all eight connectors (2026 results)

---

## 2. HubSpot

### 2.1 Overview

HubSpot has eight distinct API surfaces in 2026. For a knowledge index, the relevant surfaces are:

| API Surface | Relevance to Knowledge Index | Base URL |
|---|---|---|
| CRM API v3 (REST) | Companies, Deals, Tickets as structured knowledge | `https://api.hubapi.com/crm/v3/` |
| CRM GraphQL | Nested relationship queries (contact + deals + company) | `https://api.hubapi.com/collector/graphql` |
| Conversations API | Support inbox threads and messages | `https://api.hubapi.com/conversations/v3/` |
| CMS API | Blog posts, pages, knowledge base articles | `https://api.hubapi.com/cms/v3/` |
| Knowledge Base API | Help articles (HubSpot CMS-based KB) | `https://api.hubapi.com/cms/v3/` |
| Files API | Attachments on CRM objects | `https://api.hubapi.com/files/v3/` |

Source: `https://appnigma.ai/blogs/hubspot-api-complete-builders-guide/`

### 2.2 Authentication

All HubSpot API surfaces accept the same Bearer token from either OAuth 2.0 (for marketplace/multi-tenant apps) or Private App tokens (for single-portal internal integrations).

```typescript
// Private App token (recommended for enterprise self-hosted)
const headers = {
  'Authorization': `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
  'Content-Type': 'application/json',
};

// OAuth (multi-tenant)
const headers = {
  'Authorization': `Bearer ${oauthAccessToken}`,
  'Content-Type': 'application/json',
};
```

**Key advantage:** Single token for all surfaces. No per-API credential management.

### 2.3 Rate Limits

| Limit | Value | Notes |
|---|---|---|
| General requests | 100 req / 10 seconds per portal | Rolling window, all surfaces aggregate |
| Search API | 4 req / second per portal | `/crm/v3/objects/{type}/search` — cache aggressively |
| CRM GraphQL | Multiple "credits" per query | Effectively tighter than REST per record |
| Daily per-app cap | High hundreds of thousands | Varies by app tier |

The 10-second window is the most important constraint. A burst of 100+ requests triggers 429s immediately.

```typescript
// Token bucket rate limiter for HubSpot
class HubSpotRateLimiter {
  private requestsInWindow = 0;
  private windowStart = Date.now();
  private readonly LIMIT = 90; // conservative: 90/10s to stay below 100 hard limit
  private readonly WINDOW_MS = 10_000;

  async throttle(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart > this.WINDOW_MS) {
      this.requestsInWindow = 0;
      this.windowStart = now;
    }
    if (this.requestsInWindow >= this.LIMIT) {
      const waitMs = this.WINDOW_MS - (now - this.windowStart);
      await new Promise(resolve => setTimeout(resolve, waitMs + 100));
      this.requestsInWindow = 0;
      this.windowStart = Date.now();
    }
    this.requestsInWindow++;
  }
}
```

### 2.4 CRM API v3 — Knowledge-Relevant Objects

#### Contacts, Companies, Deals, Tickets

```typescript
// Cursor pagination — HubSpot v3 uses `after` not offset
async function* listHubSpotCRMObjects(
  objectType: 'contacts' | 'companies' | 'deals' | 'tickets',
  properties: string[],
  token: string,
): AsyncGenerator<HubSpotObject[]> {
  let after: string | undefined;

  do {
    const url = new URL(`https://api.hubapi.com/crm/v3/objects/${objectType}`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('properties', properties.join(','));
    if (after) url.searchParams.set('after', after);

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json() as HubSpotListResponse;

    yield data.results;
    after = data.paging?.next?.after;
  } while (after);
}

// Batch read — 100 records per call, 1 rate limit token
async function batchReadHubSpotObjects(
  objectType: string,
  ids: string[],
  properties: string[],
  token: string,
): Promise<HubSpotObject[]> {
  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/${objectType}/batch/read`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: ids.map(id => ({ id })),
        properties,
      }),
    },
  );
  const data = await response.json();
  return data.results;
}
```

#### CRM Object Schema (standard properties to index)

```typescript
// Companies — high-value for enterprise KB
interface HubSpotCompany {
  id: string;
  properties: {
    name: string;           // company name
    domain: string;         // website domain
    description: string;    // company description
    industry: string;
    hs_object_id: string;
    createdate: string;
    hs_lastmodifieddate: string;
  };
}

// Deals — project/opportunity context
interface HubSpotDeal {
  id: string;
  properties: {
    dealname: string;
    dealstage: string;
    amount: string;
    closedate: string;
    description: string;
    hs_lastmodifieddate: string;
  };
}

// Tickets — support knowledge
interface HubSpotTicket {
  id: string;
  properties: {
    subject: string;
    content: string;        // ticket body — valuable knowledge
    hs_ticket_priority: string;
    hs_pipeline_stage: string;
    hs_lastmodifieddate: string;
  };
}
```

### 2.5 CMS / Knowledge Base API

HubSpot's Knowledge Base is built on the CMS API. Articles are stored as pages under a specific CMS domain. There is no dedicated standalone "Knowledge Base API" — it is accessed through the CMS blog posts or custom object endpoints.

```typescript
// List knowledge base articles via CMS API
async function listHubSpotKBArticles(token: string): Promise<HubSpotKBArticle[]> {
  const response = await fetch(
    'https://api.hubapi.com/cms/v3/site-search/search?q=&type=KNOWLEDGE_ARTICLE&limit=100',
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return response.json();
}

// Alternative: CMS blog posts endpoint (KB articles are blog content in HubSpot)
async function* listKnowledgeBaseArticles(token: string): AsyncGenerator<any[]> {
  let offset = 0;
  while (true) {
    const response = await fetch(
      `https://api.hubapi.com/cms/v3/blogs/posts?limit=100&offset=${offset}&property=id,name,htmlTitle,postBody,state,updated`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    const data = await response.json();
    yield data.objects ?? [];
    if (!data.objects?.length || data.objects.length < 100) break;
    offset += 100;
  }
}
```

**Gotcha:** HubSpot Knowledge Base articles are stored as blog post objects under the CMS API, not a separate resource type. The `site-search` endpoint can filter by `KNOWLEDGE_ARTICLE` type. The private app token must have `content` scope.

### 2.6 CRM GraphQL — When REST Falls Short

Use GraphQL when you need a contact plus all their associated companies, deals, and tickets in one call. For pure read indexing, REST batch endpoints are usually sufficient and count fewer rate limit tokens.

```graphql
# HubSpot CRM GraphQL — one call instead of 5+ REST calls
query GetContactWithContext {
  CRM {
    contact(id: "12345") {
      id
      properties {
        firstname
        lastname
        email
        lifecyclestage
      }
      deals {
        items {
          id
          properties {
            dealname
            amount
            dealstage
          }
        }
      }
      company {
        id
        properties {
          name
          domain
        }
      }
    }
  }
}
```

**Limitation:** GraphQL coverage is incomplete. Events API, Conversations API, and CMS API remain REST-only.

### 2.7 Conversations API

The Conversations API exposes HubSpot's helpdesk inbox — threads, messages, and associated contacts. This is directly analogous to Intercom's Conversations API.

```typescript
// List conversations (support threads)
async function listConversations(token: string): Promise<HubSpotConversation[]> {
  const response = await fetch(
    'https://api.hubapi.com/conversations/v3/conversations?limit=100',
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return response.json();
}
```

### 2.8 Markdown Conversion

HubSpot CRM object properties are plain text. CMS/KB article bodies are HTML (the `postBody` field). Convert using `node-html-markdown` or `turndown`.

```typescript
import { NodeHtmlMarkdown } from 'node-html-markdown';

function hubSpotObjectToMarkdown(obj: HubSpotTicket): string {
  const md = NodeHtmlMarkdown.translate(obj.properties.content ?? '');
  return `# ${obj.properties.subject}\n\n${md}\n\n_Priority: ${obj.properties.hs_ticket_priority}_`;
}

function hubSpotArticleToMarkdown(article: any): string {
  const body = NodeHtmlMarkdown.translate(article.postBody ?? '');
  return `# ${article.htmlTitle}\n\n${body}`;
}
```

### 2.9 ACL Model

HubSpot does not have per-document ACL enforcement comparable to SharePoint/Confluence. Access control is at the portal level — if the private app token has access, everything in the portal is accessible. For enterprise use, this means:

- Index per-portal (one token per HubSpot instance/division)
- No per-user read restriction enforcement at the document level
- Rely on the query context (which agent user is asking) rather than HubSpot-native ACL

### 2.10 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| Search API rate limit is 4 req/s | Breaks if you use search for indexing | Use list endpoints, not search |
| CRM properties are dynamic | Hardcoded property names break | Discover properties via `GET /crm/v3/properties/{type}` at runtime |
| Association types are versioned | Association API changed between v1 and v3 | Always use v3 association endpoints |
| Cursor (`after`) is opaque | Cannot parallelize list operations | Sequential pagination only, use webhooks for delta |
| GraphQL complexity credits | Complex nested queries hit limits faster | Measure complexity headers; prefer REST for bulk operations |
| Private App tokens don't expire | Easier operationally but tokens never rotate automatically | Implement token rotation policy manually |
| KB articles are CMS objects | No dedicated KB API endpoint | Use CMS API with `KNOWLEDGE_ARTICLE` filter in site-search |

---

## 3. Linear

### 3.1 Overview

Linear is the issue tracker of choice for modern product engineering teams (founded 2019, $8/user Standard, $14/user Business). Its GraphQL API is the **same API Linear uses internally** — comprehensive, well-documented, and fully introspectable. For a knowledge index, Linear offers issues, projects, cycles, roadmaps, and documents.

**API endpoint:** `https://api.linear.app/graphql`
**Source:** `https://linear.app/developers/graphql`

### 3.2 Authentication

Two methods:

```typescript
// Method 1: Personal API Key (for internal/self-hosted use)
const headers = {
  'Content-Type': 'application/json',
  'Authorization': process.env.LINEAR_API_KEY!, // no "Bearer" prefix
};

// Method 2: OAuth 2.0 (for multi-tenant apps)
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${oauthAccessToken}`,
};
```

**Key difference from other APIs:** Personal API keys use `Authorization: <KEY>` without the `Bearer` prefix. OAuth tokens use the standard `Bearer` prefix.

### 3.3 Rate Limits

| Auth Type | Request Limit | Complexity Limit | Period |
|---|---|---|---|
| API Key | 2,500 requests | 3,000,000 points | 1 hour |
| OAuth App | 5,000 requests | 2,000,000 points | 1 hour |
| Unauthenticated | 600 requests | 100,000 points | 1 hour |

**Complexity model:** Each property = 0.1 point, each object = 1 point, each connection multiplies children by pagination size (default 50). Max single query complexity = 10,000 points.

**Response headers to monitor:**
- `X-RateLimit-Requests-Remaining`
- `X-RateLimit-Requests-Reset`
- `X-RateLimit-Complexity-Remaining`
- `X-Complexity` (complexity of the current query)

Source: `https://linear.app/developers/rate-limiting`

### 3.4 Pagination

Linear uses Relay-style cursor-based pagination with `first`/`after` and `last`/`before`.

```graphql
# Standard cursor pagination
query Issues {
  issues(first: 50, after: $cursor) {
    edges {
      node {
        id
        title
        description
        state { name }
        assignee { name email }
        team { name }
        project { name }
        createdAt
        updatedAt
      }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}

# Simplified nodes syntax (equivalent, less verbose)
query Teams {
  teams {
    nodes {
      id
      name
    }
  }
}

# Order by updatedAt for incremental sync
query RecentIssues {
  issues(first: 50, orderBy: updatedAt) {
    nodes {
      id
      identifier   # e.g., "ENG-123"
      title
      description
      updatedAt
    }
  }
}
```

Source: `https://linear.app/developers/pagination`

### 3.5 Core Schema for Knowledge Indexing

```graphql
# Full issue with all knowledge-relevant fields
query IssueWithContext {
  issue(id: $issueId) {
    id
    identifier         # "ENG-123" — human-readable short id
    title
    description        # Markdown
    state {
      id
      name             # "In Progress", "Done", etc.
      type             # "started", "completed", "cancelled", etc.
    }
    assignee {
      id
      name
      email
    }
    team {
      id
      name
      key              # team slug
    }
    project {
      id
      name
      description
    }
    labels {
      nodes {
        name
        color
      }
    }
    comments {
      nodes {
        id
        body           # Markdown
        user { name email }
        createdAt
      }
    }
    attachments {
      nodes {
        id
        title
        url
        source { type }
      }
    }
    createdAt
    updatedAt
    archivedAt
    priority           # 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
    estimate
  }
}

# Projects (contain collections of issues)
query Projects {
  projects(first: 50) {
    nodes {
      id
      name
      description   # Markdown
      slugId
      state         # "planned", "started", "completed", "cancelled", "paused"
      startDate
      targetDate
      updatedAt
      teams { nodes { name } }
    }
  }
}

# Documents (Linear's long-form document feature)
query Documents {
  documents(first: 50) {
    nodes {
      id
      title
      content        # Markdown
      project { id name }
      team { id name }
      updatedAt
    }
  }
}

# Cycles (sprints)
query Cycles {
  cycles(first: 50) {
    nodes {
      id
      number
      name
      description
      startsAt
      endsAt
      issues(first: 50) {
        nodes {
          id
          identifier
          title
          state { name }
        }
      }
    }
  }
}
```

### 3.6 TypeScript Implementation

```typescript
import { LinearClient } from '@linear/sdk';

// Using the official TypeScript SDK
const linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

// List all teams
async function getTeams() {
  const teams = await linearClient.teams();
  return teams.nodes;
}

// Paginate all issues with incremental sync support
async function* streamIssues(
  teamId?: string,
  updatedAfter?: Date,
): AsyncGenerator<LinearIssue[]> {
  let cursor: string | undefined;

  do {
    const result = await linearClient.issues({
      first: 50,
      after: cursor,
      filter: {
        ...(teamId && { team: { id: { eq: teamId } } }),
        ...(updatedAfter && { updatedAt: { gt: updatedAfter.toISOString() } }),
      },
      orderBy: 'updatedAt' as any,
    });

    yield result.nodes as LinearIssue[];
    cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined;
  } while (cursor);
}

// Raw GraphQL for custom queries (when SDK doesn't expose what you need)
async function rawLinearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.LINEAR_API_KEY!,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// Convert a Linear issue to markdown
function linearIssueToMarkdown(issue: any): string {
  const lines: string[] = [
    `# [${issue.identifier}] ${issue.title}`,
    '',
    `**Status:** ${issue.state?.name}  **Team:** ${issue.team?.name}  **Priority:** ${['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority ?? 0]}`,
    '',
    issue.description ?? '_No description_',
  ];

  if (issue.comments?.nodes?.length > 0) {
    lines.push('', '## Comments', '');
    for (const comment of issue.comments.nodes) {
      lines.push(`### ${comment.user?.name} — ${comment.createdAt}`, '', comment.body, '');
    }
  }

  return lines.join('\n');
}
```

### 3.7 Webhooks for Delta Sync

```typescript
// Linear webhooks deliver real-time issue changes
// Register at: https://linear.app/YOUR_WORKSPACE/settings/api/webhooks
// Or programmatically:

const webhookPayload = {
  url: 'https://your-server.example.com/webhooks/linear',
  teamId: 'YOUR_TEAM_ID',
  resourceTypes: ['Issue', 'Comment', 'Project', 'Cycle'],
};
```

Webhook payload includes `type` (create/update/remove), `action`, `data` (the changed object), and `updatedFrom` (previous field values for updates).

### 3.8 ACL Model

Linear has no per-document ACL comparable to SharePoint. Access is workspace-scoped:

- API key: accesses the workspace of the user who created it
- OAuth: delegates the user's access (team membership determines what they see)
- For enterprise use: use OAuth to respect team-level access restrictions, or use API key with a service account that only has access to the required teams

### 3.9 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| Archived resources hidden by default | Issues closed long ago are invisible | Pass `includeArchived: true` in pagination args |
| Images require auth | Images in issue descriptions need valid tokens to render | Download and re-host, or skip image URLs in index |
| 3-minute creation grace period | Field changes in first 3 min don't appear in activity log | Do not use activity log for very recent changes |
| Default page size 50 | Complexity multiplies: 50 issues × 50 comments = 2500 records | Specify explicit sizes to avoid complexity overruns |
| Mentions as plain URLs | `@user` mentions stored as full Linear URLs | Parse and replace with display names for readability |
| Documents API limited | Not all workspace documents surface via the API | Check `searchDocuments` query as alternative |

---

## 4. Microsoft Teams

### 4.1 Overview

Microsoft Teams has 120M+ users. All integration goes through the Microsoft Graph API — there is no native Teams-specific webhook system. This is the same Graph API used for SharePoint, OneDrive, Outlook, and the rest of M365.

**Key insight for markdown-for-agents-mcp:** Teams channel messages, meeting transcripts, and channel files are extremely high-value knowledge sources for enterprise deployments. The Teams connector overlaps significantly with SharePoint (files shared in Teams are stored in SharePoint), but channel messages and meeting transcripts are unique.

Source: `https://syncrivo.ai/en/blog/microsoft-teams-graph-api-deep-dive-interoperability`

### 4.2 Authentication

Same Azure AD / Entra ID flow as SharePoint. This is a major implementation advantage — the SharePoint connector's auth infrastructure reuses directly.

```typescript
// Client Credentials flow (server-to-server, no user interaction)
async function getGraphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
  );
  const data = await response.json();
  return data.access_token; // expires in 3600s
}
```

**Required Application permissions (not Delegated):**
- `ChannelMessage.Read.All` — read all channel messages
- `Channel.ReadBasic.All` — enumerate channels
- `Team.ReadBasic.All` — enumerate teams
- `User.Read.All` — resolve user identities
- `OnlineMeetingTranscript.Read.All` — read meeting transcripts (requires tenant opt-in as of July 2026)
- `Chat.Read.All` — read 1:1 and group chat messages (high-sensitivity permission)

**Important (July 2026):** Microsoft introduced a new tenant-level control for transcript access via Graph API, enforced after 29 July 2026. It is disabled by default. Teams admins must explicitly enable it. Source: blog-en.topedia.com.

### 4.3 Core APIs for Knowledge Indexing

#### List Teams and Channels

```typescript
// List all teams in the tenant
async function listTeams(token: string): Promise<MSTeam[]> {
  const response = await fetch(
    'https://graph.microsoft.com/v1.0/teams',
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const data = await response.json();
  return data.value;
}

// List channels in a team
async function listChannels(teamId: string, token: string): Promise<MSChannel[]> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/teams/${teamId}/channels`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const data = await response.json();
  return data.value;
}
```

#### Channel Messages

```typescript
// List messages in a channel (paginated via @odata.nextLink)
async function* streamChannelMessages(
  teamId: string,
  channelId: string,
  token: string,
): AsyncGenerator<MSChatMessage[]> {
  let url: string | null =
    `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages`;

  while (url) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    yield data.value ?? [];
    url = data['@odata.nextLink'] ?? null;
  }
}

// Get replies to a message (thread)
async function getMessageReplies(
  teamId: string,
  channelId: string,
  messageId: string,
  token: string,
): Promise<MSChatMessage[]> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const data = await response.json();
  return data.value;
}
```

#### chatMessage Schema

The `chatMessage` resource is the primary Teams message type. Key fields for knowledge indexing:

```typescript
interface MSChatMessage {
  id: string;
  replyToId: string | null;       // null = top-level message
  etag: string;
  messageType: 'message' | 'chatEvent' | 'typing' | 'unknownFutureValue';
  createdDateTime: string;        // ISO 8601
  lastModifiedDateTime: string;
  lastEditedDateTime: string | null;
  deletedDateTime: string | null;
  subject: string | null;         // set for announcement-type messages
  body: {
    contentType: 'text' | 'html';
    content: string;              // message text (HTML or plain)
  };
  from: {
    user?: {
      id: string;
      displayName: string;
      userIdentityType: 'aadUser' | 'onPremiseAadUser' | 'anonymousGuest';
    };
    application?: { displayName: string };
    device?: { displayName: string };
  };
  attachments: MSChatMessageAttachment[];   // files, cards, meetings
  mentions: {
    id: number;
    mentionText: string;
    mentioned: { user?: { displayName: string } };
  }[];
  importance: 'normal' | 'high' | 'urgent';
  webUrl: string;                 // deep link into Teams
  channelIdentity?: {
    teamId: string;
    channelId: string;
  };
}
```

Source: `https://learn.microsoft.com/en-us/graph/teams-messaging-overview`

#### Attachment Types

```typescript
// File attachment (file lives in SharePoint)
// contentType: "reference"
// contentUrl: SharePoint URL of the file

// Meeting card
// contentType: "application/vnd.microsoft.card.adaptive"
// content: JSON AdaptiveCard

// Forwarded message
// contentType: "forwardedMessageReference"

// Meeting details
// contentType: "meetingReference"
// content.exchangeId: Exchange ID to look up the meeting
```

For knowledge indexing, only `reference` (file) attachments are actionable — the others are structural metadata.

### 4.4 Meeting Transcripts

```typescript
// List online meetings (requires OnlineMeeting.Read.All)
async function getUserOnlineMeetings(userId: string, token: string): Promise<MSOnlineMeeting[]> {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return (await response.json()).value;
}

// Get transcript for a meeting
async function getMeetingTranscript(
  userId: string,
  meetingId: string,
  token: string,
): Promise<string> {
  // List available transcripts
  const transcriptListResponse = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  const transcriptList = await transcriptListResponse.json();
  if (!transcriptList.value?.length) return '';

  // Download transcript content
  const transcriptId = transcriptList.value[0].id;
  const contentResponse = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return contentResponse.text();
}
```

**Critical note (2026):** Tenant-level transcript access via Graph API requires explicit admin enablement. Build with this gated: check capability before attempting transcript indexing.

### 4.5 Subscription Model (Change Notifications)

Teams has no persistent outbound webhook. Instead, Graph API uses a subscription/notification model:

```typescript
// Create a subscription to receive change notifications
async function createChannelSubscription(
  teamId: string,
  channelId: string,
  notificationUrl: string,
  token: string,
): Promise<string> {
  const expirationDateTime = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55 min (max is 60 min)

  const response = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl,
      resource: `/teams/${teamId}/channels/${channelId}/messages`,
      expirationDateTime,
      clientState: crypto.randomUUID(), // HMAC verification secret
    }),
  });
  const sub = await response.json();
  return sub.id;
}

// Renew subscription before 60-minute expiry
async function renewSubscription(subscriptionId: string, token: string): Promise<void> {
  const expirationDateTime = new Date(Date.now() + 55 * 60 * 1000).toISOString();
  await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expirationDateTime }),
  });
}
```

**For a knowledge index (read-only, not real-time):** Skip subscriptions entirely. Use a scheduled poll with delta queries instead.

### 4.6 Delta Queries (Incremental Sync)

```typescript
// Initial sync — get all messages + delta link
async function initialChannelMessageSync(
  teamId: string,
  channelId: string,
  token: string,
): Promise<{ messages: MSChatMessage[]; deltaLink: string }> {
  const messages: MSChatMessage[] = [];
  let url: string | null =
    `https://graph.microsoft.com/v1.0/teams/${teamId}/channels/${channelId}/messages/delta`;

  while (url) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    messages.push(...(data.value ?? []));
    url = data['@odata.nextLink'] ?? null;
    if (data['@odata.deltaLink']) {
      return { messages, deltaLink: data['@odata.deltaLink'] };
    }
  }
  throw new Error('Delta link not received');
}

// Subsequent syncs — only get changes since last delta
async function incrementalChannelSync(
  deltaLink: string,
  token: string,
): Promise<{ changes: MSChatMessage[]; newDeltaLink: string }> {
  const changes: MSChatMessage[] = [];
  let url: string | null = deltaLink;

  while (url) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    changes.push(...(data.value ?? []));
    url = data['@odata.nextLink'] ?? null;
    if (data['@odata.deltaLink']) {
      return { changes, newDeltaLink: data['@odata.deltaLink'] };
    }
  }
  throw new Error('New delta link not received');
}
```

### 4.7 Message to Markdown Conversion

```typescript
import { NodeHtmlMarkdown } from 'node-html-markdown';

function teamsMessageToMarkdown(msg: MSChatMessage, channelName: string): string {
  const body = msg.body.contentType === 'html'
    ? NodeHtmlMarkdown.translate(msg.body.content)
    : msg.body.content;

  const sender = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? 'Unknown';
  const timestamp = new Date(msg.createdDateTime).toISOString();

  const lines = [
    `**${sender}** in #${channelName} — ${timestamp}`,
    '',
    body,
  ];

  if (msg.attachments?.length > 0) {
    const fileAttachments = msg.attachments.filter(a => a.contentType === 'reference');
    if (fileAttachments.length > 0) {
      lines.push('', '**Attachments:**');
      for (const att of fileAttachments) {
        lines.push(`- [${att.name}](${att.contentUrl})`);
      }
    }
  }

  return lines.join('\n');
}
```

### 4.8 Rate Limiting

Microsoft Graph does not publish exact rate limits for Teams APIs. Practical experience:
- ~3-4 requests/second per channel for `ChannelMessage.Send` before throttling
- Read operations have a higher threshold but are also throttled under sustained load
- Always handle `429 Too Many Requests` with `Retry-After` header

```typescript
async function graphFetchWithRetry(url: string, token: string, retries = 3): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '10', 10);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + Math.random() * 1000));
    return graphFetchWithRetry(url, token, retries - 1);
  }

  return response;
}
```

### 4.9 ACL Enforcement

Teams uses the same Entra ID / Azure AD identity model as SharePoint. The `transitiveMemberOf` pattern from the SharePoint connector applies directly:

- Channel message visibility maps to team membership
- `ChannelMessage.Read.All` (application permission) bypasses user-level ACL
- For per-user ACL: use delegated permissions with the user's access token
- For group-based filtering: use `GET /users/{userId}/transitiveMemberOf` to get group memberships, then filter to teams the user is a member of

### 4.10 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| Subscription max expiry = 60 minutes | Missed messages if renewal fails | Overlap renewal by 5 minutes; reconcile on restart |
| Notification URL must be HTTPS + publicly reachable | MCP server behind NAT cannot receive push | Use polling + delta queries for knowledge index use case |
| Transcript access tenant-gated (July 2026) | Silently returns 403 if admin hasn't enabled | Check capability before indexing; fail gracefully |
| HTML message bodies | Raw HTML in `body.content` | Parse with NodeHtmlMarkdown before indexing |
| Chat (1:1) messages require `Chat.Read.All` | High-sensitivity scope, likely rejected by enterprise IT | Scope to channel messages only initially |
| Large attachments in SharePoint | File content lives in SharePoint, not Teams | Reuse SharePoint connector to fetch file content |
| Teams names not globally unique | Two teams can have the same display name | Always use `teamId` as primary key, not display name |

---

## 5. Intercom

### 5.1 Overview

Intercom is a customer messaging platform used by B2B SaaS companies for support, onboarding, and customer success. Its knowledge index value comes from:

1. **Articles** — structured help center content (high signal, clean markdown equivalent)
2. **Conversations** — support threads with rich context about product issues
3. **Tickets** — structured support requests
4. **Contacts + Companies** — customer context

**API version:** 2.16 (as of 2026-08-26)
**Base URL:** `https://api.intercom.io` (EU: `https://api.eu.intercom.io`, AU: `https://api.au.intercom.io`)
**Source:** `https://developers.intercom.com/docs/references/rest-api/api.intercom.io`

### 5.2 Authentication

```typescript
// Access Token (for your own workspace — private app)
const headers = {
  'Authorization': `Bearer ${process.env.INTERCOM_ACCESS_TOKEN}`,
  'Intercom-Version': '2.16',
  'Accept': 'application/json',
};

// OAuth 2.0 (for public apps accessing customer workspaces)
// CRITICAL: Intercom OAuth does NOT issue refresh tokens
// Access tokens are long-lived (until manually revoked)
```

**The No-Refresh-Token Surprise:** Intercom's OAuth does not issue refresh tokens. Tokens live until the user revokes app access. This simplifies token lifecycle management but means:
1. Revocation detection requires monitoring 401 responses
2. Tokens are high-value long-term secrets — encrypt at rest
3. Your standard OAuth token refresh pipeline does not apply

Source: `https://truto.one/blog/how-do-i-integrate-with-the-intercom-api-2026-architecture-guide`

### 5.3 Rate Limits

**Critical implementation detail:** Although limits are measured per minute, Intercom distributes them into 10-second windows.

| App Type | Limit | Effective Window Limit |
|---|---|---|
| Private App (default) | 10,000 req/min | ~166 req per 10-second window |
| Per workspace | 25,000 req/min | ~416 req per 10-second window |

```typescript
// Rate-limit-aware Intercom fetch
async function intercomFetch(
  url: string,
  options: RequestInit,
  retries = 3,
): Promise<Response> {
  const response = await fetch(url, options);

  if (response.status === 429 && retries > 0) {
    const resetAt = response.headers.get('X-RateLimit-Reset');
    // resetAt is a Unix timestamp
    const waitMs = resetAt
      ? Math.max(0, Number(resetAt) * 1000 - Date.now()) + Math.random() * 1000
      : 10_000;
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return intercomFetch(url, options, retries - 1);
  }

  return response;
}
```

Source: `https://truto.one/blog/how-do-i-integrate-with-the-intercom-api-2026-architecture-guide`

### 5.4 Articles API

Articles are the cleanest knowledge source in Intercom — they're the help center content, directly equivalent to Confluence pages.

```typescript
// Article object schema
interface IntercomArticle {
  type: 'article';
  id: string;
  title: string;
  description: string | null;
  body: string;                   // HTML content
  author_id: number;
  state: 'published' | 'draft';
  created_at: number;             // Unix timestamp
  updated_at: number;
  url: string | null;
  parent_id: string | null;       // collection ID
  parent_ids: string[];
  parent_type: string | null;     // "collection"
  default_locale: string;         // "en"
  translated_content: Record<string, { title: string; body: string }>;
  statistics: {
    type: 'article_statistics';
    views: number;
    conversions: number;
    happy_reaction_percentage: number;
    neutral_reaction_percentage: number;
    sad_reaction_percentage: number;
  };
}

// List all articles
async function* listIntercomArticles(token: string): AsyncGenerator<IntercomArticle[]> {
  let url: string | null = 'https://api.intercom.io/articles?per_page=150';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Intercom-Version': '2.16',
    'Accept': 'application/json',
  };

  while (url) {
    const response = await intercomFetch(url, { headers });
    const data = await response.json();
    yield data.data ?? [];

    // Cursor pagination: starting_after
    url = data.pages?.next?.starting_after
      ? `https://api.intercom.io/articles?per_page=150&starting_after=${data.pages.next.starting_after}`
      : null;
  }
}

// Convert article to markdown
import { NodeHtmlMarkdown } from 'node-html-markdown';

function intercomArticleToMarkdown(article: IntercomArticle): string {
  const body = NodeHtmlMarkdown.translate(article.body);
  return [
    `# ${article.title}`,
    '',
    article.description ? `> ${article.description}` : '',
    '',
    body,
    '',
    `_State: ${article.state} | Updated: ${new Date(article.updated_at * 1000).toISOString()}_`,
  ].join('\n');
}
```

### 5.5 Collections API

Articles are organized into Collections (up to 3 levels deep). Index collections for navigation context.

```typescript
interface IntercomCollection {
  type: 'collection';
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  url: string | null;
  parent_id: string | null;
  default_locale: string;
  translated_content: Record<string, { name: string; description: string }>;
}

async function listIntercomCollections(token: string): Promise<IntercomCollection[]> {
  const response = await intercomFetch(
    'https://api.intercom.io/help_center/collections',
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Intercom-Version': '2.16',
        'Accept': 'application/json',
      },
    },
  );
  const data = await response.json();
  return data.data ?? [];
}
```

### 5.6 Conversations API

Conversations contain rich knowledge about recurring customer problems. For a knowledge index, treat closed/resolved conversations as a signal of support patterns.

```typescript
interface IntercomConversation {
  type: 'conversation';
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  waiting_since: number | null;
  snoozed_until: number | null;
  open: boolean;
  state: 'open' | 'closed' | 'snoozed';
  read: boolean;
  priority: 'priority' | 'not_priority';
  first_contact_reply: {
    created_at: number;
    type: 'conversation';
    url: string | null;
  } | null;
  conversation_message: {
    type: 'conversation_message';
    id: string;
    subject: string;
    body: string;                 // HTML
    author: { type: 'contact' | 'admin'; id: string; name: string };
    attachments: any[];
    url: string | null;
  };
  conversation_parts: {
    type: 'conversation_part.list';
    conversation_parts: IntercomConversationPart[];
    total_count: number;
  };
}

interface IntercomConversationPart {
  type: 'conversation_part';
  id: string;
  part_type: string;        // "comment", "note", "assignment", etc.
  body: string | null;      // HTML
  created_at: number;
  updated_at: number;
  author: { type: string; id: string; name: string; email: string };
  attachments: any[];
}

// Search closed conversations (most useful for KB)
async function searchIntercomConversations(
  token: string,
  query: Record<string, unknown>,
): Promise<IntercomConversation[]> {
  const response = await intercomFetch(
    'https://api.intercom.io/conversations/search',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Intercom-Version': '2.16',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );
  const data = await response.json();
  return data.conversations ?? [];
}

// Get closed conversations from last 30 days
async function getRecentClosedConversations(token: string): Promise<IntercomConversation[]> {
  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  return searchIntercomConversations(token, {
    field: 'state',
    operator: '=',
    value: 'closed',
  });
}
```

### 5.7 Pagination

All list endpoints use `starting_after` cursor pagination. No random access; no parallelization.

```typescript
// Universal Intercom paginator
async function* paginateIntercom<T>(
  baseUrl: string,
  token: string,
  dataKey = 'data',
  perPage = 150,
): AsyncGenerator<T[]> {
  let startingAfter: string | null = null;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Intercom-Version': '2.16',
    'Accept': 'application/json',
  };

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('per_page', String(perPage));
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);

    const response = await intercomFetch(url.toString(), { headers });
    const data = await response.json();
    yield (data[dataKey] ?? []) as T[];

    startingAfter = data.pages?.next?.starting_after ?? null;
  } while (startingAfter);
}
```

**Gotcha:** The maximum `per_page` is 150. The default is 20. Always set 150 explicitly for bulk indexing.

**Gotcha:** Conversations `search` endpoint uses a POST body for pagination (cursor in request body), while list endpoints use query params. Your pagination wrapper needs to handle both.

### 5.8 ACL Model

No per-document ACL. Access is workspace-scoped via the OAuth token. For enterprise use:

- One Intercom workspace per customer/division
- Index the whole workspace with service account token
- Filter by conversation assignee team if department-level scoping is needed

### 5.9 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| No refresh tokens | Broken integrations silently fail with 401 | Monitor for 401s; alert user to reconnect |
| 10-second window distribution | Burst of 167+ requests in 10s → immediate 429 | Implement a proactive 10-second token bucket |
| Cursor cannot be stored if using in-memory | Worker restart loses position | Persist cursor to Redis/DB after every page |
| `starting_after` cursor position differs by endpoint | Generic paginator breaks | Map endpoint → cursor path explicitly |
| Conversations have nested parts | Need second request for full thread content | `GET /conversations/{id}` includes `conversation_parts` |
| HTML body content | Raw HTML in all text fields | NodeHtmlMarkdown conversion required |
| Deleted content returns 404 | Index drift on deletions | Handle 404s during re-sync; remove from index |
| Multiple API regions | EU/AU companies must use regional base URL | Auto-detect region from OAuth install or test both |

---

## 6. Dropbox

### 6.1 Overview

Dropbox Business is a file storage platform with strong adoption in smaller enterprises and creative agencies. For SA enterprise, it is lower priority than Box (more common in large SA enterprises), but the API is clean and well-documented.

**API version:** v2
**Base URL:** `https://api.dropboxapi.com/2/` (API calls) + `https://content.dropboxapi.com/2/` (file downloads)
**JavaScript/Node.js SDK:** `npm install dropbox` (official, version 10.34.0 as of mid-2026)

Source: `https://developers.dropbox.com/dbx-file-access-guide`

### 6.2 Authentication

```typescript
// OAuth 2.0 (required for user files)
// PKCE flow for server-side apps
const { Dropbox, DropboxAuth } = require('dropbox');

const dbxAuth = new DropboxAuth({
  clientId: process.env.DROPBOX_APP_KEY,
  clientSecret: process.env.DROPBOX_APP_SECRET,
});

// Generate auth URL
const authUrl = await dbxAuth.getAuthenticationUrl(
  'https://your-redirect-uri.example.com',
  null,
  'code',
  'offline',   // offline = get refresh token
  null, null, true, // PKCE
);

// Exchange code for tokens
const tokenResponse = await dbxAuth.getAccessTokenFromCode(
  'https://your-redirect-uri.example.com',
  authorizationCode,
);
```

### 6.3 File Metadata Schema

```typescript
interface DropboxFileMetadata {
  '.tag': 'file';
  name: string;                    // "report.docx"
  path_lower: string;              // "/reports/q2/report.docx"
  path_display: string;            // "/Reports/Q2/report.docx"
  id: string;                      // "id:odTlUvbpIEFAAAAAAAAGOQ" — stable across moves/renames
  client_modified: string;         // ISO 8601
  server_modified: string;         // ISO 8601
  rev: string;                     // version identifier
  size: number;                    // bytes
  is_downloadable: boolean;        // false for Google Docs, Dropbox Paper
  content_hash: string;            // SHA-256-based hash for change detection
  sharing_info?: {
    read_only: boolean;
    parent_shared_folder_id: string;
    modified_by: string;
  };
  file_lock_info?: {
    is_lockholder: boolean;
    lockholder_name: string;
    lockholder_account_id: string;
    created: string;
  };
}

interface DropboxFolderMetadata {
  '.tag': 'folder';
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  sharing_info?: {
    read_only: boolean;
    parent_shared_folder_id: string;
    traverse_only: boolean;
    no_access: boolean;
  };
}
```

Source: `https://developers.dropbox.com/dbx-file-access-guide`

### 6.4 Listing Files

```typescript
import { Dropbox } from 'dropbox';
import fetch from 'node-fetch';

const dbx = new Dropbox({ accessToken: process.env.DROPBOX_ACCESS_TOKEN, fetch });

// List folder recursively
async function* listDropboxFolder(
  path: string,
): AsyncGenerator<(DropboxFileMetadata | DropboxFolderMetadata)[]> {
  let result = await dbx.filesListFolder({
    path,
    recursive: true,
    include_deleted: false,
    include_media_info: false,
  });

  yield result.result.entries as any[];

  while (result.result.has_more) {
    result = await dbx.filesListFolderContinue({
      cursor: result.result.cursor,
    });
    yield result.result.entries as any[];
  }
}

// Delta sync — only get changes since last cursor
async function getDropboxChanges(
  cursor: string,
): Promise<{ entries: any[]; cursor: string; hasMore: boolean }> {
  const result = await dbx.filesListFolderContinue({ cursor });
  return {
    entries: result.result.entries,
    cursor: result.result.cursor,
    hasMore: result.result.has_more,
  };
}

// Get a fresh longpoll cursor for a path
async function getDropboxCursor(path: string): Promise<string> {
  const result = await dbx.filesListFolderGetLatestCursor({ path, recursive: true });
  return result.result.cursor;
}
```

### 6.5 Downloading File Content

```typescript
// Download downloadable files (text, Office, PDF, etc.)
async function downloadDropboxFile(path: string, accessToken: string): Promise<Buffer> {
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });
  return Buffer.from(await response.arrayBuffer());
}

// Export non-downloadable files (Dropbox Paper, Google Docs)
// is_downloadable = false on the metadata
async function exportDropboxFile(
  path: string,
  exportFormat: string,  // "markdown" for Paper, "docx" for Office, etc.
  accessToken: string,
): Promise<Buffer> {
  const response = await fetch('https://content.dropboxapi.com/2/files/export', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path, export_format: exportFormat }),
    },
  });
  return Buffer.from(await response.arrayBuffer());
}

// Dropbox Paper documents export as markdown — very useful for knowledge indexing
async function getDropboxPaperAsMarkdown(path: string, accessToken: string): Promise<string> {
  const buffer = await exportDropboxFile(path, 'markdown', accessToken);
  return buffer.toString('utf-8');
}
```

**Key insight:** Dropbox Paper (`.paper` extension) exports directly to Markdown via the `/files/export` endpoint with `export_format: "markdown"`. This is directly ingestible without any HTML-to-markdown conversion.

### 6.6 Content Hash for Change Detection

Dropbox provides a `content_hash` field on every file. Use this to detect changes without re-downloading files:

```typescript
// Compare stored hash with current hash to detect changes
async function hasFileChanged(
  path: string,
  knownHash: string,
  accessToken: string,
): Promise<boolean> {
  const dbx = new Dropbox({ accessToken, fetch });
  const meta = await dbx.filesGetMetadata({ path });
  if (meta.result['.tag'] !== 'file') return false;
  return (meta.result as DropboxFileMetadata).content_hash !== knownHash;
}
```

### 6.7 Non-Downloadable File Types

| File Type | is_downloadable | Action |
|---|---|---|
| Regular files (.docx, .pdf, .txt) | true | Use `/files/download` |
| Dropbox Paper | false | Use `/files/export?export_format=markdown` |
| Google Docs (via Google Drive integration) | false | Use `/files/export?export_format=docx` then convert |
| Google Sheets | false | Use `/files/export?export_format=xlsx` |
| Google Slides | false | Use `/files/export?export_format=pptx` |

### 6.8 ACL Model

Dropbox sharing is per-folder with `sharing_info.read_only` and `traverse_only` flags. No integration with Entra ID.

- `read_only: true` — user can read but not modify
- `traverse_only: true` — user can see the folder exists but not its contents
- `no_access: true` — user knows the folder exists; any content access returns error

For enterprise: use the Team Namespace API to access shared business folders. Individual user tokens see only their personal Dropbox + shared folders they have been granted access to.

### 6.9 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| Locked files | Download blocked | Check `file_lock_info` before downloading |
| `traverse_only` folders return empty entries | Silently no content | Check `sharing_info.traverse_only` before listing |
| Non-downloadable files need `/files/export` | Different endpoint, different format | Check `is_downloadable` on every file before download |
| Rate limits not published | Unclear throttle thresholds | Implement 429 backoff; avoid > 1 req/s sustained |
| File ID is stable, path is not | Path-based bookmarks break on moves/renames | Always store file ID (`id:...`) as primary key |
| Cursor expires | Delta sync breaks if cursor unused too long | Store cursor with TTL; fall back to full re-scan |
| Google Docs need intermediate conversion | Extra processing step | Extract text from exported DOCX using mammoth/docx2md |

---

## 7. Box

### 7.1 Overview

Box is the enterprise document management platform most common in large regulated enterprises (financial services, healthcare, legal). It has a more sophisticated permission model than Dropbox and supports metadata templates, classification, and compliance features. For SA enterprise, Box has higher priority than Dropbox.

**API version:** 2.0 + 2025.0 + 2026.0 (versioned endpoints)
**Base URL:** `https://api.box.com/2.0`
**Source:** `https://developer.box.com/reference`

### 7.2 Authentication

Box supports multiple auth methods:

| Method | Use Case | Notes |
|---|---|---|
| OAuth 2.0 (3-legged) | User-delegated access | Standard web app flow |
| JWT (Server-to-server) | Service account / enterprise integration | No user interaction; best for MCP server |
| Client Credentials Grant | Machine-to-machine | Newer alternative to JWT |
| Developer Token | Development/testing | 60-minute tokens, manual generation |

```typescript
// JWT authentication (best for enterprise MCP server)
// Uses box-node-sdk
import BoxSDK from 'box-node-sdk';

const sdk = BoxSDK.getPreconfiguredInstance({
  boxAppSettings: {
    clientID: process.env.BOX_CLIENT_ID!,
    clientSecret: process.env.BOX_CLIENT_SECRET!,
    appAuth: {
      publicKeyID: process.env.BOX_PUBLIC_KEY_ID!,
      privateKey: process.env.BOX_PRIVATE_KEY!,
      passphrase: process.env.BOX_KEY_PASSPHRASE!,
    },
  },
  enterpriseID: process.env.BOX_ENTERPRISE_ID!,
});

// Service account client (full enterprise access)
const serviceAccountClient = sdk.getAppAuthClient('enterprise');

// Impersonate a specific user (for per-user ACL enforcement)
const userClient = sdk.getAppAuthClient('user', userId);
```

### 7.3 Files and Folders API

```typescript
// List folder contents (paginated)
async function* listBoxFolder(
  folderId: string,
  client: BoxClient,
): AsyncGenerator<BoxItem[]> {
  const PAGE_SIZE = 200; // max is 1000 for folder items
  let offset = 0;

  while (true) {
    const items = await client.folders.getItems(folderId, {
      limit: PAGE_SIZE,
      offset,
      fields: 'id,type,name,modified_at,created_at,size,sha1,path_collection,permissions',
    });

    yield items.entries;

    if (items.entries.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

// Download file content
async function downloadBoxFile(fileId: string, client: BoxClient): Promise<Buffer> {
  const stream = await client.files.getReadStream(fileId);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Box File schema
interface BoxFile {
  type: 'file';
  id: string;
  name: string;
  size: number;
  sha1: string;                    // file hash for change detection
  created_at: string;              // ISO 8601
  modified_at: string;
  path_collection: {
    total_count: number;
    entries: Array<{ type: 'folder'; id: string; name: string }>;
  };
  permissions: {
    can_download: boolean;
    can_preview: boolean;
    can_upload: boolean;
    can_annotate: boolean;
    can_comment: boolean;
    can_rename: boolean;
    can_delete: boolean;
    can_share: boolean;
  };
  metadata?: Record<string, Record<string, unknown>>; // metadata instances
}
```

### 7.4 Metadata Templates and Instances

Box's metadata system is one of its strongest enterprise features. Templates are reusable schemas; instances are applied to specific files/folders.

```typescript
// List all enterprise metadata templates
async function listBoxMetadataTemplates(client: BoxClient): Promise<BoxMetadataTemplate[]> {
  const templates = await client.metadata.getTemplates('enterprise');
  return templates.entries;
}

interface BoxMetadataTemplate {
  type: 'metadata_template';
  id: string;
  templateKey: string;          // unique key, e.g. "contractDetails"
  scope: 'enterprise' | 'global';
  displayName: string;
  hidden: boolean;
  fields: Array<{
    type: 'string' | 'float' | 'date' | 'enum' | 'multiSelect';
    key: string;
    displayName: string;
    description?: string;
    options?: Array<{ key: string }>; // for enum fields
  }>;
}

// Get metadata instance on a file
async function getFileMetadata(
  fileId: string,
  templateKey: string,
  client: BoxClient,
): Promise<Record<string, unknown>> {
  return client.files.getMetadata(fileId, 'enterprise', templateKey);
}

// Metadata query — find files by metadata values
async function queryByMetadata(
  templateKey: string,
  ancestorFolderId: string,
  query: string,           // SQL-like: "contractValue >= :value"
  queryParams: Record<string, unknown>,
  client: BoxClient,
): Promise<BoxFile[]> {
  const results = await client.metadata.query({
    from: `enterprise.${templateKey}`,
    ancestor_folder_id: ancestorFolderId,
    query,
    query_params: queryParams,
    limit: 100,
  });
  return results.entries;
}
```

### 7.5 Box AI API

Box has a native AI API for document question-answering and summarization. This is directly competitive with our Phase 2 agent use case.

```typescript
// Box AI Q&A (competitor to our MCP approach)
async function askBoxAI(fileId: string, question: string, client: BoxClient): Promise<string> {
  const response = await client.ai.ask({
    mode: 'single_item_qa',
    prompt: question,
    items: [{ type: 'file', id: fileId }],
  });
  return response.answer;
}

// Box AI extraction from metadata template fields
async function extractMetadataWithAI(
  fileId: string,
  fields: string[],
  client: BoxClient,
): Promise<Record<string, unknown>> {
  return client.ai.extractStructured({
    items: [{ type: 'file', id: fileId }],
    metadata_template: { type: 'metadata_template', scope: 'enterprise', template_key: fields[0] },
  });
}
```

**Competitive note:** Box AI API demonstrates that enterprises want AI-assisted document access directly on their file storage. Our MCP approach serves a broader agent ecosystem vs Box AI's platform lock-in.

### 7.6 Search API

```typescript
// Full-text search across Box content
async function searchBox(
  query: string,
  client: BoxClient,
  options?: { fileExtensions?: string[]; ancestorFolderIds?: string[] },
): Promise<BoxSearchResult[]> {
  const results = await client.search.query(query, {
    type: 'file',
    file_extensions: options?.fileExtensions,
    ancestor_folder_ids: options?.ancestorFolderIds,
    fields: 'id,name,modified_at,path_collection',
    limit: 100,
  });
  return results.entries;
}
```

### 7.7 ACL Model

Box has a rich permission model:

- **Collaborations:** per-file and per-folder with roles: `viewer`, `editor`, `co-owner`, `owner`, `viewer uploader`, `previewer`, `uploader`
- **Enterprise groups:** folders shared with AD groups
- **Managed users:** Box can sync with Active Directory / Entra ID

For the MCP server:

```typescript
// Check if a user has access to a file
async function canUserAccessFile(
  fileId: string,
  userId: string,
  sdk: BoxSDK,
): Promise<boolean> {
  try {
    // Impersonate the user and try to get file info
    const userClient = sdk.getAppAuthClient('user', userId);
    await userClient.files.get(fileId, { fields: 'id' });
    return true;
  } catch (err: any) {
    if (err.statusCode === 403 || err.statusCode === 404) return false;
    throw err;
  }
}
```

### 7.8 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| JWT setup is complex | 15-30 minute configuration with Box admin | Document setup guide; test with developer token first |
| API versioning (2.0/2025.0/2026.0) | Some features only on newer versions | Use `box-version` header; default to 2.0 for compatibility |
| Metadata query API needs SQL-like syntax | Learning curve for query construction | Provide helper functions for common query patterns |
| Rate limits: 1000 req/min per token | Enterprise sync can hit this | Per-client rate limiting; use service account for bulk |
| Folder item listing max 1000 | Large folders need multiple pages | Handle offset pagination carefully |
| File previews (representations) need separate call | Content not in listing response | Cache representation URLs; they expire |
| Box Notes are proprietary format | Not standard Office/PDF | Use Box AI extraction or skip Notes in first version |

---

## 8. OneDrive

### 8.1 Overview

OneDrive uses the **same Graph API as SharePoint**. The core difference is context:

| Aspect | SharePoint | OneDrive (Personal/Business) |
|---|---|---|
| API | Microsoft Graph | Microsoft Graph (same) |
| Root resource | `/sites/{siteId}/drives` | `/me/drive` or `/users/{userId}/drive` |
| Primary use | Team/org document libraries | Individual user files |
| Permissions | Site-level groups + AD groups | Per-file sharing + user identity |
| Auth | Same Azure AD client credentials | Same Azure AD, but needs `Files.Read.All` |

**Key insight:** If you build the SharePoint connector first, the OneDrive connector is ~20% incremental work — primarily changes to the root traversal path and the permission resolution model.

### 8.2 Authentication

Same Azure AD / Entra ID token as SharePoint. Additional required scope:

- `Files.Read.All` — read all files on behalf of users
- `Files.ReadWrite.All` — if write needed (not required for index)

### 8.3 Core API

```typescript
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// List all OneDrive drives for all users (requires Files.Read.All)
async function listUserDrives(userId: string, token: string): Promise<MSDrive[]> {
  const response = await fetch(`${GRAPH_BASE}/users/${userId}/drives`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return (await response.json()).value;
}

// List root folder of user's OneDrive
async function listOneDriveRoot(userId: string, token: string): Promise<MSDriveItem[]> {
  const response = await fetch(
    `${GRAPH_BASE}/users/${userId}/drive/root/children`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return (await response.json()).value;
}

// Enumerate files recursively (same pattern as SharePoint)
async function* streamOneDriveItems(
  userId: string,
  folderId: string,
  token: string,
): AsyncGenerator<MSDriveItem[]> {
  let url: string | null = `${GRAPH_BASE}/users/${userId}/drive/items/${folderId}/children?$top=100`;

  while (url) {
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await response.json();
    const folders = data.value.filter((i: MSDriveItem) => i.folder);
    yield data.value;
    url = data['@odata.nextLink'] ?? null;

    // Recurse into folders (breadth-first)
    for (const folder of folders) {
      yield* streamOneDriveItems(userId, folder.id, token);
    }
  }
}

// Download file content (same endpoint as SharePoint)
async function downloadOneDriveFile(
  userId: string,
  itemId: string,
  token: string,
): Promise<Buffer> {
  const response = await fetch(
    `${GRAPH_BASE}/users/${userId}/drive/items/${itemId}/content`,
    { headers: { 'Authorization': `Bearer ${token}` }, redirect: 'follow' },
  );
  return Buffer.from(await response.arrayBuffer());
}

// Delta sync — identical to SharePoint delta
async function getOneDriveDelta(
  userId: string,
  deltaLink: string | null,
  token: string,
): Promise<{ items: MSDriveItem[]; newDeltaLink: string }> {
  const url = deltaLink ?? `${GRAPH_BASE}/users/${userId}/drive/root/delta`;
  const items: MSDriveItem[] = [];
  let currentUrl: string | null = url;

  while (currentUrl) {
    const response = await fetch(currentUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    items.push(...(data.value ?? []));
    currentUrl = data['@odata.nextLink'] ?? null;
    if (data['@odata.deltaLink']) return { items, newDeltaLink: data['@odata.deltaLink'] };
  }
  throw new Error('Delta link not received');
}
```

### 8.4 Key Differences from SharePoint

| Aspect | SharePoint | OneDrive |
|---|---|---|
| Root path | `/sites/{siteId}/drive/root` | `/users/{userId}/drive/root` or `/me/drive/root` |
| Delta tracking | Per drive | Per drive (same API) |
| Search scope | Site collection | User's OneDrive only |
| Shared with me | Not applicable | `GET /me/drive/sharedWithMe` for items shared externally |
| Permissions | Site groups + AD | User-to-user sharing + AD groups |

```typescript
// Shared with me — files from other users shared with the current user
async function getFilesSharedWithMe(userId: string, token: string): Promise<MSDriveItem[]> {
  const response = await fetch(
    `${GRAPH_BASE}/users/${userId}/drive/sharedWithMe`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  return (await response.json()).value;
}
```

### 8.5 Implementation Strategy

**Recommendation:** Do not build a separate OneDrive connector. Extend the SharePoint connector to handle both:

```typescript
// Unified Microsoft Drive connector
interface MicrosoftDriveSource {
  type: 'sharepoint' | 'onedrive';
  // SharePoint: use siteId + driveId
  siteId?: string;
  driveId?: string;
  // OneDrive: use userId
  userId?: string;
}

function getDriveRootUrl(source: MicrosoftDriveSource): string {
  if (source.type === 'sharepoint' && source.siteId && source.driveId) {
    return `https://graph.microsoft.com/v1.0/sites/${source.siteId}/drives/${source.driveId}/root`;
  }
  if (source.type === 'onedrive' && source.userId) {
    return `https://graph.microsoft.com/v1.0/users/${source.userId}/drive/root`;
  }
  throw new Error('Invalid drive source configuration');
}
```

---

## 9. Figma

### 9.1 Overview

Figma is the dominant collaborative design tool. Its knowledge index value is different from other connectors:

- **Component documentation** — descriptions on components and styles
- **File and frame annotations** — description fields on frames/artboards
- **Comments** — design review discussions, feedback threads, resolved issues
- **Version history** — design decisions over time
- **Variables** — design tokens with descriptions

For product teams, Figma comments contain rich design rationale and decision context that is not captured elsewhere.

**API base URL:** `https://api.figma.com`
**Source:** `https://developers.figma.com/docs/rest-api/`

### 9.2 Authentication

```typescript
// Method 1: Personal Access Token (simplest, for internal use)
const headers = {
  'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN!,
};

// Method 2: OAuth 2.0 (for multi-user apps)
const headers = {
  'Authorization': `Bearer ${oauthToken}`,
};
```

**Scopes for knowledge indexing:**
- `files:read` — read file data
- `file_comments:read` — read comments
- `file_dev_resources:read` — read dev resources linked to frames

### 9.3 Files API

```typescript
// Get file structure (JSON tree of all nodes)
async function getFigmaFile(fileKey: string, token: string): Promise<FigmaFile> {
  const response = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': token },
  });
  return response.json();
}

interface FigmaFile {
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  lastModified: string;           // ISO 8601
  editorType: 'figma' | 'figjam';
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components: Record<string, FigmaComponent>;
  componentSets: Record<string, FigmaComponentSet>;
  styles: Record<string, FigmaStyle>;
  schemaVersion: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: 'DOCUMENT' | 'CANVAS' | 'FRAME' | 'GROUP' | 'COMPONENT' | 'INSTANCE' | 'TEXT' | 'VECTOR';
  children?: FigmaNode[];
  description?: string;           // documentation on components/frames — valuable knowledge
}
```

### 9.4 Comments API

Comments are the highest-knowledge-density content in Figma files — design decisions, review feedback, resolved issues.

```typescript
// List all comments on a file
async function getFigmaComments(fileKey: string, token: string): Promise<FigmaComment[]> {
  const response = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
    headers: { 'X-Figma-Token': token },
  });
  const data = await response.json();
  return data.comments;
}

interface FigmaComment {
  id: string;
  file_key: string;
  parent_id: string | null;       // null = top-level comment; string = reply
  user: FigmaUser;
  created_at: string;             // ISO 8601
  resolved_at: string | null;     // if null, comment is unresolved
  order_id: number | null;        // only on top-level comments; comment number shown in UI
  message: string;                // plain text or markdown (use as_md param)
  client_meta: FigmaCommentPosition;
  reactions: FigmaReaction[];
}

type FigmaCommentPosition =
  | { x: number; y: number }                                    // absolute canvas coordinates
  | { node_id: string; node_offset: { x: number; y: number } } // relative to a frame
  | { node_id: string; region: { x: number; y: number; width: number; height: number } }; // region comment

interface FigmaUser {
  id: string;
  handle: string;
  img_url: string;
  email: string;
}

interface FigmaReaction {
  user: FigmaUser;
  emoji: string;          // shortcode e.g. ":heart:", ":+1:"
  created_at: string;
}
```

Source: `https://developers.figma.com/docs/rest-api/comments-types/`

```typescript
// Get comments with markdown formatting
async function getFigmaCommentsAsMarkdown(fileKey: string, token: string): Promise<FigmaComment[]> {
  const response = await fetch(
    `https://api.figma.com/v1/files/${fileKey}/comments?as_md=true`,
    { headers: { 'X-Figma-Token': token } },
  );
  return (await response.json()).comments;
}

// Convert a comment thread to markdown
function figmaCommentThreadToMarkdown(
  topLevelComment: FigmaComment,
  replies: FigmaComment[],
  frameContext?: string,
): string {
  const lines = [
    `### Comment #${topLevelComment.order_id} by ${topLevelComment.user.handle}`,
    '',
    frameContext ? `_On frame: ${frameContext}_` : '',
    topLevelComment.resolved_at ? `_Resolved: ${topLevelComment.resolved_at}_` : '_Unresolved_',
    '',
    topLevelComment.message,
  ];

  for (const reply of replies.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    lines.push('', `**${reply.user.handle}** replied:`, reply.message);
  }

  return lines.filter(l => l !== null).join('\n');
}
```

### 9.5 Components and Styles

Component descriptions are often the closest thing Figma has to documentation.

```typescript
// Extract component descriptions from a file
function extractComponentDocumentation(file: FigmaFile): ComponentDoc[] {
  return Object.entries(file.components)
    .filter(([_, comp]) => comp.description)
    .map(([nodeId, comp]) => ({
      id: nodeId,
      name: comp.name,
      description: comp.description,
      componentSetId: comp.componentSetId,
    }));
}

interface ComponentDoc {
  id: string;
  name: string;
  description: string;
  componentSetId?: string;
}
```

### 9.6 Projects and Files Listing

```typescript
// List all projects for a team
async function listFigmaProjects(teamId: string, token: string): Promise<FigmaProject[]> {
  const response = await fetch(
    `https://api.figma.com/v1/teams/${teamId}/projects`,
    { headers: { 'X-Figma-Token': token } },
  );
  return (await response.json()).projects;
}

// List files in a project
async function listFigmaFiles(projectId: string, token: string): Promise<FigmaFileEntry[]> {
  const response = await fetch(
    `https://api.figma.com/v1/projects/${projectId}/files`,
    { headers: { 'X-Figma-Token': token } },
  );
  return (await response.json()).files;
}

interface FigmaFileEntry {
  key: string;                    // file identifier (use in file API calls)
  name: string;
  thumbnail_url: string;
  last_modified: string;          // ISO 8601
}
```

### 9.7 Rate Limits

Figma rate limits are not precisely published. Practical limits:
- Standard plan: ~120 requests/minute
- Enterprise/Organization plan: higher limits
- Response headers include rate limit info

```typescript
// Minimal Figma rate limiter
async function figmaFetch(url: string, token: string, retries = 3): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'X-Figma-Token': token },
  });

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    return figmaFetch(url, token, retries - 1);
  }

  return response;
}
```

### 9.8 ACL Model

Figma permissions are file/project-level:
- `role: 'viewer'` — can view (sufficient for indexing)
- `role: 'editor'` — can edit
- `role: 'owner'` — owns the file

For enterprise: Figma Organization plan supports SSO via SCIM, meaning users can be provisioned from Entra ID. But Figma does not integrate with Graph API for permission enforcement — all ACL is native Figma.

For the MCP server: use per-user OAuth tokens (each user's token only sees files they have access to), rather than a service account.

### 9.9 Limitations and Gotchas

| Issue | Impact | Mitigation |
|---|---|---|
| Large files have huge JSON responses | File tree can be hundreds of MB | Use `depth` param to limit traversal; fetch subtrees |
| No incremental file content API | Must download full file each sync | Use `lastModified` + version to skip unchanged files |
| Component descriptions are often empty | Low knowledge density for undocumented design systems | Focus on comments, not component descriptions |
| Comment position is canvas coordinates | Hard to map to human context | Use `node_id` from `client_meta` to resolve frame name |
| Rate limits undefined | Unpredictable throttling | Conservative: 60 req/min; exponential backoff on 429 |
| `as_md=true` param undocumented | May not render markdown in all comment types | Test per-workspace; fall back to plain text |
| FigJam files have different node structure | FIGJAM type needs different parsing | Check `editorType` before parsing |

---

## 10. Priority Ranking Table

Rankings based on large SA enterprise context:
- **Enterprise value:** how commonly this connector is in use at large SA telco/financial enterprises
- **Knowledge density:** how much actionable knowledge the connector contains per unit of effort
- **Implementation effort:** relative to the SharePoint connector baseline (= 5)
- **Auth complexity:** how much new infrastructure is needed beyond existing SharePoint auth

| Rank | Connector | Enterprise Value (1-10) | Knowledge Density (1-10) | Impl Effort (1-10) | Auth Complexity | Score |
|---|---|---|---|---|---|---|
| 1 | **Microsoft Teams** | 10 | 9 | 4 | Very Low (reuses SharePoint auth) | **91** |
| 2 | **OneDrive** | 9 | 8 | 2 | Very Low (reuses SharePoint auth) | **88** |
| 3 | **Box** | 8 | 8 | 6 | Medium (JWT setup) | **77** |
| 4 | **Intercom** | 6 | 9 | 5 | Low (simple OAuth) | **76** |
| 5 | **HubSpot** | 6 | 8 | 5 | Low (simple OAuth) | **73** |
| 6 | **Linear** | 5 | 8 | 3 | Low (API key or OAuth) | **68** |
| 7 | **Dropbox** | 5 | 6 | 4 | Low (OAuth) | **57** |
| 8 | **Figma** | 4 | 5 | 5 | Low (personal token or OAuth) | **44** |

**Score formula:** `(enterprise_value × 5) + (knowledge_density × 4) - (impl_effort × 3)`

**Scoring rationale:**

- **Teams** ranks first because it reuses the exact same Graph API auth as SharePoint, channel messages contain high-value institutional knowledge (decisions, discussions, announcements), and meeting transcripts are uniquely valuable. Implementation is mostly code reuse from the SharePoint connector.

- **OneDrive** ranks second because it is literally the same Graph API as SharePoint, pointed at `/users/{userId}/drive` instead of `/sites/{siteId}`. For employees who store work documents in OneDrive Personal (Business), this is essential coverage. Estimated ~20% of the work of the SharePoint connector.

- **Box** ranks third because large South African enterprises (banks, telecoms, mining) use Box extensively. The JWT auth is the main additional complexity. Box has superior metadata and ACL features compared to Dropbox.

- **Intercom** ranks fourth because the enterprise has support operations. Closed support conversations are a gold mine of solved-problem knowledge. Articles are clean, directly convertible to markdown. The no-refresh-token OAuth quirk is the main gotcha.

- **HubSpot** ranks fifth because commercial teams use CRM extensively. Deal notes, ticket content, and KB articles contain relationship context. Medium implementation effort.

- **Linear** ranks sixth because software engineering teams use it heavily. Issues + project descriptions are clean markdown. Excellent TypeScript SDK. Limited to engineering orgs.

- **Dropbox** ranks seventh. Lower enterprise penetration in SA at the target scale. Dropbox Paper's native markdown export is a nice feature, but overall enterprise value is lower.

- **Figma** ranks last. Useful for design teams, but low knowledge density compared to the effort. Most value is in comments rather than file structure. Narrow audience in most enterprise contexts.

---

## 11. Authentication Pattern Matrix

| Connector | Auth Method | Token Lifetime | Refresh Token | Multi-tenant | Entra ID Integration |
|---|---|---|---|---|---|
| **HubSpot** | OAuth 2.0 or Private App Token | OAuth: short-lived + refresh | Yes (OAuth) | Yes | No |
| **Linear** | API Key or OAuth 2.0 | API key: indefinite | N/A (API key) | Yes (OAuth) | No |
| **Microsoft Teams** | Azure AD Client Credentials / MSAL | 1 hour | Yes (via MSAL) | Yes | Native |
| **Intercom** | OAuth 2.0 or Access Token | Indefinite (no refresh) | No | Yes | No |
| **Dropbox** | OAuth 2.0 (PKCE recommended) | Short-lived + refresh | Yes | Yes | No |
| **Box** | OAuth 2.0 or JWT | JWT: as-needed | N/A (JWT) | Yes | Via SCIM |
| **OneDrive** | Azure AD (same as Teams/SharePoint) | 1 hour | Yes (via MSAL) | Yes | Native |
| **Figma** | Personal Access Token or OAuth 2.0 | PAT: indefinite | Yes (OAuth) | Yes (OAuth) | Via SCIM (Enterprise) |
| **SharePoint** | Azure AD Client Credentials | 1 hour | Yes (via MSAL) | Yes | Native |
| **Confluence** | OAuth 2.0 or API Token | API token: indefinite | Yes (OAuth) | Yes | Via SAML/SCIM |

**Key observations:**

1. Teams, OneDrive, and SharePoint all use the same Azure AD token infrastructure — build once, use three times.
2. Intercom's no-refresh-token OAuth is a unique outlier that breaks standard token refresh pipelines.
3. Box JWT is the most complex initial setup but the most robust for server-to-server enterprise integration.
4. Linear's API key (no bearer prefix) is an unusual convention that breaks generic header injection code.

### Shared Auth Infrastructure

```typescript
// Base connector interface — all connectors implement this
interface ConnectorAuth {
  getHeaders(): Promise<Record<string, string>>;
  isTokenValid(): Promise<boolean>;
  refreshIfNeeded(): Promise<void>;
}

// Microsoft Graph auth (shared by SharePoint, Teams, OneDrive)
class MicrosoftGraphAuth implements ConnectorAuth {
  private token: string | null = null;
  private expiresAt: number = 0;

  constructor(
    private readonly tenantId: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;

    const response = await fetch(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
      },
    );
    const data = await response.json();
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.token!;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { 'Authorization': `Bearer ${await this.getToken()}` };
  }

  async isTokenValid(): Promise<boolean> {
    return Date.now() < this.expiresAt - 60_000;
  }

  async refreshIfNeeded(): Promise<void> {
    await this.getToken(); // auto-refreshes if expired
  }
}
```

---

## 12. Top 5 Connectors to Build After SharePoint + Confluence

**Verdict:** Build these five in this order.

### Priority 1: OneDrive

**Why first:** It is the SharePoint connector with a different root path. Extend the SharePoint connector with a `type: 'onedrive'` mode that points to `/users/{userId}/drive/root` instead of `/sites/{siteId}`. This closes a significant gap — files that employees store personally rather than on SharePoint sites.

**Estimated effort:** 1-2 sprints
**Auth:** Zero additional infrastructure (reuse SharePoint Graph token)
**Gotcha:** `sharedWithMe` files have remote drive URLs — handle the `remoteItem` field in drive items

### Priority 2: Microsoft Teams

**Why second:** Channel messages and meeting transcripts are among the highest-value knowledge sources in any enterprise. Decisions made in Teams channels are rarely captured elsewhere. Auth is identical to SharePoint.

**Estimated effort:** 2-3 sprints (delta sync, message threading, transcript handling)
**Auth:** Zero additional infrastructure (reuse SharePoint Graph token)
**Gotcha:** Subscription model is needed for real-time but scheduling model works for index — use delta queries on a schedule

### Priority 3: Box

**Why third:** Strong enterprise file storage penetration in SA. Better metadata and classification features than Dropbox. Box's JWT auth is the main barrier.

**Estimated effort:** 3-4 sprints (JWT setup, metadata extraction, permission model)
**Auth:** New JWT-based infrastructure; document Box admin setup in connector config guide
**Gotcha:** Box Metadata Query API (SQL-like) is powerful but has its own learning curve

### Priority 4: Intercom

**Why fourth:** Support organizations are heavy Intercom users. Resolved conversations are a rich solved-problem knowledge base. Articles are clean and directly usable.

**Estimated effort:** 2-3 sprints (Articles clean, Conversations more complex)
**Auth:** Standard OAuth with the no-refresh-token gotcha handled
**Recommendation:** Start with Articles only (Phase 4a), add Conversations in Phase 4b

### Priority 5: HubSpot

**Why fifth:** CRM context enriches agent responses about deals, accounts, and support tickets. Useful if the organisation's internal teams use HubSpot for customer-facing operations.

**Estimated effort:** 2-3 sprints
**Auth:** Simple Private App token or OAuth
**Recommendation:** Start with Tickets + Companies (highest knowledge density), skip Contacts (PII sensitivity)

**Skip for now (or build only if customer-requested):**
- **Linear** — high quality API but narrow audience (engineering teams only); build on demand
- **Dropbox** — low enterprise penetration at this scale; build on demand
- **Figma** — niche value; build only if the organisation has a large design org using Figma and requesting it

---

## 13. Common Implementation Patterns and Reusable Abstractions

All eight connectors share implementation patterns. Invest in a shared connector infrastructure rather than implementing each from scratch.

### 13.1 Universal Paginator

```typescript
// Generic cursor paginator — works for most connectors
interface PaginationConfig {
  // How to extract the next cursor from a response
  extractNextCursor: (response: unknown) => string | null | undefined;
  // How to build the URL for the next page
  buildNextUrl: (baseUrl: string, cursor: string) => string;
  // How to extract the items from a response
  extractItems: <T>(response: unknown) => T[];
}

async function* paginate<T>(
  firstUrl: string,
  fetchFn: (url: string) => Promise<unknown>,
  config: PaginationConfig,
): AsyncGenerator<T[]> {
  let url: string | null = firstUrl;

  while (url) {
    const response = await fetchFn(url);
    const items = config.extractItems<T>(response);
    yield items;

    const cursor = config.extractNextCursor(response);
    url = cursor ? config.buildNextUrl(firstUrl, cursor) : null;
  }
}

// Connector-specific configs
const hubSpotPagination: PaginationConfig = {
  extractNextCursor: (r: any) => r.paging?.next?.after,
  buildNextUrl: (base, cursor) => {
    const url = new URL(base);
    url.searchParams.set('after', cursor);
    return url.toString();
  },
  extractItems: (r: any) => r.results ?? [],
};

const intercomPagination: PaginationConfig = {
  extractNextCursor: (r: any) => r.pages?.next?.starting_after,
  buildNextUrl: (base, cursor) => {
    const url = new URL(base);
    url.searchParams.set('starting_after', cursor);
    return url.toString();
  },
  extractItems: (r: any) => r.data ?? [],
};

const graphApiPagination: PaginationConfig = {
  extractNextCursor: (r: any) => r['@odata.nextLink'],
  buildNextUrl: (_, cursor) => cursor, // nextLink is already a full URL
  extractItems: (r: any) => r.value ?? [],
};
```

### 13.2 Universal Rate Limiter

```typescript
// Token bucket rate limiter — configurable per connector
class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly fillRate: number; // tokens per millisecond

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.fillRate = maxTokens / windowMs;
  }

  async acquire(cost = 1): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.fillRate);
    this.lastRefill = now;

    if (this.tokens < cost) {
      const waitMs = (cost - this.tokens) / this.fillRate;
      await new Promise(resolve => setTimeout(resolve, Math.ceil(waitMs)));
      this.tokens = 0;
    } else {
      this.tokens -= cost;
    }
  }
}

// Per-connector rate limiter instances
const rateLimiters = {
  hubspot: new TokenBucketRateLimiter(90, 10_000),       // 90/10s (HubSpot: 100/10s limit)
  linear: new TokenBucketRateLimiter(40, 1_000),          // 40/s (Linear: 2500/hr)
  intercom: new TokenBucketRateLimiter(150, 10_000),       // 150/10s (Intercom: ~166/10s)
  dropbox: new TokenBucketRateLimiter(1, 1_000),           // 1/s conservative
  box: new TokenBucketRateLimiter(15, 1_000),              // 15/s (Box: 1000/min)
  figma: new TokenBucketRateLimiter(2, 1_000),             // 2/s conservative
  graph: new TokenBucketRateLimiter(10, 1_000),            // 10/s conservative for Graph API
};
```

### 13.3 Universal Retry with Exponential Backoff

```typescript
// 429 and 5xx retry wrapper — same pattern for all connectors
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 4,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.pow(2, attempt) * 1000 + Math.random() * 1000;

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
    }

    if (response.status >= 500 && attempt < maxRetries) {
      const waitMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    return response;
  }
  throw new Error(`Max retries exceeded for ${url}`);
}
```

### 13.4 Universal HTML-to-Markdown Converter

All connectors that return HTML content (HubSpot, Intercom, Teams, Box Notes) need the same conversion:

```typescript
import { NodeHtmlMarkdown } from 'node-html-markdown';

const nhm = new NodeHtmlMarkdown({
  ignore: ['script', 'style', 'head'],
  globalEscape: [/\|/g, '\\|'], // escape table pipes
});

function htmlToMarkdown(html: string): string {
  if (!html || html.trim() === '') return '';
  // Pre-process: remove HTML comments
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  return nhm.translate(cleaned).trim();
}
```

### 13.5 Document Fingerprinting for Incremental Sync

```typescript
// Store fingerprints to avoid re-processing unchanged content
interface DocumentFingerprint {
  connectorId: string;
  documentId: string;
  hash: string;          // SHA-256 of content or API-provided hash
  lastSeen: number;      // Unix timestamp
}

import { createHash } from 'crypto';

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function hasChanged(stored: DocumentFingerprint | null, currentHash: string): boolean {
  if (!stored) return true;
  return stored.hash !== currentHash;
}
```

### 13.6 Connector Interface

All connectors should implement a common interface for the MCP tool dispatch layer:

```typescript
// Universal connector interface
interface KnowledgeConnector {
  readonly connectorId: string;
  readonly displayName: string;

  // Test connectivity and auth
  healthCheck(): Promise<{ ok: boolean; error?: string }>;

  // Full index (initial sync)
  indexAll(options?: { onProgress?: (count: number) => void }): AsyncGenerator<IndexedDocument[]>;

  // Incremental update (delta sync)
  indexDelta(sinceToken: string): AsyncGenerator<{ updated: IndexedDocument[]; deleted: string[] }>;

  // Save delta token for next run
  getDeltaToken(): Promise<string>;
}

interface IndexedDocument {
  id: string;                    // connector-scoped unique ID
  connector: string;             // connector ID
  title: string;
  content: string;               // markdown
  url: string;                   // deep link to original
  lastModified: string;          // ISO 8601
  author?: string;
  contentHash: string;
  metadata: Record<string, unknown>; // connector-specific extra fields
}
```

### 13.7 ACL Enforcement Pattern

For connectors with Entra ID integration (Teams, OneDrive, SharePoint), apply the same `transitiveMemberOf` check from the SharePoint connector. For other connectors (HubSpot, Intercom, Box, Figma), ACL is workspace-level or per-user-token:

```typescript
// Tiered ACL strategy
type ACLStrategy =
  | 'graph-transitiveMemberOf'   // SharePoint, Teams, OneDrive
  | 'workspace-scoped'           // HubSpot, Intercom (whole workspace or nothing)
  | 'per-user-token'             // Figma, Linear (delegate to user's own OAuth token)
  | 'box-collaboration'          // Box (check collaboration API per resource)
  | 'dropbox-sharing-info';      // Dropbox (check sharing_info.read_only/no_access)

// In the query handler:
async function canUserAccessDocument(
  userId: string,
  document: IndexedDocument,
  strategy: ACLStrategy,
): Promise<boolean> {
  switch (strategy) {
    case 'graph-transitiveMemberOf':
      // (existing SharePoint ACL check using transitiveMemberOf)
      return checkEntraIdGroupMembership(userId, document.metadata.groupIds as string[]);

    case 'workspace-scoped':
      // User has full access to workspace or no access at all
      return true; // if the connector is configured, user has access

    case 'per-user-token':
      // Use the user's delegated token — ACL is enforced by the API itself
      return true; // pre-filtered by token scope

    case 'box-collaboration':
      return checkBoxCollaboration(userId, document.id);

    case 'dropbox-sharing-info':
      return !document.metadata.noAccess;

    default:
      return false;
  }
}
```

---

## 14. Build vs Skip Verdicts

| Connector | Verdict | Rationale |
|---|---|---|
| **OneDrive** | Build in Phase 2 (Week 1-2) | Free ride on SharePoint infrastructure |
| **Microsoft Teams** | Build in Phase 2 (Week 3-5) | Critical institutional knowledge source; auth reuse |
| **Box** | Build in Phase 2 (Week 6-9) | Strong SA enterprise penetration; superior metadata |
| **Intercom** | Build in Phase 3 | Support knowledge is underserved; articles are clean |
| **HubSpot** | Build in Phase 3 | CRM context enriches agent responses; simple auth |
| **Linear** | Build on demand | Excellent API but narrow audience; low priority unless customers request |
| **Dropbox** | Build on demand | Niche at this scale; Paper markdown export is nice but insufficient justification |
| **Figma** | Build on demand | Lowest ROI; only if the design org specifically requests it |

**Bottom line for Phase 2 planning:** OneDrive and Teams are essentially included in the SharePoint connector investment. Box is the first new connector worth dedicated sprint allocation. Intercom and HubSpot come after in Phase 3. Linear, Dropbox, and Figma are request-driven.

---

_Research compiled 2026-08-26. Sources: Linear developer docs, HubSpot 2026 API guide (appnigma.ai), Microsoft Graph Teams messaging overview, Intercom developer platform v2.16, Dropbox file access guide, Box API reference, Figma REST API documentation, Truto Intercom integration guide, SyncRivo Teams deep dive._
