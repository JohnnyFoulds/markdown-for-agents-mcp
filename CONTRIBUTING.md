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

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly
5. Commit using conventional commits (`feat: add amazing feature`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Development Setup

```bash
# Clone repository
git clone https://github.com/your-org/markdown-for-agents-mcp.git
cd markdown-for-agents-mcp

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Run tests
npm test

# Build project
npm run build

# Run in development mode
npm run dev
```

## Code Style

### TypeScript
- Use strict mode (enforced by tsconfig.json)
- All functions must have JSDoc comments
- Type hints required for all parameters and return values
- Use `const` over `let`; avoid `var`

### File Organization
- Co-located tests (`.test.ts` next to source files)
- Utility functions in `src/utils/`
- MCP tools in `src/tools/`

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
feat: add support for custom user agents
fix: resolve timeout issue on slow connections
docs: update environment variable documentation
refactor: extract config validation to separate function
```

## Testing

- Test each service layer function independently
- Mock external dependencies (Playwright, network)
- Aim for >80% code coverage
- Run tests before committing: `npm test`

## Questions?

Feel free to reach out with questions via GitHub issues or direct contact.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what's best for the community
