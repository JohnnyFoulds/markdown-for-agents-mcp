# markdown-for-agents-mcp

An MCP (Model Context Protocol) server that fetches URLs with JavaScript rendering and converts them to clean, token-efficient markdown for AI agents.

## Features

- **JavaScript Rendering**: Uses Playwright to render JavaScript-heavy websites
- **Content Extraction**: Automatically strips navigation, ads, and boilerplate
- **Markdown Conversion**: Produces clean, LLM-friendly markdown output
- **Token Efficiency**: 80% fewer tokens than raw HTML
- **Cross-Platform**: Works on macOS, Linux, and Windows

## Installation

```bash
npm install -g markdown-for-agents-mcp
```

The package includes Playwright and will automatically install browsers on first run.

## Usage with Claude Code

Add to your `~/.claude/config.json` or `CLAUDE.md`:

```json
{
  "mcpServers": {
    "markdown": {
      "command": "markdown-mcp"
    }
  }
}
```

## Available Tools

### `fetch_url`
Fetch a single URL and return markdown.

**Arguments:**
- `url` (string): The URL to fetch

**Example:**
```
fetch_url(url="https://example.com")
```

### `fetch_urls`
Fetch multiple URLs and return markdown for each.

**Arguments:**
- `urls` (string[]): Array of URLs to fetch

**Example:**
```
fetch_urls(urls=["https://example.com", "https://blog.example.com"])
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev

# Test
npm test
```

## License

MIT
