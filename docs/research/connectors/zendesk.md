# Zendesk Connector Research

**Target:** markdown-for-agents-mcp Phase 2 enterprise knowledge index  
**Date:** 2026-08-26  
**Scope:** Help Center articles, tickets, search API, community, macros, authentication, incremental sync

---

## Table of Contents

1. [Executive Summary and Build Recommendation](#executive-summary)
2. [Authentication](#authentication)
3. [URL and Subdomain Structure](#url-and-subdomain-structure)
4. [Help Center: Content Hierarchy](#help-center-content-hierarchy)
5. [Categories API](#categories-api)
6. [Sections API](#sections-api)
7. [Articles API](#articles-api)
8. [Article Attachments API](#article-attachments-api)
9. [Article Translations (Multi-Locale)](#article-translations-multi-locale)
10. [Help Center Search API](#help-center-search-api)
11. [Tickets API](#tickets-api)
12. [Ticket Comments API](#ticket-comments-api)
13. [Search API (Ticketing)](#search-api-ticketing)
14. [Incremental Exports API](#incremental-exports-api)
15. [Community: Topics and Posts](#community-topics-and-posts)
16. [Macros as Knowledge](#macros-as-knowledge)
17. [User Segments and Access Control](#user-segments-and-access-control)
18. [Rate Limits](#rate-limits)
19. [HTML-to-Markdown Conversion](#html-to-markdown-conversion)
20. [TypeScript Implementation Guide](#typescript-implementation-guide)
21. [What to Build vs Skip](#what-to-build-vs-skip)
22. [Edge Cases and Gotchas](#edge-cases-and-gotchas)

---

## Executive Summary

Zendesk is a dominant customer support platform; many enterprise teams have their primary internal and external knowledge in Zendesk Guide (Help Center). A Zendesk connector for markdown-for-agents-mcp gives AI agents read access to:

- **Help Center KB articles** — the canonical external-facing product knowledge base
- **Resolved ticket history** — the richest source of institutional troubleshooting knowledge, often inaccessible in any KB
- **Community posts/topics** — user-generated Q&A that often answers edge-case questions
- **Macros** — pre-written agent replies that encode the most common support answers

**Verdict: Build this connector.** It unlocks a content category (customer-facing and internal KB) that no other connector covers. Ticket history indexing is the highest-value differentiator — it is proprietary to each org and not available in any generic knowledge source. Aim for Phase 2 alpha.

**Priority order:**
1. Help Center articles + categories/sections hierarchy (highest signal, cleanest content)
2. Ticket search + resolved ticket comments (highest proprietary value)
3. Macros (fast to index, excellent for agent routing knowledge)
4. Community posts (useful but lower signal-to-noise)

---

## Authentication

**Source:** https://developer.zendesk.com/api-reference/introduction/security-and-auth/

Zendesk supports three authentication mechanisms. As of 2025-2026, Zendesk is migrating away from API tokens toward OAuth 2.0 as the preferred method.

### Method 1: OAuth 2.0 Bearer Token (Recommended)

```
Authorization: Bearer {access_token}
```

OAuth tokens are scoped to specific permissions and to a single Zendesk instance (subdomain). For read-only knowledge indexing, request only `read` scope.

**OAuth scopes relevant to this connector:**

| Scope | Access |
|-------|--------|
| `read` | Read all resources (tickets, users, orgs, HC articles) |
| `tickets:read` | Read tickets only |
| `hc:read` | Read Help Center articles, sections, categories |
| `users:read` | Read user data (needed for author resolution) |

**Important:** For distributing the connector to multiple Zendesk customers, you must use **Global OAuth tokens** (not per-instance OAuth clients). The Zendesk Developer Terms prohibits sharing per-instance API credentials with third parties.

**OAuth flow for connector setup:**
1. Create an OAuth client in Admin Center > Apps and integrations > APIs > OAuth Clients
2. Store `client_id` and `client_secret`
3. Redirect user through authorization code flow to obtain `access_token` and `refresh_token`
4. Use `refresh_token` to obtain new `access_token` when current one expires

### Method 2: API Token (Deprecated but widely used)

API tokens are auto-generated passwords in Admin Center > Apps and integrations > APIs > Zendesk API.

```
Authorization: Basic {base64(email/token:api_token)}
```

Example credential construction:
```
jdoe@example.com/token:6wiIBWbGkBMo1mRDMuVwkw1EPsNkeUj95PIz2akv
```

Base64-encode the full string, prepend `Basic `.

Zendesk has announced this is deprecated in favor of OAuth but it still works as of 2026. For internal/single-org connectors this is still the fastest path to integration. Do not use for multi-tenant connector distribution.

### Method 3: Basic Auth with Password (End Users Only)

Only usable for end-user-facing requests in open Help Center instances. Not applicable for server-side indexing.

### TypeScript Auth Helper

```typescript
// zendesk-auth.ts

export interface ZendeskAuthConfig {
  subdomain: string;
  // OAuth (preferred)
  oauthToken?: string;
  // API token (deprecated, single-org internal use)
  email?: string;
  apiToken?: string;
}

export function buildAuthHeaders(config: ZendeskAuthConfig): Record<string, string> {
  if (config.oauthToken) {
    return {
      'Authorization': `Bearer ${config.oauthToken}`,
      'Content-Type': 'application/json',
    };
  }

  if (config.email && config.apiToken) {
    const credentials = `${config.email}/token:${config.apiToken}`;
    const encoded = Buffer.from(credentials).toString('base64');
    return {
      'Authorization': `Basic ${encoded}`,
      'Content-Type': 'application/json',
    };
  }

  throw new Error('Either oauthToken or email+apiToken must be provided');
}

export function buildBaseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/api/v2`;
}

export function buildHcBaseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/api/v2/help_center`;
}
```

---

## URL and Subdomain Structure

All Zendesk API endpoints are subdomain-scoped. Every request goes to:

```
https://{subdomain}.zendesk.com/api/v2/...
```

For Help Center APIs:
```
https://{subdomain}.zendesk.com/api/v2/help_center/...
```

The subdomain is the unique identifier for a Zendesk instance. For an enterprise customer `acme`, all URLs are at `acme.zendesk.com`. Some enterprise customers use custom domains (e.g., `support.acme.com`) but the API always goes through `.zendesk.com`.

**Locale in URLs:** Help Center endpoints accept an optional `{locale}` path segment. Agents and admins can omit it; end users and anonymous users must include it:

```
# Agent (no locale required)
GET /api/v2/help_center/articles

# End-user (locale required)
GET /api/v2/help_center/en-us/articles
```

For indexing, always call as an agent/admin credential and omit locale unless specifically fetching a translated version.

---

## Help Center: Content Hierarchy

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/categories/

Zendesk Guide uses a three-level hierarchy:

```
Help Center
  └── Category (top-level container)
        └── Section (can be nested with parent_section_id on Enterprise)
              └── Article (leaf content item)
```

**Traversal strategy for full index:**
1. Fetch all categories: `GET /api/v2/help_center/categories`
2. Fetch all sections per category: `GET /api/v2/help_center/categories/{id}/sections`
3. Fetch all articles per section: `GET /api/v2/help_center/sections/{id}/articles`

**Or use the flat endpoint and join to hierarchy:**
1. Fetch all articles: `GET /api/v2/help_center/incremental/articles?start_time=0`
2. Sideload sections and categories in the request: `?include=sections,categories`
3. Build the breadcrumb path from the sideloaded data

The flat + sideload approach is more efficient for initial indexing. Use the hierarchy traversal only if you need to enforce category-level access control at the connector level.

---

## Categories API

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/categories/

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/categories` | List all categories |
| GET | `/api/v2/help_center/{locale}/categories` | List categories with locale |
| GET | `/api/v2/help_center/categories/{id}` | Show a category |

### JSON Schema

```typescript
interface ZendeskCategory {
  id: number;           // read-only, auto-assigned
  name: string;         // required on create
  locale: string;       // required, e.g. "en-us"
  description: string;
  html_url: string;     // read-only, HC URL
  url: string;          // read-only, API URL
  source_locale: string; // read-only
  outdated: boolean;    // read-only
  position: integer;
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
}
```

### Example Response

```json
{
  "categories": [
    {
      "description": "This category contains a collection of Super Hero tricks",
      "id": 37486578,
      "locale": "en-us",
      "name": "Super Hero Tricks"
    }
  ]
}
```

### Pagination

Cursor pagination is recommended. Categories are typically few (< 100) so a single request usually suffices.

```typescript
async function fetchAllCategories(
  subdomain: string,
  headers: Record<string, string>
): Promise<ZendeskCategory[]> {
  const url = `https://${subdomain}.zendesk.com/api/v2/help_center/categories`;
  const categories: ZendeskCategory[] = [];

  let nextUrl: string | null = url;
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) throw new Error(`Categories fetch failed: ${res.status}`);
    const data = await res.json();
    categories.push(...data.categories);
    nextUrl = data.next_page ?? null;
  }

  return categories;
}
```

---

## Sections API

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/sections/

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/sections` | List all sections |
| GET | `/api/v2/help_center/categories/{id}/sections` | List sections in a category |
| GET | `/api/v2/help_center/sections/{id}` | Show a section |

### JSON Schema

```typescript
interface ZendeskSection {
  id: number;                   // read-only
  name: string;                 // required
  locale: string;               // required
  category_id: number;
  parent_section_id: number | null; // Enterprise only - nested sections
  description: string;
  html_url: string;
  url: string;
  source_locale: string;
  theme_template: string;
  position: number;
  outdated: boolean;
  created_at: string;
  updated_at: string;
}
```

**Note:** `parent_section_id` enables nested sections but is writable only for Guide Enterprise customers. When building the breadcrumb path, recursively follow `parent_section_id` → `category_id`.

### Sorting

```
GET /api/v2/help_center/sections?sort_by=updated_at&sort_order=desc
```

Supported `sort_by` values: `position`, `created_at`, `updated_at`

---

## Articles API

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/articles/

This is the primary content endpoint. Articles contain the full HTML body of knowledge base content.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/articles` | List all articles |
| GET | `/api/v2/help_center/sections/{id}/articles` | Articles in a section |
| GET | `/api/v2/help_center/categories/{id}/articles` | Articles in a category |
| GET | `/api/v2/help_center/articles/{id}` | Show a single article |
| GET | `/api/v2/help_center/incremental/articles?start_time={unix}` | Incremental export |
| GET | `/api/v2/help_center/{locale}/articles/{id}` | Article in specific locale |

### JSON Schema

```typescript
interface ZendeskArticle {
  id: number;                     // read-only, auto-assigned
  title: string;                  // required on create
  body: string;                   // HTML content - the main content field
  locale: string;                 // required, e.g. "en-us"
  source_locale: string;          // read-only, the source language

  author_id: number;
  section_id: number;
  permission_group_id: number;    // required on create

  // Visibility
  draft: boolean;                 // read-only after create; use Translations API to update
  user_segment_id: number | null; // null = public
  user_segment_ids: number[];     // Enterprise: multiple segments

  // Metadata
  label_names: string[];          // array of label strings
  content_tag_ids: string[];      // content tags
  comments_disabled: boolean;
  promoted: boolean;
  position: number;
  vote_count: number;             // total votes
  vote_sum: number;               // upvotes minus downvotes

  // Timestamps (all read-only)
  created_at: string;             // ISO 8601
  updated_at: string;             // ISO 8601
  edited_at: string;              // last title/body edit in displayed locale
  outdated: boolean;              // deprecated, always false
  outdated_locales: string[];

  // URLs (read-only)
  html_url: string;               // public Help Center URL
  url: string;                    // API URL
}
```

### Filtering and Sorting

```
# Filter by labels (up to 10, AND logic)
GET /api/v2/help_center/articles?label_names=billing,pricing

# Sort by last edit time
GET /api/v2/help_center/en-us/articles?sort_by=edited_at&sort_order=desc

# Incremental - all articles updated since timestamp
GET /api/v2/help_center/incremental/articles?start_time=1700000000
```

`sort_by` values: `position`, `title`, `created_at`, `updated_at`, `edited_at`  
Note: `title` and `edited_at` sorting require a locale in the URL path.

### Sideloads

The articles API supports powerful sideloads to reduce round trips:

```
GET /api/v2/help_center/articles?include=users,sections,categories,translations
```

| Sideload | Returns |
|----------|---------|
| `users` | Article author user objects |
| `sections` | Parent section objects |
| `categories` | Parent category objects |
| `translations` | All locale translations embedded in the article |

Translations are embedded within each article object (not a shared list) because they are article-specific.

### Important Limitation: Content Blocks

If a Zendesk instance has enabled **Content Blocks** (reusable content components across articles), the Articles API has critical limitations:

- GET requests return content blocks as flattened text — the block structure is lost
- If you PUT an update using that flattened content, the content block links are replaced with static text
- **For read-only indexing this is fine** — the content you get is correct, just not structured as blocks

Source: https://developer.zendesk.com/documentation/help_center/help-center-api/content-blocks-limitations/

### TypeScript Article Fetcher

```typescript
// article-fetcher.ts
import TurndownService from 'turndown';

interface ArticleWithBreadcrumb extends ZendeskArticle {
  breadcrumb: string[];  // ["Category Name", "Section Name"]
  markdownBody: string;  // converted from HTML
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export async function fetchAllArticles(
  subdomain: string,
  headers: Record<string, string>,
  startTime?: number
): Promise<ArticleWithBreadcrumb[]> {
  // Build category/section lookup maps for breadcrumb assembly
  const categoriesMap = await fetchCategoriesMap(subdomain, headers);
  const sectionsMap = await fetchSectionsMap(subdomain, headers);

  const articles: ArticleWithBreadcrumb[] = [];
  const since = startTime ?? 0;
  let url = `https://${subdomain}.zendesk.com/api/v2/help_center/incremental/articles?start_time=${since}`;

  while (url) {
    const res = await fetchWithRetry(url, { headers });
    const data = await res.json();

    for (const article of data.articles ?? []) {
      if (article.draft) continue; // skip drafts

      const section = sectionsMap.get(article.section_id);
      const category = section ? categoriesMap.get(section.category_id) : undefined;

      const breadcrumb = [
        category?.name,
        section?.name,
      ].filter(Boolean) as string[];

      articles.push({
        ...article,
        breadcrumb,
        markdownBody: article.body
          ? turndown.turndown(article.body)
          : '',
      });
    }

    url = data.next_page ?? null;
  }

  return articles;
}

async function fetchCategoriesMap(
  subdomain: string,
  headers: Record<string, string>
): Promise<Map<number, ZendeskCategory>> {
  const categories = await fetchAllCategories(subdomain, headers);
  return new Map(categories.map(c => [c.id, c]));
}

async function fetchSectionsMap(
  subdomain: string,
  headers: Record<string, string>
): Promise<Map<number, ZendeskSection>> {
  const url = `https://${subdomain}.zendesk.com/api/v2/help_center/sections`;
  const sections: ZendeskSection[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, { headers });
    const data = await res.json();
    sections.push(...(data.sections ?? []));
    nextUrl = data.next_page ?? null;
  }

  return new Map(sections.map(s => [s.id, s]));
}
```

---

## Article Attachments API

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/article_attachments/

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/articles/{id}/attachments` | List all attachments |
| GET | `/api/v2/help_center/articles/{id}/attachments/block` | Block (non-inline) attachments |
| GET | `/api/v2/help_center/articles/{id}/attachments/inline` | Inline (image) attachments |
| GET | `/api/v2/help_center/articles/{id}/attachments/{att_id}` | Show one attachment |

### JSON Schema

```typescript
interface ArticleAttachment {
  id: number;
  article_id: number;
  file_name: string;
  content_type: string;   // MIME type, e.g. "image/png", "application/pdf"
  content_url: string;    // Direct download URL
  size: number;           // bytes
  inline: boolean;        // true = embedded image in body; false = linked attachment
  locale: string;         // locale the attachment belongs to
  guide_media_id: string; // link to the Guide media library entry
  created_at: string;
  updated_at: string;
  url: string;
}
```

### Inline vs Block Attachments

- **Inline (`inline: true`):** Images embedded directly in the article HTML body. Their `content_url` is referenced in `<img src="...">` tags within the `body` field.
- **Block (`inline: false`):** Files listed as downloads at the bottom of the article (PDFs, ZIPs, etc).

**For text indexing:** block attachments can be fetched and parsed (e.g., PDFs). Inline images can be referenced but not meaningfully indexed as text.

**File size limit:** 20 MB per attachment.

**Localized inline attachments:** As of a recent Zendesk change, inline attachments in multilingual Help Centers have unique IDs per locale. This means `content_url` values may differ between translations.

**For the connector:** Index block attachments as supplementary content. Skip inline images unless implementing vision-based chunking. The `content_url` for non-inline attachments is a stable CDN URL that requires the same auth headers.

---

## Article Translations (Multi-Locale)

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/translations/

Zendesk Help Center supports multiple locales. Each article has a `source_locale` and can have translations for additional locales.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/articles/{id}/translations` | List all translations of an article |
| GET | `/api/v2/help_center/articles/{id}/translations/{locale}` | Get one translation |
| GET | `/api/v2/help_center/articles/{id}/translations/missing` | Locales without translations |

### Translation JSON Schema

```typescript
interface ArticleTranslation {
  id: number;
  article_id: number;
  locale: string;           // e.g. "fr", "de", "ja"
  source_id: number;        // same as article_id
  source_type: string;      // "Article"
  title: string;            // translated title
  body: string;             // translated HTML body
  draft: boolean;
  hidden: boolean;
  outdated: boolean;
  created_at: string;
  updated_at: string;
  updated_by_id: number;
  created_by_id: number;
  url: string;
}
```

### Connector Strategy for Multi-Locale

**Option A — Source locale only (default):** Index only `source_locale` content (usually English). Fastest, simplest.

**Option B — All locales:** Fetch all translations per article. Creates multiple index entries per article, each with a `locale` tag. Best for multilingual teams.

**Option C — Configurable:** Let the connector config specify which locales to index. Recommended approach.

```typescript
// When fetching articles, the sideloaded translations are embedded in the article
// GET /api/v2/help_center/articles?include=translations
// Each article.translations array contains all locale variants

interface ArticleWithTranslations extends ZendeskArticle {
  translations: ArticleTranslation[];
}
```

**Gotcha:** When sideloading translations, the `body` field in the main article object reflects the `source_locale` body. The translation objects each have their own `body`.

---

## Help Center Search API

The Help Center has its own search endpoint, separate from the Ticketing Search API. It searches only within Guide content.

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/ (Search section)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/help_center/articles/search?query={q}` | Search articles |
| GET | `/api/v2/help_center/{locale}/articles/search?query={q}` | Search in specific locale |

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query text |
| `locale` | string | Filter by locale |
| `category` | integer | Filter by category ID |
| `section` | integer | Filter by section ID |
| `label_names` | string | Comma-separated label filter |
| `per_page` | integer | Results per page (default 30, max 30) |
| `page` | integer | Page number |

### Response Format

```json
{
  "count": 42,
  "next_page": "https://...",
  "previous_page": null,
  "results": [
    {
      "id": 12345,
      "title": "How to reset your password",
      "body": "<p>To reset your password...</p>",
      "snippet": "...reset your password by clicking...",
      "locale": "en-us",
      "url": "https://..."
    }
  ]
}
```

**Note:** The `snippet` field contains the contextually relevant excerpt from the body. This is useful for search result display.

**Limitation:** Max 30 results per page. For full text search across large Help Centers, the Ticketing Search API (`/api/v2/search`) may return more results but doesn't include `snippet`.

---

## Tickets API

**Source:** https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/

Tickets are the core data model in Zendesk Support. For knowledge indexing, **resolved/closed tickets** are the highest-value content because they represent problems that were actually solved.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/tickets` | List all tickets |
| GET | `/api/v2/tickets/{id}` | Show a ticket |
| GET | `/api/v2/incremental/tickets/cursor` | Cursor-based incremental export |
| GET | `/api/v2/search?query=type:ticket status:solved` | Search for solved tickets |

### Ticket JSON Schema (Selected Fields)

```typescript
interface ZendeskTicket {
  id: number;
  subject: string;
  description: string;   // read-only; same as first comment body
  status: 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed';
  type: 'problem' | 'incident' | 'question' | 'task' | null;
  priority: 'urgent' | 'high' | 'normal' | 'low' | null;

  // Actors
  requester_id: number;
  submitter_id: number;
  assignee_id: number | null;
  group_id: number | null;
  organization_id: number | null;
  collaborator_ids: number[];
  follower_ids: number[];
  email_cc_ids: number[];

  // Classification
  tags: string[];
  brand_id: number;
  channel: string;        // "email", "web", "api", "chat", "phone", etc.
  custom_fields: Array<{ id: number; value: string | null }>;
  custom_status_id: number | null;   // if custom statuses enabled

  // Relationships
  ticket_form_id: number | null;
  problem_id: number | null;        // for incidents linked to a problem ticket
  via: {
    channel: string;
    source: { from: object; to: object; rel: string | null };
  };

  // Timestamps
  created_at: string;
  updated_at: string;
  due_at: string | null;

  // URLs
  url: string;
  html_url: string;    // not directly on ticket; construct as needed

  // Satisfaction
  satisfaction_rating: {
    id: number;
    score: string;      // "good" | "bad"
    comment: string;
  } | null;
}
```

### Ticket Status Lifecycle

```
new → open → pending → hold → solved → closed
```

| Status | Meaning |
|--------|---------|
| `new` | Unassigned, no agent has touched it |
| `open` | Being worked on by an agent |
| `pending` | Waiting for customer response |
| `hold` | Waiting on a third party |
| `solved` | Agent considers it resolved |
| `closed` | Locked, no further updates allowed |

**For knowledge indexing:** Target `status:solved` and `status:closed` tickets. These represent successfully resolved issues and are the most trustworthy knowledge signals.

### Custom Ticket Statuses

Enterprise accounts can enable custom ticket statuses. When enabled:
- `status` contains the **status category** (one of the standard values above)
- `custom_status_id` contains the ID of the specific custom status
- Sideload custom statuses for human-readable labels: `?include=custom_statuses`

---

## Ticket Comments API

**Source:** https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/

Comments are the conversation thread within a ticket. They are the primary knowledge content within a ticket.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/tickets/{id}/comments` | List all comments on a ticket |
| GET | `/api/v2/tickets/{id}/comments?include=users` | Comments with author objects |

### Comment JSON Schema

```typescript
interface TicketComment {
  id: number;
  type: 'Comment' | 'VoiceComment';
  author_id: number;
  body: string;          // plain text
  html_body: string;     // HTML - richer than body
  plain_body: string;    // most sanitized plain text
  public: boolean;       // false = internal note (agent-only)
  audit_id: number;
  created_at: string;
  attachments: Array<{
    id: number;
    file_name: string;
    content_type: string;
    content_url: string;
    size: number;
    inline: boolean;
  }>;
  via: {
    channel: string;     // "email", "web", "api", etc.
    source: object;
  };
  metadata: {
    system: {
      client: string;
      ip_address: string;
      location: string;
    };
    flags: number[];     // see Comment Flags section
    flags_options: object;
  };
}
```

### Public vs Private Comments

- `public: true` — visible to the ticket requester (customer)
- `public: false` — internal agent note, not visible to customer

**For knowledge indexing:** Index **both** public and private comments when using admin credentials. Internal notes often contain the actual solution, workaround steps, or root cause analysis.

### Comment Limits

- Max **5,000 comments** per ticket. After this limit, the ticket can still be updated in other ways but no new comments can be added (returns 422).
- Body size limit: **64 KB** per comment. Content exceeding this is silently truncated.

### Creating Comments (Write Path — Not Needed for Indexing)

Comments are created via the Tickets API update, not the Comments API:
```
PUT /api/v2/tickets/{id}
{"ticket": {"comment": {"body": "...", "public": true}}}
```

The Ticket Comments API has no create endpoint.

### TypeScript: Fetch Ticket with Full Comment Thread

```typescript
interface ZendeskTicketWithComments extends ZendeskTicket {
  comments: TicketComment[];
  markdownSummary: string;
}

async function fetchTicketWithComments(
  subdomain: string,
  ticketId: number,
  headers: Record<string, string>
): Promise<ZendeskTicketWithComments> {
  const [ticketRes, commentsRes] = await Promise.all([
    fetchWithRetry(
      `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}`,
      { headers }
    ),
    fetchWithRetry(
      `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments?include=users`,
      { headers }
    ),
  ]);

  const { ticket } = await ticketRes.json();
  const { comments } = await commentsRes.json();

  const markdownSummary = buildTicketMarkdown(ticket, comments);

  return { ...ticket, comments, markdownSummary };
}

function buildTicketMarkdown(
  ticket: ZendeskTicket,
  comments: TicketComment[]
): string {
  const lines: string[] = [
    `# [Ticket #${ticket.id}] ${ticket.subject}`,
    '',
    `**Status:** ${ticket.status} | **Priority:** ${ticket.priority ?? 'none'} | **Type:** ${ticket.type ?? 'none'}`,
    `**Tags:** ${ticket.tags.join(', ') || 'none'}`,
    `**Created:** ${ticket.created_at}`,
    '',
    '---',
    '',
  ];

  for (const comment of comments) {
    const author = comment.public ? 'Customer' : 'Agent (Internal)';
    lines.push(`## ${author} — ${comment.created_at}`);
    lines.push('');
    // Prefer html_body → convert to markdown; fall back to plain body
    const bodyText = comment.html_body
      ? turndown.turndown(comment.html_body)
      : comment.body;
    lines.push(bodyText);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
```

---

## Search API (Ticketing)

**Source:** https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/

The Ticketing Search API is a unified search across tickets, users, and organizations. It is distinct from the Help Center Search API.

### Endpoint

```
GET /api/v2/search?query={query_string}
```

### Query Syntax

The query syntax uses field:value pairs with operators:

| Operator | Meaning | Example |
|----------|---------|---------|
| `:` | Equals | `status:solved` |
| `>` | Greater than | `created_at>2024-01-01` |
| `<` | Less than | `updated_at<2024-12-31` |
| `-` | Negation | `-status:closed` |
| `*` | Wildcard | `subject:password*` |
| `""` | Exact phrase | `"reset password"` |

### Ticket-Specific Search Fields

| Field | Example | Description |
|-------|---------|-------------|
| `type` | `type:ticket` | Filter to tickets only |
| `status` | `status:solved` | Ticket status |
| `priority` | `priority:high` | Ticket priority |
| `tags` | `tags:billing` | Has specific tag |
| `created_at` | `created_at>2024-01-01` | Creation date filter |
| `updated_at` | `updated_at>2024-01-01` | Update date filter |
| `assignee` | `assignee:agent@company.com` | Assigned agent |
| `requester` | `requester:customer@company.com` | Requesting user |
| `group` | `group:Support` | Assigned group |
| `organization` | `organization:Acme` | Organization |
| `subject` | `subject:billing` | Subject line keyword |
| `description` | `description:error` | First comment keyword |
| `custom_field_{id}` | `custom_field_360001234:value` | Custom field value |

### Combined Query Examples

```
# All solved tickets about billing
type:ticket status:solved tags:billing

# High priority open tickets in the last 30 days
type:ticket status:open priority:high created_at>2025-07-27

# Solved tickets with specific subject keyword
type:ticket status:solved subject:reset*

# Full text search in solved tickets
type:ticket status:solved "error code 500"
```

### Response Format

```typescript
interface SearchResponse {
  count: number;         // total results (up to 5000 reported, but 1000 returned)
  facets: null;
  next_page: string | null;
  previous_page: string | null;
  results: Array<ZendeskTicket & { result_type: 'ticket' }>;
}
```

### Limitations

- Maximum **1,000 results returned** per query (up to 100 per page)
- If you request page 11 at 100 per page, a **422 Insufficient Resource Error** is returned
- `count` reports the actual number of matches (e.g., 5,000) but only 1,000 are accessible
- For large datasets: use the **Export Search Results** endpoint or **Incremental Exports**
- Search indexing can lag by **a few minutes** for newly created tickets

### Export Search Results (Cursor-Based)

```
GET /api/v2/search/export?query={query}&filter[type]=ticket
```

This endpoint avoids the 1,000-result limit by using cursor pagination. Rate limit: 100 requests/minute.

### Rate Limit for Search

The search endpoint has its own rate limit tracked separately from the global limit:

```
Zendesk-RateLimit-search-index: total=2500; remaining=2499; resets=58
```

Standard plans: 2,500 searches per minute. Same as global limit, tracked separately.

---

## Incremental Exports API

**Source:** https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/

The Incremental Exports API is essential for keeping the index in sync with Zendesk without re-fetching everything. It provides efficient change detection.

### Available Incremental Export Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/incremental/tickets/cursor` | Cursor-based ticket export (recommended) |
| `GET /api/v2/incremental/tickets` | Time-based ticket export |
| `GET /api/v2/incremental/ticket_events` | Individual ticket events/audit trail |
| `GET /api/v2/incremental/users/cursor` | Cursor-based user export |
| `GET /api/v2/incremental/users` | Time-based user export |
| `GET /api/v2/incremental/organizations` | Time-based organization export |
| `GET /api/v2/help_center/incremental/articles` | Article changes since timestamp |

### Rate Limit for Incremental Exports

- Standard plans: **10 requests per minute**
- High Volume API add-on: **30 requests per minute**

This is much lower than the global limit. Design sync jobs to be infrequent (e.g., every 5-15 minutes).

### Cursor-Based Ticket Export

This is the recommended approach. It provides consistent performance and avoids duplicate results.

```
# Initial request
GET /api/v2/incremental/tickets/cursor?start_time={unix_timestamp}

# Subsequent requests
GET /api/v2/incremental/tickets/cursor?cursor={cursor_value}
```

**Response Format:**

```typescript
interface IncrementalTicketResponse {
  tickets: ZendeskTicket[];
  after_url: string | null;     // URL for next page
  after_cursor: string | null;  // cursor for next page
  before_url: string | null;    // URL for previous page
  before_cursor: string | null;
  end_of_stream: boolean;       // true = caught up to current time
  count: number;
}
```

**Key behavior:**
- `end_of_stream: true` means you have retrieved all data up to the current moment
- Store the `after_cursor` value as your checkpoint for the next sync run
- The `start_time` is only used for the initial request; all subsequent calls use `cursor`
- Minimum start_time is **1 minute in the past** (avoids race conditions)
- Returns **deleted tickets** by default — use `exclude_deleted=true` to omit them

```typescript
// incremental-sync.ts
interface SyncCheckpoint {
  cursor: string | null;
  lastStartTime: number;
}

async function syncTicketsIncremental(
  subdomain: string,
  headers: Record<string, string>,
  checkpoint: SyncCheckpoint,
  onTickets: (tickets: ZendeskTicket[]) => Promise<void>
): Promise<SyncCheckpoint> {
  let url: string;

  if (checkpoint.cursor) {
    url = `https://${subdomain}.zendesk.com/api/v2/incremental/tickets/cursor?cursor=${checkpoint.cursor}&exclude_deleted=true`;
  } else {
    const startTime = checkpoint.lastStartTime || Math.floor(Date.now() / 1000) - 86400;
    url = `https://${subdomain}.zendesk.com/api/v2/incremental/tickets/cursor?start_time=${startTime}&exclude_deleted=true`;
  }

  let newCursor = checkpoint.cursor;

  while (url) {
    const res = await fetchWithRetry(url, { headers });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      await sleep(retryAfter * 1000);
      continue;
    }

    const data: IncrementalTicketResponse = await res.json();

    if (data.tickets.length > 0) {
      await onTickets(data.tickets);
    }

    newCursor = data.after_cursor;

    if (data.end_of_stream) {
      break;
    }

    url = data.after_url ?? '';
  }

  return { cursor: newCursor, lastStartTime: Math.floor(Date.now() / 1000) };
}
```

### Incremental Article Export

Articles use a simpler time-based approach:

```
GET /api/v2/help_center/incremental/articles?start_time={unix}
```

Articles don't have cursor-based incremental export — only time-based. Store the `end_time` from each response as the next `start_time`.

```typescript
interface IncrementalArticleResponse {
  articles: ZendeskArticle[];
  next_page: string | null;
  end_time: number;       // unix timestamp of last item in this batch
  count: number;
}
```

### Sideloads in Incremental Exports

Incremental ticket exports support sideloading to reduce round trips:

```
GET /api/v2/incremental/tickets/cursor?start_time=...&include=metric_sets,users,groups,organizations
```

| Sideload | Returns |
|----------|---------|
| `metric_sets` | Ticket metrics (FRT, reply time, etc.) |
| `users` | Requester, assignee, and CC user objects |
| `groups` | Assigned group objects |
| `organizations` | Requester organization objects |
| `sharing_agreements` | Shared ticket metadata |

Note: `last_audits` sideload is **not supported** on incremental endpoints for performance reasons.

---

## Community: Topics and Posts

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/topics/ and /posts/

Zendesk Guide includes a community forum feature (Topics and Posts) separate from the knowledge base articles.

### Topics API

Topics are the forum sections within the community.

```
GET /api/v2/community/topics
```

**Topic JSON Schema:**
```typescript
interface ZendeskTopic {
  id: number;
  name: string;
  description: string;
  position: number;
  follower_count: number;
  html_url: string;
  url: string;
  user_segment_id: number | null;
  user_segment_ids: number[];
  created_at: string;
  updated_at: string;
}
```

### Posts API

Posts are user-created discussions within topics.

```
GET /api/v2/community/posts                    # All posts
GET /api/v2/community/topics/{id}/posts        # Posts in a topic
GET /api/v2/community/users/{id}/posts         # Posts by a user
```

**Post JSON Schema:**
```typescript
interface ZendeskPost {
  id: number;
  title: string;
  details: string;         // HTML body content (user-generated)
  status: 'planned' | 'not_planned' | 'answered' | 'completed' | null;
  author_id: number;       // read-only
  topic_id: number;
  closed: boolean;         // further comments allowed?
  featured: boolean;
  pinned: boolean;
  vote_count: number;
  vote_sum: number;
  comment_count: number;
  follower_count: number;
  html_url: string;
  url: string;
  created_at: string;
  updated_at: string;
  non_author_editor_id: number | null;
  non_author_updated_at: string | null;
}
```

### Post Content Format

Post `details` (body) is HTML-based and supports a subset of HTML tags:
- Block: `<p>`, `<div>`, `<span>`, `<br>`, headers
- Text: `<b>`, `<i>`, `<strong>`, `<em>`, `<code>`, `<pre>`
- Lists: `<ul>`, `<ol>`, `<li>`
- Tables: `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`
- Links: `<a>`
- Images: `<img>` with user-uploaded src only
- Zendesk-specific: `<x-zendesk-user>` (user mentions)

**For indexing:** Convert `details` HTML to markdown via Turndown. Filter out `<x-zendesk-user>` tags or replace with `@{user_id}` notation.

### Post Comments API

```
GET /api/v2/community/posts/{id}/comments
```

Community post comments use the same HTML content format as posts. Indexing post + all comments gives the full discussion thread.

### Access Control for Community

Topics can have `user_segment_id` restrictions. A null `user_segment_id` means public. When indexing with admin credentials, you will see all topics regardless of user segment. This is important: **the connector must respect user segments when deciding what each user can see.**

### Value Assessment for Knowledge Indexing

| Content Type | Value | Notes |
|-------------|-------|-------|
| `status: answered` posts | High | Community-verified answers |
| `status: completed` posts | High | Confirmed resolutions |
| `status: planned` posts | Medium | Feature requests/roadmap signals |
| `vote_sum > 10` posts | High | Highly upvoted = community-endorsed |
| Unfeatured, low-vote posts | Low | Often noise or duplicates |

**Recommendation:** For initial indexing, filter to posts with `status = "answered"` or `vote_sum >= 5`. This dramatically improves signal-to-noise.

---

## Macros as Knowledge

**Source:** https://developer.zendesk.com/api-reference/ticketing/business-rules/macros/

Zendesk macros are pre-written agent responses and ticket update sequences. They encode the organization's most common support answers and are an underutilized knowledge source for AI agents.

### Why Index Macros

A macro with a `comment_value` action contains a polished, agent-written answer to a known issue. Unlike tickets (which are messy conversation threads), macros are curated responses that agents chose to standardize. They are closer in quality to KB articles but often cover different types of issues.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/macros` | List all macros (active + inactive) |
| GET | `/api/v2/macros/active` | List only active macros |
| GET | `/api/v2/macros/search?query={q}` | Search macros by title |
| GET | `/api/v2/macros/{id}` | Show a macro |

### Macro JSON Schema

```typescript
interface ZendeskMacro {
  id: number;
  title: string;
  description: string | null;
  active: boolean;
  default: boolean;
  position: number;
  restriction: {
    type: 'User' | 'Group' | null;
    id: number;
  } | null;              // null = accessible to all agents
  actions: MacroAction[];
  created_at: string;
  updated_at: string;
  url: string;
}

interface MacroAction {
  field: string;    // e.g. "status", "comment_value", "assignee_id", "tags"
  value: string | string[];
}
```

### Extracting Knowledge from Macro Actions

```typescript
function extractMacroKnowledge(macro: ZendeskMacro): string | null {
  const commentAction = macro.actions.find(a => a.field === 'comment_value');
  if (!commentAction) return null;

  const statusAction = macro.actions.find(a => a.field === 'status');
  const tagsAction = macro.actions.find(a => a.field === 'tags');

  const lines = [
    `# Macro: ${macro.title}`,
    '',
    macro.description ? `**Description:** ${macro.description}` : '',
    statusAction ? `**Sets status to:** ${statusAction.value}` : '',
    tagsAction ? `**Tags:** ${Array.isArray(tagsAction.value) ? tagsAction.value.join(', ') : tagsAction.value}` : '',
    '',
    '## Standard Response',
    '',
    typeof commentAction.value === 'string'
      ? commentAction.value  // Already text, may contain markdown
      : commentAction.value.join('\n'),
  ].filter(l => l !== null && l !== undefined && l !== '');

  return lines.join('\n');
}

async function indexAllMacros(
  subdomain: string,
  headers: Record<string, string>
): Promise<Array<{ title: string; content: string; url: string }>> {
  const url = `https://${subdomain}.zendesk.com/api/v2/macros/active`;
  const macros: ZendeskMacro[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, { headers });
    const data = await res.json();
    macros.push(...(data.macros ?? []));
    nextUrl = data.next_page ?? null;
  }

  return macros
    .map(macro => {
      const content = extractMacroKnowledge(macro);
      if (!content) return null;
      return {
        title: macro.title,
        content,
        url: `https://${subdomain}.zendesk.com/agent/macros/${macro.id}`,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}
```

### Macro Access Control

Macros can be restricted to:
- A specific user (`restriction.type = "User"`)
- A specific group (`restriction.type = "Group"`)
- All agents (`restriction = null`)

For knowledge indexing with admin credentials, all macros are visible regardless of restrictions.

**Pagination note:** Returns max 100 records per page. Macros are typically small (< 1,000 total) so complete fetching is fast.

---

## User Segments and Access Control

**Source:** https://developer.zendesk.com/api-reference/help_center/help-center-api/user_segments/

User segments control visibility of Help Center content. This is Zendesk's access control mechanism for articles and community topics.

### User Segment Types

A user segment can specify access by:
- `signed_in_users` — any signed-in user
- `staff` — only agents and admins
- `tags` — signed-in users with specific profile tags
- `organization_ids` — signed-in users from specific organizations
- `group_ids` — agents belonging to specific groups

### Relevance to the Connector

When indexing content for an AI agent system, you must decide:

1. **Agent-credential indexing:** The connector authenticates as an agent/admin and sees all content regardless of user_segment restrictions. This means the index contains content that not all end users can see.
2. **Per-user filtering at query time:** At retrieval time, filter indexed documents by the querying user's user_segment membership.
3. **Open content only:** Index only articles with `user_segment_id: null` (fully public).

**Recommended approach for enterprise knowledge index:** Index everything with admin credentials, store `user_segment_id` and `user_segment_ids` as metadata on each document, and filter at query time based on the authenticated user's attributes. This mirrors what the SharePoint connector does with Entra ID ACL enforcement.

```typescript
// Store segment info as metadata on indexed documents
interface ArticleIndexDocument {
  id: string;             // "zendesk-article-{id}"
  title: string;
  content: string;        // markdown
  source: 'zendesk-hc';
  url: string;
  breadcrumb: string[];
  locale: string;
  labels: string[];
  user_segment_id: number | null;    // null = public
  user_segment_ids: number[];
  section_id: number;
  category_id: number;
  author_id: number;
  created_at: string;
  updated_at: string;
}
```

---

## Rate Limits

**Source:** https://developer.zendesk.com/api-reference/introduction/rate-limits/

Understanding rate limits is critical for building a robust connector that doesn't get throttled during initial indexing.

### Plan-Based Rate Limits

| Plan | Support + Help Center API (req/min) |
|------|-------------------------------------|
| Team | 200 |
| Growth | 400 |
| Professional | 400 |
| Enterprise | 700 |
| Enterprise Plus | 2,500 (built-in) |
| High Volume API add-on | 2,500 |

**Important:** Support API and Help Center API have **separate** rate limit pools. Requests to HC articles do not count against the Support API ticket limit, and vice versa. This means the connector can use both APIs simultaneously without halving either limit.

### Endpoint-Specific Rate Limits

| Endpoint | Special Limit |
|----------|--------------|
| `GET /api/v2/incremental/*` | 10 req/min (standard), 30 req/min (High Volume) |
| `GET /api/v2/search` | 2,500 req/min (tracked separately) |
| `GET /api/v2/search/export` | 100 req/min |
| `PUT /api/v2/tickets/{id}` | 30 updates per 10 minutes per user per ticket |
| `GET /api/v2/tickets?page={n}` where n > 500 | 50 req/min |

### Rate Limit Headers

```
X-Rate-Limit: 700
X-Rate-Limit-Remaining: 699
Retry-After: 30           # present on 429 responses, seconds to wait
```

Ticketing APIs include additional granular headers:
```
x-rate-limit: 700
ratelimit-limit: 700
x-rate-limit-remaining: 699
ratelimit-remaining: 699
ratelimit-reset: 41         # seconds until reset
```

### 429 Handling

A `429 Too Many Requests` response includes `Retry-After` header. Always respect it:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 5
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      console.warn(`Rate limited. Waiting ${retryAfter}s before retry.`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (res.status === 503 || res.status === 502) {
      // Transient server errors - exponential backoff
      const wait = Math.min(1000 * Math.pow(2, attempt), 30000);
      await sleep(wait);
      continue;
    }

    return res;
  }

  throw new Error(`Failed after ${maxRetries} retries: ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Recommended Concurrency Limits

For initial indexing, use conservative concurrency to stay within limits:

| Plan | Safe concurrent requests |
|------|--------------------------|
| Team (200/min) | 2-3 concurrent |
| Professional (400/min) | 4-5 concurrent |
| Enterprise (700/min) | 8-10 concurrent |

Use a queue with controlled concurrency (e.g., `p-limit` npm package):

```typescript
import pLimit from 'p-limit';

const limit = pLimit(5); // 5 concurrent requests max

const articles = await Promise.all(
  articleIds.map(id =>
    limit(() => fetchArticleById(subdomain, id, headers))
  )
);
```

### Account-Wide Limit

Zendesk will throttle if detecting DoS-like patterns. The account-wide limit is **100,000 requests/minute** regardless of plan. This is a safety ceiling, not a target.

---

## HTML-to-Markdown Conversion

Zendesk article bodies and community post details are HTML. Converting to markdown is essential for clean indexing.

### Recommended Library: Turndown

```
npm install turndown @types/turndown
```

Turndown is the standard HTML-to-markdown library in the Node.js ecosystem with 3M+ weekly downloads.

### Zendesk-Specific Configuration

```typescript
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',           // Use ## headers not underline style
  codeBlockStyle: 'fenced',      // Use ``` not indented code blocks
  bulletListMarker: '-',         // Use - for lists
  strongDelimiter: '**',
  emDelimiter: '_',
});

// Enable GitHub Flavored Markdown for table support
turndown.use(gfm);

// Remove Zendesk-specific custom tags that don't convert cleanly
turndown.addRule('zendesk-user-mention', {
  filter: (node) => node.nodeName === 'X-ZENDESK-USER',
  replacement: (content) => `@${content}`,
});

// Handle Zendesk's placeholder syntax (don't let it get escaped)
turndown.addRule('preserve-zendesk-placeholders', {
  filter: (node) => {
    return node.nodeType === 3 && node.textContent?.includes('{{') === true;
  },
  replacement: (content) => content,
});

// Strip empty divs (common in Zendesk article bodies)
turndown.addRule('empty-div', {
  filter: (node) =>
    node.nodeName === 'DIV' &&
    (node.textContent?.trim() === '' || node.innerHTML?.trim() === ''),
  replacement: () => '',
});

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  try {
    return turndown.turndown(html).trim();
  } catch (err) {
    console.error('HTML-to-markdown conversion failed:', err);
    // Fallback: strip all HTML tags
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
```

### Zendesk HTML Quirks to Handle

| Quirk | How to Handle |
|-------|---------------|
| `<x-zendesk-user>` custom tags | Add a Turndown rule to convert to `@mention` |
| Zendesk placeholders `{{ticket.id}}` | Preserve as-is; do not escape double braces |
| Inline images with CDN URLs | Replace with `[Image: filename]` or skip |
| Tables with merged cells | GFM plugin handles standard tables; complex merged-cell tables may degrade |
| Nested blockquotes in email threads | Convert cleanly with standard rules |
| Empty `<p>&nbsp;</p>` spacer paragraphs | Strip via empty-div rule |
| Base64-embedded images | Strip completely — they will bloat the index |

### Content Blocks

Articles with Zendesk Content Blocks are returned as flat HTML in GET responses. The content is correct but the block structure is lost. Turndown handles this correctly — just convert the returned HTML normally.

---

## TypeScript Implementation Guide

### Project Structure

```
src/
  connectors/
    zendesk/
      index.ts              # Main connector entry point
      auth.ts               # Authentication helpers
      articles.ts           # Help Center article fetching
      tickets.ts            # Ticket + comment fetching
      macros.ts             # Macro indexing
      community.ts          # Topics and posts
      search.ts             # Search API wrapper
      incremental.ts        # Incremental sync logic
      html-to-markdown.ts   # Conversion utilities
      rate-limiter.ts       # Rate limit handling
      types.ts              # All TypeScript interfaces
```

### Main Connector Interface

```typescript
// connectors/zendesk/index.ts

import { buildAuthHeaders, buildBaseUrl } from './auth';
import { fetchAllArticles } from './articles';
import { syncTicketsIncremental } from './incremental';
import { indexAllMacros } from './macros';
import { fetchAllPosts } from './community';

export interface ZendeskConnectorConfig {
  subdomain: string;
  auth: {
    type: 'oauth' | 'api-token';
    token?: string;          // OAuth Bearer token
    email?: string;          // for api-token auth
    apiToken?: string;       // for api-token auth
  };
  options: {
    indexArticles: boolean;
    indexTickets: boolean;          // only solved/closed
    indexMacros: boolean;
    indexCommunity: boolean;
    locales: string[];              // e.g. ["en-us"] or ["en-us", "fr", "de"]
    ticketStartTime?: number;       // unix timestamp for initial ticket sync
    minPostVoteSum?: number;        // filter low-quality community posts
    excludeDrafts: boolean;
  };
}

export interface IndexedDocument {
  id: string;
  title: string;
  content: string;              // markdown
  source: string;               // "zendesk-hc" | "zendesk-ticket" | "zendesk-macro" | "zendesk-community"
  url: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export async function* zendeskConnector(
  config: ZendeskConnectorConfig
): AsyncGenerator<IndexedDocument> {
  const headers = buildAuthHeaders({
    subdomain: config.subdomain,
    oauthToken: config.auth.token,
    email: config.auth.email,
    apiToken: config.auth.apiToken,
  });

  if (config.options.indexArticles) {
    const articles = await fetchAllArticles(config.subdomain, headers);
    for (const article of articles) {
      if (config.options.excludeDrafts && article.draft) continue;
      yield {
        id: `zendesk-article-${article.id}`,
        title: article.title,
        content: article.markdownBody,
        source: 'zendesk-hc',
        url: article.html_url,
        metadata: {
          locale: article.locale,
          section_id: article.section_id,
          author_id: article.author_id,
          labels: article.label_names,
          breadcrumb: article.breadcrumb,
          user_segment_id: article.user_segment_id,
          vote_sum: article.vote_sum,
        },
        updatedAt: article.updated_at,
      };
    }
  }

  if (config.options.indexTickets) {
    const startTime = config.options.ticketStartTime ?? 0;
    await syncTicketsIncremental(
      config.subdomain,
      headers,
      { cursor: null, lastStartTime: startTime },
      async (tickets) => {
        for (const ticket of tickets) {
          if (!['solved', 'closed'].includes(ticket.status)) continue;
          // Fetch comments for each ticket
          // Yield ticket document
        }
      }
    );
  }

  if (config.options.indexMacros) {
    const macros = await indexAllMacros(config.subdomain, headers);
    for (const macro of macros) {
      yield {
        id: `zendesk-macro-${macro.title.replace(/\s+/g, '-').toLowerCase()}`,
        title: macro.title,
        content: macro.content,
        source: 'zendesk-macro',
        url: macro.url,
        metadata: {},
        updatedAt: new Date().toISOString(),
      };
    }
  }

  if (config.options.indexCommunity) {
    const minVotes = config.options.minPostVoteSum ?? 0;
    const posts = await fetchAllPosts(config.subdomain, headers, minVotes);
    for (const post of posts) {
      yield {
        id: `zendesk-post-${post.id}`,
        title: post.title,
        content: htmlToMarkdown(post.details ?? ''),
        source: 'zendesk-community',
        url: post.html_url,
        metadata: {
          status: post.status,
          vote_sum: post.vote_sum,
          topic_id: post.topic_id,
        },
        updatedAt: post.updated_at,
      };
    }
  }
}
```

### Efficient Initial Index Strategy

For a large Zendesk instance (10,000+ articles, 1M+ tickets), follow this initialization sequence:

```typescript
async function buildInitialIndex(config: ZendeskConnectorConfig): Promise<void> {
  // Phase 1: Fetch structure (fast)
  // ~3 requests: categories + sections + (optional) labels
  const [categories, sections] = await Promise.all([
    fetchAllCategories(config.subdomain, headers),
    fetchAllSections(config.subdomain, headers),
  ]);

  // Phase 2: Fetch articles via incremental endpoint (efficient)
  // start_time=0 means "all articles ever"
  // Returns ~1000 per page, cursor-free (time-based only for articles)
  const articleDocs = await fetchAllArticles(config.subdomain, headers, 0);

  // Phase 3: Index tickets (slow for large instances)
  // Stream with cursor-based export, process in batches
  // Budget: 10 req/min incremental limit = 10,000 tickets/min at max page size
  await streamTicketsToIndex(config, startTime);

  // Phase 4: Macros (fast, typically < 500 macros)
  const macroDocs = await indexAllMacros(config.subdomain, headers);
}
```

**Time estimates for a mid-size instance (5,000 articles, 100,000 tickets):**
- Articles: ~5-10 seconds (cursor paginated, 1000/page)
- Ticket metadata: ~10 minutes at 10 req/min incremental limit
- Ticket comments (one request per ticket): too expensive for all tickets — fetch on-demand instead or limit to recent/tagged tickets

**Recommendation:** For tickets, index only metadata initially (subject, tags, status, created_at). Fetch full comment threads on-demand when a ticket matches a search query. This keeps the initial index fast while making deep content available.

---

## What to Build vs Skip

### Build: Phase 2 Alpha

| Feature | Priority | Why |
|---------|----------|-----|
| Help Center articles | P0 | Primary KB source, clean structured content |
| Category/section hierarchy | P0 | Required for breadcrumb and filtering |
| Article incremental sync | P0 | Keep index fresh without re-fetching everything |
| Ticket search (metadata) | P1 | Most valuable proprietary content |
| Ticket comment fetch on-demand | P1 | Full resolution details when needed |
| Macros | P1 | High-quality curated answers, fast to index |
| OAuth 2.0 auth | P0 | Required for multi-tenant distribution |

### Build: Phase 2 Beta

| Feature | Priority | Why |
|---------|----------|-----|
| Community posts (filtered by status/votes) | P2 | Useful Q&A content, noisier than articles |
| Article translations | P2 | Essential for multilingual enterprises |
| Article attachments (PDF extraction) | P2 | High value for technical documentation |
| Ticket incremental cursor sync | P1 | Efficient ongoing sync |

### Skip or Defer

| Feature | Reason to Skip |
|---------|----------------|
| Ticket triggers | Machine-readable conditions only, no human-readable knowledge |
| Automations | Same as triggers — conditional logic, not prose knowledge |
| SLA policies | Numeric thresholds, not knowledge content |
| Views | Saved search queries, not content |
| User/org data | PII risk, not knowledge content |
| Voice/phone transcripts | Expensive to access, low ROI vs other ticket content |
| Zendesk Chat history | Separate product, separate API, separate auth |
| Sandbox instances | Never index — contain test/dummy data |

---

## Edge Cases and Gotchas

### Authentication

1. **API token deprecation timeline:** Zendesk has not set a hard sunset date as of mid-2026, but new integrations should use OAuth. Enterprise customers may still provide API tokens for simplicity.

2. **Token scope gap:** Per-instance OAuth tokens cannot be used for multi-tenant SaaS distributions (per Zendesk Developer Terms). You must register as a Global OAuth client if you want to distribute to multiple organizations.

3. **401 vs 403:** Zendesk returns 401 for invalid credentials and 403 for valid credentials without permission for the resource. Handle both.

### Articles

4. **Draft articles:** The `draft` field is `true` for unpublished articles. These may contain sensitive internal content. Always filter `draft: true` articles out of public-facing contexts.

5. **Archived articles:** Zendesk has an "archive" state for deprecated articles. These are not returned in standard list endpoints but may appear in incremental exports. Check the `body` field — archived articles may have placeholder text.

6. **Article body truncation:** The API does not truncate article bodies, but articles can be very large (up to the Zendesk CMS limit). Plan for articles up to 500KB of HTML.

7. **Content block API limitation:** If a Help Center uses Content Blocks, GET requests return flat HTML (content correctly rendered but not structured). PUT updates would destroy block links. For read-only indexing, this is fine.

8. **Inline image URLs:** Images embedded in article bodies via `<img src="...">` use Zendesk CDN URLs that **require authentication** to access. Anonymous users cannot download inline images. When converting to markdown, these image references will break if accessed without credentials.

### Tickets

9. **Rate limit on comments endpoint:** Fetching comments for every ticket is expensive. For 100,000 tickets at 700 req/min (Enterprise plan), fetching all comment threads would take ~143 minutes of API time plus rate limiting headroom. Batch or defer this.

10. **Deleted ticket tombstones:** Incremental ticket export returns deleted tickets as stubs with `status: deleted`. Store the deletion and remove from the index; don't re-index the stale content.

11. **Ticket spam:** Many Zendesk instances have significant spam in their ticket history. Filter using `exclude_deleted=true` and only index `status:solved` or `status:closed` to avoid indexing spam tickets.

12. **Subject field missing:** Tickets can have no subject (especially API-created and email-in tickets). The `description` (first comment body) is set as subject on first agent workspace edit. Always check for null/empty subject.

13. **Custom ticket statuses:** If `custom_status_id` is present, the `status` field contains the category, not the custom status name. Sideload `custom_statuses` or make a separate lookup if you need human-readable status names.

14. **Ticket merge:** When tickets are merged, the absorbed ticket gets `status: deleted` but its comment history is appended to the target ticket. Incremental export will show both the deletion of the source and the update of the target.

### Incremental Exports

15. **Minimum start_time of 1 minute ago:** The incremental endpoints enforce that `start_time` must be more than 1 minute in the past. Use `Math.floor(Date.now() / 1000) - 120` to be safe.

16. **end_of_stream gotcha:** `end_of_stream: true` does not mean there are no more results — it means you are caught up to the current time. You should still store the `after_cursor` and use it in the next scheduled sync.

17. **Cursor persistence:** If you lose the cursor (e.g., crash or restart), you must fall back to `start_time`. Store cursors durably (database or file) and have a fallback recovery strategy.

18. **Incremental export rate limit is per-account:** If multiple connector instances or other apps are using the incremental endpoint for the same Zendesk account, they share the 10 req/min limit. Coordinate to avoid rate limit collisions.

### Help Center Search

19. **Search result limit of 30 per page:** The Help Center search (`/api/v2/help_center/articles/search`) caps at 30 results per page, with no cursor-based pagination. It is not suitable for bulk export; use the articles incremental endpoint for that.

20. **Search indexing lag:** Newly created or updated articles may not appear in search results for a few minutes. For freshness-critical use cases, fetch the article directly by ID after a creation webhook, don't rely on search to find it.

### Community

21. **Community requires Guide Enterprise:** The community (topics/posts) feature is not available on all Zendesk plans. Check for 404 on community endpoints before assuming they are available.

22. **Post body is user-generated HTML:** Unlike articles (which are moderated), community post `details` can contain any user-submitted content. Sanitize aggressively before indexing.

### Multi-Tenancy

23. **Per-subdomain auth:** Each Zendesk instance has its own subdomain, users, and auth tokens. There is no cross-subdomain API. Each customer of the connector is a completely separate Zendesk instance.

24. **Plan detection:** Rate limits differ dramatically by plan (200 vs 2,500 req/min). Add a config option or auto-detect plan tier and set concurrency accordingly.

---

## Summary of Key API URLs

| Resource | URL Pattern |
|---------|-------------|
| All articles | `GET /api/v2/help_center/articles` |
| Incremental articles | `GET /api/v2/help_center/incremental/articles?start_time={unix}` |
| Single article | `GET /api/v2/help_center/articles/{id}` |
| Article attachments | `GET /api/v2/help_center/articles/{id}/attachments` |
| Article translations | `GET /api/v2/help_center/articles/{id}/translations` |
| All categories | `GET /api/v2/help_center/categories` |
| All sections | `GET /api/v2/help_center/sections` |
| HC search | `GET /api/v2/help_center/articles/search?query={q}` |
| Tickets | `GET /api/v2/tickets` |
| Ticket comments | `GET /api/v2/tickets/{id}/comments` |
| Incremental tickets (cursor) | `GET /api/v2/incremental/tickets/cursor?start_time={unix}` |
| Incremental tickets (time) | `GET /api/v2/incremental/tickets?start_time={unix}` |
| Search (unified) | `GET /api/v2/search?query={q}` |
| Search export (cursor) | `GET /api/v2/search/export?query={q}` |
| Macros | `GET /api/v2/macros` |
| Active macros | `GET /api/v2/macros/active` |
| Community topics | `GET /api/v2/community/topics` |
| Community posts | `GET /api/v2/community/posts` |
| Posts in topic | `GET /api/v2/community/topics/{id}/posts` |
| Post comments | `GET /api/v2/community/posts/{id}/comments` |
| Rate limits doc | https://developer.zendesk.com/api-reference/introduction/rate-limits/ |
| Auth doc | https://developer.zendesk.com/api-reference/introduction/security-and-auth/ |
| Incremental exports doc | https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/ |
