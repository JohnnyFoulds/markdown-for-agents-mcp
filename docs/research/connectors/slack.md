# Slack Connector: Enterprise Knowledge Indexing Research

**Status:** Research complete — ready for implementation planning  
**Date:** 2026-08-26  
**Scope:** Slack API for conversation indexing, file retrieval, Enterprise Grid, ACL enforcement, and real-time event handling

---

## Table of Contents

1. [Decision Summary](#decision-summary)
2. [Token Types and Authentication](#token-types-and-authentication)
3. [search.messages — Legacy Search API](#searchmessages--legacy-search-api)
4. [assistant.search.context — Real-Time Search API (Recommended)](#assistantsearchcontext--real-time-search-api-recommended)
5. [conversations.history — Full History Crawl](#conversationshistory--full-history-crawl)
6. [conversations.replies — Thread Handling](#conversationsreplies--thread-handling)
7. [conversations.list — Channel Discovery](#conversationslist--channel-discovery)
8. [File Attachments and Content Download](#file-attachments-and-content-download)
9. [User and Profile Resolution](#user-and-profile-resolution)
10. [Enterprise Grid](#enterprise-grid)
11. [Event Subscriptions — Real-Time Indexing](#event-subscriptions--real-time-indexing)
12. [Rate Limits](#rate-limits)
13. [Permission Model and ACL Enforcement](#permission-model-and-acl-enforcement)
14. [Compliance Export API and Discovery API](#compliance-export-api-and-discovery-api)
15. [Audit Logs API](#audit-logs-api)
16. [Complete TypeScript Connector Implementation](#complete-typescript-connector-implementation)
17. [What to Build vs. What to Skip](#what-to-build-vs-what-to-skip)

---

## Decision Summary

**The single most important decision for this connector:** Use `assistant.search.context` (Real-Time Search API, GA February 2026), not `search.messages` (legacy, deprecated direction) or bulk `conversations.history` crawling (rate-limited and policy-restricted for non-Marketplace apps as of May 2026).

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| `assistant.search.context` | Permission-aware, no data storage required, semantic search, real-time | Requires AI-features app type, max 20 results/page | **Build this** |
| `search.messages` | Simple, user-scoped | User token only, legacy/deprecated direction, 100 result max | **Skip for new builds** |
| `conversations.history` bulk crawl | Complete historical coverage | Rate-limited to 1 req/min (15 msgs) for non-Marketplace apps since May 2026, must store data | **Internal apps only** |
| Discovery API | Complete org-level coverage including DMs | Requires Slack approval, Enterprise Grid only, DLP/eDiscovery use case only | **Not for knowledge indexing** |

**Architecture recommendation:** Real-Time Search as the primary query path. If the customer is an internal deployment (not Marketplace-distributed), layer in incremental `conversations.history` crawling with event subscription delta updates.

---

## Token Types and Authentication

Sources: [docs.slack.dev/authentication/tokens](https://docs.slack.dev/authentication/tokens/), [docs.slack.dev/reference/scopes](https://docs.slack.dev/reference/scopes/)

### Token Type Comparison

| Token Type | Prefix | Obtains Via | Sees as | Key Limitation |
|---|---|---|---|---|
| Bot token | `xoxb-` | OAuth app install | Bot user identity | Only sees channels bot is invited to (private channels) |
| User token | `xoxp-` | OAuth user auth | Acting user's identity | Tied to one human user; results respect that user's search filters |
| App-level token | `xapp-` | Socket Mode | Socket connection | Not for API calls — only for Socket Mode WS connection |
| Org-level token | `xoxb-` (org-wide) | Enterprise org install | Org-wide bot identity | Requires `org_deploy_enabled: true` in app manifest |

### Scopes Required for Knowledge Indexing

**Minimum viable bot token scopes (public channels only):**

```
channels:history      — read messages from public channels
channels:read         — list public channels
files:read            — read file metadata and download URLs
users:read            — resolve user IDs to display names
users:read.email      — access email addresses (required separately since 2017)
```

**Extended scopes for private channels (bot must be invited):**

```
groups:history        — read messages from private channels
groups:read           — list private channels
```

**Scopes for DMs and group DMs:**

```
im:history            — read direct messages (bot must be participant)
im:read               — list DMs
mpim:history          — read multi-party DMs
mpim:read             — list MPIMs
```

**Scopes for Real-Time Search API (`assistant.search.context`):**

Bot token scopes:
```
search:read.files     — search files
search:read.public    — search public channel messages
search:read.users     — search users
```

User token scopes (also needed for private channel and DM search via RTS):
```
search:read.im        — search DMs
search:read.mpim      — search MPIMs
search:read.private   — search private channels
search:read.public    — search public channels
search:read.users     — search users
search:read.files     — search files
```

**Critical gotcha:** `search.messages` (legacy) only works with a **user token** — bot tokens are rejected with `not_allowed_token_type`. The new `assistant.search.context` accepts both bot and user tokens but requires different scope sets.

### Choosing Between Bot and User Tokens

For a self-hosted enterprise knowledge index:

- **Bot token** = correct for public channel indexing and file metadata. The bot is a service account; results are consistent and not user-specific.
- **User token** = required for private channel access (user must be a member), DM access, and legacy `search.messages`. This is per-user; each person authorising gives their own view.
- **Hybrid (recommended for full coverage):** Bot token for public crawling + per-user `assistant.search.context` calls so search results respect the caller's access. This mirrors how SharePoint/Confluence connectors enforce ACLs via on-behalf-of tokens.

---

## search.messages — Legacy Search API

Source: [api.slack.com/methods/search.messages](https://api.slack.com/methods/search.messages)

**Status as of 2026: Legacy. Slack's own documentation says "We recommend using the Real-time Search API (assistant.search.context method) instead."**

### Facts

- **Endpoint:** `GET https://slack.com/api/search.messages`
- **Rate limit:** Tier 2 (20+ per minute)
- **Required scopes:** User token with `search:read` only
- **Bot tokens:** Rejected — `not_allowed_token_type`

### Parameters

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `token` | string | Yes | — | User token only |
| `query` | string | Yes | — | Full text search query with operators |
| `count` | integer | No | 20 | Max 100 results per page |
| `highlight` | boolean | No | false | Wrap matches in U+E000/U+E001 markers |
| `page` | integer | No | 1 | Max page 100 |
| `cursor` | string | No | — | Use `*` for first call with cursormark pagination |
| `sort` | string | No | `score` | `score` or `timestamp` |
| `sort_dir` | string | No | `desc` | `asc` or `desc` |
| `team_id` | string | No | — | Required when using org-level token; ignored for workspace token |

### Query Operator Syntax

```
# Channel filter
in:#channel-name
in:<#CHANNEL_ID>

# User filter  
from:<@USER_ID>
from:botname

# Date filters
before:2024-12-31
after:2024-01-01
on:2024-06-15

# Content filters
has:link
has:pin
has:reaction
has:file
has:star

# Thread filters
threads:all        # messages in any thread
threads:replies    # only replies, not root messages

# File type (in search.all context)
type:pdf
```

### Response Schema

```typescript
interface SearchMessagesResponse {
  ok: boolean;
  query: string;
  messages: {
    total: number;
    pagination: {
      total_count: number;
      page: number;
      per_page: number;
      page_count: number;
      first: number;
      last: number;
    };
    paging: {
      count: number;
      total: number;
      page: number;
      pages: number;
    };
    matches: SearchMessage[];
  };
}

interface SearchMessage {
  type: string;           // "message"
  ts: string;             // "1508284197.000015" — unique message ID
  text: string;           // message body (mrkdwn format)
  user: string;           // user ID e.g. "U2U85N1RV"
  username: string;       // display name at time of message
  iid: string;            // internal message ID for dedup
  permalink: string;      // permanent link to the message
  team: string;           // workspace ID e.g. "T12345678"
  channel: {
    id: string;           // "C12345678"
    name: string;         // "general"
    is_private: boolean;
    is_shared: boolean;
    is_org_shared: boolean;
    is_ext_shared: boolean;
    is_mpim: boolean;
    pending_shared: string[];
    is_pending_ext_shared: boolean;
  };
  // Deprecated and removed Dec 3, 2020:
  // previous, previous_2, next, next_2
}
```

### Limitations

1. **User token only.** Cannot use a service account bot; results are filtered by the installing user's workspace access.
2. **Maximum 100 results per page, 100 pages.** Hard ceiling of 10,000 results per query.
3. **Search index lag.** New messages may not appear immediately in search results.
4. **No cross-workspace search** with workspace token; requires org-level token + `team_id`.
5. **User's UI filters apply.** If the user has search filters set in the Slack UI, those affect API results too.
6. **Deprecated direction.** Slack is actively steering developers away; use `assistant.search.context`.

---

## assistant.search.context — Real-Time Search API (Recommended)

Sources: [docs.slack.dev/reference/methods/assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context), [slack.dev/secure-data-connectivity-for-the-modern-ai-era](https://slack.dev/secure-data-connectivity-for-the-modern-ai-era/), [docs.slack.dev/changelog/2026/02/17/slack-mcp](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/)

**GA since February 2026. This is the correct API for AI-powered knowledge indexing.**

### Facts

- **Endpoint:** `POST https://slack.com/api/assistant.search.context`
- **Rate limit:** Special (not Tier 1-4; consult method docs)
- **Bot token scopes:** `search:read.files`, `search:read.public`, `search:read.users`
- **User token scopes:** `search:read.files`, `search:read.im`, `search:read.mpim`, `search:read.private`, `search:read.public`, `search:read.users`
- **Action token required** for bot token calls (pass `action_token` from message event)

### Key Design Principle

The RTS API is designed for **real-time, permission-aware search at query time** — not bulk data export. The user running the search only sees results they are authorised to see. This is the correct model for a knowledge index that respects Slack's access controls without maintaining a separate permission table.

### Parameters

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `token` | string | Yes | — | Bot or user token |
| `query` | string | Yes | — | Natural language or keyword query |
| `action_token` | string | Bot calls only | — | From the message event; not needed for user token calls |
| `channel_types` | array | No | `["public_channel"]` | Any of: `public_channel`, `private_channel`, `mpim`, `im` |
| `content_types` | array | No | `["messages"]` | Any of: `messages`, `files`, `channels`, `users` |
| `include_bots` | boolean | No | — | Include bot messages |
| `include_deleted_users` | boolean | No | false | Include results from deleted users |
| `before` | integer | No | — | Unix timestamp upper bound |
| `after` | integer | No | — | Unix timestamp lower bound |
| `include_context_messages` | boolean | No | false | Return surrounding messages |
| `context_channel_id` | string | No | — | Scope search to a specific channel context |
| `cursor` | string | No | — | Pagination cursor; `""` for first page |
| `limit` | integer | No | 20 | Max 20 per page |
| `sort` | string | No | `score` | `score` or `timestamp` |
| `sort_dir` | string | No | `desc` | `asc` or `desc` |
| `include_message_blocks` | boolean | No | — | Include Block Kit block payload |
| `highlight` | boolean | No | false | Highlight matched terms |
| `term_clauses` | array | No | — | Conjunctive query terms (AND logic between clauses) |
| `modifiers` | string | No | — | Modifier string e.g. `"has:pin before:yesterday"` |
| `include_archived_channels` | boolean | No | — | Include archived channel results |
| `disable_semantic_search` | boolean | No | false | Force keyword-only search |

### Query Operators (same syntax as search.messages)

```
in:#channel-name        — restrict to channel
from:<@USER_ID>         — from specific user
before:2025-12-31       — date filter (YYYY-MM-DD format required)
after:2025-01-01        — date filter
has:pin                 — pinned messages only
has:reaction            — messages with emoji reactions
has:file                — messages with file attachments
threads:all             — all threaded messages
threads:replies         — only thread replies
type:pdf                — file type filter
```

**Important format note:** When filtering by channel or user in the `query` string, enclose IDs in angle brackets: `in:<#C12345678>`, `from:<@U12345678>`.

### Advanced: term_clauses for Conjunctive Search

```typescript
// Find messages containing ("banana" OR "date") AND "milkshake" AND "recipe"
const body = {
  query: "recipes",
  term_clauses: [
    ["banana", "date"],   // OR within clause
    ["milkshake"],         // AND between clauses
    ["recipe"]
  ],
  channel_types: ["public_channel", "private_channel"],
  content_types: ["messages"]
};
```

### Response Schema

```typescript
interface RTSResponse {
  ok: boolean;
  next_cursor: string;       // empty string when no more pages
  messages?: RTSMessage[];
  files?: RTSFile[];
  channels?: RTSChannel[];
  users?: RTSUser[];
}

interface RTSMessage {
  ts: string;                     // message timestamp (unique ID)
  text: string;                   // message body
  user: string;                   // user ID
  channel_id: string;             // channel ID
  channel_name: string;           // channel display name
  team_id: string;                // workspace ID
  permalink: string;              // permanent link
  is_author_bot: boolean;         // distinguish bot from human messages
  thread_ts?: string;             // parent ts if in a thread
  context_messages?: {            // surrounding messages (if requested)
    before: RTSMessage[];
    after: RTSMessage[];
  };
  blocks?: object[];              // Block Kit payload (if requested)
  score?: number;                 // relevance score
}
```

### Implementation Pattern for MCP Tool

```typescript
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function searchSlackMessages(
  query: string,
  options: {
    channelTypes?: ('public_channel' | 'private_channel' | 'mpim' | 'im')[];
    before?: Date;
    after?: Date;
    limit?: number;
    actionToken?: string;
  } = {}
): Promise<RTSMessage[]> {
  const results: RTSMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await slack.assistant.search.context({
      query,
      channel_types: options.channelTypes ?? ['public_channel'],
      content_types: ['messages'],
      before: options.before ? Math.floor(options.before.getTime() / 1000) : undefined,
      after: options.after ? Math.floor(options.after.getTime() / 1000) : undefined,
      limit: options.limit ?? 20,
      action_token: options.actionToken,
      cursor: cursor ?? '',
      include_context_messages: true,
      sort: 'timestamp',
      sort_dir: 'desc',
    });

    if (!response.ok) throw new Error(`Slack RTS error: ${response.error}`);

    const messages = (response as any).messages ?? [];
    results.push(...messages);

    cursor = (response as any).next_cursor || undefined;

    // RTS is paginated — max 20/page, stop when cursor is empty
  } while (cursor && results.length < (options.limit ?? 100));

  return results;
}
```

---

## conversations.history — Full History Crawl

Source: [api.slack.com/methods/conversations.history](https://api.slack.com/methods/conversations.history)

### Facts

- **Endpoint:** `GET https://slack.com/api/conversations.history`
- **Rate limit:** Tier 3 (50+ req/min) for Marketplace and internal apps
- **CRITICAL:** Non-Marketplace apps created after May 29, 2025 = **1 req/min, max 15 messages per request**
- **Scopes:** Bot or user token with `channels:history`, `groups:history`, `im:history`, `mpim:history`

### Parameters

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `token` | string | Yes | — | Bot or user token |
| `channel` | string | Yes | — | Channel ID (C..., G..., D...) |
| `cursor` | string | No | — | Cursor-based pagination |
| `include_all_metadata` | boolean | No | false | Return all message metadata |
| `inclusive` | boolean | No | false | Include messages at exact oldest/latest timestamps |
| `latest` | string | No | now | Only messages before this Unix timestamp |
| `oldest` | string | No | 0 | Only messages after this Unix timestamp |
| `limit` | integer | No | 100 | Max 999 (Marketplace); max 15 (non-Marketplace post May 2025) |

### Response Schema

```typescript
interface ConversationsHistoryResponse {
  ok: boolean;
  messages: Message[];
  has_more: boolean;
  pin_count: number;
  response_metadata: {
    next_cursor: string;
  };
}

interface Message {
  type: 'message';
  user?: string;          // user ID; absent for bot messages
  bot_id?: string;        // present for bot messages
  text: string;           // mrkdwn-formatted text
  ts: string;             // Unix timestamp with microsecond precision (message ID)
  thread_ts?: string;     // if set, this message is part of a thread
  reply_count?: number;   // number of replies (root message only)
  reply_users?: string[]; // user IDs who replied
  reactions?: Reaction[];
  attachments?: Attachment[];
  files?: FileRef[];
  blocks?: Block[];
  subtype?: MessageSubtype;
  is_starred?: boolean;
  is_limited?: boolean;   // free plan message limit hit
}

type MessageSubtype =
  | 'bot_message'
  | 'channel_join'
  | 'channel_leave'
  | 'channel_name'
  | 'channel_archive'
  | 'channel_unarchive'
  | 'me_message'
  | 'message_changed'
  | 'message_deleted'
  | 'pinned_item'
  | 'unpinned_item';
```

### Pagination Strategy

```typescript
async function* fetchChannelHistory(
  slack: WebClient,
  channelId: string,
  options: { oldest?: string; latest?: string } = {}
): AsyncGenerator<Message[]> {
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.history({
      channel: channelId,
      cursor,
      limit: 200,  // Safe for Tier 3; use 15 if non-Marketplace
      oldest: options.oldest,
      latest: options.latest,
      inclusive: false,
    });

    if (!response.ok) {
      if (response.error === 'ratelimited') {
        // Retry-After header tells you how long to wait
        throw new SlackRateLimitError(response.headers?.['retry-after']);
      }
      throw new Error(`conversations.history failed: ${response.error}`);
    }

    yield response.messages as Message[];

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
}
```

### Thread Handling Critical Detail

`conversations.history` returns **only top-level messages**. Thread replies are not included unless you call `conversations.replies` separately for each message where `reply_count > 0`. This is a major indexing overhead:

```typescript
async function indexChannelWithThreads(
  slack: WebClient,
  channelId: string
): Promise<IndexDocument[]> {
  const docs: IndexDocument[] = [];

  for await (const batch of fetchChannelHistory(slack, channelId)) {
    for (const msg of batch) {
      // Skip non-user messages for knowledge indexing
      if (msg.subtype && !['bot_message'].includes(msg.subtype)) continue;

      docs.push(toIndexDoc(channelId, msg));

      // Fetch thread replies separately
      if (msg.reply_count && msg.reply_count > 0) {
        const thread = await fetchThread(slack, channelId, msg.ts);
        docs.push(...thread.map(r => toIndexDoc(channelId, r)));
      }
    }
  }

  return docs;
}
```

### Message Deduplication

Messages are uniquely identified by the combination of `channel_id + ts`. The `ts` field is a Unix timestamp with sub-second precision encoded as a string (e.g. `"1512085950.000216"`). It serves as the message ID. Use it as your document ID in the index.

### Handling Edits and Deletions

Edited messages arrive as new events with `subtype: "message_changed"` wrapping the updated message. Deleted messages arrive as `subtype: "message_deleted"` with the original `ts`. In a full-crawl scenario you need to handle these subtypes during incremental re-indexing.

---

## conversations.replies — Thread Handling

Source: [api.slack.com/methods/conversations.replies](https://api.slack.com/methods/conversations.replies)

### Facts

- **Endpoint:** `GET https://slack.com/api/conversations.replies`
- **Rate limit:** Tier 3 (50+ req/min) for Marketplace and internal apps; same 1 req/min restriction for non-Marketplace post May 2025
- **Scopes:** Same `*:history` scopes as `conversations.history`
- **Required params:** `channel` (channel ID) + `ts` (parent message timestamp)

### Key Behaviours

1. The **first message returned is always the root/parent message**, then replies follow. The root message has `reply_count` and `reply_users` fields.
2. If `ts` points to a message with zero replies, only that single message is returned — no error.
3. `reply_users` may contain **bot IDs** instead of user IDs for some bot-posted messages. Check the prefix (`B` = bot, `U`/`W` = user) before calling `users.info`.
4. `channel_leave` and `channel_join` subtypes **cannot be threaded** — `thread_not_found` will be returned if you attempt to fetch their replies.

### Response Schema

```typescript
interface ConversationsRepliesResponse {
  ok: boolean;
  messages: ThreadMessage[];
  has_more: boolean;
  response_metadata: {
    next_cursor: string;
  };
}

interface ThreadMessage extends Message {
  thread_ts: string;       // always present; equals ts for root message
  parent_user_id?: string; // present on replies (not root)
  subscribed?: boolean;    // present on root message
  last_read?: string;      // present on root message
  unread_count?: number;   // present on root message
}
```

---

## conversations.list — Channel Discovery

Source: [api.slack.com/methods/conversations.list](https://api.slack.com/methods/conversations.list)

### Facts

- **Endpoint:** `GET https://slack.com/api/conversations.list`
- **Rate limit:** Tier 2 (20+ req/min)
- **Scopes:** Bot or user token with `channels:read`, `groups:read`, `im:read`, `mpim:read`

### Parameters

| Parameter | Type | Required | Default | Notes |
|---|---|---|---|---|
| `token` | string | Yes | — | |
| `cursor` | string | No | — | Cursor pagination |
| `exclude_archived` | boolean | No | false | Filter out archived channels |
| `limit` | integer | No | 100 | Max 999 |
| `team_id` | string | No | — | **Required** for org-level token; ignored for workspace token |
| `types` | string | No | `public_channel` | Comma-separated: `public_channel`, `private_channel`, `mpim`, `im` |

### Important Pagination Gotcha

From the official docs: **"When paginating, any filters used in the request are applied after retrieving a virtual page's limit."** This means if you request `limit=20` with `exclude_archived=true`, and the virtual page contains 15 archived channels, you only get 5 results back — but a cursor is still returned. Always iterate until cursor is empty, not until you get fewer results than requested.

### Channel Object Schema

```typescript
interface Channel {
  id: string;                 // "C012AB3CD"
  name: string;               // "general"
  is_channel: boolean;
  is_group: boolean;          // true for private channels
  is_im: boolean;             // true for DMs
  is_mpim: boolean;           // true for group DMs
  is_private: boolean;
  is_archived: boolean;
  is_general: boolean;
  is_shared: boolean;         // shared with another workspace
  is_org_shared: boolean;     // shared across org workspaces
  is_ext_shared: boolean;     // shared externally via Slack Connect
  is_pending_ext_shared: boolean;
  is_member: boolean;         // bot/user is a member
  created: number;            // Unix timestamp
  creator: string;            // user ID
  name_normalized: string;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  num_members: number;
  unlinked: number;
  previous_names: string[];
  updated: number;            // last updated timestamp in ms
}
```

### Channel Discovery for Indexing

```typescript
async function discoverChannels(
  slack: WebClient,
  options: {
    teamId?: string;          // required for Enterprise Grid org token
    types?: string[];
    excludeArchived?: boolean;
  } = {}
): Promise<Channel[]> {
  const channels: Channel[] = [];
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.list({
      cursor,
      limit: 200,
      types: (options.types ?? ['public_channel']).join(','),
      exclude_archived: options.excludeArchived ?? false,
      team_id: options.teamId,
    });

    if (!response.ok) throw new Error(`conversations.list failed: ${response.error}`);

    channels.push(...(response.channels as Channel[]));
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}
```

---

## File Attachments and Content Download

Sources: [api.slack.com/methods/files.info](https://api.slack.com/methods/files.info), [docs.slack.dev/messaging/working-with-files](https://docs.slack.dev/messaging/working-with-files/)

### File Reference in Messages

When a message contains a file, it appears in the `files` array of the message object:

```typescript
interface FileRef {
  id: string;             // "F0S43PZDF"
  created: number;
  name: string;
  title: string;
  mimetype: string;       // "application/pdf", "image/gif", etc.
  filetype: string;       // "pdf", "docx", "png", etc.
  pretty_type: string;    // "PDF", "Word Document", etc.
  user: string;           // uploader user ID
  size: number;           // bytes
  url_private: string;    // authenticated download URL (requires token in header)
  url_private_download: string;
  permalink: string;      // Slack UI permalink
  is_public: boolean;
  mode: 'hosted' | 'external' | 'snippet' | 'post';
}
```

### files.info — Full File Metadata

- **Endpoint:** `GET https://slack.com/api/files.info`
- **Rate limit:** Tier 4 (100+ req/min) — safe to call frequently
- **Scopes:** `files:read`
- **Required params:** `file` (file ID)

#### File Download Pattern

```typescript
import axios from 'axios';

async function downloadSlackFile(
  fileId: string,
  token: string
): Promise<{ content: Buffer; mimetype: string; filename: string }> {
  // Get full file metadata first
  const slack = new WebClient(token);
  const fileInfo = await slack.files.info({ file: fileId });

  if (!fileInfo.ok) throw new Error(`files.info failed: ${fileInfo.error}`);

  const file = fileInfo.file as FileRef;

  // Download via authenticated request — MUST include token in Authorization header
  // Never use url_private_download directly in browser; always proxy server-side
  const response = await axios.get(file.url_private_download, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    maxContentLength: 50 * 1024 * 1024, // 50MB safety limit
  });

  return {
    content: Buffer.from(response.data),
    mimetype: file.mimetype,
    filename: file.name,
  };
}
```

### Supported File Types for Text Extraction

| Slack `filetype` | MIME type | Extractable? | Method |
|---|---|---|---|
| `pdf` | `application/pdf` | Yes | pdf-parse or pdfjs |
| `docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Yes | mammoth |
| `doc` | `application/msword` | Partial | libreoffice conversion |
| `pptx` | `application/vnd.openxmlformats...presentation` | Partial | officegen/unzip |
| `xlsx` | `application/vnd.openxmlformats...spreadsheet` | Partial | xlsx library |
| `txt` | `text/plain` | Yes | direct read |
| `md` | `text/markdown` | Yes | direct read |
| `html` | `text/html` | Yes | cheerio |
| `csv` | `text/csv` | Yes | csv-parse |
| `png/jpg/gif` | `image/*` | Via OCR only | tesseract.js |
| `mp4/mov` | `video/*` | Via transcript only | not recommended |

### Files in Slack Connect (External Shared Channels)

Files shared in Slack Connect channels may return `access_denied` from `files.info` even with `files:read` scope if the file originated from the external org. The `is_ext_shared` field on channels helps identify this risk.

### DLP Considerations for File Indexing

**Recommendation:** Do not store file content in the index. Store only metadata (filename, type, channel, timestamp, uploader, permalink) and fetch content at query time via `url_private_download`. This pattern:

1. Avoids copying sensitive data out of Slack
2. Respects deletions — a deleted file's `url_private_download` returns 404 automatically
3. Aligns with Slack's updated API Terms of Service (May 2026) on data storage restrictions

---

## User and Profile Resolution

Source: [api.slack.com/methods/users.info](https://api.slack.com/methods/users.info)

### users.info

- **Endpoint:** `GET https://slack.com/api/users.info`
- **Rate limit:** Tier 4 (100+ req/min) — aggressive but manageable
- **Scopes:** `users:read` (+ `users:read.email` for email field)
- **Optional params:** `user` (user ID), `include_locale` (boolean)

### User Object Schema

```typescript
interface SlackUser {
  id: string;               // "W012A3CDE" (W prefix = Enterprise org user; U prefix = workspace user)
  team_id: string;          // workspace this user belongs to
  name: string;             // username (login handle)
  real_name: string;        // full display name
  deleted: boolean;         // deactivated user
  is_admin: boolean;
  is_owner: boolean;
  is_bot: boolean;
  is_app_user: boolean;
  updated: number;          // last profile update Unix timestamp
  color: string;            // hex color for avatar placeholder
  tz: string;               // "America/Los_Angeles"
  tz_label: string;
  tz_offset: number;        // seconds offset from UTC
  profile: {
    real_name: string;
    real_name_normalized: string;
    display_name: string;
    display_name_normalized: string;
    email?: string;         // requires users:read.email scope
    first_name?: string;
    last_name?: string;
    title?: string;
    phone?: string;
    skype?: string;
    avatar_hash: string;
    image_24: string;       // avatar URLs in multiple sizes
    image_32: string;
    image_48: string;
    image_72: string;
    image_192: string;
    image_512: string;
    status_text?: string;   // current status
    status_emoji?: string;
    team: string;
  };
}
```

### Enterprise Grid User IDs

In Enterprise Grid, users have two types of IDs:
- **Enterprise user ID (W prefix):** Stable across all workspaces in the org. Always store this.
- **Legacy/local user ID (U prefix):** Workspace-specific. May differ between workspaces.

When indexing messages from an Enterprise Grid workspace, use `users.info` with the ID as returned in the message (may be W or U prefix), and always store the enterprise-level `id` field for cross-workspace identity resolution.

### User Cache Strategy

```typescript
class UserCache {
  private cache = new Map<string, SlackUser>();
  private ttl = 24 * 60 * 60 * 1000; // 24 hours
  private timestamps = new Map<string, number>();

  async resolve(slack: WebClient, userId: string): Promise<SlackUser | null> {
    const cached = this.cache.get(userId);
    const ts = this.timestamps.get(userId) ?? 0;

    if (cached && Date.now() - ts < this.ttl) {
      return cached;
    }

    try {
      const resp = await slack.users.info({ user: userId });
      if (resp.ok && resp.user) {
        this.cache.set(userId, resp.user as SlackUser);
        this.timestamps.set(userId, Date.now());
        return resp.user as SlackUser;
      }
    } catch (e) {
      // Handle deleted users gracefully
      if ((e as any).data?.error === 'user_not_found') return null;
      throw e;
    }
    return null;
  }

  getDisplayName(user: SlackUser | null): string {
    if (!user) return 'Unknown User';
    return user.profile.display_name_normalized
      || user.profile.real_name_normalized
      || user.name;
  }
}
```

### users.list for Bulk User Pre-loading

For large workspaces, pre-load all users with `users.list` (Tier 2, cursor-paginated) rather than making individual `users.info` calls per message. This dramatically reduces API calls during bulk indexing.

---

## Enterprise Grid

Sources: [docs.slack.dev/enterprise](https://docs.slack.dev/enterprise/), [docs.slack.dev/enterprise/developing-for-enterprise-orgs](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)

### What Enterprise Grid Adds

An **Enterprise organization** is a network of two or more Slack workspaces. Key differences:

| Aspect | Standard Workspace | Enterprise Grid |
|---|---|---|
| Installation scope | One workspace | Org-wide (all workspaces) or per-workspace |
| Token type | Workspace bot token | Org-level bot token (`is_enterprise_install: true`) |
| User IDs | U prefix (local) | W prefix (enterprise) OR U prefix (local) |
| Channel IDs | Per workspace | Shared channels appear in multiple workspaces |
| `conversations.list` | Workspace only | Needs `team_id` for each workspace |
| `users.list` | Workspace only | Needs `team_id` parameter |
| `search.messages` | Workspace only | Pass `team_id`; org token searches across workspaces |
| Rate limits | Per workspace per app | Per workspace per app (same structure) |

### App Manifest for Enterprise Grid Support

```json
{
  "display_information": { "name": "Knowledge Index" },
  "settings": {
    "org_deploy_enabled": true
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "channels:history",
        "channels:read",
        "files:read",
        "users:read",
        "search:read.public",
        "search:read.files",
        "search:read.users"
      ]
    }
  }
}
```

### OAuth Response for Enterprise Install

```typescript
// After OAuth, check this field:
interface OAuthResponse {
  ok: boolean;
  access_token: string;     // xoxb-... (org-level bot token)
  token_type: 'bot';
  scope: string;
  bot_user_id: string;
  app_id: string;
  team: null;               // null for org-wide installs
  enterprise: {
    id: string;             // "E123ABC456" — store this
    name: string;
  };
  is_enterprise_install: boolean;  // true = org-level install
}
```

### Workspace Enumeration for Org-Level Crawl

With an org-level token, you must call `conversations.list` with each workspace's `team_id`. Get workspace IDs via `admin.teams.list` (requires org admin scope):

```typescript
async function listAllWorkspaces(slack: WebClient): Promise<string[]> {
  const teamIds: string[] = [];
  let cursor: string | undefined;

  do {
    // admin.teams.list requires admin:teams:read scope on org-level token
    const response = await slack.admin.teams.list({ cursor, limit: 100 });
    if (!response.ok) throw new Error(`admin.teams.list failed: ${response.error}`);

    const teams = (response as any).teams as Array<{ id: string }>;
    teamIds.push(...teams.map(t => t.id));

    cursor = (response as any).response_metadata?.next_cursor || undefined;
  } while (cursor);

  return teamIds;
}

async function crawlEnterpriseOrg(orgToken: string): Promise<void> {
  const slack = new WebClient(orgToken);
  const workspaceIds = await listAllWorkspaces(slack);

  for (const teamId of workspaceIds) {
    const channels = await discoverChannels(slack, { teamId, types: ['public_channel'] });
    // ... index each channel
  }
}
```

### Shared Channels

Multi-workspace shared channels appear in `conversations.list` responses for each workspace they belong to. They have `is_org_shared: true`. When indexing, deduplicate by channel ID — the same channel ID appears in multiple workspace listings.

```typescript
// Check channel flags when building index doc
function channelSharingType(channel: Channel): string {
  if (channel.is_ext_shared) return 'slack_connect';   // external org
  if (channel.is_org_shared) return 'multi_workspace';  // same Enterprise org
  if (channel.is_shared) return 'shared';              // generic shared
  return 'standard';
}
```

### Enterprise User ID Reconciliation

When the same person appears in two workspaces, they have the same enterprise user ID (W prefix) but may have different local IDs:

```typescript
// auth.test tells you whether you're on Enterprise Grid
const authInfo = await slack.auth.test();
const isEnterpriseInstall = !!(authInfo as any).enterprise_id;

// For cross-workspace user resolution, always use enterprise user ID when available
function normalizeUserId(userId: string): string {
  // W prefix = enterprise ID (stable), U prefix = local (workspace-specific)
  // Both are safe to pass to users.info; prefer W when you have it
  return userId;
}
```

---

## Event Subscriptions — Real-Time Indexing

Sources: [docs.slack.dev/apis/events-api](https://docs.slack.dev/apis/events-api/), [docs.slack.dev/reference/events/message](https://docs.slack.dev/reference/events/message/)

### Event Types for Indexing

| Event | Trigger | Notes |
|---|---|---|
| `message` | New message in any channel bot is in | Primary event for live indexing |
| `message` with `subtype: message_changed` | Message edited | Update existing index document |
| `message` with `subtype: message_deleted` | Message deleted | Remove from index |
| `file_shared` | File shared to a channel | Trigger file metadata indexing |
| `file_public` | File made public | Rarely useful for indexing |
| `channel_created` | New public channel | Trigger channel discovery |
| `channel_archive` / `channel_unarchive` | Channel status change | Update channel metadata |
| `member_joined_channel` | User joins channel | Update ACL data |
| `member_left_channel` | User leaves channel | Update ACL data |
| `app_mention` | Bot mentioned | Optional: answer questions from index |

### Events API Architecture

There are two delivery modes:

**HTTP endpoint (production-recommended):**
- Slack POSTs JSON to your HTTPS endpoint
- 3-second acknowledgement window (return `200 OK` immediately, process async)
- Retries up to 3 times on failure with exponential backoff
- Rate: up to 30,000 event deliveries per workspace per app per hour

**Socket Mode (development/firewall environments):**
- Persistent WebSocket connection to Slack's servers
- No public endpoint needed
- Uses app-level token (`xapp-`) for connection
- Not recommended for production high-volume indexing

### Event Payload Structure

```typescript
interface MessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;          // channel ID
  channel_type: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;            // absent for bot messages
  bot_id?: string;          // present for bot messages
  text: string;
  ts: string;               // message ID
  event_ts: string;         // when the event was fired
  thread_ts?: string;       // present if message is in a thread
  // For message_changed:
  message?: Message;        // the updated message
  previous_message?: Message;
  // For message_deleted:
  deleted_ts?: string;      // ts of deleted message
}

// Outer event wrapper (what Slack actually POSTs)
interface EventPayload {
  token: string;
  team_id: string;
  enterprise_id?: string;   // present for Enterprise Grid
  api_app_id: string;
  event: MessageEvent;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  authorizations: Array<{
    enterprise_id?: string;
    team_id: string;
    user_id: string;
    is_bot: boolean;
    is_enterprise_install: boolean;
  }>;
}
```

### Express Handler for Live Indexing

```typescript
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.raw({ type: 'application/json' }));

function verifySlackSignature(req: express.Request, signingSecret: string): boolean {
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  // Reject if older than 5 minutes (replay attack prevention)
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const hmac = crypto.createHmac('sha256', signingSecret);
  const sigBase = `v0:${timestamp}:${req.body.toString()}`;
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

app.post('/slack/events', (req, res) => {
  if (!verifySlackSignature(req, process.env.SLACK_SIGNING_SECRET!)) {
    return res.status(401).send('Unauthorized');
  }

  const body = JSON.parse(req.body.toString());

  // URL verification challenge (happens when you first configure Event Subscriptions)
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately — process async
  res.status(200).send();

  // Queue for async processing
  processSlackEvent(body as EventPayload).catch(console.error);
});

async function processSlackEvent(payload: EventPayload): Promise<void> {
  const event = payload.event;

  if (event.type !== 'message') return;
  if (!event.subtype) {
    // New message
    await indexMessage(payload.team_id, event);
  } else if (event.subtype === 'message_changed') {
    await updateIndexedMessage(payload.team_id, event);
  } else if (event.subtype === 'message_deleted') {
    await deleteFromIndex(`${payload.team_id}/${event.channel}/${event.deleted_ts}`);
  }
}
```

### Deduplication Warning

The Events API can deliver the same event multiple times. Always use `event_id` for deduplication before processing:

```typescript
const processedEvents = new Set<string>(); // use Redis in production

async function processSlackEvent(payload: EventPayload): Promise<void> {
  if (processedEvents.has(payload.event_id)) return; // duplicate
  processedEvents.add(payload.event_id);
  // ... process
}
```

---

## Rate Limits

Sources: [docs.slack.dev/apis/web-api/rate-limits](https://docs.slack.dev/apis/web-api/rate-limits), [docs.slack.dev/changelog/2018/03/01/great-rate-limits](https://docs.slack.dev/changelog/2018/03/01/great-rate-limits/)

### Web API Tiers

| Tier | Rate | Methods (relevant to indexing) |
|---|---|---|
| Tier 1 | 1+ req/min | Very infrequent admin methods |
| Tier 2 | 20+ req/min | `conversations.list`, `search.messages`, `users.list` |
| Tier 3 | 50+ req/min | `conversations.history`, `conversations.replies`, `conversations.members` |
| Tier 4 | 100+ req/min | `users.info`, `files.info`, `conversations.info` |
| Special | Varies | `chat.postMessage` (1/sec/channel), `assistant.search.context` |

### Critical Policy Change: May 29, 2025

**Non-Marketplace apps commercially distributed outside the Slack Marketplace** (e.g., third-party connectors that are not Slack-approved):

- `conversations.history`: Rate limited to **1 request per minute**; max `limit` reduced to **15 objects**
- `conversations.replies`: Same restriction

**Not affected:**
- Slack Marketplace apps
- Internal customer-built apps (not commercially distributed)

**Implication for this project:** markdown-for-agents-mcp is self-hosted by the customer for internal use. It is **not commercially distributed** in the sense of selling it to multiple customers via an unlisted app. Internal use = no restriction. If we ever offer a hosted SaaS version, we need Marketplace approval to keep Tier 3 limits.

### Burst Behaviour

Slack uses a **token bucket** algorithm. The tier rates are **committed floors**, not hard ceilings. Short bursts above the rate are tolerated. Slack recommends designing to a maximum of **1 request per second** for any given method, knowing occasional higher bursts are allowed.

Exact burst limits are not published and are subject to change. Do not hardcode burst assumptions.

### Per-Scope of Rate Limiting

Rate limits are enforced **per app per method per workspace**. If your app has 10 user tokens and 1 bot token all in Workspace A:

- All 11 tokens draw from the **same pool** for each method
- Calling `conversations.history` with the bot token does NOT consume from the `chat.postMessage` budget
- Calling the same method in Workspace A does NOT consume from Workspace B's budget

### Handling 429 Responses

```typescript
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.code === 'slack_webapi_platform_error' && error.data?.error === 'ratelimited') {
        const retryAfter = parseInt(error.headers?.['retry-after'] ?? '60', 10);
        console.warn(`Rate limited. Waiting ${retryAfter}s before retry ${attempt + 1}/${maxRetries}`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Max retries exceeded`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Rate Limit Budget for Full Crawl

Estimating time to index a large workspace (example: 1,000 channels, 100,000 total messages):

| Step | Method | Tier | Calls | Time at floor rate |
|---|---|---|---|---|
| List channels | `conversations.list` | T2 (20/min) | ~5 | <1 min |
| Fetch histories (200 msgs each) | `conversations.history` | T3 (50/min) | ~500 | ~10 min |
| Fetch thread replies | `conversations.replies` | T3 (50/min) | ~2,000 | ~40 min |
| Resolve users (with cache) | `users.info` | T4 (100/min) | ~500 | ~5 min |
| Fetch file metadata | `files.info` | T4 (100/min) | ~1,000 | ~10 min |

**Total estimated crawl time:** ~65 minutes for 100K messages. Much of this is parallelisable across channels since rate limits are per-method, not global.

---

## Permission Model and ACL Enforcement

### How Slack Access Control Works

| Content Type | Who Can Read | API Behaviour |
|---|---|---|
| Public channels | Any workspace member | `conversations.history` works with bot token; bot auto-joins on scope grant |
| Private channels | Only invited members | Bot must be explicitly invited; `channel_not_found` returned otherwise |
| Group DMs (MPIM) | Only participants | Bot must be a participant |
| Direct messages (DM) | Only the two parties | Bot must be a participant; `im:history` scope required |
| Shared channels | Members in any linked workspace | Works like private/public depending on the channel's visibility |

### Bot Membership for Private Channels

A bot token **cannot** read a private channel it hasn't been invited to. `conversations.list` with `types=private_channel` only lists channels the bot is already in. If you need comprehensive private channel coverage, you need an admin-granted approach:

```
Option A: Bot invited to channels by admin (requires human action per channel)
Option B: User token from an admin who is in all channels (impersonation concerns)
Option C: Discovery API (Enterprise Grid only; requires Slack approval; overkill for search)
```

**Recommendation:** For the knowledge index, index only channels where the bot has been explicitly invited. Document this clearly as a setup step. Private channels that users want indexed must have the bot added by a channel admin.

### ACL Enforcement at Query Time

The correct pattern for a knowledge index is to **not store channel membership** and instead enforce access at query time:

```typescript
// Option 1: Use assistant.search.context with the END USER's token
// Results automatically respect that user's access
async function searchForUser(userToken: string, query: string) {
  const slack = new WebClient(userToken);
  return slack.assistant.search.context({ query, channel_types: ['public_channel', 'private_channel', 'im', 'mpim'] });
}

// Option 2: For stored index with bot token — pre-compute ACL
// Store: channel_id -> Set<user_id> membership
// At query time: filter results to channels user is a member of

async function getChannelMembership(slack: WebClient, channelId: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;

  do {
    const resp = await slack.conversations.members({ channel: channelId, cursor, limit: 200 });
    if (!resp.ok) break;
    members.push(...(resp.members as string[]));
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return members;
}
```

### Entra ID ACL Integration (Phase 2)

For the `transitiveMemberOf` ACL pattern used with SharePoint and Confluence:

1. Store the Slack user ID alongside the Entra Object ID (map via email: `users.info` email field → Entra user lookup)
2. For each indexed document, store the list of Slack user IDs who can access that channel (from `conversations.members`)
3. At query time: resolve the requesting user's Entra ID → their Slack user ID → filter documents to channels they have membership in

This is cheaper than calling `conversations.members` per query. Rebuild the membership table incrementally using `member_joined_channel` / `member_left_channel` events.

---

## Compliance Export API and Discovery API

Sources: [slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs](https://slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs), [www.strac.io/blog/slack-discovery-api](https://www.strac.io/blog/slack-discovery-api)

### What the Discovery API Is

The Slack Discovery API is a **completely separate API surface** from the Web API. It is:

- Available only to **Enterprise Grid customers**
- Requires **explicit approval from Slack** (not just app installation)
- Restricted to **security and compliance use cases** (eDiscovery, DLP, archiving)
- Governed by specific API Terms of Service clauses

**It is NOT appropriate for knowledge indexing.** Using it for search/knowledge use cases violates Slack's ToS.

### Discovery API vs conversations.history

| Dimension | `conversations.history` | Discovery API |
|---|---|---|
| Scope | Workspace-level; channels bot is in | Org-level; ALL workspaces, ALL channels, ALL DMs |
| DMs | Only if bot is a participant | Yes, all DMs org-wide |
| Slack Connect | Limited | Yes, including external |
| Mutation actions | No | Yes: tombstone, redact, delete messages |
| Content type | Public/private channels per bot access | Everything: messages, files, edits, reactions |
| Access model | OAuth app installation | Slack partner approval + special scopes (`discovery.*`) |
| Use case | Reading channels you're in | DLP, eDiscovery, legal hold, archiving |
| Rate limits | Standard tiers | Different (streaming-based) |

### What to Tell Customers

If a customer asks about the Discovery API for knowledge indexing: redirect them to `assistant.search.context` with appropriate scopes. The Discovery API is for their security/compliance team, not their knowledge management use case.

### Standard Export for Non-Enterprise Customers

For non-Enterprise Grid customers who want a full data export (e.g., migration, backup):

- **Free/Pro:** Only public channels exportable via admin console (no API)
- **Business+:** Public and private channels via admin console
- **Enterprise Grid:** Discovery API (with Slack approval) or DM Export (admin-enabled)

For knowledge indexing on non-Grid plans: `conversations.history` + bot membership is the correct approach.

---

## Audit Logs API

Source: [docs.slack.dev/admins/audit-logs-api](https://docs.slack.dev/admins/audit-logs-api/)

### Purpose

The Audit Logs API records administrative and security-relevant actions across Enterprise Grid workspaces. It is relevant to the knowledge connector for two reasons:

1. **Security monitoring:** Track when the indexing app accesses messages or downloads files
2. **Change detection:** Detect channel permission changes, user deactivations, app modifications

### Key Audit Events

| Event | Description | Relevance to Indexing |
|---|---|---|
| `file_downloaded` | File downloaded by a user or app | Monitor for unexpected access |
| `channel_created` | New channel created | Trigger indexing of new channel |
| `channel_deleted` | Channel deleted | Remove from index |
| `member_joined_channel` | User joins channel | Update ACL table |
| `member_left_channel` | User leaves channel | Update ACL table |
| `user_deactivated` | User account deactivated | Remove from user cache and ACL |
| `app_installed` | App installed in workspace | Audit trail |
| `message_tombstoned` | Message hidden by DLP | Remove from index if present |

### Audit API Endpoint

```
GET https://api.slack.com/audit/v1/logs
```

This is a separate base URL from the Web API. Enterprise Grid only, requires org admin token with `audit:read` scope.

---

## Complete TypeScript Connector Implementation

```typescript
import { WebClient } from '@slack/web-api';
import type { Channel, ConversationsHistoryArguments } from '@slack/web-api';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SlackConnectorConfig {
  botToken: string;
  signingSecret: string;
  enterpriseId?: string;        // for Grid org crawls
  workspaceIds?: string[];      // if provided, only index these workspaces
  channelTypes: Array<'public_channel' | 'private_channel' | 'mpim' | 'im'>;
  excludeArchived: boolean;
  maxMessagesPerChannel?: number;
  fileIndexingEnabled: boolean;
}

export interface IndexDocument {
  id: string;                   // "{teamId}/{channelId}/{ts}"
  type: 'message' | 'file';
  text: string;
  channelId: string;
  channelName: string;
  channelType: string;
  teamId: string;
  userId?: string;
  userDisplayName?: string;
  userEmail?: string;
  ts: string;
  threadTs?: string;
  isThreadReply: boolean;
  permalink: string;
  fileId?: string;
  fileName?: string;
  fileMimeType?: string;
  indexedAt: string;
  // ACL
  memberUserIds: string[];      // who can see this message
}

// ─── Main Connector ─────────────────────────────────────────────────────────

export class SlackKnowledgeConnector {
  private slack: WebClient;
  private userCache: UserCache;
  private config: SlackConnectorConfig;

  constructor(config: SlackConnectorConfig) {
    this.config = config;
    this.slack = new WebClient(config.botToken);
    this.userCache = new UserCache(this.slack);
  }

  // ── Full Crawl ────────────────────────────────────────────────────────────

  async fullCrawl(onDocument: (doc: IndexDocument) => Promise<void>): Promise<void> {
    const workspaceIds = this.config.workspaceIds ?? await this.discoverWorkspaceIds();

    for (const teamId of workspaceIds) {
      const channels = await this.listChannels(teamId);
      console.log(`Crawling ${channels.length} channels in workspace ${teamId}`);

      for (const channel of channels) {
        try {
          await this.crawlChannel(teamId, channel, onDocument);
        } catch (e) {
          console.error(`Failed to crawl channel ${channel.id}: ${e}`);
        }
      }
    }
  }

  private async discoverWorkspaceIds(): Promise<string[]> {
    if (!this.config.enterpriseId) return ['self']; // single workspace

    // Enterprise Grid: enumerate all workspaces
    const ids: string[] = [];
    let cursor: string | undefined;

    do {
      const resp = await callWithRetry(() =>
        this.slack.admin.teams.list({ cursor, limit: 100 } as any)
      );
      const teams = (resp as any).teams as Array<{ id: string }>;
      ids.push(...teams.map((t: { id: string }) => t.id));
      cursor = (resp as any).response_metadata?.next_cursor || undefined;
    } while (cursor);

    return ids;
  }

  private async listChannels(teamId: string): Promise<Channel[]> {
    const channels: Channel[] = [];
    let cursor: string | undefined;

    do {
      const resp = await callWithRetry(() =>
        this.slack.conversations.list({
          cursor,
          limit: 200,
          types: this.config.channelTypes.join(','),
          exclude_archived: this.config.excludeArchived,
          team_id: teamId === 'self' ? undefined : teamId,
        })
      );

      channels.push(...(resp.channels as Channel[]));
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  }

  private async crawlChannel(
    teamId: string,
    channel: Channel,
    onDocument: (doc: IndexDocument) => Promise<void>
  ): Promise<void> {
    const memberIds = await this.getChannelMembers(channel.id);
    let msgCount = 0;

    for await (const batch of this.fetchHistory(channel.id)) {
      for (const msg of batch) {
        // Skip non-content subtypes
        if (msg.subtype && !['bot_message', 'me_message'].includes(msg.subtype ?? '')) {
          continue;
        }

        const user = msg.user ? await this.userCache.resolve(msg.user) : null;

        const doc: IndexDocument = {
          id: `${teamId}/${channel.id}/${msg.ts}`,
          type: 'message',
          text: msg.text ?? '',
          channelId: channel.id,
          channelName: channel.name ?? '',
          channelType: channel.is_im ? 'dm' : channel.is_mpim ? 'mpim' : channel.is_private ? 'private' : 'public',
          teamId,
          userId: msg.user,
          userDisplayName: user ? this.userCache.getDisplayName(user) : undefined,
          userEmail: user?.profile?.email,
          ts: msg.ts,
          threadTs: msg.thread_ts,
          isThreadReply: !!(msg.thread_ts && msg.thread_ts !== msg.ts),
          permalink: await this.getPermalink(channel.id, msg.ts),
          indexedAt: new Date().toISOString(),
          memberUserIds: memberIds,
        };

        await onDocument(doc);
        msgCount++;

        // Fetch thread replies if this is a root message with replies
        if ((msg as any).reply_count > 0 && !doc.isThreadReply) {
          await this.crawlThread(teamId, channel, msg.ts, memberIds, onDocument);
        }

        // Handle file attachments
        if (this.config.fileIndexingEnabled && (msg as any).files?.length > 0) {
          for (const file of (msg as any).files) {
            const fileDoc = await this.buildFileDoc(teamId, channel, file, doc, memberIds);
            if (fileDoc) await onDocument(fileDoc);
          }
        }
      }

      if (this.config.maxMessagesPerChannel && msgCount >= this.config.maxMessagesPerChannel) break;
    }
  }

  private async *fetchHistory(channelId: string): AsyncGenerator<any[]> {
    let cursor: string | undefined;

    do {
      const resp = await callWithRetry(() =>
        this.slack.conversations.history({
          channel: channelId,
          cursor,
          limit: 200,
          inclusive: false,
        } as ConversationsHistoryArguments)
      );

      if (!resp.ok) throw new Error(`conversations.history error: ${resp.error}`);
      yield resp.messages ?? [];
      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  private async crawlThread(
    teamId: string,
    channel: Channel,
    parentTs: string,
    memberIds: string[],
    onDocument: (doc: IndexDocument) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const resp = await callWithRetry(() =>
        this.slack.conversations.replies({
          channel: channel.id,
          ts: parentTs,
          cursor,
          limit: 200,
        })
      );

      for (const msg of resp.messages ?? []) {
        if (msg.ts === parentTs) continue; // skip root message (already indexed)
        if (msg.subtype && !['bot_message'].includes(msg.subtype ?? '')) continue;

        const user = msg.user ? await this.userCache.resolve(msg.user) : null;

        await onDocument({
          id: `${teamId}/${channel.id}/${msg.ts}`,
          type: 'message',
          text: msg.text ?? '',
          channelId: channel.id,
          channelName: channel.name ?? '',
          channelType: channel.is_private ? 'private' : 'public',
          teamId,
          userId: msg.user,
          userDisplayName: user ? this.userCache.getDisplayName(user) : undefined,
          userEmail: user?.profile?.email,
          ts: msg.ts,
          threadTs: msg.thread_ts,
          isThreadReply: true,
          permalink: await this.getPermalink(channel.id, msg.ts),
          indexedAt: new Date().toISOString(),
          memberUserIds: memberIds,
        });
      }

      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  private async getChannelMembers(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;

    try {
      do {
        const resp = await callWithRetry(() =>
          this.slack.conversations.members({ channel: channelId, cursor, limit: 200 })
        );
        members.push(...(resp.members as string[]));
        cursor = resp.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (e: any) {
      if (e.data?.error === 'channel_not_found') return [];
      throw e;
    }

    return members;
  }

  private async buildFileDoc(
    teamId: string,
    channel: Channel,
    file: any,
    parentMsg: IndexDocument,
    memberIds: string[]
  ): Promise<IndexDocument | null> {
    try {
      const fileInfo = await callWithRetry(() =>
        this.slack.files.info({ file: file.id })
      );

      if (!fileInfo.ok) return null;
      const f = fileInfo.file as any;

      return {
        id: `${teamId}/${channel.id}/file/${f.id}`,
        type: 'file',
        text: f.title ?? f.name,
        channelId: channel.id,
        channelName: channel.name ?? '',
        channelType: parentMsg.channelType,
        teamId,
        userId: f.user,
        userDisplayName: parentMsg.userDisplayName,
        ts: parentMsg.ts,
        isThreadReply: false,
        permalink: f.permalink,
        fileId: f.id,
        fileName: f.name,
        fileMimeType: f.mimetype,
        indexedAt: new Date().toISOString(),
        memberUserIds: memberIds,
      };
    } catch (e) {
      console.warn(`Failed to fetch file info for ${file.id}: ${e}`);
      return null;
    }
  }

  private async getPermalink(channelId: string, ts: string): Promise<string> {
    try {
      const resp = await this.slack.chat.getPermalink({ channel: channelId, message_ts: ts });
      return (resp as any).permalink ?? '';
    } catch {
      return '';
    }
  }

  // ── Real-Time Search (Query Time) ──────────────────────────────────────────

  async searchMessages(
    query: string,
    options: {
      userToken?: string;     // use for private channel + DM results
      channelTypes?: Array<'public_channel' | 'private_channel' | 'mpim' | 'im'>;
      before?: Date;
      after?: Date;
      limit?: number;
      actionToken?: string;
    } = {}
  ): Promise<any[]> {
    const token = options.userToken ?? this.config.botToken;
    const slack = new WebClient(token);
    const results: any[] = [];
    let cursor = '';

    do {
      const resp = await callWithRetry(() =>
        (slack as any).assistant.search.context({
          query,
          channel_types: options.channelTypes ?? ['public_channel'],
          content_types: ['messages'],
          before: options.before ? Math.floor(options.before.getTime() / 1000) : undefined,
          after: options.after ? Math.floor(options.after.getTime() / 1000) : undefined,
          limit: Math.min(options.limit ?? 20, 20),
          action_token: options.actionToken,
          cursor,
          include_context_messages: true,
          sort: 'timestamp',
          sort_dir: 'desc',
        })
      );

      if (!(resp as any).ok) throw new Error(`RTS API error: ${(resp as any).error}`);

      results.push(...((resp as any).messages ?? []));
      cursor = (resp as any).next_cursor ?? '';
    } while (cursor && results.length < (options.limit ?? 20));

    return results;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

class UserCache {
  private cache = new Map<string, any>();
  private timestamps = new Map<string, number>();
  private ttl = 24 * 60 * 60 * 1000;

  constructor(private slack: WebClient) {}

  async resolve(userId: string): Promise<any | null> {
    const ts = this.timestamps.get(userId) ?? 0;
    if (this.cache.has(userId) && Date.now() - ts < this.ttl) {
      return this.cache.get(userId);
    }

    try {
      const resp = await callWithRetry(() => this.slack.users.info({ user: userId }));
      if (resp.ok && resp.user) {
        this.cache.set(userId, resp.user);
        this.timestamps.set(userId, Date.now());
        return resp.user;
      }
    } catch (e: any) {
      if (e.data?.error === 'user_not_found') return null;
    }
    return null;
  }

  getDisplayName(user: any): string {
    return user?.profile?.display_name_normalized
      || user?.profile?.real_name_normalized
      || user?.name
      || 'Unknown';
  }
}

async function callWithRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimited =
        error?.code === 'slack_webapi_platform_error' && error?.data?.error === 'ratelimited';

      if (isRateLimited) {
        const retryAfter = parseInt(error?.headers?.['retry-after'] ?? '60', 10);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## What to Build vs. What to Skip

### Build

| Feature | Why |
|---|---|
| `assistant.search.context` query path | The only correct API for permission-aware real-time knowledge search; GA since Feb 2026 |
| `conversations.history` incremental crawl | For internal apps: provides complete historical coverage; pair with event delta updates |
| Event subscription handler for delta indexing | Keeps index current without full re-crawl; 30K events/hr per workspace is generous |
| User resolution cache | Required for human-readable attribution; Tier 4 makes it cheap |
| File metadata indexing (no content storage) | Store filename/type/permalink; fetch content at query time |
| `conversations.members` ACL table | Required for correct private channel access filtering |
| Enterprise Grid workspace enumeration | Required for org-level coverage |
| Rate-limit-aware client with `Retry-After` respect | Slack 429s are inevitable at scale; build retry once, use everywhere |
| Request signature verification | Security baseline; Slack signs every webhook POST |

### Skip (or defer to Phase 3+)

| Feature | Why to Skip |
|---|---|
| `search.messages` | Deprecated direction; user token only; superseded by `assistant.search.context` |
| Discovery API integration | Requires Slack approval; ToS restricts to DLP/eDiscovery only; not for knowledge use cases |
| Full file content extraction | Legal/DLP risk; storage requirement; latency hit; start with metadata only |
| DM indexing | Privacy sensitivity; requires user consent per user; limited knowledge value; hard to get bot invited |
| Real-time socket mode in production | HTTP endpoints are more reliable and scalable for high event volumes |
| Audit Logs API for change detection | Overkill; the Events API gives you message events directly |
| Legacy RTM API | Deprecated; replaced by Events API and Socket Mode |
| Reaction/emoji indexing | Low knowledge value; adds significant volume overhead |

### Open Questions for Implementation

1. **Marketplace vs. internal:** Will we distribute this commercially? If yes, seek Marketplace approval early to avoid the `conversations.history` rate limit cliff (1 req/min).
2. **User token flow:** For full private channel coverage, we need per-user OAuth grants. Is the customer willing to implement that? Or do we document "add the bot to private channels you want indexed" as a setup requirement?
3. **File content strategy:** Build stub now (metadata only), implement content extraction as a configurable option with explicit consent/data-handling disclosure.
4. **Channel scope:** Should the connector index ALL public channels by default, or require explicit channel opt-in? Opt-in is safer for large orgs with hundreds of channels.
5. **Index storage:** Slack's ToS (updated May 2026) tightened restrictions on storing message data externally. Confirm with legal before building a persistent message store. The RTS API (no storage needed) sidesteps this entirely.

---

## Reference: Complete Scope List

```
# Bot token scopes — minimum for public channel indexing
channels:history
channels:read
files:read
users:read

# Bot token scopes — add for private channels (bot must be invited)
groups:history
groups:read

# Bot token scopes — add for Real-Time Search API
search:read.public
search:read.files
search:read.users

# Bot token scopes — add for DM indexing (bot must be participant)
im:history
im:read
mpim:history
mpim:read

# Bot token scopes — add for Enterprise Grid workspace enumeration
admin:teams:read  (org-level token)

# User token scopes — for RTS API with private/DM access
search:read.private
search:read.im
search:read.mpim
search:read.public
search:read.files
search:read.users

# User token scopes — for email access in user resolution
users:read
users:read.email
```

---

## Sources

- [api.slack.com/methods/search.messages](https://api.slack.com/methods/search.messages)
- [api.slack.com/methods/conversations.history](https://api.slack.com/methods/conversations.history)
- [api.slack.com/methods/conversations.list](https://api.slack.com/methods/conversations.list)
- [api.slack.com/methods/conversations.replies](https://api.slack.com/methods/conversations.replies)
- [api.slack.com/methods/users.info](https://api.slack.com/methods/users.info)
- [api.slack.com/methods/files.info](https://api.slack.com/methods/files.info)
- [docs.slack.dev/reference/methods/assistant.search.context](https://docs.slack.dev/reference/methods/assistant.search.context)
- [docs.slack.dev/enterprise/](https://docs.slack.dev/enterprise/)
- [docs.slack.dev/enterprise/developing-for-enterprise-orgs](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)
- [docs.slack.dev/apis/web-api/rate-limits](https://docs.slack.dev/apis/web-api/rate-limits)
- [docs.slack.dev/authentication/tokens](https://docs.slack.dev/authentication/tokens/)
- [docs.slack.dev/reference/scopes](https://docs.slack.dev/reference/scopes/)
- [docs.slack.dev/apis/events-api](https://docs.slack.dev/apis/events-api/)
- [docs.slack.dev/admins/audit-logs-api](https://docs.slack.dev/admins/audit-logs-api/)
- [slack.dev/secure-data-connectivity-for-the-modern-ai-era](https://slack.dev/secure-data-connectivity-for-the-modern-ai-era/)
- [docs.slack.dev/changelog/2026/02/17/slack-mcp](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/)
- [slack.com/help/articles/360002079527](https://slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs)
- [www.strac.io/blog/slack-discovery-api](https://www.strac.io/blog/slack-discovery-api)
- [docs.slack.dev/changelog/2018/03/01/great-rate-limits](https://docs.slack.dev/changelog/2018/03/01/great-rate-limits/)
- [trailhead.salesforce.com — Discovery and Audit Logs APIs](https://trailhead.salesforce.com/content/learn/modules/slack-apis-for-automating-and-managing-your-org/use-discovery-and-audit-logs-apis)
