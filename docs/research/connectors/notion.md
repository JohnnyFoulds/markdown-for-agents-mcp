# Notion Connector Research

**Project:** markdown-for-agents-mcp  
**Phase:** 2 — Enterprise Knowledge Index  
**Date:** 2026-08-26  
**API version researched:** 2026-03-11 (current stable), with notes on 2025-09-03 breaking changes  
**Sources:** developers.notion.com (direct page fetches)

---

## Summary and Recommendation

Build the Notion connector. Notion is the most popular knowledge management tool for tech-forward teams and a logical Phase 2 target alongside SharePoint and Confluence. The API is well-designed, the official JavaScript SDK handles rate-limit retries automatically, and the block-based content model maps cleanly to markdown.

**What to build:**
- Full content extraction: pages + database rows + nested blocks
- Search-first discovery (title search) with incremental sync via `last_edited_time`
- Rich text to markdown converter covering all annotation types and inline mention types
- Webhook-driven invalidation for near-real-time index updates

**What to skip (Phase 2):**
- File download/re-hosting — link to Notion-hosted URLs, note the 1-hour expiry
- Formula/rollup evaluation — serialize the raw formula string, not the computed result
- Views API — scoped to a specific display format, not useful for knowledge extraction
- Meeting notes / transcriptions — niche block type, low ROI

---

## Table of Contents

