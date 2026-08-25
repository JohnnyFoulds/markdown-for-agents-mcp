# Build, Setup, Deployment, and Installation Guide

## Prerequisites

- **Node.js**: >= 22.0.0 (required for `node:sqlite` built-in)
- **npm**: >= 8.0.0
- **Linux/macOS** (Playwright requires specific system dependencies on Linux)

---

## 1. Installation

### Step 1: Clone Repository

```bash
git clone https://github.com/JohnnyFoulds/markdown-for-agents-mcp.git
cd markdown-for-agents-mcp
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs all runtime and development dependencies, including:
- `@modelcontextprotocol/sdk` — MCP server framework
- `playwright` — Browser automation for Tier 3 rendering
- `markdown-for-agents` — HTML to markdown conversion library
- `undici` — Unified HTTP client (Tiers 1 & 2)
- `zod` — Env var validation
- `better-sqlite3` / `node:sqlite` — SQLite store backend
- `vitest` — Test framework

### Step 3: Install Playwright Browsers

```bash
npx playwright install chromium
```

Or run the postinstall script (run automatically by `npm install`):

```bash
npm run postinstall
```

To install system dependencies for Playwright (Linux):

```bash
npx playwright install-deps chromium
```

---

## 2. Build

### Development Mode

```bash
npm run dev
```

Compiles TypeScript to `dist/` and watches for changes.

### Production Build

```bash
npm run build
```

### Type Checking

```bash
npm run typecheck
```

---

## 3. Testing

### Run All Tests

```bash
npm test
```

### Run Tests in Watch Mode

```bash
npx vitest
```

### Run Specific Test File

```bash
npx vitest run src/converter.test.ts
```

### Run Tests with Coverage

```bash
npx vitest run --coverage
```

### Run with Redis Contract Tests

Start a local Redis first:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm test
```

### Run Real-Browser Tests

```bash
RUN_BROWSER_TESTS=1 npm test
```

---

## 4. Running the MCP Server

### stdio (default — zero config)

```bash
npx markdown-for-agents-mcp
# or after build:
node dist/index.js
```

### HTTP server mode

```bash
HTTP_PORT=3000 node dist/index.js
# or
node dist/index.js --http 3000
```

### Worker-only mode (crawl jobs)

```bash
MCP_ROLE=worker node dist/index.js
# or
node dist/index.js --role=worker
```

### Using with an MCP Client

```json
{
  "mcpServers": {
    "markdown-for-agents": {
      "command": "node",
      "args": ["/path/to/markdown-for-agents-mcp/dist/index.js"]
    }
  }
}
```

### CLI Testing

```bash
markdown-cli https://example.com          # single URL
markdown-cli -b https://a.com https://b.com  # batch
markdown-cli -s "typescript tutorials"    # web search
```

---

## 5. Available Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies and Playwright |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | TypeScript watch mode |
| `npm test` | Run all tests with Vitest |
| `npm run typecheck` | TypeScript type checking |
| `npx playwright install chromium` | Install Playwright browser |
| `node dist/index.js` | Run MCP server (stdio) |
| `HTTP_PORT=3000 node dist/index.js` | Run HTTP server |
| `MCP_ROLE=worker node dist/index.js` | Run crawl worker |

---

## 6. Project Structure

```
markdown-for-agents-mcp/
├── src/
│   ├── index.ts              # Entry point: HTTP/stdio/worker bootstrap
│   ├── config.ts             # Zod-validated env vars
│   ├── fetcher.ts            # URL fetcher (delegates to render ladder)
│   ├── converter.ts          # HTML → markdown
│   ├── server/
│   │   ├── registry.ts       # Tool registration loop
│   │   └── lifecycle.ts      # Graceful drain
│   ├── tools/
│   │   ├── definitions.ts    # All 13 tool definitions
│   │   ├── fetchUrl.ts
│   │   ├── fetchUrls.ts
│   │   └── types.ts
│   ├── render/               # 3-tier render ladder
│   │   ├── ladder.ts
│   │   ├── heuristic.ts
│   │   ├── browserPool.ts
│   │   └── tiers/            # httpTier, lightpandaTier, playwrightTier
│   ├── extract/              # HTML → format pipeline
│   ├── http/                 # Unified HTTP client
│   ├── search/               # Search provider abstraction
│   ├── rank/                 # Chunker + reranker
│   ├── crawl/                # BFS + async job worker
│   ├── store/                # Pluggable stores (memory/sqlite/redis)
│   ├── obs/                  # Prometheus metrics
│   └── utils/
├── scripts/
│   ├── dast/
│   │   └── detectors.mjs     # Pure probe-verdict logic (side-effect free, testable)
│   ├── install-playwright.js
│   ├── scan-dast.mjs         # Full-stack DAST probe runner
│   ├── scan-sast.mjs         # SAST / semgrep wrapper
│   └── scale-proof.mjs       # Docker scale integration proof
├── dist/                     # Compiled JavaScript (generated)
├── docker-compose.yml        # Local development stack
├── docker-compose.scale-test.yml  # Multi-replica scale test
├── Dockerfile
├── vitest.config.ts
├── tsconfig.json
└── package.json
```

