# MCP Server Design Patterns

**Research for:** markdown-for-agents-mcp  
**Spec version covered:** 2026-07-28 (latest)  
**Date:** 2026-08-26  
**Sources:** modelcontextprotocol.io official docs, spec pages, blog posts, community guides

---

## Table of Contents

1. [Protocol Overview and Architecture](#1-protocol-overview-and-architecture)
2. [The Stateless Revolution: 2026-07-28 Spec Changes](#2-the-stateless-revolution-2026-07-28-spec-changes)
3. [Transport Layer](#3-transport-layer)
4. [Server Primitives: Tools, Resources, Prompts](#4-server-primitives-tools-resources-prompts)
5. [Tool Design Patterns](#5-tool-design-patterns)
6. [Resource Design Patterns](#6-resource-design-patterns)
7. [Prompt Design Patterns](#7-prompt-design-patterns)
8. [Authentication and Authorization](#8-authentication-and-authorization)
9. [Elicitation: Server-Initiated User Input](#9-elicitation-server-initiated-user-input)
10. [Caching and Performance](#10-caching-and-performance)
11. [Error Handling](#11-error-handling)
12. [Streaming and Long-Running Operations](#12-streaming-and-long-running-operations)
13. [Multi-Tenant Patterns](#13-multi-tenant-patterns)
14. [Enterprise Hardening](#14-enterprise-hardening)
15. [Testing Infrastructure](#15-testing-infrastructure)
16. [What to Build vs Skip for markdown-for-agents-mcp](#16-what-to-build-vs-skip-for-markdown-for-agents-mcp)

---

## 1. Protocol Overview and Architecture

Source: https://modelcontextprotocol.io/docs/concepts/architecture

### 1.1 Participants

MCP follows a strict client-server architecture with three distinct roles:

| Role | Description | Example |
|------|-------------|---------|
| **MCP Host** | The AI application that coordinates MCP clients | Claude Desktop, Claude Code, Cursor, VS Code |
| **MCP Client** | Component inside the host, maintains 1:1 connection with one server | Internal to the host, not user-visible |
| **MCP Server** | Program that provides context and capabilities | This project (markdown-for-agents-mcp) |

Key architectural rule: one MCP client per server. A host like VS Code instantiates separate client objects for each server it connects to. The server is the program, regardless of where it runs — local (stdio) or remote (Streamable HTTP).

### 1.2 Two Layers

```
┌─────────────────────────────────────────────┐
│              DATA LAYER                      │
│  JSON-RPC 2.0 protocol: tools, resources,    │
│  prompts, elicitation, caching, pagination   │
└─────────────────────────────────────────────┘
                    ↕ framed by
┌─────────────────────────────────────────────┐
│             TRANSPORT LAYER                  │
│  stdio (local) | Streamable HTTP (remote)    │
│  Handles: framing, auth, connection setup    │
└─────────────────────────────────────────────┘
```

The data layer is entirely transport-agnostic. The same JSON-RPC 2.0 messages run over any transport. This is the critical design insight: your tool logic is written once and works over stdio in development and Streamable HTTP in production.

### 1.3 JSON-RPC 2.0 Fundamentals

All MCP messages are JSON-RPC 2.0. Three message types:

- **Request**: has `id`, expects a `Response`
- **Response**: has `id` matching the request, has `result` or `error`
- **Notification**: no `id`, no response expected (fire-and-forget)

**As of 2026-07-28**: Servers do NOT initiate JSON-RPC requests. Server-to-client interaction happens only through `InputRequiredResult` during active request processing (see Elicitation section).

### 1.4 The `_meta` Field

Every request in 2026-07-28 carries a `_meta` field with required fields:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "fetch_url",
    "arguments": { "url": "https://example.com" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "claude-desktop",
        "version": "1.5.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {
        "elicitation": { "form": {}, "url": {} }
      }
    }
  }
}
```

This stateless metadata model (every request is self-contained) is what enables horizontal scaling without sticky sessions.

---

## 2. The Stateless Revolution: 2026-07-28 Spec Changes

Source: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/

This is the most significant spec revision since launch. Every server builder needs to understand these changes before writing new code.

### 2.1 Session Elimination

**Before (2025-11-25):**
```http
POST /mcp HTTP/1.1
Mcp-Session-Id: 1868a90c-3a3f-4f5b      ← pins client to one instance
Content-Type: application/json

{"jsonrpc":"2.0","id":2,"method":"tools/call",...}
```

**After (2026-07-28):**
```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call                  ← for load balancer routing
Mcp-Name: search
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"search","arguments":{"q":"otters"},
           "_meta":{"io.modelcontextprotocol/clientInfo":{"name":"my-app","version":"1.0"}}}}
```

The `initialize`/`initialized` handshake is gone. The `Mcp-Session-Id` header is gone. Any request can land on any server instance. No more sticky routing, no more shared session stores.

### 2.2 Practical Impact on Server Design

| Concern | Old approach | New approach |
|---------|-------------|--------------|
| State across calls | Session context on server | Explicit handles in tool arguments |
| Load balancing | Session affinity required | Plain round-robin works |
| Horizontal scaling | Shared session store required | Each instance is independent |
| Discovery | `initialize` handshake | `server/discover` request (cacheable) |

**The explicit handle pattern** (recommended for stateful workflows):

```typescript
// OLD: Server stored state in session
// NEW: Server mints a handle, model passes it back

// Tool 1: Creates something, returns handle
server.tool("create_search_session", {...}, async ({ query }) => {
  const sessionId = crypto.randomUUID();
  await cache.set(sessionId, { query, results: [], cursor: null }, { ttl: 3600 });
  return { content: [{ type: "text", text: JSON.stringify({ sessionId }) }] };
});

// Tool 2: Uses the handle
server.tool("continue_search", {...}, async ({ sessionId, limit }) => {
  const state = await cache.get(sessionId);
  if (!state) throw new Error("Session expired or not found");
  // ...
});
```

The model threads the `sessionId` from call to call as an ordinary argument. This makes state visible to the model — it can reason about, compose, and hand off handles in ways that hidden session state never permitted.

### 2.3 What Was Deprecated in 2026-07-28

| Deprecated feature | Replacement |
|-------------------|-------------|
| Sampling (server requests LLM completion) | Direct LLM provider API integration |
| Roots (server learns client's root URIs) | Tool params, resource URIs, server config |
| Logging (server sends log messages to client) | `stderr` for stdio; OpenTelemetry for HTTP |
| Dynamic Client Registration (OAuth DCR) | Client ID Metadata Documents |

**Decision for markdown-for-agents-mcp**: Do not implement sampling, roots, or logging primitives. Use `stderr` for debug output (stdio) and OpenTelemetry spans for Streamable HTTP.

### 2.4 New Extension Framework

Extensions are now first-class:
- Identified by reverse-DNS IDs (e.g., `io.modelcontextprotocol.tasks`)
- Negotiated via `extensions` map in capabilities
- Version independently from core spec
- Live in separate `ext-*` repositories

Notable stable extensions:
- **Tasks**: Durable handles for long-running operations (poll-based, no SSE stream required)
- **MCP Apps**: Server-rendered HTML UIs in sandboxed iframes

---

## 3. Transport Layer

Sources: https://modelcontextprotocol.io/docs/concepts/transports, https://rollbrains.com/mcp/mcp-transports-compared/

### 3.1 Transport Decision Table

| Situation | Transport | Reason |
|-----------|-----------|--------|
| Local dev, single user, same machine | stdio | Simplest, no networking |
| New remote server | Streamable HTTP | Current standard |
| Multi-tenant SaaS | Streamable HTTP | OAuth, horizontal scaling |
| Existing HTTP+SSE server | Migrate to Streamable HTTP | SSE deprecated, removal deadlines |
| Many concurrent clients | Streamable HTTP | stdio collapses at ~20 concurrent |
| CI/CD testing | stdio | Easiest to script |

**Rule**: Build new servers on Streamable HTTP even if the first client is local. The concurrency wall on stdio (most requests fail at ~20 simultaneous connections) is not a scaling problem — it is a hard wall.

### 3.2 stdio Transport

**How it works**: Client launches server as a child process. Communication via `stdin`/`stdout`. Messages are newline-delimited JSON-RPC.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "markdown-for-agents-mcp",
  version: "1.0.0",
});

// ... register tools, resources, prompts

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Cancellation**: Client sends `notifications/cancelled` notification with the request `id`.

**Gotcha**: `ENOENT spawn` errors almost always mean the command is not on the PATH the client launched with, not an MCP misconfiguration. Always specify full paths in `claude_desktop_config.json` when debugging.

**Gotcha**: Write debug/log output to `stderr`, never `stdout`. Stdout is the protocol channel. Any non-JSON-RPC output on stdout will break the connection.

### 3.3 Streamable HTTP Transport

**How it works**: Single endpoint (typically `/mcp`). Client POSTs JSON-RPC messages. Server replies with:
- A single JSON body (for immediate responses), or  
- An SSE stream (for streaming/long-running responses)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamable-http.js";
import express from "express";

const app = express();
app.use(express.json());

const server = new McpServer({
  name: "markdown-for-agents-mcp",
  version: "1.0.0",
});

// ... register tools

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ res });
  await server.connect(transport);
  await transport.handleRequest(req.body);
});

app.listen(3000);
```

**Required headers (2026-07-28)**:
- `Mcp-Method`: the JSON-RPC method (e.g., `tools/call`)
- `Mcp-Name`: the tool/resource/prompt name
- `MCP-Protocol-Version`: e.g., `2026-07-28`

These headers allow load balancers and gateways to route requests without parsing the body.

**Cancellation**: Client closes the response stream (HTTP connection close).

### 3.4 Deprecated: HTTP+SSE Transport

HTTP+SSE used two endpoints: a persistent GET connection for the SSE event stream, and a POST endpoint for messages. Problems:
- No native resumability
- Two-connection design hostile to load balancers and serverless
- Proxy buffering silently kills the event stream
- Firewall traversal issues

**Removal deadlines already passed**:
- Keboola: 2026-04-01
- Atlassian Rovo: 2026-06-30

**Do not implement HTTP+SSE** in any new server. If the codebase has it, migrate.

### 3.5 Supporting Multiple Transports

Both SDKs allow a single server binary to expose both transports, switched by environment variable:

```typescript
const mode = process.env.MCP_TRANSPORT ?? "stdio";

if (mode === "http") {
  startStreamableHTTP(server, { port: parseInt(process.env.PORT ?? "3000") });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

Tool logic is identical in both modes. This is the right pattern for markdown-for-agents-mcp: stdio for local/Claude Desktop development, Streamable HTTP for the self-hosted deployment.

---

## 4. Server Primitives: Tools, Resources, Prompts

Sources: https://stacktr.ee/blog/mcp-resources-vs-tools-vs-prompts, https://modelcontextprotocol.io/docs/concepts/tools, https://modelcontextprotocol.io/docs/concepts/resources

### 4.1 The Control-Model Decision Framework

The single most important question when designing a server primitive: **who decides when it runs?**

| Primitive | Control model | Invoked by | Purpose |
|-----------|--------------|------------|---------|
| **Tool** | Model-controlled | LLM, automatically | Take an action, modify state, fetch data |
| **Resource** | Application-controlled | Host app, by URI | Read structured data as context |
| **Prompt** | User-controlled | User explicitly | Run a canned workflow or template |

This distinction is not aesthetic — it determines what the primitive IS. Getting it wrong means the host won't surface it correctly, or the LLM will try to use it in the wrong context.

### 4.2 Decision Rules

**Use a Tool when:**
- The model should be able to invoke it autonomously based on context
- There is a side effect (API call, write, send, compute)
- The result goes back to the model as content for reasoning
- Examples: `fetch_url`, `search_web`, `index_document`, `query_knowledge_base`

**Use a Resource when:**
- The host application needs to read data and inject it as context
- The data is addressable by a URI
- There are no side effects
- The data might be subscribed to for updates
- Examples: `knowledge://index/status`, `config://server-settings`, `schema://sharepoint-fields`

**Use a Prompt when:**
- A user will explicitly invoke a repeatable workflow by name
- The workflow needs to combine tool calls + resource reads in a known sequence
- You want to expose it as a slash command
- Examples: `/summarize-page`, `/index-site`, `/explain-acl`

### 4.3 Worked Example: markdown-for-agents-mcp

```
TOOLS (model-controlled):
  fetch_url       - Fetch a URL and return markdown
  search_web      - DuckDuckGo search, return results
  index_document  - Add a document to the knowledge index (Phase 2)
  query_index     - Search the knowledge index (Phase 2)
  get_acl_for     - Get Entra ID ACL for a resource (Phase 2)

RESOURCES (application-controlled):
  knowledge://index/status     - Current index stats (document count, last updated)
  knowledge://index/sources    - List of indexed source connectors
  config://server-settings     - Current server configuration

PROMPTS (user-controlled):
  /fetch-and-summarize <url>   - Fetch a URL and return a structured summary
  /index-sharepoint <site>     - Start indexing a SharePoint site (Phase 2)
```

The `fetch_url` and `search_web` tools are model-controlled because the LLM should be able to invoke them automatically when it determines web access is needed. The index status is a Resource because it is read-only data the host can inject as context.

---

## 5. Tool Design Patterns

Sources: https://modelcontextprotocol.io/specification/2026-07-28/server/tools (official spec)

### 5.1 Tool Definition Schema

```typescript
interface Tool {
  name: string;              // Required. 1-128 chars, [A-Za-z0-9_\-.]
  title?: string;            // Optional human-readable display name
  description: string;       // Required. Used by LLM to decide when to invoke
  inputSchema: JSONSchema;   // Required. Full JSON Schema 2020-12
  outputSchema?: JSONSchema; // Optional. Describes structured output
  annotations?: ToolAnnotations;
  icons?: Icon[];
}
```

**inputSchema** rules (2026-07-28):
- MUST be a valid JSON Schema 2020-12 object (not null)
- Root MUST be `{ "type": "object" }` for tools with parameters
- For no-parameter tools: `{ "type": "object", "additionalProperties": false }`
- Now supports: `oneOf`, `anyOf`, `allOf`, `$ref`, `$defs`, conditionals
- Implementations MUST NOT auto-dereference external `$ref` URIs
- Bound schema depth and validation time in your implementation

### 5.2 Tool Naming Conventions

```
Good names:
  fetch_url           snake_case action
  search_web          verb_noun pattern
  get_weather         CRUD prefix
  index_document      clear intent
  DATA_EXPORT_v2      versioned tool
  admin.tools.list    namespaced with dots

Bad names:
  do_stuff            too vague
  tool1               meaningless
  fetch url           spaces not allowed
  FetchURL,Search     commas not allowed
```

Name uniqueness is per-server. If aggregating multiple servers in a proxy, implement disambiguation (e.g., prefix with server name).

### 5.3 Description Quality

The description is what the LLM uses to decide when to invoke the tool. It must be a contract, not a label:

```typescript
// BAD description
{
  name: "fetch_url",
  description: "Fetches a URL"
}

// GOOD description
{
  name: "fetch_url",
  description: `Fetches a web page and returns its content as clean markdown.
    Use this when the user asks to read, summarize, or analyze content at a specific URL.
    Returns the page title, markdown body, and metadata (word count, links found).
    Does NOT execute JavaScript — use for static content and server-rendered pages.
    Constraints: Max URL length 2048 chars. Max response size 1MB (truncated with notice).
    Returns isError:true with an error message if the URL is unreachable or returns non-2xx.`
}
```

Guidelines:
- State what it does and what it returns
- State explicit constraints (size limits, format requirements)
- State what it does NOT do (important for avoiding misuse)
- Describe error behavior
- Use when/if clauses to guide the model's decision

### 5.4 Input Schema Patterns

**Minimal required tool:**
```json
{
  "name": "fetch_url",
  "description": "...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "The URL to fetch. Must be http:// or https://",
        "format": "uri",
        "maxLength": 2048
      }
    },
    "required": ["url"],
    "additionalProperties": false
  }
}
```

**Tool with optional parameters and defaults:**
```json
{
  "name": "search_web",
  "description": "...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query",
        "minLength": 1,
        "maxLength": 500
      },
      "max_results": {
        "type": "integer",
        "description": "Maximum number of results to return (1-20)",
        "minimum": 1,
        "maximum": 20,
        "default": 10
      },
      "safe_search": {
        "type": "boolean",
        "description": "Enable safe search filtering",
        "default": true
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

**Tool with enum options:**
```json
{
  "name": "get_document",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string" },
      "format": {
        "type": "string",
        "enum": ["markdown", "html", "text"],
        "default": "markdown",
        "description": "Output format for the document content"
      }
    },
    "required": ["id"]
  }
}
```

**No-parameter tool:**
```json
{
  "name": "get_server_status",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

### 5.5 Output Schema and Structured Content

Use `outputSchema` and `structuredContent` when the tool returns data the host application needs to process programmatically:

```typescript
server.tool(
  "search_web",
  "Search the web and return structured results",
  {
    query: z.string(),
    max_results: z.number().int().min(1).max(20).default(10)
  },
  async ({ query, max_results }) => {
    const results = await searchDDG(query, max_results);
    
    return {
      content: [
        {
          type: "text",
          text: results.map(r => `## ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
        }
      ],
      // structuredContent for programmatic use by the host
      structuredContent: {
        results: results.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet
        })),
        total: results.length,
        query
      }
    };
  }
);
```

`outputSchema` declares the shape of `structuredContent`. Unrestricted JSON Schema (unlike `inputSchema` which requires object root).

### 5.6 Tool Annotations

Annotations are hints to the client about tool behavior. **Clients MUST treat them as untrusted unless the server is trusted** — they are advisory only.

```typescript
server.tool(
  "delete_document",
  "...",
  { id: z.string() },
  { 
    annotations: {
      destructive: true,      // Modifies or destroys data
      readOnly: false,        // Tool modifies state
      idempotent: false,      // Multiple calls = different outcomes
      openWorld: false        // Operates on known data only
    }
  },
  async ({ id }) => { /* ... */ }
);
```

### 5.7 x-mcp-header for Routing

The `x-mcp-header` extension lets specific tool parameters become HTTP headers for load balancer routing:

```json
{
  "name": "query_index",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tenant_id": {
        "type": "string",
        "description": "Tenant identifier for routing",
        "x-mcp-header": "Tenant-Id"
      },
      "query": { "type": "string" }
    },
    "required": ["tenant_id", "query"]
  }
}
```

When called with `tenant_id: "acme"`, the client adds `Mcp-Param-Tenant-Id: acme` to the HTTP request, enabling the gateway to route to the correct tenant's index without parsing the body.

**Security warning**: Do NOT mark sensitive parameters (passwords, API keys, tokens, PII) with `x-mcp-header`. Header values are visible to network intermediaries.

### 5.8 Tool Result Content Types

```typescript
// Text (most common)
{ type: "text", text: "Result text here" }

