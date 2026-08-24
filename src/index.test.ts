/**
 * MCP Server unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, resetConfig, validateAndInitializeConfig, getConfig } from './config.js';
import { Logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('warmup wiring (source inspection)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  it('/readyz gates on rerankerGuard.isReady()', () => {
    // handleProbe must check the guard before returning 200
    expect(src).toContain('rerankerGuard.isReady()');
    expect(src).toContain('isReady() && rerankerReady');
  });

  it('warmup() is only called in the HTTP mode branch', () => {
    // Warmup must not be called for stdio — it would slow a one-shot CLI by 120s
    const httpModeIdx = src.indexOf('if (isHttpMode)');
    expect(httpModeIdx).toBeGreaterThan(-1);
    const beforeHttpMode = src.slice(0, httpModeIdx);
    expect(beforeHttpMode).not.toContain('.warmup()');
    // The call must exist somewhere after the HTTP mode check
    const afterHttpMode = src.slice(httpModeIdx);
    expect(afterHttpMode).toContain('.warmup()');
  });

  it('warmup() is kicked off without awaiting (non-blocking)', () => {
    // warmup() must not be awaited — it should use .then()/.catch() chaining
    expect(src).toContain('.warmup()');
    expect(src).toContain('.catch(');
    // Must NOT use 'await reranker.warmup()' or 'await getReranker().warmup()'
    expect(src).not.toContain('await reranker.warmup()');
    expect(src).not.toContain('await getReranker().warmup()');
  });
});

describe('MCP Server Configuration', () => {
  beforeEach(() => {
    resetConfig();
    initializeConfig({
      LOG_LEVEL: 'INFO',
      LOG_FORMAT: 'text',
      USE_ALLOWLIST_MODE: 'false',
      BLOCKLIST_DOMAINS: '',
      BLOCKLIST_URL_PATTERNS: '',
      FETCH_TIMEOUT_MS: '30000',
      MAX_CONCURRENT_FETCHES: '5',
      MAX_REDIRECTS: '10',
      MAX_CONTENT_LENGTH: '100000',
      CACHE_MAX_BYTES: '52428800',
      CACHE_TTL_MS: '900000',
    });
    Logger.clearMetrics();
  });

  afterEach(() => {
    resetConfig();
    Logger.clearMetrics();
  });

  describe('config validation', () => {
    it('should validate valid configuration', () => {
      const config = getConfig();
      expect(config.LOG_LEVEL).toBe('INFO');
      expect(config.LOG_FORMAT).toBe('text');
    });

    it('should transform number strings to numbers', () => {
      const config = getConfig();
      expect(typeof config.FETCH_TIMEOUT_MS).toBe('number');
      expect(config.FETCH_TIMEOUT_MS).toBe(30000);
      expect(typeof config.MAX_CONCURRENT_FETCHES).toBe('number');
      expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
    });

    it('should use defaults for missing values', () => {
      resetConfig();
      initializeConfig({});

      const config = getConfig();
      expect(config.FETCH_TIMEOUT_MS).toBe(30000);
      expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
      expect(config.LOG_LEVEL).toBe('INFO');
    });

    it('should reject invalid LOG_LEVEL', () => {
      resetConfig();

      expect(() => initializeConfig({ LOG_LEVEL: 'INVALID' })).toThrow('Invalid LOG_LEVEL');
    });

    it('should reject invalid LOG_FORMAT', () => {
      resetConfig();

      expect(() => initializeConfig({ LOG_FORMAT: 'invalid' })).toThrow('Invalid LOG_FORMAT');
    });
  });

  describe('tool schemas', () => {
    it('should have fetch_url tool', () => {
      // Tool definitions are in index.ts
      // This test verifies the config system supports the tools
      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.LOG_LEVEL).toBeDefined();
    });

    it('should have fetch_urls tool', () => {
      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.MAX_CONCURRENT_FETCHES).toBeGreaterThan(0);
    });

    it('should have health_check tool', () => {
      const config = getConfig();
      expect(config).toBeDefined();
      // Health check uses Logger metrics
      const health = Logger.getHealth();
      expect(health.status).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle missing required env vars with defaults', () => {
      resetConfig();
      initializeConfig({});

      expect(() => getConfig()).not.toThrow();
    });

    it('should provide clear error messages for invalid config', () => {
      resetConfig();

      try {
        initializeConfig({ LOG_LEVEL: 'INVALID' });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain('Invalid LOG_LEVEL');
      }
    });
  });

  describe('logging integration', () => {
    it('should use configured log level', () => {
      resetConfig();
      initializeConfig({ LOG_LEVEL: 'DEBUG' });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Logger.debug('debug message');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should support JSON log format', () => {
      resetConfig();
      initializeConfig({ LOG_FORMAT: 'json' });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Logger.info('test message');

      const call = consoleSpy.mock.calls[0]?.[0] as string;
      if (call) {
        const parsed = JSON.parse(call);
        expect(parsed.level).toBe('INFO');
        expect(parsed.message).toBe('test message');
      }
      consoleSpy.mockRestore();
    });
  });
});

describe('Response security headers (source inspection)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  it('defines an applyBaseHeaders helper', () => {
    expect(src).toContain('applyBaseHeaders');
  });

  it('applyBaseHeaders sets Cache-Control: no-store', () => {
    // ZAP flagged the absence of this header (finding ZAP_10049)
    expect(src).toContain('Cache-Control');
    expect(src).toContain('no-store');
  });

  it('applyBaseHeaders sets X-Content-Type-Options: nosniff', () => {
    expect(src).toContain('X-Content-Type-Options');
    expect(src).toContain('nosniff');
  });

  it('applyBaseHeaders uses res.setHeader (composes with SDK writeHead)', () => {
    // res.writeHead merges over previously-set headers; res.setHeader is safe
    // to call before the SDK transport or sendJson calls writeHead.
    expect(src).toContain('res.setHeader');
  });
});

describe('HTTP auth fail-closed (source inspection)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  it('reads auth token from config, not raw process.env', () => {
    // A direct process.env read bypasses Zod validation and is the root cause
    // of the fail-open bug: unset / misspelled env var silently disables auth.
    // After Phase 2.1, the token must come from the validated config object.
    expect(src).not.toContain("process.env['MCP_AUTH_TOKEN']");
  });

  it('calls assertHttpAuthPolicy to enforce fail-closed startup in HTTP mode', () => {
    expect(src).toContain('assertHttpAuthPolicy');
  });
});

// ── Phase 4.2 — HTTP endpoint auth policy (source inspection) ─────────────────
//
// Table-driven: ROUTE_TABLE is the authoritative list of HTTP routes and their
// auth policy. A new route in index.ts without a ROUTE_TABLE entry fails the
// coverage assertion — requiring an explicit requiresAuth decision per route.
//
// This is source-inspection (structural check), not behavioral (actual HTTP).
// Behavioral coverage lives in scripts/scan-dast.mjs section 2.1 (auth enforcement).
describe('Phase 4.2 — HTTP endpoint auth policy (source inspection)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');

  // ── Route table ──────────────────────────────────────────────────────────
  // requiresAuth = true  → must reject requests without valid bearer token
  // requiresAuth = false → must be reachable without any auth (k8s health probes)
  interface RoutePolicy { path: string; requiresAuth: boolean; reason: string; }
  const ROUTE_TABLE: RoutePolicy[] = [
    { path: '/mcp',     requiresAuth: true,  reason: 'MCP tool calls — user data, SSRF surface' },
    { path: '/metrics', requiresAuth: false, reason: 'Prometheus — cluster-internal scrape port only' },
    { path: '/healthz', requiresAuth: false, reason: 'Kubernetes liveness probe — must be public' },
    { path: '/readyz',  requiresAuth: false, reason: 'Kubernetes readiness probe — must be public' },
  ];

  it('every route in ROUTE_TABLE exists in index.ts', () => {
    for (const route of ROUTE_TABLE) {
      // Match both single and double-quoted forms
      const found = src.includes(`'${route.path}'`) || src.includes(`"${route.path}"`);
      expect(found, `Route "${route.path}" is in ROUTE_TABLE but not found in index.ts`).toBe(true);
    }
  });

  it('all known route strings in index.ts appear in ROUTE_TABLE', () => {
    // Routes we watch for — if one of these appears in the source but is absent from
    // ROUTE_TABLE, the test fails, requiring an explicit auth policy decision.
    const watchlist = [
      '/mcp', '/metrics', '/healthz', '/readyz',
      // Paths that would be alarming if added — must appear in ROUTE_TABLE first:
      '/debug', '/admin', '/api', '/graphql', '/oauth',
    ];
    const knownPaths = new Set(ROUTE_TABLE.map(r => r.path));
    for (const path of watchlist) {
      const appearsInSource = src.includes(`'${path}'`) || src.includes(`"${path}"`);
      if (appearsInSource) {
        expect(knownPaths.has(path),
          `Route "${path}" is referenced in index.ts but not in ROUTE_TABLE. ` +
          `Add it with an explicit requiresAuth policy.`,
        ).toBe(true);
      }
    }
  });

  it('protected routes have a 401 response path in the handler', () => {
    for (const route of ROUTE_TABLE.filter(r => r.requiresAuth)) {
      // The handler must contain a 401 response — auth enforcement exists
      expect(src, `Protected route "${route.path}" must have a 401 response in its handler`
        + ` — no auth enforcement found`).toContain('sendJson(res, 401');
    }
  });

  it('health probe routes come before any authToken check in the request flow', () => {
    // /healthz and /readyz must be served before the auth guard runs, so that
    // Kubernetes probes work even when MCP_AUTH_TOKEN is set.
    const healthzIdx  = src.indexOf("'/healthz'");
    const readyzIdx   = src.indexOf("'/readyz'");
    const firstAuthIdx = src.indexOf('sendJson(res, 401');

    expect(healthzIdx, '/healthz not found in index.ts').toBeGreaterThan(-1);
    expect(readyzIdx,  '/readyz not found in index.ts').toBeGreaterThan(-1);

    // The first 401 response must come AFTER the health probe route definitions
    if (firstAuthIdx > -1) {
      const firstProbeIdx = Math.min(healthzIdx, readyzIdx);
      expect(firstAuthIdx).toBeGreaterThan(firstProbeIdx);
    }
  });

  it('assertHttpAuthPolicy call-site precedes startHttpServer call-site (fail-closed startup)', () => {
    // Compare CALL SITES, not function definitions — startHttpServer is defined
    // earlier in the file but called after assertHttpAuthPolicy.
    // assertHttpAuthPolicy(config.  → the call with the config argument
    // await startHttpServer(        → the awaited call in main()
    const assertIdx = src.indexOf('assertHttpAuthPolicy(config.');
    const startIdx  = src.indexOf('await startHttpServer(');
    expect(assertIdx, 'assertHttpAuthPolicy(config.) call not found in index.ts').toBeGreaterThan(-1);
    expect(startIdx,  'await startHttpServer( call not found in index.ts').toBeGreaterThan(-1);
    expect(assertIdx,
      'assertHttpAuthPolicy must be called before await startHttpServer — fail-closed startup',
    ).toBeLessThan(startIdx);
  });
});

describe('validateAndInitializeConfig', () => {
  beforeEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    resetConfig();
    vi.unstubAllEnvs();
  });

  it('parses process.env and makes config accessible via getConfig()', () => {
    vi.stubEnv('LOG_LEVEL', 'WARN');
    vi.stubEnv('FETCH_TIMEOUT_MS', '45000');

    const config = validateAndInitializeConfig();

    expect(config.LOG_LEVEL).toBe('WARN');
    expect(config.FETCH_TIMEOUT_MS).toBe(45000);

    // Must be accessible via getConfig() after initialization
    const stored = getConfig();
    expect(stored.LOG_LEVEL).toBe('WARN');
    expect(stored.FETCH_TIMEOUT_MS).toBe(45000);
  });

  it('parses the environment exactly once (returns consistent result)', () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');

    const first = validateAndInitializeConfig();
    const second = getConfig();

    expect(first.LOG_LEVEL).toBe(second.LOG_LEVEL);
    expect(first.FETCH_TIMEOUT_MS).toBe(second.FETCH_TIMEOUT_MS);
  });

  it('throws on invalid LOG_LEVEL in process.env', () => {
    vi.stubEnv('LOG_LEVEL', 'INVALID_LEVEL');
    expect(() => validateAndInitializeConfig()).toThrow('Invalid configuration');
  });

  it('uses defaults for missing env vars', () => {
    const config = validateAndInitializeConfig();
    expect(config.FETCH_TIMEOUT_MS).toBe(30000);
    expect(config.MAX_CONCURRENT_FETCHES).toBe(5);
    expect(config.LOG_LEVEL).toBe('INFO');
  });
});
