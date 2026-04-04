# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this project, please report it responsibly.

**Do not** create a public GitHub issue for security concerns. Instead, contact the maintainers directly through private channels.

## Security Features

### Input Validation
- All URLs are validated using Zod schemas before processing
- URL format validation prevents injection attacks
- Domain blocking prevents access to malicious sites

### Network Security
- Configurable redirect limits (default: 10) to prevent redirect loops
- Same-origin redirect validation by default
- Domain allowlist/blocklist modes for fine-grained control
- Timeout enforcement prevents hanging connections

### Content Security
- Maximum content length enforcement (default: 100KB)
- Script and iframe removal during content extraction
- Dangerous HTML element filtering

### Configuration Security
- Environment variable validation at startup
- Fail-fast on invalid configuration
- No secrets in code or logs

## Safe Practices

### For Users
1. Use allowlist mode (`USE_ALLOWLIST_MODE=true`) for production deployments
2. Explicitly blocklist known malicious domains
3. Set reasonable timeouts based on your network
4. Monitor cache utilization and adjust limits as needed

### For Developers
1. Never commit `.env` files with actual values
2. Use `.env.example` as a template
3. Run security audits before releases
4. Keep dependencies updated

## Dependencies

This project uses the following dependencies with known security considerations:

| Dependency | Purpose | Security Notes |
|------------|---------|----------------|
| playwright | Browser automation | Updates browsers regularly |
| zod | Schema validation | Actively maintained |
| @modelcontextprotocol/sdk | MCP protocol | Official Anthropic SDK |

## Version Support

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

Only the latest release receives security updates.