// Image (base64 encoded)
{ type: "image", data: "base64...", mimeType: "image/png" }

// Audio (base64 encoded)
{ type: "audio", data: "base64...", mimeType: "audio/wav" }

// Resource link (URI reference, client fetches if needed)
{ type: "resource_link", uri: "knowledge://doc/abc123", name: "report.md", mimeType: "text/markdown" }

// Embedded resource (inline content)
{ 
  type: "resource",
  resource: {
    uri: "knowledge://doc/abc123",
    mimeType: "text/markdown",
    text: "# Report\n..."
  }
}
```

Return `isError: true` for tool-level errors (the tool ran but the operation failed). Return a JSON-RPC error for protocol-level failures.

### 5.9 TypeScript Tool Registration with Zod

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "markdown-for-agents-mcp",
  version: "1.0.0",
});

server.tool(
  "fetch_url",
  `Fetches a web page and returns its content as clean markdown.
   Use this when the user asks to read, summarize, or analyze a URL.
   Returns title, markdown body, word count. Returns isError:true if unreachable.`,
  {
    url: z.string().url().max(2048).describe("The URL to fetch"),
    include_links: z.boolean().default(false).describe("Include extracted links in output"),
    max_length: z.number().int().min(100).max(100000).default(10000)
      .describe("Maximum characters to return (truncated with notice if exceeded)")
  },
  async ({ url, include_links, max_length }) => {
    try {
      const result = await fetchAndConvertToMarkdown(url, { include_links, max_length });
      return {
        content: [{ type: "text", text: result.markdown }],
        structuredContent: {
          title: result.title,
          url: result.finalUrl,
          wordCount: result.wordCount,
          truncated: result.truncated,
          links: include_links ? result.links : undefined
        }
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching ${url}: ${err.message}` }],
        isError: true
      };
    }
  }
);
```

### 5.10 Dynamic Tool Lists

The set of tools returned by `tools/list` MAY vary by authorization context. This is the per-user scoping pattern:

```typescript
// Tools/list varies based on the token presented on the request
// (credentials are per-request input, not connection state)
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const token = extractBearerToken(request._meta);
  const scopes = await validateTokenAndGetScopes(token);
  
  const allTools = getFullToolList();
  const visibleTools = allTools.filter(tool => 
    hasRequiredScope(scopes, tool.requiredScope)
  );
  
  return {
    tools: visibleTools,
    ttlMs: 300000,
    // Per-user — must not share cache between users
    cacheScope: "private"
  };
});
```

Declare `listChanged: true` in capabilities if the tool list can change dynamically.

---

## 6. Resource Design Patterns

Source: https://modelcontextprotocol.io/docs/concepts/resources (official spec)

### 6.1 Resource Definition Schema

```typescript
interface Resource {
  uri: string;              // Required. Unique identifier (URI)
  name: string;             // Required. Human-readable name
  title?: string;           // Optional. Display name for UI
  description?: string;     // Optional
  mimeType?: string;        // Optional. MIME type of content
  size?: number;            // Optional. Size in bytes
  icons?: Icon[];
  annotations?: {
    audience?: ("user" | "assistant")[];
    priority?: number;       // 0.0 (optional) to 1.0 (required)
    lastModified?: string;   // ISO 8601 timestamp
  };
}
```

### 6.2 URI Scheme Design

| Scheme | Use case | Example |
|--------|----------|---------|
| `file://` | Local filesystem or file-like data | `file:///path/to/doc.md` |
| `https://` | Web resources (client can fetch directly) | `https://example.com/page` |
| `git://` | Git version control | `git://repo/commit/file` |
| `knowledge://` | Custom: knowledge index | `knowledge://index/status` |
| `config://` | Custom: server configuration | `config://server-settings` |

