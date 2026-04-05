# markdown-for-agents-mcp

An MCP (Model Context Protocol) server that fetches URLs with JavaScript rendering and converts them to clean, token-efficient markdown for AI agents.

## Overview

This tool enables AI agents to fetch web content from JavaScript-heavy websites and convert it to clean markdown optimized for LLM processing. It automatically strips navigation, ads, and boilerplate content, delivering 80% fewer tokens than raw HTML.

## Features

- **JavaScript Rendering**: Uses Playwright to fully render JavaScript-heavy websites (React, Vue, Angular apps)
- **Content Extraction**: Automatically identifies and extracts main article content
- **Boilerplate Removal**: Strips navigation, ads, headers, footers, and other non-essential elements
- **Token Efficiency**: Produces clean, LLM-friendly markdown output
- **Web Search**: DuckDuckGo search with optional fetch-to-markdown for top results
- **Domain Filtering**: Block or allow specific domains in both fetch and search operations
- **Cross-Platform**: Works on macOS, Linux, and Windows
- **Zero Configuration**: Auto-installs all dependencies on first run

## Installation

```bash
npm install -g markdown-for-agents-mcp
```

The package includes Playwright and will automatically install Chromium browser on first run.

## Configuration

### Environment Variables

Configure the server using environment variables. Create a `.env` file or set them in your shell:

```bash
# Fetch settings
FETCH_TIMEOUT_MS=30000              # Timeout for fetch requests (ms)
MAX_CONCURRENT_FETCHES=5            # Maximum parallel fetches
STABILIZATION_DELAY_MS=2000         # Wait for JS rendering (ms)
MAX_REDIRECTS=10                    # Max redirect hops
MAX_CONTENT_LENGTH=100000           # Max content size (chars)

# Logging
LOG_LEVEL=INFO                      # DEBUG, INFO, WARN, ERROR
LOG_FORMAT=text                     # text or json

# Cache
CACHE_MAX_BYTES=52428800            # Max cache size (50MB)
CACHE_TTL_MS=900000                 # Cache TTL (15 minutes)

# Security
USE_ALLOWLIST_MODE=false            # Only allow whitelisted domains
BLOCKLIST_DOMAINS=                  # Comma-separated blocked domains

# Web Search
WEB_SEARCH_MAX_RESULTS=10           # Maximum search results to return
WEB_SEARCH_DEFAULT_TIMEOUT_MS=30000 # Default timeout for search (ms)
```

See `.env.example` for all options with descriptions.

### MCP Configuration

Add to your `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp"
    }
  }
}
```

Or in VS Code settings (`claude.json`):

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp"
    }
  }
}
```

### Available Tools

#### `fetch_url`

Fetches a single URL with JavaScript rendering and converts to clean markdown.

**Arguments:**
- `url` (string, required): The URL to fetch and convert

**Example:**
```typescript
fetch_url(url="https://example.com/blog/post")
```

**Output:**
```markdown
# Blog Post Title

This is the main content of the article, stripped of navigation, ads, and boilerplate.

## Related Section

More content here...
```

#### `fetch_urls`

Fetches multiple URLs and returns markdown for each in a single operation.

**Arguments:**
- `urls` (string[], required): Array of URLs to fetch

**Example:**
```typescript
fetch_urls(urls=[
  "https://example.com/post1",
  "https://example.com/post2",
  "https://blog.example.com/article"
])
```

**Output:**
```markdown
## URL: https://example.com/post1
# Post 1 Title
...

---

## URL: https://example.com/post2
# Post 2 Title
...

---
```

#### `web_search`

Searches DuckDuckGo and optionally fetches top results to markdown. Returns structured search results with title, URL, and snippet, plus optional full page content.

**Arguments:**
- `query` (string, required): The search query
- `maxResults` (number, optional): Maximum results to return (default: 10)
- `allowedDomains` (string[], optional): Only include results from these domains
- `blockedDomains` (string[], optional): Exclude results from these domains
- `fetchResults` (boolean, optional): Fetch and convert top results to markdown
- `timeout` (number, optional): Request timeout in milliseconds

**Example:**
```typescript
web_search(
  query="typescript tutorials",
  maxResults=5,
  allowedDomains=["typescriptlang.org", "github.com"]
)
```

**Example with fetchResults:**
```typescript
web_search(
  query="react hooks guide",
  fetchResults=true,
  maxResults=3
)
```

**Output (structured):**
```markdown
# Web Search Results

