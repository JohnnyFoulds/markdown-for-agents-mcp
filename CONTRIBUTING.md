# Contributing Guidelines

Thank you for your interest in contributing to this project!

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- Clear title and description
- Steps to reproduce the behavior
- Expected vs actual behavior
- Environment details (Node.js version, OS)
- Logs if applicable

### Suggesting Features

Feature suggestions are welcome! Please provide:

- Clear description of the feature
- Use case and motivation
- Any relevant examples or references

### Pull Requests

1. Branch from `development`
2. Make your changes
3. Add or update tests — aim for >90% coverage
4. Run `npm run lint` and `npm run scan` — both must pass (0 errors, 0 high/critical findings) before opening a PR
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
6. Push to your fork and open a pull request against `development`

## Development Setup

```bash
# Clone repository
git clone https://github.com/JohnnyFoulds/markdown-for-agents-mcp.git
cd markdown-for-agents-mcp

# Install dependencies (Node.js >= 22 required)
npm install

# Install Playwright browsers
npx playwright install chromium

# Run tests
npm test

# Run tests with Redis store contract tests
REDIS_URL=redis://localhost:6379 npm test

# Build project
npm run build

# Run in development mode
npm run dev
```

## Code Style

### TypeScript
- Use strict mode (enforced by `tsconfig.json`)
- No JSDoc on obvious signatures — comments only for non-obvious WHY
- No `implicit any` in new code
- Use `const` over `let`; avoid `var`

### Directory structure

```
src/
├── index.ts          # Entry point: HTTP/stdio/worker bootstrap
├── config.ts         # Zod-validated env vars
├── server/           # Tool registry + graceful drain
├── tools/            # Tool definitions and handlers
├── render/           # 3-tier render ladder (http / lightpanda / playwright)
├── extract/          # HTML → format pipeline (selectors, pagination)
├── http/             # Unified HTTP client (retry, robots, rate-limit, proxy)
├── search/           # Search provider abstraction + fan-out
├── rank/             # Chunker + reranker (ONNX / TEI)
├── crawl/            # BFS crawl engine + async job worker
├── store/            # Pluggable stores (memory / sqlite / redis)
├── obs/              # Prometheus metrics + OTel
└── utils/            # Cache, domain blocklist, errors, logger
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body with one bullet per logical change]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `test`: Test additions or changes
- `chore`: Maintenance tasks

**Examples:**
```
feat(search): add Brave Search provider
fix(crawl): reclaim expired leases on worker restart
docs: update .env.example with reranker config
```

Do **not** add AI co-authorship lines to commits.

## Confidentiality

This repository is **public**. Never introduce a customer, client, or internal-platform
name into any file. Use generic vocabulary already established in
`docs/enterprise/OWNERSHIP.md` and `docs/enterprise/FSP_DEPLOYMENT.md` — terms like
"the deploying organisation", "the agent platform", and "the reference deployment".

A confidentiality pre-push hook is distributed with this project (not committed — it
lives in `.git/hooks/pre-push` of each local clone). It blocks pushes that add brand
markers in file content, paths, or commit messages.

## Testing

- Test each layer independently; mock at the DI seam (injected deps, not module internals)
- Aim for >90% statement coverage
- Run tests before committing: `npm test`
- Redis contract tests: `REDIS_URL=redis://localhost:6379 npm test`
- Real-browser tests: `RUN_BROWSER_TESTS=1 npm test`

All new MCP tools must have `outputSchema` and `toText` — enforced by `registry.test.ts`.

## Prerequisites

- **Node.js >= 22.0.0** (required for `node:sqlite` built-in)
- npm >= 8

## Questions?

Reach out via GitHub issues.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what's best for the community