Custom schemes MUST conform to RFC 3986. Use `knowledge://` and `config://` for internal server data rather than `file://` (which implies filesystem semantics).

### 6.3 Resource Templates

For parameterized resources, use URI templates:

```json
{
  "uriTemplate": "knowledge://documents/{doc_id}",
  "name": "Knowledge Document",
  "description": "Retrieve a document from the knowledge index by ID",
  "mimeType": "text/markdown"
}
```

Arguments can be auto-completed through the completion API. This avoids needing a separate `get_document` tool for simple read-only lookups.

### 6.4 TypeScript Resource Registration

```typescript
// Static resource
server.resource(
  "index-status",
  "knowledge://index/status",
  {
    title: "Knowledge Index Status",
    description: "Current status of the knowledge index including document count and last update",
    mimeType: "application/json"
  },
  async () => {
    const stats = await getIndexStats();
    return {
      contents: [{
        uri: "knowledge://index/status",
        mimeType: "application/json",
        text: JSON.stringify(stats, null, 2)
      }],
      ttlMs: 60000,       // Fresh for 1 minute
      cacheScope: "private" // Per-user (stats may differ by tenant)
    };
  }
);

// Resource template
server.resourceTemplate(
  "knowledge-document",
  "knowledge://documents/{doc_id}",
  {
    title: "Knowledge Document",
    mimeType: "text/markdown"
  },
  async (uri, { doc_id }) => {
    const doc = await getDocument(doc_id, { fromToken: getTokenFromContext() });
    if (!doc) {
      throw new McpError(ErrorCode.InvalidParams, `Document not found: ${doc_id}`);
    }
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: doc.content
      }],
      ttlMs: 300000,
      cacheScope: "private"
    };
  }
);
```

