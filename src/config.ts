/**
 * Centralized configuration module
 * Validates and provides access to all environment variables
 */

import { z } from 'zod';

const configSchema = z.object({
  // Fetch settings
  FETCH_TIMEOUT_MS: z.string().default('30000').transform(Number),
  MAX_CONCURRENT_FETCHES: z.string().default('5').transform(Number),
  MAX_REDIRECTS: z.string().default('10').transform(Number),
  MAX_CONTENT_LENGTH: z.string().default('100000').transform(Number),

  // Logging
  LOG_LEVEL: z.string().default('INFO').refine(val => ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(val), {
    message: 'Invalid LOG_LEVEL',
  }),
  LOG_FORMAT: z.string().default('text').refine(val => ['text', 'json'].includes(val), {
    message: 'Invalid LOG_FORMAT',
  }),

  // Cache
  CACHE_MAX_BYTES: z.string().default('52428800').transform(Number), // 50MB
  CACHE_TTL_MS: z.string().default('900000').transform(Number), // 15 minutes

  // Security
  USE_ALLOWLIST_MODE: z.string().default('false').transform(val => val === 'true'),
  BLOCKLIST_DOMAINS: z.string().optional(),
  BLOCKLIST_URL_PATTERNS: z.string().optional(),

  // Web Search
  WEB_SEARCH_DEFAULT_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // File Download
  DOWNLOAD_TIMEOUT_MS: z.string().default('60000').transform(Number),
  MAX_DOWNLOAD_BYTES: z.string().default('52428800').transform(Number), // 50 MB

  // HTTP server mode
  HTTP_PORT: z.string().optional().transform(v => v ? Number(v) : undefined),

  // Proxy (HTTP_PROXY_URL is canonical; PLAYWRIGHT_PROXY kept as legacy alias)
  HTTP_PROXY_URL: z.string().optional(),
  PLAYWRIGHT_PROXY: z.string().optional(),
  PLAYWRIGHT_PROXY_BYPASS: z.string().optional(),

  // HTTP client
  RATE_LIMIT_PER_HOST_RPS: z.string().default('0').transform(Number),
  RATE_LIMIT_BURST: z.string().default('10').transform(Number),
  RATE_LIMIT_MAX_WAIT_MS: z.string().default('30000').transform(Number),
  RESPECT_ROBOTS_TXT: z.string().default('false').transform(val => val === 'true'),
  HTTP_DEFAULT_CHARSET: z.string().default('utf-8'),

  // Render ladder
  BROWSER_POOL_SIZE: z.string().default('1').transform(Number),
  RENDER_MAX_CONCURRENCY: z.string().default('4').transform(Number),
  RENDER_SETTLE_MS: z.string().default('2000').transform(Number),
  BROWSER_MAX_JOBS: z.string().default('50').transform(Number),
  RENDER_BLOCK_RESOURCES: z.string().default('true').transform(val => val === 'true'),

  // Lightpanda (Tier 2)
  LIGHTPANDA_ENABLED: z.string().default('false').transform(val => val === 'true'),
  LIGHTPANDA_CDP_URL: z.string().default('ws://127.0.0.1:9222'),
  LIGHTPANDA_MAX_FAILURE_RATE: z.string().default('0.4').transform(Number),

  // Search providers
  BRAVE_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),
  SEARXNG_URL: z.string().optional(),
  SEARCH_FANOUT_RESULTS: z.string().default('20').transform(Number),
  SEARCH_DEFAULT_COUNTRY: z.string().default('za'),
  SEARCH_DEFAULT_LANGUAGE: z.string().default('en'),
  LOG_REDACT_QUERIES: z.string().default('true').transform(val => val === 'true'),

  // Reranker
  RERANK_BACKEND: z.string().default('none').refine(v => ['none', 'local', 'tei'].includes(v), {
    message: 'RERANK_BACKEND must be none, local, or tei',
  }),
  RERANK_MODEL: z.string().default('Xenova/bge-reranker-base'),
  RERANK_DTYPE: z.string().default('q8'),
  RERANK_DEVICE: z.string().default('cpu'),
  RERANK_TEI_URL: z.string().optional(),

  // Stores (Phase 6)
  // 'auto' = memory for stdio, sqlite for http
  STORE_BACKEND: z.string().default('auto').refine(v => ['auto', 'memory', 'sqlite', 'redis'].includes(v), {
    message: 'STORE_BACKEND must be auto, memory, sqlite, or redis',
  }),
  STORE_SQLITE_PATH: z.string().default('crawl.db'),
  STORE_REDIS_URL: z.string().optional(),

  // Crawl engine (Phase 6)
  CRAWL_MAX_PAGES: z.string().default('1000').transform(Number),
  CRAWL_MAX_DEPTH: z.string().default('10').transform(Number),
  CRAWL_MAX_CONCURRENCY: z.string().default('5').transform(Number),
  CRAWL_QUEUE_LEASE_MS: z.string().default('30000').transform(Number),
  CRAWL_WORKER_POLL_MS: z.string().default('1000').transform(Number),

  // Process role (Phase 6)
  MCP_ROLE: z.string().default('server').refine(v => ['server', 'worker', 'both'].includes(v), {
    message: 'MCP_ROLE must be server, worker, or both',
  }),

  // SOCKS5 gateway (Phase 10)
  // Ingress listener — a policy-enforcing SOCKS5 relay on loopback
  SOCKS5_LISTEN_ENABLED: z.string().default('false').transform(val => val === 'true'),
  SOCKS5_LISTEN_HOST: z.string().default('127.0.0.1'),
  SOCKS5_LISTEN_PORT: z.string().default('1080').transform(Number),
  // 'tunnel' = CONNECT relay (recommended); 'intercept' = TLS MITM (requires CA)
  SOCKS5_LISTEN_MODE: z.string().default('tunnel').refine(v => ['tunnel', 'intercept'].includes(v), {
    message: 'SOCKS5_LISTEN_MODE must be tunnel or intercept',
  }),
  // 'none' = no auth required; 'userpass' = RFC 1929 username/password
  SOCKS5_LISTEN_AUTH: z.string().default('none').refine(v => ['none', 'userpass'].includes(v), {
    message: 'SOCKS5_LISTEN_AUTH must be none or userpass',
  }),
  SOCKS5_LISTEN_USER: z.string().optional(),
  SOCKS5_LISTEN_PASS: z.string().optional(),
  // intercept mode only — operator must supply the CA; never auto-generated
  SOCKS5_INTERCEPT_CA_CERT: z.string().optional(),
  SOCKS5_INTERCEPT_CA_KEY: z.string().optional(),

  // Upstream SOCKS5 egress — used by all three render tiers
  SOCKS5_UPSTREAM_URL: z.string().optional(),
  SOCKS5_UPSTREAM_USER: z.string().optional(),
  SOCKS5_UPSTREAM_PASS: z.string().optional(),

  // Stealth + proxy rotation (Phase 8)
  // STEALTH_ENABLED: use playwright-extra + puppeteer-extra-plugin-stealth for Tier 3
  STEALTH_ENABLED: z.string().default('false').transform(val => val === 'true'),
  // PROXY_PINS: JSON array of proxy URLs for round-robin rotation, e.g. '["http://p1:3128","http://p2:3128"]'
  PROXY_PINS: z.string().optional(),

  // HTTP transport mode (Phase 7)
  // 'stateless' = no session affinity, any replica serves any request (default for N-replica)
  // 'session'   = stateful sessions, requires Ingress affinity on Mcp-Session-Id
  MCP_HTTP_MODE: z.string().default('stateless').refine(v => ['stateless', 'session'].includes(v), {
    message: 'MCP_HTTP_MODE must be stateless or session',
  }),

  // Graceful drain (Phase 7)
  SHUTDOWN_DRAIN_MS: z.string().default('5000').transform(Number),
  SHUTDOWN_TIMEOUT_MS: z.string().default('30000').transform(Number),

  // Metrics (Phase 7)
  METRICS_BIND_PORT: z.string().optional().transform(v => v ? Number(v) : undefined),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Get configuration - throws if not initialized
 */
export function getConfig(): Config {
  const globalWithConfig = globalThis as GlobalWithConfig;
  if (!globalWithConfig.__config) {
    throw new Error(
      'Configuration not initialized. Call validateAndInitializeConfig() first.'
    );
  }
  return globalWithConfig.__config;
}

/**
 * Initialize configuration (for testing)
 */
export function initializeConfig(env: Record<string, string>): Config {
  const globalWithConfig = globalThis as GlobalWithConfig;
  globalWithConfig.__config = configSchema.parse(env);
  return globalWithConfig.__config;
}

/**
 * Validate configuration from process.env, store globally, and return it.
 * Parses the environment exactly once.
 */
export function validateAndInitializeConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((e) =>
      `  - ${e.path.join('.')}: ${e.message}`
    ).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const globalWithConfig = globalThis as GlobalWithConfig;
  globalWithConfig.__config = result.data;
  return result.data;
}

// Store config in global for testing
interface GlobalWithConfig {
  __config?: Config;
}

export function resetConfig(): void {
  delete (globalThis as GlobalWithConfig).__config;
}