---

## 7. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

All variables are documented in `.env.example`. Key variables for getting started:

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | _(unset)_ | Start HTTP server on this port |
| `MCP_AUTH_TOKEN` | _(unset)_ | Bearer token for HTTP mode |
| `STORE_BACKEND` | `auto` | `auto` \| `memory` \| `sqlite` \| `redis` |
| `STORE_REDIS_URL` | _(unset)_ | Redis URL when `STORE_BACKEND=redis` |
| `LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `RATE_LIMIT_PER_HOST_RPS` | `0` | Max requests/sec per host (0 = unlimited) |
| `RESPECT_ROBOTS_TXT` | `false` | Honour robots.txt |
| `RERANK_BACKEND` | `none` | `none` \| `local` \| `tei` |
| `MCP_ROLE` | `server` | `server` \| `worker` \| `both` |

---

## 8. Troubleshooting

### Playwright Installation Issues

```bash
rm -rf node_modules/.cache/playwright
npx playwright install chromium
```

### Node Version

```bash
node --version  # Must be >= 22.0.0
```

### TypeScript Compilation Errors

```bash
rm -rf dist node_modules
npm install
npm run build
```

### MCP Connection Issues

```bash
node dist/index.js 2>&1 | tee mcp.log
```

### Redis Connection

```bash
# Test Redis is reachable
redis-cli -u $STORE_REDIS_URL ping
```

---

## 9. Verification

```bash
# 1. Check Node version (must be >= 22)
node --version

# 2. Run tests
npm test

# 3. Build
npm run build

# 4. Type check
npm run typecheck

# 5. Lint
npm run lint

# 6. Security scan (SCA + SAST + secrets — no server needed)
npm run scan

# 7. Smoke test (stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node dist/index.js

# 8. Smoke test (HTTP)
HTTP_PORT=3456 node dist/index.js &
curl -s -X POST http://localhost:3456/healthz
kill %1
```

---

## 10. Container Deployment

### Dockerfile

The repo includes a production-ready `Dockerfile`. It uses the official Playwright base image to ensure Chromium is available without manual `apt-get` steps:

```dockerfile
# Build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage — Playwright's image has Chromium + all system deps
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Provide a properly-sized /dev/shm (Docker default 64 MB exhausts Chromium)
# In Docker: add shm_size: 1gb to compose; in k8s: emptyDir{medium:Memory}
# See SECURITY.md for the --disable-dev-shm-usage trade-off.

EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
```

> **Alpine is not supported.** Playwright does not ship a musl Chromium binary. Using `node:22-alpine` + `apk add chromium` requires setting `executablePath` manually and is unsupported.

Build and run:

```bash
docker build -t markdown-mcp .
docker run --rm --shm-size=1gb -e HTTP_PORT=3000 -p 3000:3000 markdown-mcp
```

### Docker Compose

```bash
# Development stack (server + worker + Redis)
docker compose up

# Multi-replica scale test (3 servers, 2 workers, nginx)
docker compose -f docker-compose.scale-test.yml up --scale mcp-server=3 --scale mcp-worker=2

# Run scale proof
node scripts/scale-proof.mjs
```

---

## 11. Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `playwright` | Tier 3 browser automation |
| `markdown-for-agents` | HTML to markdown conversion |
| `undici` | Unified HTTP client |
| `zod` | Config validation |
| `prom-client` | Prometheus metrics |

### Optional Runtime (lazy-imported)

| Package | Purpose |
|---------|---------|
| `ioredis` | Redis store backend |
| `@huggingface/transformers` | Local ONNX reranker |
| `@opentelemetry/sdk-node` | OpenTelemetry tracing |

### Development

| Package | Purpose |
|---------|---------|
| `vitest` | Test framework |
| `typescript` | TypeScript compiler |
| `@types/node` | Node.js type definitions |

---

## 12. Testing Checklist

- [ ] `node --version` shows >= 22.0.0
- [ ] `npm install` completes successfully
- [ ] `npx playwright install chromium` completes
- [ ] `npm test` shows all tests passing
- [ ] `npm run build` completes without errors
- [ ] `npm run typecheck` shows no errors
- [ ] `npm run lint` shows 0 errors (warnings acceptable)
- [ ] `npm run scan` exits 0 — no SCA critical/high CVEs, no SAST error/high findings, no secrets
- [ ] `node dist/index.js` starts in stdio mode
- [ ] `HTTP_PORT=3000 node dist/index.js` serves `/healthz` → 200