### 6.5 Resource Subscriptions

For dynamic resources that change over time:

```typescript
// Declare subscribe capability
capabilities: {
  resources: {
    listChanged: true,
    subscribe: true        // Clients can subscribe for update notifications
  }
}

// Notify subscribers when a document is updated (after indexing)
server.sendNotification({
  method: "notifications/resources/updated",
  params: {
    uri: `knowledge://documents/${docId}`
  }
});
```

### 6.6 When Resources Beat Tools

Resources are significantly more efficient than tools for read-only data:
- Results are cacheable with TTL hints
- Subscriptions eliminate polling
- Host can inject resource content as context without an LLM round-trip
- URI-addressable: client knows exactly where to refetch

For markdown-for-agents-mcp Phase 2, the SharePoint document index should expose both:
- A `query_index` **tool** (for model-invoked search with parameters)
- A `knowledge://index/status` **resource** (for host-injected context about index health)

---

## 7. Prompt Design Patterns

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/prompts

### 7.1 Prompt Definition Schema

```typescript
interface Prompt {
  name: string;               // Required. Unique identifier
  title?: string;             // Optional. Display name
  description?: string;       // Optional
  arguments?: PromptArgument[];
  icons?: Icon[];
}

interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}
```

### 7.2 TypeScript Prompt Registration

```typescript
server.prompt(
  "fetch-and-summarize",
  "Fetch a web page and return a structured summary with key points",
  [
    { name: "url", description: "The URL to fetch and summarize", required: true },
    { name: "focus", description: "Optional aspect to focus on (e.g., 'technical details', 'pricing')", required: false }
  ],
  async ({ url, focus }) => {
    const focusInstruction = focus 
      ? `Focus particularly on: ${focus}` 
      : "Provide a general summary";
    
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please fetch the URL "${url}" using the fetch_url tool and provide:
1. A 2-3 sentence summary of the main content
2. Key points or findings (bullet list)
3. Any notable caveats or limitations of the content

${focusInstruction}`
          }
        }
      ]
    };
  }
);
```

### 7.3 When to Use Prompts

Prompts are underused in real deployments but valuable for:
- Complex multi-step workflows the user wants to invoke by name
- Domain-specific tasks where the LLM needs careful instruction
- Slash commands in Claude Desktop
- Standardizing how agents interact with your server

For markdown-for-agents-mcp, prompts are optional for Phase 1 (web fetch/search). More relevant for Phase 2 (knowledge indexing workflows that users explicitly trigger).

---

## 8. Authentication and Authorization

Sources: https://rohitraj.tech/en/notes/mcp-server-authentication-oauth-guide-2026, https://modelcontextprotocol.io/specification/2026-07-28/base/authorization

### 8.1 Auth Model Selection

| Scenario | Auth approach |
|----------|--------------|
| Local stdio server | Environment variables (no OAuth) |
| Internal HTTP server, single tenant | API key in bearer header |
| Public or multi-tenant HTTP server | OAuth 2.1 with PKCE |
| Enterprise with IdP | OAuth 2.1 + Enterprise-Managed Authorization (EMA/ID-JAG) |

The spec is explicit: **stdio servers SHOULD NOT use OAuth** — read credentials from environment. **HTTP servers SHOULD conform to OAuth 2.1**.

### 8.2 OAuth 2.1 Requirements (for remote servers)

The MCP spec pins these specific RFCs:

| RFC | What it requires |
|-----|-----------------|
| OAuth 2.1 (draft-ietf-oauth-v2-1) | PKCE mandatory. Implicit grant prohibited. |
| RFC 9728 (Protected Resource Metadata) | Server MUST publish `/.well-known/oauth-protected-resource` |
| RFC 8414 (Authorization Server Metadata) | At least one AS metadata endpoint must exist |
| RFC 8707 (Resource Indicators) | Token MUST be bound to specific server (audience) |
| RFC 9207 (Issuer Identification) | Client validates `iss` param to prevent mix-up attacks |

### 8.3 Protected Resource Metadata

Your server MUST serve this at `/.well-known/oauth-protected-resource`:

```json
{
  "resource": "https://mcp.yourcompany.com/mcp",
  "authorization_servers": ["https://auth.yourcompany.com"],
  "scopes_supported": [
    "mcp:tools:read",
    "mcp:tools:execute",
    "mcp:resources:read",
    "knowledge:read",
    "knowledge:write"
  ],
  "bearer_methods_supported": ["header"]
}
```

### 8.4 Token Validation Middleware

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://auth.yourcompany.com/.well-known/jwks.json")
);

// Cache JWKS with a reasonable TTL (jose handles this internally)

export async function verifyMcpToken(authHeader: string | undefined): Promise<TokenPayload> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing bearer token"), { statusCode: 401 });
  }
  
  const token = authHeader.slice(7);
  
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: "https://auth.yourcompany.com",
      // RFC 8707: MUST validate audience = THIS server specifically
      // This prevents confused-deputy attacks
      audience: "https://mcp.yourcompany.com/mcp",
    });
    
    return payload as TokenPayload;
  } catch (err) {
    throw Object.assign(new Error(`Invalid token: ${err.message}`), { statusCode: 401 });
  }
}

// Express middleware
app.use("/mcp", async (req, res, next) => {
  try {
    const payload = await verifyMcpToken(req.headers.authorization);
    req.mcpUser = payload;
    next();
  } catch (err) {
    if (err.statusCode === 401) {
      res.status(401).set(
        "WWW-Authenticate",
        `Bearer resource_metadata="https://mcp.yourcompany.com/.well-known/oauth-protected-resource"`
      ).json({ error: "unauthorized" });
    } else {
      next(err);
    }
  }
});
```

**Critical**: The `audience` check is mandatory. Without it, any token your server can read becomes a key to your server (confused-deputy attack).

### 8.5 Dynamic Client Registration (Deprecated) vs Client ID Metadata Documents

**Old approach (now deprecated, only for backward compat):**
Client POSTs to `/register` endpoint to get a `client_id`. Requires managing ephemeral client records.

**New approach (Client ID Metadata Documents):**
Client uses an HTTPS URL as its `client_id`. The authorization server fetches metadata from that URL. No registration round-trip needed.

```
Client ID: https://client.example.com/mcp-client-metadata.json
```

The authorization server fetches:
```json
{
  "client_id": "https://client.example.com/mcp-client-metadata.json",
  "client_name": "My MCP Client",
  "redirect_uris": ["https://client.example.com/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "native"
}
```

For markdown-for-agents-mcp: if implementing OAuth, support Client ID Metadata Documents as primary mechanism, DCR only as legacy fallback.

### 8.6 Enterprise-Managed Authorization (Zero-Touch OAuth)

Released stable 2026-06-18. The "zero-touch OAuth" model for enterprise deployments:

