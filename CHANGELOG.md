# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-04-06

### Fixed
- `scripts/install-playwright.js` added to `files` array — postinstall hook was silently failing for all npm users because the file was excluded from the published package
- `repository.url` changed from SSH (`git@github.com:...`) to HTTPS so npm renders the repository link correctly on the package page

### Added
- `homepage`, `bugs`, and `author` fields in `package.json`
- Expanded `keywords`: `web-scraping`, `fetch`, `spa`, `chromium`, `llm`, `mcp-server`, `javascript-rendering`
- Improved `description` — explicitly mentions React/Vue/Angular, Playwright/Chromium, and token efficiency

---

## [1.0.0] - 2026-04-06

### Added
- **Structured output** — `fetch_url`, `fetch_urls`, and `web_search` now return typed `structuredContent` alongside the text response (fields: `url`, `title`, `markdown`, `fetchedAt`, `contentSize`), compatible with MCP SDK 1.11+
- **HTTP server mode** — `--http [port]` flag or `HTTP_PORT` env var starts a Streamable HTTP transport server at `/mcp`; optional bearer token auth via `MCP_AUTH_TOKEN`
- **Proxy support** — `PLAYWRIGHT_PROXY` and `PLAYWRIGHT_PROXY_BYPASS` env vars route Playwright traffic through a proxy
- **Page title extraction** — `document.title` is extracted during rendering and used as the markdown heading (`# Title\n\nSource: url`) instead of the raw URL
- **Tool annotations** — all tools declare `readOnlyHint`, `idempotentHint`, and `destructiveHint` for MCP-aware clients
- `src/tools/types.ts` — shared `FetchUrlResult`, `FetchUrlsResult`, `WebSearchResult` interfaces

### Changed
- Migrated `index.ts` from `Server` + `setRequestHandler` to `McpServer` + `registerTool` (MCP SDK high-level API)
- Updated `@modelcontextprotocol/sdk` pin from `^1.0.0` to `^1.29.0`
- All tool functions now return typed result objects instead of raw markdown strings
- `converter.convertWithMetadata` gains optional `title` parameter

---

## [0.4.0] - 2026-04-06

### Changed
- Upgraded `typescript` from 5.x to 6.0
- Upgraded `eslint` from 9.x to 10.x
- Upgraded `@types/node` from 20.x to 25.x
- Upgraded `markdown-for-agents` from 1.0.0 to 1.3.4 (Node 22 support, bug fixes)

### Fixed
- TypeScript 6.0 compatibility: added `"types": ["node"]` to `tsconfig.json`
- TypeScript 6.0 compatibility: replaced removed `Global` type with plain interface in `config.ts`

---

## [0.3.0] - 2026-04-06

### Added
- `download_file` MCP tool — downloads binary files (PDFs, images, ZIPs, etc.) from a URL to a local path
- CLI `--download` / `-d` and `--output` / `-o` flags for downloading files
- `MAX_DOWNLOAD_BYTES` config option (default 50 MB) — separate limit from HTML truncation
- Mocked Playwright tests covering timeout, redirect, cache, and domain-blocking paths

### Fixed
- SSRF protection: block decimal-encoded IPs (e.g. `2130706433` = 127.0.0.1), IPv6 ULA (`fc00::/7`), and IPv6 unspecified (`::`)
- ReDoS protection: user-supplied `BLOCKLIST_URL_PATTERNS` now validated before compilation
- `download_file`: filename now derived from final URL after redirects (not the original)
- `download_file`: off-by-one in redirect loop
- `download_file`: uses `MAX_DOWNLOAD_BYTES` instead of `MAX_CONTENT_LENGTH`
- `outputPath` validated as absolute path before use
- `parseInt` missing radix in CLI argument parser
- `navigator.plugins` mock corrected to empty array
- Removed dead `validateConfig()` function from `config.ts`
- CI: pinned `codecov/codecov-action` to commit SHA; added `downloadFile.js` to build verification

### Changed
- Test coverage improved from 79% to 92%+

---

## [0.2.0] - 2026-04-06

### Added
- Centralized configuration module with Zod validation
- Structured logging with configurable log levels (DEBUG, INFO, WARN, ERROR)
- JSON log format support
- Request correlation IDs for tracing
- Graceful shutdown with signal handlers (SIGTERM, SIGINT)
- Health check tool for monitoring server status
- LRU cache with TTL and configurable size limits
- Domain blocking and URL pattern filtering
- Configurable redirect handling with loop detection
- Web search tool via DuckDuckGo with optional fetch-to-markdown
- CI/CD pipeline with Node.js matrix testing and npm publish workflow

### Changed
- Replaced hardcoded constants with centralized configuration
- Improved error messages and error handling
- Better initialization order safety with fallback config values

### Security
- Input validation using Zod schemas
- Domain allowlist/blocklist modes
- URL validation before fetching
- Redirect validation (same-origin only)

---

## [0.1.0] - 2026-04-04

### Added
- Initial release
- MCP server with `fetch_url` and `fetch_urls` tools
- JavaScript rendering with Playwright
- HTML to markdown conversion optimized for AI agents
- Content extraction that removes navigation, ads, and boilerplate
- Concurrent fetch limiting
- Content truncation for large pages
- Cache hit/miss logging
- Fetch duration metrics
