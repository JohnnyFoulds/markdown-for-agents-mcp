# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