- Administrator defines access policy in IdP (Okta, Azure AD, etc.)
- Policy keyed on group membership, roles, conditional-access rules
- User signs in once via SSO; IdP decides which servers they can reach
- Per-server consent screens disappear

**Mechanism**: Identity Assertion JWT Authorization Grant (ID-JAG):
1. During SSO, client obtains an ID-JAG token from the IdP
2. Client exchanges ID-JAG for an access token from the MCP server's AS
3. No per-server consent screen required

For markdown-for-agents-mcp Phase 2 (enterprise knowledge index), EMA is the correct auth model for Entra ID integration. The ID-JAG token can carry the user's Entra ID group memberships, which the server uses for ACL enforcement.

### 8.7 Scope Design for markdown-for-agents-mcp

```
Phase 1 (web fetch/search):
  mcp:tools:execute     - Can call any tool
  mcp:resources:read    - Can read resources

Phase 2 (knowledge index):
  knowledge:read        - Can query the index
  knowledge:write       - Can submit documents for indexing
  knowledge:admin       - Can manage connectors and settings
  acl:impersonate       - Can query ACL on behalf of a user (admin only)
```

Scope granularity enables per-user tool lists: a user with only `knowledge:read` sees no indexing tools.

---

## 9. Elicitation: Server-Initiated User Input

Source: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation

### 9.1 What Elicitation Replaces

Old pattern (deprecated): Server held an SSE stream open and sent `sampling/createMessage` requests mid-connection.

New pattern: Server returns `InputRequiredResult` from within a tool call. Client gathers input, retries the call with `inputResponses`. Any server instance can handle the retry (stateless).

### 9.2 The Multi Round-Trip Pattern

```
Client                          Server
  |                               |
  |--- tools/call id=1 ---------> |
  |                               | (needs user input)
  |<-- InputRequiredResult id=1 --|
  |                               |
  | [show form to user]           |
  |                               |
  |--- tools/call id=2 ---------> | (NEW id, includes inputResponses + requestState)
  |<-- complete result id=2 ------|
```

**Key rule**: The retry MUST use a different JSON-RPC `id`. The `requestState` opaque blob (base64 JSON) carries any server-side state needed to process the retry — no server-side storage required.

### 9.3 Form Mode Elicitation

For collecting non-sensitive structured data:

```typescript
// Server-side: return InputRequiredResult during a tool call
return {
  resultType: "input_required",
  inputRequests: {
    "sharepoint_site": {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Which SharePoint site should be indexed?",
        requestedSchema: {
          type: "object",
          properties: {
            site_url: {
              type: "string",
              title: "SharePoint Site URL",
              description: "e.g., https://company.sharepoint.com/sites/engineering",
              format: "uri"
            },
            include_subsites: {
              type: "boolean",
              title: "Include subsites",
              default: false
            }
          },
          required: ["site_url"]
        }
      }
    }
  },
  requestState: Buffer.from(JSON.stringify({ step: "get_site", userId })).toString("base64")
};
```

**Schema restrictions for form mode**: Flat objects with primitive properties only (string, number, boolean, enum). No nested objects or arrays of objects.

**Security rule**: MUST NOT use form mode to collect passwords, API keys, access tokens, or payment credentials. Use URL mode for those.

### 9.4 URL Mode Elicitation

For OAuth flows and other sensitive interactions:

```typescript
return {
  resultType: "input_required",
  inputRequests: {
    "oauth_flow": {
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Please authorize access to your SharePoint account",
        // Server-provided URL — client shows it, user navigates
        // Data does NOT pass through the MCP client
        url: `https://auth.yourcompany.com/oauth/authorize?...`
      }
    }
  }
};
```

The client displays the URL, user navigates to it, the OAuth flow completes out-of-band, and the server detects completion through its own callback mechanism (e.g., a webhook or database polling).

---

## 10. Caching and Performance

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities (Caching section)

### 10.1 Cacheable Operations

All list and read operations MUST include caching hints:

| Operation | Must cache? | Typical TTL |
|-----------|-------------|-------------|
| `server/discover` | Yes | Long (hours) |
| `tools/list` | Yes | Medium (minutes) |
| `prompts/list` | Yes | Medium (minutes) |
| `resources/list` | Yes | Medium (minutes) |
| `resources/templates/list` | Yes | Medium (minutes) |
| `resources/read` | Yes | Depends on content |

### 10.2 Cache Scope

```typescript
// Public: same result for all users — safe to share across auth contexts
{
  ttlMs: 3600000,     // 1 hour
  cacheScope: "public"
}

// Private: user-specific data — MUST NOT share across users
{
  ttlMs: 300000,      // 5 minutes
  cacheScope: "private"
}
```

**Rules**:
- `"public"` for tool/prompt lists that are identical for all users
- `"private"` for filtered lists that vary per user, and for all resource reads

### 10.3 TTL Semantics

- `ttlMs: 0` = immediately stale, client should re-fetch every time
- `ttlMs > 0` = client MAY consider fresh for that many ms after receiving
- `ttlMs` absent = treat as 0 (only in old server versions)
- TTL is NOT a polling interval — client checks freshness when it needs data

### 10.4 Interaction with Notifications

TTL and `listChanged` notifications are complementary:
- Server can use both: TTL for efficiency between changes, notification for immediate invalidation
- When a notification is received while TTL is still valid, notification wins (immediately stale)

### 10.5 Performance Design for markdown-for-agents-mcp

```typescript
// Tool list: same for all users in Phase 1 (no auth-filtered tools)
return {
  tools: allTools,
  ttlMs: 3600000,       // 1 hour — tools rarely change
  cacheScope: "public"
};

// Tool list: Phase 2, auth-filtered
return {
  tools: visibleTools,
  ttlMs: 300000,        // 5 minutes — scopes can change
  cacheScope: "private"
};

// Resource read: knowledge index status
return {
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(stats) }],
  ttlMs: 60000,         // 1 minute — index updates frequently
  cacheScope: "private"
};
```

---

## 11. Error Handling

Sources: official spec pages, https://mcp-best-practice.github.io/mcp-best-practice/best-practice/

### 11.1 Error Categories

| Error type | When to use | JSON-RPC error code |
|------------|-------------|---------------------|
| Protocol error | Malformed request, wrong method | -32700 (Parse error), -32600 (Invalid Request), -32601 (Method not found) |
| Invalid params | Schema validation failure, unknown tool | -32602 (Invalid Params) |
| Internal error | Server crash, unexpected state | -32603 (Internal Error) |
| Resource not found | `resources/read` on non-existent URI | -32602 (also accept -32002 for backward compat) |
| Tool execution error | Tool ran but operation failed | `isError: true` in result content (NOT a JSON-RPC error) |

### 11.2 Tool Error vs Protocol Error

This distinction is critical:

```typescript
// WRONG: Throwing a JSON-RPC error for tool execution failure
throw new McpError(ErrorCode.InternalError, "URL fetch failed: 404 Not Found");
// This tells the client the SERVER failed, not the URL

// CORRECT: Return isError:true for tool execution failures
return {
  content: [{ type: "text", text: "Error: URL fetch failed: 404 Not Found at https://example.com" }],
  isError: true
};
// The LLM sees this as part of the conversation and can reason about it
```

The model needs to see tool errors as content — it may decide to try a different URL, ask the user for clarification, or explain the failure. JSON-RPC errors are for the client library to handle, not the LLM.

### 11.3 Resource Error Handling

```typescript
// Resource not found: use -32602 (Invalid Params)
throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);

