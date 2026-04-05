# CLAUDE.md

This file provides guidance to Claude Code when working with the `markdown-for-agents-mcp` codebase.

## Purpose

An MCP (Model Context Protocol) server that fetches URLs with JavaScript rendering and converts them to clean, token-efficient markdown for AI agents.

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
│  │ fetcher.ts  │──│ converter.ts │──│  markdown       │     │
│  │ (Playwright)│  │ (HTML→MD)    │  │  library        │     │
│  └─────────────┘  └──────────────┘  └─────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/
├── index.ts          # MCP server entry point, tool registration
├── fetcher.ts        # Playwright-based URL fetcher with JS rendering
├── converter.ts      # HTML to markdown conversion
└── tools/
    ├── fetchUrl.ts   # Single URL fetch tool implementation
    └── fetchUrls.ts  # Batch URL fetch tool implementation
```

## MCP Tools

### `fetch_url`
Fetches a single URL with JavaScript rendering and converts to markdown.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string" }
  },
  "required": ["url"]
}
```

### `fetch_urls`
Fetches multiple URLs and returns markdown for each.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "urls": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["urls"]
}
```

## Development Workflow

### Prerequisites
- Node.js >= 18.0.0
- npm or yarn

### Building
```bash
npm install
npm run build
```

### Testing
```bash
npm test
```

### Development Mode
```bash
npm run dev  # TypeScript watch mode
```

## Coding Standards

### TypeScript
- Strict mode enabled
- All functions must have JSDoc comments
- Type hints required for all parameters and return values

### Error Handling
- Use try/catch for external operations (network, file system)
- Return user-friendly error messages
- Log errors with context

### MCP Protocol
- Follow `@modelcontextprotocol/sdk` patterns
- Tools must validate input arguments before processing
- Return errors in MCP error format

## Testing Guidelines

### Unit Tests
- Test each service layer function independently
- Mock Playwright and external dependencies
- Aim for >80% code coverage

### Integration Tests
- Test full MCP tool flow with real URLs
- Include timeout handling tests
- Test error cases (invalid URLs, network failures)

## Troubleshooting

### Playwright Installation Issues
If Playwright browsers fail to install:
```bash
npx playwright install chromium
```

### MCP Connection Issues
Check server logs:
```bash
markdown-mcp 2>&1 | tee mcp.log
```

### Build Errors
Clear and rebuild:
```bash
rm -rf node_modules dist
npm install
npm run build
```

## Branch Strategy

- `main` - Production-ready releases
- `development` - Active development

## Dependencies

- `@modelcontextprotocol/sdk` - MCP server framework
- `playwright` - JavaScript rendering
- `markdown-for-agents` - HTML to markdown conversion

## Commit Guidelines

- Conventional Commits (`type(scope): subject`).
- Non-trivial commits must include a body with one bullet per logical change.
- No AI co-authorship lines.
