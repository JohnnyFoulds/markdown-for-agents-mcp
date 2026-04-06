# Build, Setup, Deployment, and Installation Guide

## Prerequisites

- **Node.js**: >= 20.0.0 (tested with Node 20 LTS and Node 22)
- **npm**: >= 8.0.0
- **Linux/MacOS** (Playwright requires specific system dependencies)

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

This installs:
- `@modelcontextprotocol/sdk` - MCP server framework
- `playwright` - Browser automation for JavaScript rendering
- `markdown-for-agents` - HTML to markdown conversion library
- `vitest` - Test framework
- `typescript` - TypeScript compiler

### Step 3: Install Playwright Browsers

```bash
npx playwright install chromium
```

Or run the postinstall script (automatically run by npm):

```bash
npm run postinstall
```

To install all Playwright browsers (recommended for development):

```bash
npx playwright install
```

To install system dependencies for Playwright:

```bash
npx playwright install-deps
```

---

## 2. Build

### Development Mode

Run TypeScript in watch mode:

```bash
npm run dev
```

This compiles TypeScript to `dist/` and watches for changes.

### Production Build

Compile TypeScript with type checking:

```bash
npm run build
```

This produces:
- `dist/index.js` - Compiled JavaScript
- `dist/index.d.ts` - TypeScript declarations

### Type Checking

Run TypeScript type checking without emitting files:

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

---

## 4. Running the MCP Server

### Direct Execution

```bash
node dist/index.js
```

Expected output:
```
markdown-for-agents-mcp server running on stdio
```

### As a CLI Tool

```bash
markdown-mcp
```

(The binary is defined in `package.json` as `markdown-mcp`)

### Using with an MCP Client

Configure your MCP client to use stdio transport:

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

Use the `markdown-cli` binary to test the server manually:

```bash
# Single URL fetch
markdown-cli https://example.com

# Batch fetch
markdown-cli -b https://example.com https://example.org

# Search
markdown-cli -s "typescript tutorials"
```

---

## 5. Available Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies and Playwright |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run dev` | TypeScript watch mode |
| `npm run test` | Run all tests with Vitest |
| `npm run typecheck` | TypeScript type checking |
| `npx playwright install` | Install Playwright browsers |
| `node dist/index.js` | Run MCP server |

---

## 6. Project Structure

```
markdown-for-agents-mcp/
├── src/
│   ├── index.ts          # MCP server entry point
│   ├── fetcher.ts        # Playwright-based URL fetcher
│   ├── converter.ts      # HTML to markdown converter
│   ├── fetcher.test.ts   # Fetcher unit tests (7 tests)
│   ├── converter.test.ts # Converter unit tests (13 tests)
│   └── tools/
│       ├── fetchUrl.ts   # Single URL fetch tool
│       ├── fetchUrl.test.ts   # Single URL tests (7 tests)
│       ├── fetchUrls.ts  # Batch URL fetch tool
│       └── fetchUrls.test.ts  # Batch URL tests (8 tests)
├── dist/                 # Compiled JavaScript (generated)
├── scripts/
│   └── install-playwright.js  # Playwright installation script
├── vitest.config.ts      # Vitest configuration
├── tsconfig.json         # TypeScript configuration
├── package.json          # Project dependencies and scripts
└── BUILD_INSTRUCTIONS.md # This file
```

---

## 7. Environment Variables

No environment variables are required for basic operation.

Optional environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PLAYWRIGHT_BROWSERS_PATH` | Custom Playwright browser path | System default |

---

## 8. Troubleshooting

### Playwright Installation Issues

If Playwright browsers fail to install:

```bash
# Remove existing installation
rm -rf node_modules/.cache/playwright

# Reinstall
npx playwright install chromium
```

### Permission Errors on Linux

Add the user to the appropriate groups:

```bash
sudo usermod -aG docker $USER
sudo usermod -aG video $USER
```

### TypeScript Compilation Errors

Clear and rebuild:

```bash
rm -rf dist node_modules
npm install
npm run build
```

### MCP Connection Issues

Check server logs:

```bash
node dist/index.js 2>&1 | tee mcp.log
```

---

## 9. Verification

After installation, verify everything works:

```bash
# 1. Check Node version
node --version  # Should be >= 20.0.0

# 2. Check npm version
npm --version   # Should be >= 8.0.0

# 3. Run tests
npm test        # Should show all tests passing

# 4. Build the project
npm run build   # Should complete without errors

# 5. Start the server (in background)
node dist/index.js &

# 6. Check if server is running
pgrep -f "dist/index.js"  # Should show PID

# 7. Kill server when done
kill <PID>
```

---

## 10. Deployment

### Container Deployment (Docker)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install Playwright dependencies
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certures fonts-terminus

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY src ./src
COPY scripts ./scripts
COPY vitest.config.ts ./vitest.config.ts
COPY tsconfig.json ./tsconfig.json

# Run postinstall
RUN npm run postinstall

# Build
RUN npm run build

# Expose nothing (stdio transport)
ENTRYPOINT ["node", "dist/index.js"]
```

Build and run:

```bash
docker build -t markdown-mcp .
docker run --rm markdown-mcp
```

### Global Installation

```bash
npm install -g markdown-for-agents-mcp
```

Then use:

```bash
markdown-mcp
```

---

## 11. Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP server framework |
| `playwright` | ^1.40.0 | Browser automation |
| `markdown-for-agents` | ^1.0.0 | HTML to markdown conversion |

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `vitest` | ^4.1.2 | Test framework |
| `typescript` | ^5.3.0 | TypeScript compiler |
| `@types/node` | ^20.19.39 | Node.js type definitions |

---

## 12. Testing Checklist

- [ ] `npm install` completes successfully
- [ ] `npx playwright install chromium` completes successfully
- [ ] `npm test` shows all tests passing
- [ ] `npm run build` completes without errors
- [ ] `npm run typecheck` shows no errors
- [ ] `node dist/index.js` starts and outputs success message

---

## 13. Build Artifacts

After `npm run build`, the following files are generated in `dist/`:

```
dist/
├── index.js          # Main entry point (ESM)
├── index.d.ts        # TypeScript declarations
├── fetcher.js
├── fetcher.d.ts
├── converter.js
├── converter.d.ts
└── tools/
    ├── fetchUrl.js
    ├── fetchUrl.d.ts
    └── fetchUrls.js
    └── fetchUrls.d.ts
```