// Do NOT return empty contents array for non-existent resources
// Empty array is ambiguous (exists but empty vs. does not exist)
```

### 11.4 Error Data Field

Include structured data in errors for diagnostic use:

```typescript
throw new McpError(
  ErrorCode.InvalidParams,
  "Resource not found",
  {
    uri: requestedUri,
    availableSchemes: ["knowledge://", "config://"],
    hint: "Use resources/list to discover available resources"
  }
);
```

### 11.5 Validation-First Pattern

Validate inputs before executing any side effects:

```typescript
server.tool("fetch_url", "...", { url: z.string() }, async ({ url }) => {
  // 1. URL format validation (Zod does this automatically)
  
  // 2. Business rule validation
  if (isBlockedDomain(url)) {
    return { content: [{ type: "text", text: `Domain blocked by policy: ${new URL(url).hostname}` }], isError: true };
  }
  
  // 3. Execute
  try {
    const result = await fetchUrl(url);
    return { content: [{ type: "text", text: result.markdown }] };
  } catch (err) {
    // 4. Network/execution errors return isError:true, not throw
    return { content: [{ type: "text", text: `Fetch failed: ${err.message}` }], isError: true };
  }
});
```

---

## 12. Streaming and Long-Running Operations

### 12.1 Progress Notifications (2025 spec)

In the 2025-11-25 spec, progress was reported via `notifications/progress` with a `progressToken`:

```typescript
// 2025 pattern (still compatible)
const { progressToken } = request.params._meta ?? {};

if (progressToken) {
  server.notification({
    method: "notifications/progress",
    params: {
      progressToken,
      progress: 0.3,
      total: 1.0,
      message: "Fetching page..."
    }
  });
}
```

### 12.2 Tasks Extension (2026-07-28)

For genuinely long-running operations (indexing a SharePoint site, crawling a website), the Tasks extension is the 2026 answer. Instead of holding an SSE stream open:

1. Server returns a task handle from `tools/call`
2. Client polls with `tasks/get`
3. Server can request mid-flight input with `InputRequiredResult`
4. Client cancels with `tasks/cancel`

```typescript
// Tool returns a task handle
server.tool("index_sharepoint_site", "...", { site_url: z.string().url() }, async (args) => {
  const taskId = crypto.randomUUID();
  
  // Start background job
  indexingQueue.enqueue({ taskId, ...args });
  
  // Return task handle immediately
  return {
    content: [{ 
      type: "text", 
      text: `Indexing started. Task ID: ${taskId}. Use check_indexing_status to monitor progress.` 
    }],
    structuredContent: {
      taskId,
      status: "queued",
      estimatedDurationMs: 300000
    }
  };
});

// Separate status-check tool
server.tool("check_indexing_status", "...", { task_id: z.string() }, async ({ task_id }) => {
  const status = await indexingQueue.getStatus(task_id);
  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    isError: status.status === "failed"
  };
});
```

**Decision for markdown-for-agents-mcp**: Use the explicit-handle pattern for Phase 2 indexing operations. The Tasks extension is cleaner but requires explicit capability negotiation. The explicit-handle approach works without extension support from the client.

---

## 13. Multi-Tenant Patterns

Sources: https://mcp-best-practice.github.io, https://shahvatsal.com/blog/mcp-server-enterprise-registry-governance-2026

### 13.1 Per-Request Context vs Connection Context

The stateless 2026-07-28 model means all tenant/user context arrives per-request:

```typescript
// Extract user context from the bearer token on every request
function getUserContext(request: McpRequest): UserContext {
  const token = request.params?._meta?.authorization ?? 
                request.headers?.authorization;
  
  const payload = verifyToken(token);
  return {
    userId: payload.sub,
    tenantId: payload.tid,          // Azure AD tenant ID
    scopes: payload.scp?.split(" ") ?? [],
    groups: payload.groups ?? []   // Entra ID group memberships
  };
}
```

### 13.2 Tool List Scoping

Return different tools based on tenant/user context:

```typescript
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const ctx = getUserContext(req);
  
  const tools = BASE_TOOLS.filter(tool => {
    // Phase 1: all tools available to authenticated users
    if (tool.tier === "basic") return true;
    // Phase 2: knowledge tools require knowledge scope
    if (tool.tier === "knowledge") return ctx.scopes.includes("knowledge:read");
    // Admin tools require admin role
    if (tool.tier === "admin") return ctx.groups.includes("mcp-admins");
    return false;
  });
  
  return { tools, ttlMs: 300000, cacheScope: "private" };
});
```

### 13.3 Data Isolation

For the Phase 2 enterprise knowledge index, data isolation is critical:

```typescript
// Every storage operation is tenant-scoped
class KnowledgeIndex {
  async search(query: string, ctx: UserContext): Promise<SearchResult[]> {
    // Tenant namespace prevents cross-tenant data leakage
    const namespace = `tenant:${ctx.tenantId}`;
    
    const results = await this.vectorDb.search(query, { namespace });
    
    // ACL post-filter: remove docs user doesn't have access to
    // Uses Entra ID transitiveMemberOf for group membership
    return this.filterByAcl(results, ctx.userId, ctx.groups);
  }
  
  private async filterByAcl(results: Doc[], userId: string, groups: string[]): Promise<Doc[]> {
    return results.filter(doc => {
      const acl = doc.acl; // Stored at index time from SharePoint permissions
      // Check if user is in any allowed group, or is explicitly allowed
      return acl.some(entry => 
        entry.principalId === userId || 
        groups.includes(entry.principalId)
      );
    });
  }
}
```

### 13.4 Rate Limiting

Per-tenant rate limiting should run at the gateway layer (before the MCP server receives the request):

```typescript
// Leaky bucket per tenant, per tool category
const rateLimiter = new RateLimiter({
  buckets: {
    "fetch_url": { tokensPerMinute: 60 },
    "search_web": { tokensPerMinute: 30 },
    "query_index": { tokensPerMinute: 120 }
  }
});

app.use("/mcp", async (req, res, next) => {
  const ctx = getUserContext(req);
  const method = req.headers["mcp-method"] as string;
  const toolName = req.headers["mcp-name"] as string;
  
  const allowed = await rateLimiter.consume(ctx.tenantId, toolName);
  if (!allowed) {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      retryAfterMs: rateLimiter.getRetryAfter(ctx.tenantId, toolName)
    });
  }
  
  next();
});
```

The `Mcp-Method` and `Mcp-Name` headers (required in 2026-07-28) make this possible without body inspection.

### 13.5 Audit Logging

Every tool call must be logged with full context:

```typescript
interface AuditEntry {
  timestamp: string;           // ISO 8601
  requestId: string;           // UUID
  tenantId: string;
  userId: string;
  toolName: string;
  arguments: Record<string, unknown>; // Scrubbed of secrets
  resultType: "complete" | "error" | "input_required";
  latencyMs: number;
  clientInfo?: { name: string; version: string };
}

// Middleware: wrap tool handlers with audit logging
function auditedTool<T>(
  name: string,
  handler: (args: T, ctx: UserContext) => Promise<McpToolResult>
) {
  return async (args: T, ctx: UserContext): Promise<McpToolResult> => {
    const start = Date.now();
    const requestId = crypto.randomUUID();
    
    try {
      const result = await handler(args, ctx);
      await auditLog.write({
        requestId, tenantId: ctx.tenantId, userId: ctx.userId,
        toolName: name, arguments: scrubSecrets(args),
        resultType: result.isError ? "error" : "complete",
        latencyMs: Date.now() - start, timestamp: new Date().toISOString()
      });
      return result;
    } catch (err) {
      await auditLog.write({ /* ... */ resultType: "error", error: err.message });
      throw err;
    }
  };
}
```

---

## 14. Enterprise Hardening

Source: https://mcp-best-practice.github.io/mcp-best-practice/best-practice/

### 14.1 Input Validation

Zod-based validation catches format errors before execution. Add business-rule validation on top:

```typescript
// Zod schema — format validation
const FetchUrlArgs = z.object({
  url: z.string().url().max(2048),
  include_links: z.boolean().default(false),
});