## Query: typescript tutorials
**Found 5 results in 1234ms**

### Results:

1. [TypeScript Handbook](https://www.typescriptlang.org/docs/)
   The TypeScript Handbook provides comprehensive documentation...

2. [Best TypeScript Tutorials](https://github.com/danistefanovic/build-your-own-typescript)
   Learn TypeScript by building your own compiler...

---

## Fetched Content:

### https://www.typescriptlang.org/docs/
# TypeScript Documentation
Content from the page...
```

## CLI Usage

You can also use this tool directly from the command line without the MCP protocol.

### Installation

```bash
npm install -g markdown-for-agents-mcp
```

### Single URL

Fetch a single URL and output markdown to stdout:

```bash
markdown-cli https://example.com
```

**Output:**
```markdown
# Example Domain

This domain is for use in documentation examples without needing permission.

[Learn more](https://iana.org/domains/example)

---
*Converted by markdown-for-agents-mcp*
```

### Multiple URLs

Fetch multiple URLs using batch mode:

```bash
markdown-cli -b https://example.com https://example.org https://example.net
```

**Output:**
```markdown
## URL: https://example.com

# Example Domain
...

---

## URL: https://example.org

# Example Domain
...

---
```

### Command Reference

| Command | Description |
|---------|-------------|
| `markdown-cli <url>` | Fetch single URL and output markdown |
| `markdown-cli -b <url1> <url2> ...` | Fetch multiple URLs in batch mode |
| `markdown-cli --help` | Show help message |

### Examples

```bash
# Single article
markdown-cli https://example.com/blog/my-article

# Research multiple sources
markdown-cli -b \
  https://example.com/api/docs \
  https://example.com/guides/setup \
  https://example.com/tutorials/getting-started

# Save to file
markdown-cli https://example.com > article.md
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server Layer                         │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐     │
│  │ index.ts    │  │ fetchUrl.ts  │  │ fetchUrls.ts    │     │
│  │ (entry)     │──│ (tool 1)     │──│ (tool 2)        │     │
│  └─────────────┘  └──────────────┘  └─────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Service Layer                            │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐     │
│  │ fetcher.ts  │──│ converter.ts │──│ markdown        │     │
│  │ (Playwright)│  │ (HTML→MD)    │  │ library         │     │
│  └─────────────┘  └──────────────┘  └─────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Components

1. **MCP Server Layer** (`index.ts`, `tools/`)
   - Registers available tools with the MCP protocol
   - Validates input arguments
   - Routes requests to appropriate handlers

2. **Service Layer** (`fetcher.ts`, `converter.ts`)
   - `fetcher.ts`: Uses Playwright to render JavaScript and extract HTML
   - `converter.ts`: Converts HTML to clean markdown

## Development

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn

### Setup

```bash
# Clone repository
git clone https://github.com/JohnnyFoulds/markdown-for-agents-mcp.git
cd markdown-for-agents-mcp

# Install dependencies (includes Playwright installation)
npm install
```

### Building

```bash
npm run build        # Compile TypeScript
npm run dev          # Development mode with watch
npm run typecheck    # Type checking only
```

### Testing

```bash
npm test             # Run test suite
```

### Configuration

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
# Edit .env with your settings
```

### Running Locally

```bash
# Build first
npm run build

# Run MCP server
node dist/index.js
```

### Debugging

Enable debug logging:

```bash
LOG_LEVEL=DEBUG node dist/index.js
```

Or use JSON format:

```bash
LOG_LEVEL=DEBUG LOG_FORMAT=json node dist/index.js
```

## Troubleshooting

### Playwright Installation Issues

If Playwright browsers fail to install automatically:

```bash
npx playwright install chromium
```

### MCP Connection Issues

Check server logs:

```bash
markdown-mcp 2>&1 | tee mcp.log
```

### Browser Launch Failures

On Linux systems, ensure sandbox is disabled:

```bash
# Check if running in container
npx playwright install-deps chromium
```

### Build Errors

Clear and rebuild:

```bash
rm -rf node_modules dist
npm install
npm run build
```

## License

MIT

## Contributing

Contributions welcome! Please follow the existing code style and add tests for new features.

1. Create a feature branch from `development`
2. Make your changes
3. Add tests
4. Submit a pull request