1. [API Overview and Versioning](#1-api-overview-and-versioning)
2. [Authentication: Internal vs. Public Connection vs. PAT](#2-authentication)
3. [Search API](#3-search-api)
4. [Block Types: Complete Schema Reference](#4-block-types)
5. [Rich Text to Markdown Conversion](#5-rich-text-to-markdown)
6. [Recursive Block Fetching](#6-recursive-block-fetching)
7. [Databases and Data Sources (2025-09-03 model change)](#7-databases-and-data-sources)
8. [Page Metadata](#8-page-metadata)
9. [Files and Media](#9-files-and-media)
10. [Incremental Sync](#10-incremental-sync)
11. [Webhooks for Real-time Invalidation](#11-webhooks)
12. [Rate Limits and Retry Strategy](#12-rate-limits-and-retry)
13. [Synced Blocks and Linked Databases](#13-synced-blocks-and-linked-databases)
14. [Complete TypeScript Connector Implementation](#14-complete-typescript-connector)
15. [Limitations, Edge Cases, and Gotchas](#15-limitations-edge-cases-and-gotchas)
16. [Feature-by-Feature Build Plan](#16-feature-build-plan)

---

## 1. API Overview and Versioning

**Base URL:** `https://api.notion.com`  
**Current version header:** `Notion-Version: 2026-03-11`  
**Protocol:** HTTPS only, REST, JSON bodies  
**Naming convention:** `snake_case` property names, ISO 8601 timestamps  
**Source:** https://developers.notion.com/reference/intro

### Key versioning note: 2025-09-03 breaking change

In September 2025 Notion split "database" into two objects:

| Old model (pre-2025-09-03) | New model (2025-09-03+) |
|---|---|
| A database is a table with one set of properties | A **database** is a container holding one or more **data sources** |
| `POST /v1/databases/{id}/query` | `POST /v1/data_sources/{id}/query` |
| Database object includes properties schema | Database object now has `data_sources[]` array; properties live on the data source |
| No concept of multiple data sources | One database can have multiple data sources, each with independent property schemas |

The deprecated query endpoint (`/v1/databases/{id}/query`) continues to work up to and including version `2022-06-28`. For new implementations, use the data source APIs.

**Decision for our connector:** Target `2026-03-11` (current). Use data source APIs. Implement a version-detection fallback for older workspaces if necessary.

### Required header

```typescript
const headers = {
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2026-03-11",
  "Content-Type": "application/json",
};
```

---

## 2. Authentication

**Source:** https://developers.notion.com/docs/authorization

### Three token types

| Type | Use case | Token format | Scope |
|---|---|---|---|
| Internal connection (installation access token) | Team-owned automations; single workspace | Static bot token | Pages manually shared with the connection |
| Public connection (OAuth 2.0) | SaaS apps installed by many workspaces | Short-lived access token + refresh token | Pages user selects in page picker |
| Personal access token (PAT) | Scripts, CLIs, trusted individual tools | Static user-scoped token | Same permissions as the user who created it |

### For markdown-for-agents-mcp

Use **internal connection** for enterprise deployments (one token per Notion workspace, configured by admin). Use **public connection + OAuth** if building a multi-tenant SaaS product.

The key constraint: pages must be **explicitly shared** with the connection. There is no "all workspace content" scope. A connection cannot see pages the user hasn't granted it access to. This is a fundamental security model — it is the correct behavior for an enterprise knowledge index.

### Internal connection setup

1. Create a connection at https://developers.notion.com
2. Retrieve the installation access token from the Configuration tab
3. Share relevant pages/databases with the connection from the Notion UI (••• menu > Add connections)

```typescript
const notion = new Client({
  auth: process.env.NOTION_ACCESS_TOKEN,
  notionVersion: "2026-03-11",
});
```

### OAuth flow (public connection)

Authorization URL format:
```
https://api.notion.com/v1/oauth/authorize
  ?owner=user
  &client_id=<client_id>
  &redirect_uri=<redirect_uri>
  &response_type=code
  &state=<csrf_token>
```

Token exchange (`POST /v1/oauth/token`):
- Returns `access_token`, `refresh_token`, `workspace_id`, `workspace_name`, `bot_id`
- Refresh token used at `POST /v1/oauth/token` with `grant_type=refresh_token`

### Connection capabilities

Connections declare which operations they need. For read-only knowledge indexing, request **read content** capabilities. Without this, some fields (like page body content) are not returned.

---

## 3. Search API

**Endpoint:** `POST /v1/search`  
**Source:** https://developers.notion.com/reference/post-search

### What it searches

Searches all pages and data sources (formerly databases) **that have been shared with the connection**. It searches **titles only** — not full-text content.

This is an important limitation: `/v1/search` is a title search, not a full-text search. For full content retrieval, you must enumerate with search (or start from known parent page IDs) and then fetch blocks separately.

### Request body

```typescript
interface SearchRequest {
  query?: string;           // Title substring match. Empty string = return all
  filter?: {
    property: "object";
    value: "page" | "database";  // Filter to pages or databases only
    in_trash?: boolean;          // Include trashed items (default false)
  };
  sort?: {
    direction: "ascending" | "descending";
    timestamp: "last_edited_time";  // Only supported sort key
  };
  start_cursor?: string;    // Cursor for pagination
  page_size?: number;       // Max 100, default 100
}
```

### Response

```typescript
interface SearchResponse {
  object: "list";
  type: "page_or_data_source";
  results: (PageObject | DataSourceObject)[];
  has_more: boolean;
  next_cursor: string | null;
  request_status: {
    type: "complete" | "partial";
    incomplete_reason?: "query_result_limit_reached";
  };
}
```

Note the `request_status` field: if `incomplete_reason` is `"query_result_limit_reached"`, the search hit an internal cap before returning all matching items. This can happen even when `has_more` is false.

### TypeScript example: enumerate all accessible pages

```typescript
import { Client, iteratePaginatedAPI } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_ACCESS_TOKEN });

async function* enumerateAllPages() {
  for await (const item of iteratePaginatedAPI(notion.search, {
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
  })) {
    yield item;
  }
}

// Enumerate all databases (data sources)
async function* enumerateAllDatabases() {
  for await (const item of iteratePaginatedAPI(notion.search, {
    filter: { property: "object", value: "database" },
  })) {
    yield item;
  }
}
```

### Incremental search (changed since timestamp)

The search API **does not support a `last_edited_time` filter parameter**. The `sort` parameter sorts by `last_edited_time` descending — so to find recently changed pages, fetch the first page of results and stop when you encounter items older than your last sync time.

```typescript
async function* changedSinceLastSync(since: Date) {
  for await (const item of iteratePaginatedAPI(notion.search, {
    sort: { direction: "descending", timestamp: "last_edited_time" },
    filter: { property: "object", value: "page" },
  })) {
    const editedAt = new Date(item.last_edited_time);
    if (editedAt < since) break; // Items are sorted by edit time; stop early
    yield item;
  }
}
```

Caveat: The `break` optimization only works if Notion returns items in strict descending order. In practice this holds, but don't rely on it for critical correctness — do a full scan for the initial index build.

---

## 4. Block Types

**Source:** https://developers.notion.com/reference/block

### Common block fields

Every block object contains:

| Field | Type | Description |
|---|---|---|
| `object` | `"block"` | Always `"block"` |
| `id` | `string (UUIDv4)` | Block identifier |
| `parent` | `object` | Parent block/page/database reference |
| `type` | `string (enum)` | Block type (see full list below) |
| `created_time` | `ISO 8601` | Creation timestamp |
| `last_edited_time` | `ISO 8601` | Last edit timestamp |
| `created_by` | `Partial User` | Creator |
| `last_edited_by` | `Partial User` | Last editor |
| `has_children` | `boolean` | Whether the block has nested children |
| `in_trash` | `boolean` | Whether the block is trashed (use instead of deprecated `archived`) |
| `{type}` | `object` | Type-specific content object |

### All supported block types (enum values)

```
"audio"          "bookmark"          "breadcrumb"
"bulleted_list_item"  "callout"       "child_database"
"child_page"     "code"              "column"
"column_list"    "divider"           "embed"
"equation"       "file"              "heading_1"
"heading_2"      "heading_3"         "heading_4"
"image"          "link_preview"      "numbered_list_item"
"paragraph"      "pdf"               "quote"
"synced_block"   "table"             "table_of_contents"
"table_row"      "template"          "to_do"
"toggle"         "transcription"     "unsupported"
"video"
```

Note: `"transcription"` is also known as "Meeting notes" in the UI as of 2026-03-11.  
Note: `"unsupported"` blocks include a `block_type` field naming the underlying type (e.g., `"form"`, `"button"`).

### Block types that support child blocks

The following block types can contain nested `children`:

- `bulleted_list_item`, `numbered_list_item`, `to_do`
- `callout`, `quote`
- `paragraph`
- `heading_1`, `heading_2`, `heading_3`, `heading_4` — **only when `is_toggleable: true`**
- `toggle`
- `column_list` → contains `column` blocks → each column contains children
- `child_page`, `child_database`
- `synced_block`
- `table` → contains `table_row` blocks
- `template`
- `transcription` / meeting notes

### Complete block type schemas

#### paragraph

```typescript
interface ParagraphBlock {
  type: "paragraph";
  paragraph: {
    rich_text: RichText[];
    color: ColorEnum;
    children?: Block[];  // Only present if has_children and fetched separately
  };
}
```

#### heading_1, heading_2, heading_3, heading_4

```typescript
interface HeadingBlock {
  type: "heading_1" | "heading_2" | "heading_3" | "heading_4";
  heading_1: {  // (or heading_2, etc.)
    rich_text: RichText[];
    color: ColorEnum;
    is_toggleable: boolean;  // If true, block can have children
  };
}
```

#### bulleted_list_item / numbered_list_item

```typescript
interface ListItemBlock {
  type: "bulleted_list_item" | "numbered_list_item";
  bulleted_list_item: {  // (or numbered_list_item)
    rich_text: RichText[];
    color: ColorEnum;
    children?: Block[];
  };
}
```

#### to_do

```typescript
interface ToDoBlock {
  type: "to_do";
  to_do: {
    rich_text: RichText[];
    checked: boolean | null;
    color: ColorEnum;
    children?: Block[];
  };
}
```

#### toggle

```typescript
interface ToggleBlock {
  type: "toggle";
  toggle: {
    rich_text: RichText[];
    color: ColorEnum;
    children?: Block[];
  };
}
```

#### callout

```typescript
interface CalloutBlock {
  type: "callout";
  callout: {
    rich_text: RichText[];
    icon: EmojiObject | FileObject | null;
    color: ColorEnum;
    children?: Block[];
  };
}
```

#### quote

```typescript
interface QuoteBlock {
  type: "quote";
  quote: {
    rich_text: RichText[];
    color: ColorEnum;
    children?: Block[];
  };
}
```

#### code

```typescript
interface CodeBlock {
  type: "code";
  code: {
    rich_text: RichText[];    // The code content
    caption: RichText[];      // Optional caption
    language: string;         // e.g., "typescript", "python", "plain text"
  };
}
```

#### equation (block-level)

```typescript
interface EquationBlock {
  type: "equation";
  equation: {
    expression: string;  // LaTeX string
  };
}
```

#### divider

```typescript
interface DividerBlock {
  type: "divider";
  divider: {};  // Empty object
}
```

#### table

```typescript
interface TableBlock {
  type: "table";
  table: {
    table_width: number;          // Number of columns
    has_column_header: boolean;
    has_row_header: boolean;
    children?: TableRowBlock[];   // Fetched via block children
  };
}

interface TableRowBlock {
  type: "table_row";
  table_row: {
    cells: RichText[][];  // Array of cells; each cell is an array of rich text
  };
}
```

#### column_list and column

```typescript
interface ColumnListBlock {
  type: "column_list";
  column_list: {};  // Empty; children are column blocks
}

interface ColumnBlock {
  type: "column";
  column: {};  // Empty; children are the actual content blocks within this column
}
```

Fetching column content requires two levels of child fetching:
1. Fetch children of the `column_list` → get `column` blocks
2. Fetch children of each `column` block → get the content

#### image / video / audio / pdf / file

```typescript
interface MediaBlock {
  type: "image" | "video" | "audio" | "pdf" | "file";
  image: {  // (or video, audio, pdf, file)
    type: "external" | "file" | "file_upload";
    external?: { url: string };
    file?: { url: string; expiry_time: string };  // URL valid 1 hour
    file_upload?: { id: string };
    caption: RichText[];
  };
}
```

Supported image external URL types: `.png`, `.jpg`, `.jpeg`, `.gif`, `.tif`, `.tiff`, `.bmp`, `.svg`, `.ico`

#### embed

```typescript
interface EmbedBlock {
  type: "embed";
  embed: {
    url: string;
    caption: RichText[];
  };
}
```

#### bookmark

```typescript
interface BookmarkBlock {
  type: "bookmark";
  bookmark: {
    url: string;
    caption: RichText[];
  };
}
```

#### link_preview

```typescript
interface LinkPreviewBlock {
  type: "link_preview";
  link_preview: {
    url: string;
  };
}
```

#### child_page / child_database

```typescript
interface ChildPageBlock {
  type: "child_page";
  child_page: {
    title: string;  // Plain text title of the child page
  };
}

interface ChildDatabaseBlock {
  type: "child_database";
  child_database: {
    title: string;  // Plain text title of the child database
  };
}
```

These blocks are references to other pages/databases. The `id` field on the block is the page/database ID. Fetch them separately to get content.

#### synced_block

```typescript
interface SyncedBlock {
  type: "synced_block";
  synced_block: {
    synced_from: { type: "block_id"; block_id: string } | null;
    // null means this is the ORIGINAL synced block
    // block_id present means this is a DUPLICATE (reference to original)
    children?: Block[];  // Only present on the original, fetched via children endpoint
  };
}
```

For duplicates (`synced_from != null`), fetch the original block's children to get content.

#### table_of_contents

```typescript
interface TableOfContentsBlock {
  type: "table_of_contents";
  table_of_contents: {
    color: ColorEnum;
  };
}
```

For markdown output, either omit or regenerate the TOC from heading structure.

#### breadcrumb

```typescript
interface BreadcrumbBlock {
  type: "breadcrumb";
  breadcrumb: {};  // Empty object
}
```

Omit from markdown output or render as a note about page location.

#### unsupported

```typescript
interface UnsupportedBlock {
  type: "unsupported";
  unsupported: {
    block_type: string;  // Actual underlying type, e.g., "form", "button"
  };
}
```

Log the `block_type` for monitoring; skip in markdown output.

### Color enum values

Used across many block types for background/foreground color:

```typescript
type ColorEnum =
  | "default" | "gray" | "brown" | "orange" | "yellow" | "green"
  | "blue" | "purple" | "pink" | "red"
  | "gray_background" | "brown_background" | "orange_background"
  | "yellow_background" | "green_background" | "blue_background"
  | "purple_background" | "pink_background" | "red_background";
```

Colors are decorative metadata — for knowledge indexing purposes, ignore them or map `*_background` colors to callout-like markdown styling.

---

## 5. Rich Text to Markdown Conversion

**Source:** https://developers.notion.com/reference/rich-text

### Rich text object structure

Every rich text object has:

```typescript
interface RichText {
  type: "text" | "mention" | "equation";
  text?: TextContent;
  mention?: MentionContent;
  equation?: EquationContent;
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: ColorEnum;
  };
  plain_text: string;  // Always available — unformatted text
  href: string | null; // URL if this text is a link or mention
}
```

### Text type

```typescript
interface TextContent {
  content: string;  // Max 2000 chars
  link: { url: string } | null;
}
```

### Mention types

```typescript
type MentionContent =
  | { type: "database"; database: { id: string } }
  | { type: "date"; date: { start: string; end: string | null } }
  | { type: "link_preview"; link_preview: { url: string } }
  | { type: "page"; page: { id: string } }
  | { type: "template_mention"; template_mention: TemplateMentionContent }
  | { type: "user"; user: UserObject };
```

### Equation type (inline)

```typescript
interface EquationContent {
  expression: string;  // LaTeX; max 1000 chars
}
```

### Complete rich text to markdown converter

```typescript
function richTextToMarkdown(richText: RichText[]): string {
  return richText.map(rt => convertRichTextItem(rt)).join("");
}

function convertRichTextItem(rt: RichText): string {
  // Special handling by type
  if (rt.type === "equation") {
    return `$${rt.equation!.expression}$`;
  }

  if (rt.type === "mention") {
    return convertMention(rt);
  }

  // Type === "text"
  let text = rt.text?.content ?? rt.plain_text;

  // Apply annotations (order matters: code wrapping first, then formatting)
  const ann = rt.annotations;

  if (ann.code) {
    text = `\`${text}\``;
    // Don't apply other formatting inside code spans
    if (rt.text?.link) return `[\`${rt.text.content}\`](${rt.text.link.url})`;
    return text;
  }

  // Markdown doesn't have underline — skip or use HTML <u>
  // Bold and italic can be combined: ***text***
  if (ann.bold && ann.italic) text = `***${text}***`;
  else if (ann.bold) text = `**${text}**`;
  else if (ann.italic) text = `*${text}*`;

  if (ann.strikethrough) text = `~~${text}~~`;

  // Apply link wrapping
  const url = rt.text?.link?.url ?? rt.href;
  if (url) text = `[${text}](${url})`;

  return text;
}

function convertMention(rt: RichText): string {
  const mention = rt.mention!;

  switch (mention.type) {
    case "page":
      // plain_text contains the page title if accessible
      return rt.href
        ? `[${rt.plain_text}](${rt.href})`
        : rt.plain_text;

    case "database":
      return rt.href
        ? `[${rt.plain_text}](${rt.href})`
        : rt.plain_text;

    case "user":
      // plain_text is "@Name" or "@Unknown" if no access
      return rt.plain_text;

    case "date":
      const d = mention.date;
      return d.end ? `${d.start} → ${d.end}` : d.start;

    case "link_preview":
      return `[${mention.link_preview.url}](${mention.link_preview.url})`;

    case "template_mention":
      // These are template placeholders, render as plain text
      return rt.plain_text;

    default:
      return rt.plain_text;
  }
}
```

### Edge cases in rich text

1. **Empty rich_text arrays** — block has no text content; output empty string or skip
2. **Nested annotations** — Notion allows bold+italic simultaneously; use `***text***`
3. **Partial access to mentioned pages** — `plain_text` shows "Untitled" and annotations default when connection lacks access
4. **Color annotations** — Ignore for markdown; optionally map background colors to HTML spans if rich output needed
5. **Text content limit** — Each rich text item is max 2000 chars but a block can have up to 100 items in its array (100 elements per array limit)
6. **Inline equations** — LaTeX wrapped in `$...$`; rendered differently per markdown renderer

---

## 6. Recursive Block Fetching

**Endpoint:** `GET /v1/blocks/{block_id}/children`  
**Source:** https://developers.notion.com/reference/get-block-children

### Pagination parameters

| Parameter | Type | Default | Max |
|---|---|---|---|
| `page_size` | number | 100 | 100 |
| `start_cursor` | string | undefined | — |

Response includes `has_more` and `next_cursor`.

### The recursion problem

The API returns only **one level** of children per call. To get full nested content, you must:
1. Fetch children of the page (page ID = block ID for top-level)
2. For each returned block where `has_children = true`, fetch that block's children
3. Recurse

This means a deep page with many toggle blocks, nested lists, column layouts, and tables can require dozens of API calls.

### Efficient recursive fetcher with rate-limit-aware concurrency

```typescript
import { Client, iteratePaginatedAPI } from "@notionhq/client";
import pLimit from "p-limit"; // npm install p-limit

const notion = new Client({ auth: process.env.NOTION_ACCESS_TOKEN });

// Stay well under 3 req/sec per-connection rate limit
// Use 2 concurrent requests with queue to avoid burst
const limit = pLimit(2);

interface BlockWithChildren {
  block: BlockObjectResponse;
  children?: BlockWithChildren[];
}

async function fetchBlocksRecursive(
  blockId: string,
  depth = 0,
  maxDepth = 15
): Promise<BlockWithChildren[]> {
  if (depth > maxDepth) {
    console.warn(`Max depth ${maxDepth} reached at block ${blockId}`);
    return [];
  }

  const blocks: BlockObjectResponse[] = [];

  // Collect all paginated blocks at this level
  for await (const block of iteratePaginatedAPI(
    notion.blocks.children.list,
    { block_id: blockId }
  )) {
    blocks.push(block as BlockObjectResponse);
  }

  // Fetch children concurrently (rate-limited)
  const results: BlockWithChildren[] = await Promise.all(
    blocks.map(block =>
      limit(async () => {
        if (!block.has_children) {
          return { block };
        }

        // Special handling: synced_block duplicates reference the original
        if (block.type === "synced_block" && block.synced_block.synced_from) {
          const originalId = block.synced_block.synced_from.block_id;
          const children = await fetchBlocksRecursive(originalId, depth + 1, maxDepth);
          return { block, children };
        }

        const children = await fetchBlocksRecursive(block.id, depth + 1, maxDepth);
        return { block, children };
      })
    )
  );

  return results;
}
```

### Request cost estimation

A page with average nesting depth of 3 and 50 blocks at each level requires approximately:
- 1 top-level call (50 blocks)
- Up to 50 second-level calls (if all have children)
- Up to 2500 third-level calls

This is the worst case. In practice, most pages have a handful of nested blocks. Still, budget for 10–50 API calls per page for a moderately complex document.

### column_list special handling

```typescript
function isColumnList(block: Block): boolean {
  return block.type === "column_list";
}

// When rendering: fetch column_list children → get columns
// Then fetch each column's children → get actual content
// Render as side-by-side in markdown: NOT possible.
// Fall back to sequential rendering with a horizontal rule between columns
function renderColumnList(block: BlockWithChildren): string {
  const columns = block.children ?? [];
  return columns
    .map(col => {
      const content = renderBlocks(col.children ?? []);
      return content;
    })
    .join("\n\n---\n\n");
}
```

---

## 7. Databases and Data Sources

**Source:** https://developers.notion.com/reference/database  
**Source:** https://developers.notion.com/reference/data-source  
**Source:** https://developers.notion.com/reference/post-database-query (deprecated)

### Data model (2025-09-03+)

```
Workspace
  └── Database (container, has icon/cover/title/parent)
        ├── Data Source 1 (has properties schema, contains pages)
        │     ├── Page (row)
        │     └── Page (row)
        └── Data Source 2 (independent schema)
              └── Page (row)
```

Pre-2025-09-03: database and data source were the same concept.

### Database object fields

| Field | Type | Description |
|---|---|---|
| `object` | `"database"` | Always `"database"` |
| `id` | `string (UUID)` | Unique identifier |
| `data_sources` | `array` | List of child data sources with `id` and `name` |
| `title` | `RichText[]` | Database name |
| `description` | `RichText[]` | Description |
| `icon` | `Emoji/Icon/File/null` | Icon |
| `cover` | `File/null` | Cover image |
| `parent` | `object` | Parent page, database, or workspace |
| `created_time` | `ISO 8601` | Creation timestamp |
| `last_edited_time` | `ISO 8601` | Last edit timestamp |
| `url` | `string` | Notion URL |
| `in_trash` | `boolean` | Trashed status |
| `is_inline` | `boolean` | Whether inline (true) or full-page (false) |
| `public_url` | `string/null` | Public URL if published |

### Data source object fields

| Field | Type | Description |
|---|---|---|
| `object` | `"data_source"` | Always `"data_source"` |
| `id` | `string (UUID)` | Unique identifier |
| `properties` | `object` | Property schema (key: property name, value: Property object) |
| `parent` | `object` | Parent database (or data source for externally synced) |
| `database_parent` | `object` | The containing database's parent |
| `title` | `RichText[]` | Data source name |
| `description` | `RichText[]` | Description |
| `created_time` | `ISO 8601` | Creation timestamp |
| `last_edited_time` | `ISO 8601` | Last edit timestamp |
| `in_trash` | `boolean` | Trashed status |

### Property types

Notion supports the following property types in data source schemas:

| Property type | Description | Value format |
|---|---|---|
| `title` | The required name/title column | `RichText[]` |
| `rich_text` | Multi-line text | `RichText[]` |
| `number` | Numeric value with optional format | `number \| null` |
| `select` | Single select from predefined options | `{ id, name, color } \| null` |
| `multi_select` | Multiple selects | `Array<{ id, name, color }>` |
| `status` | Status with groups | `{ id, name, color } \| null` |
| `date` | Date or date range | `{ start, end, time_zone } \| null` |
| `people` | User references | `PartialUser[]` |
| `files` | File attachments | `FileObject[]` |
| `checkbox` | Boolean | `boolean` |
| `url` | URL string | `string \| null` |
| `email` | Email address | `string \| null` |
| `phone_number` | Phone number | `string \| null` |
| `formula` | Computed value | `{ type: "string"|"number"|"boolean"|"date", value }` |
| `relation` | References to pages in another database | `Array<{ id: string }>` |
| `rollup` | Aggregation over related pages | Complex; type varies |
| `created_time` | Auto-filled creation timestamp | `ISO 8601 string` |
| `created_by` | Auto-filled creator | `PartialUser` |
| `last_edited_time` | Auto-filled last edit timestamp | `ISO 8601 string` |
| `last_edited_by` | Auto-filled last editor | `PartialUser` |
| `unique_id` | Auto-incremented integer ID | `{ prefix, number }` |
| `button` | Button to trigger actions (cannot be queried) | Unsupported in API |
| `verification` | Page verification status | `{ state, verified_by, date }` |

### Querying a data source (new API)

```typescript
// POST /v1/data_sources/{data_source_id}/query
const response = await notion.dataSources.query({
  data_source_id: "abc123",
  filter: {
    and: [
      { property: "Status", status: { equals: "Done" } },
      {
        or: [
          { property: "Tags", multi_select: { contains: "important" } },
          { property: "Priority", select: { equals: "High" } },
        ],
      },
    ],
  },
  sorts: [
    { property: "Due date", direction: "descending" },
    { timestamp: "created_time", direction: "ascending" },
  ],
  page_size: 100,
});
```

### Filter operators by property type

| Property type | Supported filter conditions |
|---|---|
| `rich_text`, `title` | `equals`, `does_not_equal`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` |
| `number` | `equals`, `does_not_equal`, `greater_than`, `less_than`, `greater_than_or_equal_to`, `less_than_or_equal_to`, `is_empty`, `is_not_empty` |
| `checkbox` | `equals`, `does_not_equal` |
| `select` | `equals`, `does_not_equal`, `is_empty`, `is_not_empty` |
| `multi_select` | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` |
| `status` | `equals`, `does_not_equal`, `is_empty`, `is_not_empty` |
| `date`, `created_time`, `last_edited_time` | `equals`, `before`, `after`, `on_or_before`, `on_or_after`, `is_empty`, `is_not_empty`, `past_week`, `past_month`, `past_year`, `next_week`, `next_month`, `next_year`, `this_week` |
| `people`, `created_by`, `last_edited_by` | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` |
| `files` | `is_empty`, `is_not_empty` |
| `url`, `email`, `phone_number` | `equals`, `does_not_equal`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` |
| `relation` | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` |
| `formula` | Depends on formula output type; one of: `string`, `number`, `checkbox`, `date` — nested as `formula: { string: { equals: "x" } }` |
| `rollup` | Depends on rollup type; nested as `rollup: { any: {...} }`, `rollup: { every: {...} }`, or `rollup: { none: {...} }` |

### Converting database rows to markdown

For knowledge indexing, render each database page as a structured markdown document:

```typescript
function databasePageToMarkdown(page: PageObjectResponse, dataSource: DataSourceObjectResponse): string {
  const lines: string[] = [];

  // Title
  const titleProp = Object.values(page.properties).find(p => p.type === "title");
  const title = titleProp?.type === "title"
    ? richTextToMarkdown(titleProp.title)
    : "Untitled";
  lines.push(`# ${title}\n`);

  // Metadata table
  lines.push("| Property | Value |");
  lines.push("|---|---|");

  for (const [name, value] of Object.entries(page.properties)) {
    if (value.type === "title") continue; // Already rendered as heading
    const rendered = renderPropertyValue(value);
    if (rendered) {
      lines.push(`| ${name} | ${rendered} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderPropertyValue(prop: PagePropertyValue): string {
  switch (prop.type) {
    case "rich_text":
      return richTextToMarkdown(prop.rich_text);
    case "number":
      return prop.number?.toString() ?? "";
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return prop.multi_select.map(s => s.name).join(", ");
    case "status":
      return prop.status?.name ?? "";
    case "date":
      if (!prop.date) return "";
      return prop.date.end
        ? `${prop.date.start} → ${prop.date.end}`
        : prop.date.start;
    case "checkbox":
      return prop.checkbox ? "Yes" : "No";
    case "url":
      return prop.url ? `[${prop.url}](${prop.url})` : "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "people":
      return prop.people.map(u => u.name ?? u.id).join(", ");
    case "files":
      return prop.files.map(f => {
        if (f.type === "external") return `[${f.name}](${f.external.url})`;
        if (f.type === "file") return `[${f.name}](${f.file.url})`;
        return f.name;
      }).join(", ");
    case "relation":
      return prop.relation.map(r => r.id).join(", ");
    case "formula":
      return renderFormulaValue(prop.formula);
    case "rollup":
      return renderRollupValue(prop.rollup);
    case "created_time":
    case "last_edited_time":
      return prop[prop.type] ?? "";
    case "created_by":
    case "last_edited_by":
      return prop[prop.type]?.name ?? prop[prop.type]?.id ?? "";
    case "unique_id":
      const uid = prop.unique_id;
      return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
    default:
      return "";
  }
}

function renderFormulaValue(formula: FormulaPropertyValue["formula"]): string {
  switch (formula.type) {
    case "string": return formula.string ?? "";
    case "number": return formula.number?.toString() ?? "";
    case "boolean": return formula.boolean ? "true" : "false";
    case "date": return formula.date?.start ?? "";
    default: return "";
  }
}
```

---

## 8. Page Metadata

**Source:** https://developers.notion.com/reference/page

### Page object fields

| Field | Type | Notes |
|---|---|---|
| `object` | `"page"` | |
| `id` | `string (UUIDv4)` | |
| `created_time` | `ISO 8601` | |
| `last_edited_time` | `ISO 8601` | Use for incremental sync |
| `created_by` | `Partial User` | |
| `last_edited_by` | `Partial User` | |
| `cover` | `File \| null` | Page cover image |
| `icon` | `Emoji \| Icon \| CustomEmoji \| File \| null` | Page icon |
| `parent` | `Parent object` | `{ type: "page_id" \| "database_id" \| "workspace" \| "data_source_id", ... }` |
| `properties` | `object` | Property values; for non-DB pages, only `title` property |
| `url` | `string` | Notion app URL |
| `public_url` | `string \| null` | Public web URL if published |
| `in_trash` | `boolean` | Whether trashed |
| `is_archived` | `boolean` | Deprecated alias for `in_trash` |
| `is_locked` | `boolean` | Whether locked |

### Extracting page title

```typescript
function getPageTitle(page: PageObjectResponse): string {
  // For database pages: title is a named property
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      return richTextToMarkdown(prop.title) || "Untitled";
    }
  }
  // For non-database pages
  return "Untitled";
}
```

### Rendering page icon

```typescript
function renderPageIcon(icon: PageObjectResponse["icon"]): string {
  if (!icon) return "";
  if (icon.type === "emoji") return icon.emoji;
  if (icon.type === "external") return `![icon](${icon.external.url})`;
  if (icon.type === "file") return `![icon](${icon.file.url})`;
  return "";
}
```

---

## 9. Files and Media

**Source:** https://developers.notion.com/reference/file-object

### File object types

```typescript
type FileObject =
  | { type: "file"; file: { url: string; expiry_time: string } }
  | { type: "file_upload"; file_upload: { id: string } }
  | { type: "external"; external: { url: string } };
```

### Critical constraint: 1-hour expiry

Files uploaded through the Notion UI (`type: "file"`) are hosted on Notion's S3 infrastructure. The `url` returned is a **pre-signed S3 URL valid for 1 hour**. After expiry, re-fetch the block/page to get a fresh URL.

**Implications for the knowledge index:**
- Do NOT store file URLs in the index — they expire
- Instead, store the block/page ID and re-fetch on demand
- Or proxy through a server-side endpoint that re-fetches on demand
- External files (`type: "external"`) do not expire — safe to store

### File handling strategy for markdown output

```typescript
function renderFileInMarkdown(file: FileObject, caption: RichText[], blockType: string): string {
  const captionText = richTextToMarkdown(caption);
  const captionSuffix = captionText ? `\n_${captionText}_` : "";

  switch (file.type) {
    case "external":
      if (blockType === "image") return `![${captionText}](${file.external.url})${captionSuffix}`;
      return `[File: ${captionText || file.external.url}](${file.external.url})`;

    case "file":
      // URL expires in 1 hour — mark as expiring in output
      if (blockType === "image") return `![${captionText}](${file.file.url})${captionSuffix}`;
      return `[Notion file — link expires](${file.file.url})${captionSuffix}`;

    case "file_upload":
      // Need to resolve the upload ID to a URL separately
      return `[File upload: ${file.file_upload.id}]`;

    default:
      return "";
  }
}
```

---

## 10. Incremental Sync

### Strategy

Notion does not provide a `last_edited_after` filter in the search API. Two viable strategies:

#### Strategy A: Poll + time-based filter in search sort (recommended for small–medium workspaces)

```typescript
async function incrementalSync(since: Date, indexPage: (id: string) => Promise<void>) {
  for await (const page of iteratePaginatedAPI(notion.search, {
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
  })) {
    const editedAt = new Date(page.last_edited_time);
    if (editedAt <= since) break; // Sorted descending; safe to stop
    await indexPage(page.id);
  }
}
```

#### Strategy B: Webhooks + invalidation (recommended for large workspaces)

See Section 11. Use webhooks to receive `page.content_updated` events, then re-index only the specific page.

### Handling deletions

There is no "deleted pages" feed. Options:
1. **Soft delete detection:** On full sync, compare the set of page IDs in your index against all pages returned by search. Pages in your index but not in search results have been deleted or unshared. Remove them.
2. **`in_trash` field:** When fetching a page, if `in_trash: true` and you have it indexed, remove it from the index.
3. **Webhook `page.deleted` event:** If using webhooks, subscribe to page deletion events.

### Last_edited_time granularity

Notion timestamps are at minute granularity in the API (`2022-03-01T19:05:00.000Z`). If multiple edits happen in the same minute, they may all share the same `last_edited_time`. For precise incremental sync, use a checkpoint timestamp with a small buffer (subtract 1 minute from the last sync time).

```typescript
const checkpoint = new Date(lastSyncTime.getTime() - 60_000); // 1-min buffer
```

---

## 11. Webhooks

**Source:** https://developers.notion.com/reference/webhooks

### Webhook setup

1. Create a subscription in the Developer portal (Webhooks tab)
2. Enter a public HTTPS endpoint URL
3. Subscribe to specific event types
4. Notion sends a `verification_token` to your endpoint
5. Paste the token back in the UI to activate

### Event types available

| Category | Events |
|---|---|
| Pages | `page.content_updated`, `page.created`, `page.deleted`, `page.locked`, `page.moved`, `page.property_updated`, `page.restored`, `page.trashed`, `page.unlocked`, `page.untrashed` |
| Databases | `database.created`, `database.deleted`, `database.property_updated`, `database.restored`, `database.trashed` |
| Data sources | `data_source.created`, `data_source.deleted`, etc. |
| Comments | `comment.created`, `comment.deleted` |
| File uploads | `file_upload.completed` |

### Webhook payload structure

```typescript
interface WebhookEvent {
  id: string;
  type: string;           // e.g., "page.content_updated"
  entity: {
    id: string;           // Page/database/etc. ID
    type: "page" | "database" | "data_source" | "comment";
  };
  workspace_id: string;
  timestamp: string;      // ISO 8601
  authors: Array<{ id: string; type: "person" | "bot" }>;
  subscription_id: string;
}
```

### Payload verification (TypeScript)

```typescript
import { verifyWebhookSignature } from "@notionhq/client"; // v5.23.0+

async function handleWebhook(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-notion-signature") ?? "";

  const isValid = await verifyWebhookSignature({
    body: rawBody,
    signature,
    verificationToken: process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN!,
  });

  if (!isValid) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event: WebhookEvent = JSON.parse(rawBody);
  await processWebhookEvent(event);
  return new Response("OK", { status: 200 });
}

async function processWebhookEvent(event: WebhookEvent) {
  switch (event.type) {
    case "page.content_updated":
    case "page.property_updated":
      await reIndexPage(event.entity.id);
      break;
    case "page.trashed":
    case "page.deleted":
      await removeFromIndex(event.entity.id);
      break;
    case "page.restored":
    case "page.untrashed":
      await reIndexPage(event.entity.id);
      break;
  }
}
```

### Important webhook caveat: aggregated events

Notion aggregates events over a short window (typically under a minute). A single page edit may result in one webhook event even if multiple fields changed. The payload tells you *what* changed (the event type) but not *which specific field*. Always re-fetch the full page when processing a content update event.

---

## 12. Rate Limits and Retry Strategy

**Source:** https://developers.notion.com/reference/request-limits

### Rate limit rules

| Limit | Value |
|---|---|
| Per-connection average | 3 requests/second |
| Burst allowed | Yes (short bursts above 3/s) |
| Per-workspace | Shared across all connections; scales with workspace plan |
| HTTP status on rate limit | 429 (rate_limited) or 529 (service_overload) |
| Response header | `Retry-After: <seconds>` |

### `additional_data.rate_limit_reason` values

- `public_api_request_rate_limit` — per-connection limit hit
- `public_api_space_request_rate_limit` — workspace-wide limit hit

### Size limits

| Parameter | Limit |
|---|---|
| `rich_text[].text.content` | 2000 characters |
| `rich_text[].text.link.url` | 2000 characters |
| `rich_text[].equation.expression` | 1000 characters |
| Any array (rich text, block children) | 100 elements |
| Any URL property | 2000 characters |
| Any email property | 200 characters |
| Any phone number | 200 characters |
| Multi-select options per property | 100 |
| Relation items per request | 100 (per-request cap, not total) |
| People per request | 100 |
| Request body total | 500KB, max 1000 block elements |
| Data source properties | 500 recommended max, 50KB schema |

### TypeScript retry wrapper

```typescript
async function notionRequest<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || error?.status === 529;
      const isServerError = [500, 502, 503, 504].includes(error?.status);

      if (!isRateLimit && !isServerError) throw error;
      if (attempt === maxAttempts - 1) throw error;

      const retryAfter = error?.headers?.["retry-after"];
      const baseDelay = retryAfter
        ? Number(retryAfter) * 1000
        : Math.min(2 ** attempt * 1000, 30_000);
      const jitter = Math.random() * 250;

      await new Promise(r => setTimeout(r, baseDelay + jitter));
    }
  }
  throw new Error("unreachable");
}
```

Note: The official `@notionhq/client` SDK already includes retry logic for 429 on all methods, and 500/503 on GET/DELETE. If using the SDK, you get this for free.

### Practical batching strategy for large indexing jobs

The 3 req/s average with burst means you can safely do:
- **Sequential scan:** 2 req/s continuous → well under limit
- **Concurrent with p-limit:** 2 concurrent requests, queue all requests through a single limiter
- **Avoid:** 10+ concurrent promises without a rate limiter — will hit 429 immediately

```typescript
import pLimit from "p-limit";
const limit = pLimit(2); // 2 concurrent max

// Wrap all notion API calls
const safeQuery = (params) => limit(() => notion.blocks.children.list(params));
```

---

## 13. Synced Blocks and Linked Databases

### Synced blocks

A synced block allows the same content to appear in multiple places. The API distinguishes:

| Type | `synced_from` value | Children |
|---|---|---|
| Original block | `null` | Has children (the actual content) |
| Duplicate block | `{ type: "block_id", block_id: "<original_id>" }` | No own children; content lives on original |

```typescript
async function fetchSyncedBlockContent(block: SyncedBlockObjectResponse): Promise<BlockWithChildren[]> {
  if (block.synced_block.synced_from === null) {
    // This IS the original — fetch children normally
    return fetchBlocksRecursive(block.id);
  } else {
    // This is a duplicate — fetch children from the original
    const originalId = block.synced_block.synced_from.block_id;
    return fetchBlocksRecursive(originalId);
  }
}
```

**Gotcha:** When indexing, if you encounter the same original synced block ID from multiple pages, deduplicate in your index rather than indexing the same content multiple times.

### Child databases (linked databases)

A `child_database` block references a database that is a child of the current page. The block's `id` is the database ID. To get rows from this database:

```typescript
async function processChildDatabase(block: ChildDatabaseBlockObjectResponse) {
  const databaseId = block.id;
  // Retrieve the database object
  const db = await notion.databases.retrieve({ database_id: databaseId });
  // Query all rows
  for await (const page of iteratePaginatedAPI(notion.databases.query, {
    database_id: databaseId,
  })) {
    await indexDatabasePage(page as PageObjectResponse, db);
  }
}
```

Note: As of 2025-09-03, use `notion.dataSources.query` instead of `notion.databases.query` for better multi-data-source support.

### Circular reference risk

Theoretically a workspace could contain circular `child_page` / `child_database` references. Protect against this:

```typescript
async function crawlPage(pageId: string, visited = new Set<string>()) {
  if (visited.has(pageId)) return; // Cycle detected
  visited.add(pageId);
  // ... process page
}
```

---

## 14. Complete TypeScript Connector Implementation

### Package dependencies

```json
{
  "dependencies": {
    "@notionhq/client": "^2.3.0",
    "p-limit": "^6.1.0"
  },
  "devDependencies": {
    "@notionhq/client": "^2.3.0"
  }
}
```

### Types

```typescript
// src/connectors/notion/types.ts

export interface NotionConnectorConfig {
  accessToken: string;
  notionVersion?: string;
  maxConcurrency?: number;
  maxDepth?: number;
}

export interface IndexedDocument {
  id: string;
  title: string;
  url: string;
  content: string;      // Full markdown content
  metadata: {
    source: "notion";
    pageId: string;
    lastEditedTime: string;
    createdTime: string;
    parentType: string;
    parentId: string;
    icon: string;
    inTrash: boolean;
  };
}
```

### Main connector class

```typescript
// src/connectors/notion/NotionConnector.ts

import { Client, iteratePaginatedAPI } from "@notionhq/client";
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import pLimit from "p-limit";
import type { NotionConnectorConfig, IndexedDocument } from "./types";

export class NotionConnector {
  private client: Client;
  private limit: ReturnType<typeof pLimit>;
  private maxDepth: number;
  private visitedIds = new Set<string>();

  constructor(config: NotionConnectorConfig) {
    this.client = new Client({
      auth: config.accessToken,
      notionVersion: config.notionVersion ?? "2026-03-11",
    });
    this.limit = pLimit(config.maxConcurrency ?? 2);
    this.maxDepth = config.maxDepth ?? 15;
  }

  // ------- Public API -------

  async *indexAll(): AsyncGenerator<IndexedDocument> {
    this.visitedIds.clear();

    // Enumerate all accessible pages
    for await (const result of iteratePaginatedAPI(this.client.search, {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    })) {
      const page = result as PageObjectResponse;
      if (page.in_trash) continue;

      try {
        const doc = await this.indexPage(page);
        if (doc) yield doc;
      } catch (err) {
        console.error(`Failed to index page ${page.id}:`, err);
      }
    }
  }

  async *indexChangedSince(since: Date): AsyncGenerator<IndexedDocument> {
    for await (const result of iteratePaginatedAPI(this.client.search, {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
    })) {
      const page = result as PageObjectResponse;
      const editedAt = new Date(page.last_edited_time);

      // Sorted descending — safe to break early
      if (editedAt <= since) break;

      if (page.in_trash) {
        yield { id: page.id } as any; // Signal deletion to caller
        continue;
      }

      try {
        const doc = await this.indexPage(page);
        if (doc) yield doc;
      } catch (err) {
        console.error(`Failed to index page ${page.id}:`, err);
      }
    }
  }

  async indexPageById(pageId: string): Promise<IndexedDocument | null> {
    const page = await this.client.pages.retrieve({ page_id: pageId }) as PageObjectResponse;
    return this.indexPage(page);
  }

  // ------- Private implementation -------

  private async indexPage(page: PageObjectResponse): Promise<IndexedDocument | null> {
    if (this.visitedIds.has(page.id)) return null;
    this.visitedIds.add(page.id);

    const title = this.getPageTitle(page);
    const blocks = await this.fetchBlocksRecursive(page.id, 0);
    const content = this.renderBlocks(blocks);

    return {
      id: page.id,
      title,
      url: page.url,
      content: `# ${title}\n\n${content}`,
      metadata: {
        source: "notion",
        pageId: page.id,
        lastEditedTime: page.last_edited_time,
        createdTime: page.created_time,
        parentType: page.parent.type,
        parentId: this.getParentId(page.parent),
        icon: this.getIconText(page.icon),
        inTrash: page.in_trash,
      },
    };
  }

  private async fetchBlocksRecursive(
    blockId: string,
    depth: number
  ): Promise<Array<{ block: BlockObjectResponse; children: any[] }>> {
    if (depth > this.maxDepth) return [];

    const blocks: BlockObjectResponse[] = [];
    for await (const block of iteratePaginatedAPI(
      this.client.blocks.children.list,
      { block_id: blockId }
    )) {
      blocks.push(block as BlockObjectResponse);
    }

    return Promise.all(
      blocks.map(block =>
        this.limit(async () => {
          if (!block.has_children) return { block, children: [] };

          // Synced block duplicate: fetch from original
          if (
            block.type === "synced_block" &&
            block.synced_block.synced_from !== null
          ) {
            const originalId = block.synced_block.synced_from.block_id;
            if (this.visitedIds.has(`synced:${originalId}`)) {
              return { block, children: [] };
            }
            this.visitedIds.add(`synced:${originalId}`);
            const children = await this.fetchBlocksRecursive(originalId, depth + 1);
            return { block, children };
          }

          const children = await this.fetchBlocksRecursive(block.id, depth + 1);
          return { block, children };
        })
      )
    );
  }

  private renderBlocks(
    blocks: Array<{ block: BlockObjectResponse; children: any[] }>
  ): string {
    return blocks.map(({ block, children }) => this.renderBlock(block, children)).join("\n\n");
  }

  private renderBlock(
    block: BlockObjectResponse,
    children: Array<{ block: BlockObjectResponse; children: any[] }>
  ): string {
    const childContent = children.length > 0
      ? "\n" + this.renderBlocks(children).split("\n").map(l => "    " + l).join("\n")
      : "";

    switch (block.type) {
      case "paragraph":
        return this.richText(block.paragraph.rich_text) + childContent;

      case "heading_1":
        return `# ${this.richText(block.heading_1.rich_text)}` + childContent;
      case "heading_2":
        return `## ${this.richText(block.heading_2.rich_text)}` + childContent;
      case "heading_3":
        return `### ${this.richText(block.heading_3.rich_text)}` + childContent;
      case "heading_4":
        return `#### ${this.richText(block.heading_4.rich_text)}` + childContent;

      case "bulleted_list_item":
        return `- ${this.richText(block.bulleted_list_item.rich_text)}` + childContent;

      case "numbered_list_item":
        return `1. ${this.richText(block.numbered_list_item.rich_text)}` + childContent;

      case "to_do": {
        const checked = block.to_do.checked ? "[x]" : "[ ]";
        return `- ${checked} ${this.richText(block.to_do.rich_text)}` + childContent;
      }

      case "toggle":
        return `<details><summary>${this.richText(block.toggle.rich_text)}</summary>\n\n${this.renderBlocks(children)}\n\n</details>`;

      case "callout": {
        const icon = block.callout.icon?.type === "emoji" ? block.callout.icon.emoji + " " : "";
        const text = this.richText(block.callout.rich_text);
        return `> ${icon}${text}` + (childContent ? "\n>" + childContent.split("\n").join("\n>") : "");
      }

      case "quote":
        return `> ${this.richText(block.quote.rich_text)}` + childContent;

      case "code": {
        const lang = block.code.language === "plain text" ? "" : block.code.language;
        const code = block.code.rich_text.map(rt => rt.plain_text).join("");
        const caption = this.richText(block.code.caption);
        return `\`\`\`${lang}\n${code}\n\`\`\`` + (caption ? `\n_${caption}_` : "");
      }

      case "equation":
        return `$$\n${block.equation.expression}\n$$`;

      case "divider":
        return "---";

      case "image": {
        const img = block.image;
        const caption = this.richText(img.caption);
        const url = img.type === "external" ? img.external.url
          : img.type === "file" ? img.file.url
          : null;
        if (!url) return caption ? `_(image: ${caption})_` : "_(image)_";
        return `![${caption}](${url})`;
      }

      case "video": {
        const vid = block.video;
        const url = vid.type === "external" ? vid.external.url
          : vid.type === "file" ? vid.file.url : null;
        const caption = this.richText(vid.caption);
        if (!url) return caption ? `_(video: ${caption})_` : "_(video)_";
        return `[Video: ${caption || url}](${url})`;
      }

      case "file": {
        const f = block.file;
        const caption = this.richText(f.caption);
        const url = f.type === "external" ? f.external.url
          : f.type === "file" ? f.file.url : null;
        return url ? `[${caption || "File"}](${url})` : `_(file: ${caption})_`;
      }

      case "pdf": {
        const pdf = block.pdf;
        const caption = this.richText(pdf.caption);
        const url = pdf.type === "external" ? pdf.external.url
          : pdf.type === "file" ? pdf.file.url : null;
        return url ? `[PDF: ${caption || "document"}](${url})` : `_(pdf: ${caption})_`;
      }

      case "audio": {
        const audio = block.audio;
        const url = audio.type === "external" ? audio.external.url
          : audio.type === "file" ? audio.file.url : null;
        return url ? `[Audio](${url})` : "_(audio)_";
      }

      case "embed":
        return `[Embedded content](${block.embed.url})`;

      case "bookmark": {
        const caption = this.richText(block.bookmark.caption);
        return `[${caption || block.bookmark.url}](${block.bookmark.url})`;
      }

      case "link_preview":
        return `[${block.link_preview.url}](${block.link_preview.url})`;

      case "table": {
        // Children are table_row blocks
        if (children.length === 0) return "_(empty table)_";
        return this.renderTable(children, block.table.has_column_header);
      }

      case "table_row":
        // Handled by the parent table renderer
        return "";

      case "column_list":
        // Children are column blocks
        return children.map(col => this.renderBlocks(col.children ?? [])).join("\n\n");

      case "column":
        // Content is in children
        return this.renderBlocks(children);

      case "child_page":
        return `[${block.child_page.title}](https://notion.so/${block.id.replace(/-/g, "")})`;

      case "child_database":
        return `[Database: ${block.child_database.title}](https://notion.so/${block.id.replace(/-/g, "")})`;

      case "synced_block":
        return this.renderBlocks(children);

      case "table_of_contents":
        return ""; // Omit — TOC auto-generates from headings

      case "breadcrumb":
        return ""; // Omit navigation element

      case "template":
        return this.renderBlocks(children);

      case "unsupported":
        return `_(unsupported block: ${(block as any).unsupported?.block_type ?? "unknown"})_`;

      default:
        return "";
    }
  }

  private renderTable(
    rows: Array<{ block: BlockObjectResponse; children: any[] }>,
    hasHeader: boolean
  ): string {
    const tableRows = rows
      .filter(r => r.block.type === "table_row")
      .map(r => (r.block as any).table_row.cells as RichTextItemResponse[][]);

    if (tableRows.length === 0) return "_(empty table)_";

    const formatRow = (cells: RichTextItemResponse[][]) =>
      "| " + cells.map(cell => this.richText(cell)).join(" | ") + " |";

    const lines: string[] = [];
    if (hasHeader && tableRows.length > 0) {
      lines.push(formatRow(tableRows[0]));
      lines.push("|" + tableRows[0].map(() => "---|").join(""));
      for (let i = 1; i < tableRows.length; i++) {
        lines.push(formatRow(tableRows[i]));
      }
    } else {
      for (const row of tableRows) {
        lines.push(formatRow(row));
      }
    }

    return lines.join("\n");
  }

  // ------- Rich text helpers -------

  private richText(items: RichTextItemResponse[]): string {
    return items.map(rt => this.convertRichTextItem(rt)).join("");
  }

  private convertRichTextItem(rt: RichTextItemResponse): string {
    if (rt.type === "equation") {
      return `$${rt.equation.expression}$`;
    }

    if (rt.type === "mention") {
      return this.convertMention(rt);
    }

    let text = rt.plain_text;

    if (rt.annotations.code) {
      text = `\`${text}\``;
      return rt.href ? `[\`${rt.plain_text}\`](${rt.href})` : text;
    }

    if (rt.annotations.bold && rt.annotations.italic) text = `***${text}***`;
    else if (rt.annotations.bold) text = `**${text}**`;
    else if (rt.annotations.italic) text = `*${text}*`;
    if (rt.annotations.strikethrough) text = `~~${text}~~`;

    const url = (rt.type === "text" && rt.text.link?.url) ?? rt.href;
    if (url) text = `[${text}](${url})`;

    return text;
  }

  private convertMention(rt: RichTextItemResponse): string {
    if (rt.type !== "mention") return rt.plain_text;
    const m = rt.mention;

    switch (m.type) {
      case "page":
      case "database":
        return rt.href ? `[${rt.plain_text}](${rt.href})` : rt.plain_text;
      case "user":
        return rt.plain_text; // "@Name"
      case "date":
        return m.date.end ? `${m.date.start} → ${m.date.end}` : m.date.start;
      case "link_preview":
        return `[${m.link_preview.url}](${m.link_preview.url})`;
      default:
        return rt.plain_text;
    }
  }

  // ------- Utility helpers -------

  private getPageTitle(page: PageObjectResponse): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title" && prop.title.length > 0) {
        return prop.title.map(rt => rt.plain_text).join("");
      }
    }
    return "Untitled";
  }

  private getParentId(parent: PageObjectResponse["parent"]): string {
    if (parent.type === "page_id") return parent.page_id;
    if (parent.type === "database_id") return parent.database_id;
    if (parent.type === "data_source_id") return parent.data_source_id;
    return "workspace";
  }

  private getIconText(icon: PageObjectResponse["icon"]): string {
    if (!icon) return "";
    if (icon.type === "emoji") return icon.emoji;
    if (icon.type === "external") return icon.external.url;
    if (icon.type === "file") return icon.file.url;
    return "";
  }
}
```

### MCP tool integration

```typescript
// src/tools/notionSearch.ts

import { NotionConnector } from "../connectors/notion/NotionConnector";

const connector = new NotionConnector({
  accessToken: process.env.NOTION_ACCESS_TOKEN!,
});

export const notionSearchTool = {
  name: "notion_search",
  description: "Search Notion workspace pages by title and retrieve their content as markdown",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Title search query" },
      page_size: { type: "number", description: "Number of results (max 100)", default: 10 },
    },
    required: ["query"],
  },
  async execute({ query, page_size = 10 }: { query: string; page_size?: number }) {
    const notion = connector["client"]; // Access internal client
    const results = await notion.search({
      query,
      filter: { property: "object", value: "page" },
      page_size,
    });

    const pages = results.results as PageObjectResponse[];
    const documents = await Promise.all(
      pages.filter(p => !p.in_trash).map(p => connector.indexPageById(p.id))
    );

    return documents.filter(Boolean).map(doc => ({
      id: doc!.id,
      title: doc!.title,
      url: doc!.url,
      content: doc!.content,
    }));
  },
};
```

---

## 15. Limitations, Edge Cases, and Gotchas

### API limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Search is title-only | Cannot full-text search content via API | Index content locally; use vector search on indexed markdown |
| No `last_edited_after` filter | Incremental sync requires scanning all results | Sort descending + early-exit heuristic; use webhooks for real-time |
| File URLs expire in 1 hour | Cannot cache file URLs long-term | Re-fetch on demand; don't store URLs in index |
| 3 req/s per-connection rate limit | Slow for large workspaces | Use concurrency limiter (p-limit); budget 10–50 req/page |
| Max 100 results per page | Pagination required for all lists | Use `iteratePaginatedAPI` from SDK |
| `request_status: incomplete` on search | May miss pages even with pagination | Log and alert; consider alternative enumeration strategies |
| 2025-09-03 model change | Older connection versions use different APIs | Target current version; no need for backward compat |
| Page picker for new page grants | Cannot auto-grant access to new pages | Users must manually share new pages with the connection |
| No workspace-wide read | Each page must be explicitly shared | Document this clearly in setup guide |

### Content rendering gotchas

1. **Numbered list continuity**: The API returns each `numbered_list_item` individually. Adjacent numbered list items don't share state, so you must detect runs of consecutive numbered items and maintain your own counter for correct numbering.

   ```typescript
   function renderBlocksWithListContext(blocks: Block[]): string {
     const lines: string[] = [];
     let numberedCount = 0;
     for (const block of blocks) {
       if (block.type === "numbered_list_item") {
         numberedCount++;
         lines.push(`${numberedCount}. ${richText(block.numbered_list_item.rich_text)}`);
       } else {
         numberedCount = 0;
         lines.push(renderBlock(block));
       }
     }
     return lines.join("\n");
   }
   ```

2. **Toggle headings**: `heading_1/2/3/4` with `is_toggleable: true` have children fetched via the block children endpoint. Plain headings (is_toggleable: false) do NOT have children even if has_children appears true in some edge cases.

3. **Empty rich_text**: Blocks can have `rich_text: []`. Always handle empty arrays — `plain_text` is not always available at the block level.

4. **Column ordering**: Columns in a `column_list` appear in order in the children array. Preserve this order when rendering sequentially.

5. **Table header detection**: Use `has_column_header` and `has_row_header` on the table block to generate proper markdown table headers.

6. **Child databases in search results**: The `search` endpoint with `filter.value = "database"` returns database-level objects, not data sources. Use the data source API separately to enumerate rows.

7. **Unsupported blocks**: As of 2026, Notion blocks like "Button", "Form", and custom AI blocks return as `type: "unsupported"` with a `block_type` field. These cannot be rendered but should be noted.

8. **Transcription / meeting notes**: Block type `"transcription"` contains rich text content from AI meeting notes. Can be rendered as a blockquote or special callout.

### Performance gotchas

1. **Deep nesting multiplies API calls**: A page with 50 toggle blocks each containing 20 items requires 51+ API calls (1 top-level + 50 child fetches). Budget accordingly.

2. **Column lists double the cost**: Each `column_list` requires 1 call (get columns) + N calls (one per column). A page with 3 two-column layouts needs 6+ extra calls.

3. **Table rows are a single call**: Unlike blocks, a table's row children are all returned in one `GET /blocks/{table_id}/children` call. Tables are efficient.

4. **Large databases**: A database with 10,000 rows requires 100 paginated calls at page_size=100. At 2 req/s, that's 50 seconds just for the row enumeration.

5. **Workspace-wide enumeration cold start**: First full index of a large Notion workspace can take hours. Design for incremental operation from day 2 onward.

### Access and security gotchas

1. **`object_not_found` vs `restricted_resource`**: If you get 404 with `object_not_found`, the page doesn't exist OR you don't have access. If you get 403 with `restricted_resource`, your connection lacks a required capability.

2. **Trashed pages in search**: By default, search excludes trashed pages. Set `filter.in_trash = true` only if you specifically want to index deleted content.

3. **Public URL vs app URL**: `url` always returns the `https://app.notion.com` URL. `public_url` returns the published web URL (e.g., `https://workspace.notion.site/...`) or `null`. Use `url` for internal links, `public_url` for shareable external links.

4. **Notion version header required**: Always include `Notion-Version` header. Without it, you may get responses from an older API version with different field names.

---

## 16. Feature Build Plan

### Phase 2 MVP (recommended scope)

| Feature | Priority | Complexity | Notes |
|---|---|---|---|
| Internal connection auth + token config | P0 | Low | Single env var |
| Enumerate accessible pages via search | P0 | Low | SDK `iteratePaginatedAPI` |
| Fetch page blocks recursively | P0 | Medium | Implement depth limit |
| Rich text to markdown converter | P0 | Medium | Cover all annotation types and mention types |
| All block types to markdown | P0 | High | ~30 block types to handle |
| Database row enumeration | P1 | Medium | Use data source query API |
| Property value to markdown | P1 | Medium | ~20 property types |
| File URL handling (link only, no download) | P1 | Low | Note expiry caveat |
| Incremental sync (poll + sort trick) | P1 | Low | Sort descending, break on old items |
| Rate limit handling | P1 | Low | SDK handles this automatically |
| Webhook receiver for real-time invalidation | P2 | Medium | Express/Fastify endpoint |
| Synced block deduplication | P2 | Low | Track visited original IDs |
| Numbered list counter tracking | P2 | Low | Context-aware renderer |

### Features to skip

| Feature | Reason |
|---|---|
| OAuth public connection flow | Internal connection sufficient for enterprise; add later if multi-tenant needed |
| File upload / re-hosting | Out of scope for read-only knowledge index |
| Formula/rollup rendering | Serializing the raw value (which the API returns) is sufficient |
| Views API | Display-layer concept; not needed for content extraction |
| Comments indexing | Low knowledge value for most use cases; add as opt-in |
| Meeting notes / transcription | Niche; handle as generic rich text block |
| Admin API | Separate admin plane; not needed for content indexing |

### Comparison to SharePoint and Confluence connectors

| Dimension | Notion | SharePoint | Confluence |
|---|---|---|---|
| Access model | Page-level sharing; user grants per-page | Entra ID groups + site permissions | Space/page permissions |
| Auth mechanism | Static token (internal) or OAuth | Entra ID OAuth + Microsoft Graph | OAuth or API token |
| Content model | Block-based JSON tree | Files + metadata + list items | Pages + macros + attachments |
| Full-text search | Title-only via API | Microsoft Search (deep) | CQL (deep) |
| Incremental sync | Sort + early exit; webhooks | Delta link (Graph API) | Last modified filter in CQL |
| Rate limits | 3 req/s per connection | 1000–10000 req/10min | ~150 req/min (Cloud) |
| Schema complexity | Medium (block tree) | High (Graph API verbosity) | Medium (Confluence API) |
| Enterprise readiness | Good for tech teams | Standard for legacy enterprise | Standard for dev teams |

Notion's rate limit (3 req/s) is the most restrictive of the three. Optimize for fewer API calls, not raw throughput.

---

*Research complete. All information sourced from https://developers.notion.com — fetched 2026-08-26.*