// Business rule validators
const BLOCKED_PATTERNS = [
  /^https?:\/\/169\.254\./,          // AWS metadata service
  /^https?:\/\/10\./,                // Private network
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,  // Private network
  /^https?:\/\/192\.168\./,          // Private network
  /^https?:\/\/localhost/,           // Localhost
  /^file:\/\//,                      // Local files
];

function validateUrlSafety(url: string): void {
  const parsed = new URL(url);
  
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Protocol not allowed: ${parsed.protocol}`);
  }
  
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`URL blocked by security policy: ${url}`);
    }
  }
}
```

### 14.2 Output Sanitization

For returned content, prevent injection attacks:

```typescript
// Sanitize HTML in markdown output
import { sanitize } from "isomorphic-dompurify";
import TurndownService from "turndown";

const turndown = new TurndownService();

function htmlToSafeMarkdown(html: string): string {
  // First sanitize HTML to remove XSS vectors
  const cleanHtml = sanitize(html, {
    ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", 
                   "ul", "ol", "li", "a", "strong", "em", "code", "pre",
                   "table", "thead", "tbody", "tr", "th", "td", "blockquote"],
    ALLOWED_ATTR: ["href", "src", "alt", "title"]
  });
  
  // Convert to markdown
  return turndown.turndown(cleanHtml);
}
```

### 14.3 SSRF Prevention

Server-Side Request Forgery is the main risk for a web-fetch MCP server:

```typescript
import dns from "dns/promises";
import net from "net";

async function validateNoSSRF(url: string): Promise<void> {
  const parsed = new URL(url);
  
  // Resolve hostname to IPs and check all
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  
  for (const { address } of addresses) {
    if (net.isIPv4(address)) {
      const parts = address.split(".").map(Number);
      
      // Private ranges
      if (parts[0] === 10) throw new Error("SSRF: private network");
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) throw new Error("SSRF: private network");
      if (parts[0] === 192 && parts[1] === 168) throw new Error("SSRF: private network");
      if (parts[0] === 127) throw new Error("SSRF: loopback");
      if (parts[0] === 169 && parts[1] === 254) throw new Error("SSRF: link-local (metadata service)");
      if (parts[0] === 0) throw new Error("SSRF: zero address");
    }
    
    if (net.isIPv6(address)) {
      if (address === "::1") throw new Error("SSRF: loopback");
      if (address.startsWith("fc") || address.startsWith("fd")) throw new Error("SSRF: private network");
    }
  }
}
```

DNS rebinding: validate at DNS lookup time, not just at URL parse time. Resolve the hostname immediately before connecting.

### 14.4 Content Size Limits

```typescript
const FETCH_LIMITS = {
  maxResponseBytes: 5 * 1024 * 1024,  // 5MB raw response
  maxMarkdownChars: 100_000,           // Truncate output
  maxRedirects: 3,                     // Follow redirects limit
  timeoutMs: 15_000                    // 15 second timeout
};

async function fetchWithLimits(url: string): Promise<{ content: string; truncated: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_LIMITS.timeoutMs);
  
  try {
    const response = await fetch(url, { 
      signal: controller.signal,
      redirect: "follow",  // node-fetch respects maxRedirect option
      follow: FETCH_LIMITS.maxRedirects
    });
    
    const contentLength = parseInt(response.headers.get("content-length") ?? "0");
    if (contentLength > FETCH_LIMITS.maxResponseBytes) {
      throw new Error(`Response too large: ${contentLength} bytes`);
    }
    
    const reader = response.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      received += value.length;
      if (received > FETCH_LIMITS.maxResponseBytes) {
        throw new Error("Response body exceeded size limit");
      }
      chunks.push(value);
    }
    
    const content = new TextDecoder().decode(Buffer.concat(chunks));
    const truncated = content.length > FETCH_LIMITS.maxMarkdownChars;
    
    return {
      content: truncated ? content.slice(0, FETCH_LIMITS.maxMarkdownChars) : content,
      truncated
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

### 14.5 Secret Management

```typescript
// NEVER inline secrets in config or code
// NEVER log argument values without scrubbing

const SCRUB_KEYS = ["password", "api_key", "token", "secret", "authorization", "credential"];

function scrubSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      SCRUB_KEYS.some(s => k.toLowerCase().includes(s)) ? "[REDACTED]" : v
    ])
  );
}

// Load secrets from environment — never from config files
const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,          // Phase 2 optional
  entraClientId: process.env.ENTRA_CLIENT_ID,        // Phase 2
  entraClientSecret: process.env.ENTRA_CLIENT_SECRET, // Phase 2
  jwtSecret: process.env.JWT_SECRET,                  // Optional internal auth
};

// Validate on startup
for (const [key, value] of Object.entries(config)) {
  if (value === undefined && isRequired(key)) {
    throw new Error(`Required environment variable not set: ${key.toUpperCase()}`);
  }
}
```

### 14.6 TLS and Transport Security

```typescript
// For Streamable HTTP production deployment:
import https from "https";
import fs from "fs";

const httpsServer = https.createServer({
  cert: fs.readFileSync(process.env.TLS_CERT_PATH!),
  key: fs.readFileSync(process.env.TLS_KEY_PATH!),
  // Minimum TLS 1.2 (TLS 1.3 preferred)
  minVersion: "TLSv1.2",
  ciphers: "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES256-GCM-SHA384"
}, app);

// HSTS header
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
```

### 14.7 Container Security

```dockerfile
# Use distroless base — no shell, no package manager
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build

FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Non-root user (distroless default is nonroot)
USER nonroot

EXPOSE 3000
CMD ["dist/server.js"]
```

---

## 15. Testing Infrastructure

Sources: https://modelcontextprotocol.io/docs/tools/inspector

### 15.1 MCP Inspector

The reference developer tool. Three modes from one package:

```bash
# Install once
npm install -g @modelcontextprotocol/inspector

# Web UI (richest, default)
npx @modelcontextprotocol/inspector node ./dist/server.js

# CLI mode (CI/scriptable)
npx @modelcontextprotocol/inspector --cli node ./dist/server.js \
  --method tools/list

# Call a specific tool
npx @modelcontextprotocol/inspector --cli node ./dist/server.js \
  --method tools/call \
  --tool-name fetch_url \
  --tool-arg url=https://example.com \
  --format json | jq .result

# TUI mode (terminal)
npx @modelcontextprotocol/inspector --tui node ./dist/server.js

# Remote HTTP server
npx @modelcontextprotocol/inspector \
  --server-url https://mcp.yourcompany.com/mcp \
  --transport http
```

The Inspector requires Node 22.19.0+. It handles OAuth flows, protocol-era negotiation (legacy 2025 vs modern 2026-07-28), and shows the full protocol traffic in a monitoring sidebar.

### 15.2 Unit Testing with Vitest

Test tool handlers in isolation:

```typescript
// tests/tools/fetch-url.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleFetchUrl } from "../../src/tools/fetch-url.js";

describe("fetch_url tool", () => {
  it("returns markdown for a successful fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<html><body><h1>Test</h1><p>Content</p></body></html>"
    });
    
    const result = await handleFetchUrl(
      { url: "https://example.com" },
      { fetch: mockFetch }
    );
    
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("# Test");
  });
  
  it("returns isError:true for 404 responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    });
    
    const result = await handleFetchUrl(
      { url: "https://example.com/missing" },
      { fetch: mockFetch }
    );
    
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });
  
  it("blocks private IP addresses", async () => {
    const result = await handleFetchUrl(
      { url: "http://192.168.1.1/admin" },
      { fetch: vi.fn() }  // should never be called
    );
    
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("blocked");
  });
});
```

### 15.3 Integration Testing with In-Process Server

```typescript
// tests/integration/server.test.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../src/server.js";

describe("MCP Server integration", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    server = createServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    
    await server.connect(serverTransport);
    
    client = new Client({ name: "test-client", version: "1.0.0" }, {
      capabilities: { elicitation: {} }
    });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists available tools", async () => {
    const result = await client.listTools();
    expect(result.tools.map(t => t.name)).toContain("fetch_url");
    expect(result.tools.map(t => t.name)).toContain("search_web");
  });

  it("fetch_url tool returns content", async () => {
    // Use a mock HTTP server or nock for real integration tests
    const result = await client.callTool("fetch_url", { url: "https://example.com" });
    expect(result.isError).toBeFalsy();
  });
});
```

### 15.4 Claude Desktop Test Setup

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "markdown-for-agents-mcp-dev": {
      "command": "node",
      "args": ["/Users/you/markdown-for-agents-mcp/dist/server.js"],
      "env": {
        "NODE_ENV": "development",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

After editing, restart Claude Desktop. Check logs at `~/Library/Logs/Claude/mcp-server-markdown-for-agents-mcp-dev.log`.

### 15.5 CI Pipeline Testing

```yaml
# .github/workflows/mcp-test.yml
jobs:
  mcp-integration-test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci && npm run build
      
      # Inspector CLI smoke test
      - name: Test tools/list
        run: |
          npx @modelcontextprotocol/inspector --cli \
            node ./dist/server.js \
            --method tools/list \
            --format json > tools.json
          cat tools.json | jq '.tools | length > 0'
      
      # Test specific tool
      - name: Test fetch_url
        run: |
          npx @modelcontextprotocol/inspector --cli \
            node ./dist/server.js \
            --method tools/call \
            --tool-name fetch_url \
            --tool-arg url=https://example.com \
            --format json | jq '.result.isError == false'
```

---

## 16. What to Build vs Skip for markdown-for-agents-mcp

### 16.1 Phase 1 (Current: Web Fetch + Search)

**Build:**
- `fetch_url` tool — Streamable HTTP + stdio both, Zod input validation, SSRF prevention, markdown conversion
- `search_web` tool — DuckDuckGo via w3m/curl, pagination support, `max_results` param
- Streamable HTTP transport with `Mcp-Method`/`Mcp-Name` headers
- stdio transport for local dev/Claude Desktop
- `server/discover` response with proper capabilities declaration
- `tools/list` with `ttlMs: 3600000, cacheScope: "public"` (no auth in Phase 1)
- MCP Inspector CI test

**Skip:**
- OAuth (not needed for public self-hosted server in Phase 1)
- Elicitation (no user input needed for web fetch/search)
- Resources (useful for Phase 2 index status; skip for Phase 1)
- Prompts (useful for Phase 2 workflows; optional for Phase 1)
- Sampling (deprecated)
- Roots (deprecated)
- Tasks extension (not needed for synchronous tools)

### 16.2 Phase 2 (Enterprise Knowledge Index)

**Build:**
- `index_document` tool + `query_index` tool with Entra ID ACL filtering
- `check_indexing_status` tool (explicit-handle pattern for long-running jobs)
- `knowledge://index/status` resource + `knowledge://documents/{id}` resource template
- OAuth 2.1 middleware with RFC 9728 metadata endpoint
- Per-tenant tool list scoping via bearer token scopes
- Entra ID `transitiveMemberOf` for group-based ACL
- Audit logging for every tool call
- Rate limiting per tenant (at gateway level)
- EMA / ID-JAG support for zero-touch enterprise rollout
- Elicitation for interactive indexing configuration (URL mode for OAuth, form mode for settings)

**Skip for Phase 2:**
- DCR (Dynamic Client Registration) — implement Client ID Metadata Documents instead
- Sampling — use direct LLM API calls if needed for summarization during indexing
- MCP Apps extension — UI belongs in the admin dashboard, not in the MCP protocol layer

### 16.3 Architecture Decision: Gateway vs Embedded

| Approach | Pros | Cons |
|----------|------|------|
| **Single server with embedded auth** | Simple deployment, no extra infrastructure | Auth logic coupled to tool logic |
| **MCP Gateway + backend server** | Centralized auth, routing, rate limiting; tool server stays clean | Extra component to deploy and maintain |

**Recommendation**: For Phase 1, embedded (single server). For Phase 2 with multi-tenant enterprise requirements, introduce a thin gateway that handles auth/rate limiting and proxies to the MCP server. The 2026-07-28 `Mcp-Method`/`Mcp-Name` headers make gateway routing easy.

### 16.4 Transport Strategy

```
Development: stdio (Claude Desktop via config)
   ↓
Self-hosted production: Streamable HTTP on port 3000 behind nginx/Caddy
   ↓
Enterprise multi-tenant: Streamable HTTP behind gateway with auth middleware
```

The same server binary supports all three scenarios via `MCP_TRANSPORT` environment variable.

### 16.5 Spec Version Targeting

Target `2026-07-28` as the primary spec version. The stateless model is better for horizontal scaling. For backward compatibility with clients still on 2025-11-25, include version negotiation in `server/discover`:

```json
{
  "supportedVersions": ["2026-07-28", "2025-11-25"],
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": { "listChanged": true, "subscribe": true }
  }
}
```

The SDK handles per-version compatibility when clients negotiate down.

---

## Summary: Key Design Rules for markdown-for-agents-mcp

1. **Stateless by default.** Every request carries all context in `_meta`. Use explicit handles (UUID from tool → passed back as argument) for any state that spans calls.

2. **Tools for actions, resources for data.** `fetch_url` is a tool (model decides when to call it). Index status is a resource (host injects it as context).

3. **Streamable HTTP for production.** stdio is fine for local dev/Claude Desktop. Never implement HTTP+SSE.

4. **Description is the LLM interface.** Write tool descriptions like API documentation: what it does, what it returns, what it doesn't do, constraints, error behavior.

5. **`isError: true` for tool failures, JSON-RPC error for protocol failures.** URL 404 = `isError: true`. Invalid JSON = JSON-RPC parse error.

6. **SSRF is the main security risk for web-fetch servers.** Validate URLs, resolve DNS before connecting, block private IP ranges including AWS metadata service.

7. **Cache tool lists.** `ttlMs: 3600000, cacheScope: "public"` for Phase 1. This directly improves LLM prompt cache hit rates when tools are in context.

8. **MCP Inspector for development.** Run it as part of CI with `--cli` mode for smoke testing.

9. **OAuth 2.1 for Phase 2 HTTP.** RFC 9728 Protected Resource Metadata + RFC 8707 audience binding are mandatory. Never skip the audience check.

10. **Enterprise auth = EMA/ID-JAG.** Not per-server consent screens. Wire Entra ID groups directly to tool scope grants.

---

*Sources:*
- *https://modelcontextprotocol.io/docs/concepts/architecture*
- *https://modelcontextprotocol.io/specification/2026-07-28*
- *https://modelcontextprotocol.io/specification/2025-03-26*
- *https://modelcontextprotocol.io/docs/concepts/tools*
- *https://modelcontextprotocol.io/docs/concepts/resources*
- *https://modelcontextprotocol.io/specification/2026-07-28/server/tools*
- *https://modelcontextprotocol.io/specification/2026-07-28/server/utilities (caching)*
- *https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation*
- *https://modelcontextprotocol.io/specification/2026-07-28/server/prompts*
- *https://modelcontextprotocol.io/docs/concepts/transports*
- *https://modelcontextprotocol.io/docs/tools/inspector*
- *https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/*
- *https://rollbrains.com/mcp/mcp-transports-compared/*
- *https://mcp-best-practice.github.io/mcp-best-practice/best-practice/*
- *https://rohitraj.tech/en/notes/mcp-server-authentication-oauth-guide-2026*
- *https://stacktr.ee/blog/mcp-resources-vs-tools-vs-prompts*
- *https://shahvatsal.com/blog/mcp-server-enterprise-registry-governance-2026*
- *https://dev.to/x4nent/complete-guide-to-mcp-model-context-protocol-in-2026-architecture-implementation-and-4a11*
