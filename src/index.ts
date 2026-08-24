#!/usr/bin/env node
import { createRequire } from "module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateAndInitializeConfig } from "./config.js";
import { fetcher } from "./fetcher.js";
import { Logger } from "./utils/logger.js";
import { registerAll } from "./server/registry.js";
import { TOOLS } from "./tools/definitions.js";
import { initStores, closeStores, getStores } from "./store/factory.js";
import { gracefulDrain, setReady, isReady } from "./server/lifecycle.js";
import { Socks5Server } from "./proxy/socks5Server.js";
import { registry as metricsRegistry } from "./obs/metrics.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Probe paths that bypass bearer-token auth
const UNAUTHED_PATHS = new Set(['/healthz', '/readyz']);

/** Timing-safe bearer comparison — prevents timing side-channel on the token. */
function isValidBearer(authHeader: string, token: string): boolean {
  const expected = `Bearer ${token}`;
  // Hash both strings to a fixed-length digest so timingSafeEqual always
  // receives equal-length Buffers regardless of token length.
  const a = createHash('sha256').update(authHeader).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---- helpers ----------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function handleProbe(req: IncomingMessage, res: ServerResponse): boolean {
  const path = req.url?.split('?')[0] ?? '';
  if (path === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return true;
  }
  if (path === '/readyz') {
    if (isReady()) {
      sendJson(res, 200, { status: 'ok' });
    } else {
      sendJson(res, 503, { status: 'not_ready' });
    }
    return true;
  }
  return false;
}

async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url?.split('?')[0] ?? '';
  if (path !== '/metrics') return false;
  const data = await metricsRegistry.metrics();
  res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
  res.end(data);
  return true;
}

// ---- HTTP server ------------------------------------------------------------

async function startHttpServer(
  serverFactory: () => McpServer,
  port: number,
  mode: string,
): Promise<ReturnType<typeof createServer>> {
  const authToken = process.env['MCP_AUTH_TOKEN'];

  // Stateful mode: one shared server + transport (session affinity required).
  // Stateless mode: fresh server + transport per request (SDK requirement —
  // WebStandardStreamableHTTPServerTransport._hasHandledRequest guard rejects
  // any second call on the same instance with "Stateless transport cannot be
  // reused across requests").
  let sharedServer: McpServer | undefined;
  let sharedTransport: StreamableHTTPServerTransport | undefined;
  if (mode !== 'stateless') {
    sharedServer = serverFactory();
    sharedTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await sharedServer.connect(sharedTransport);
  }

  const httpServer = createServer(async (req, res) => {
    try {
      // Probes — always unauthenticated
      if (handleProbe(req, res)) return;

      // Metrics endpoint — behind bearer token if set
      if (req.url?.split('?')[0] === '/metrics') {
        if (authToken) {
          const auth = req.headers['authorization'] ?? '';
          if (!isValidBearer(auth, authToken)) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }
        }
        await handleMetrics(req, res);
        return;
      }

      // Auth guard for all other endpoints
      if (authToken) {
        const path = req.url?.split('?')[0] ?? '';
        if (!UNAUTHED_PATHS.has(path)) {
          const auth = req.headers['authorization'] ?? '';
          if (!isValidBearer(auth, authToken)) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }
        }
      }

      if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
        if (mode === 'stateless') {
          // Per-request server + transport — required by the SDK for stateless mode.
          const reqServer = serverFactory();
          const reqTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          await reqServer.connect(reqTransport);
          res.on('close', () => {
            reqTransport.close().catch(() => {});
            reqServer.close().catch(() => {});
          });
          await reqTransport.handleRequest(req, res);
        } else {
          await sharedTransport!.handleRequest(req, res);
        }
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      Logger.error(`HTTP handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  await new Promise<void>(resolve => httpServer.listen(port, resolve));
  Logger.info(`markdown-for-agents-mcp HTTP server listening on port ${port} (mode=${mode})`);
  console.error(`markdown-for-agents-mcp server running on HTTP port ${port}`);

  return httpServer;
}

// ---- metrics on separate port -----------------------------------------------

async function startMetricsServer(port: number): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/metrics') {
      const data = await metricsRegistry.metrics();
      res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
      res.end(data);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(port, resolve));
  Logger.info(`Metrics server listening on port ${port}`);
  return server;
}

// ---- worker -----------------------------------------------------------------

async function startWorker(
  pollMs: number,
  leaseMs: number,
  batchSize: number,
): Promise<AbortController> {
  const { runWorkerLoop } = await import('./crawl/engine.js');
  const abort = new AbortController();
  const workerId = randomUUID();

  runWorkerLoop({ workerId, pollMs, leaseMs, batchSize, signal: abort.signal }).catch(err => {
    Logger.error(`[worker] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return abort;
}

// ---- main -------------------------------------------------------------------

async function main() {
  let config: ReturnType<typeof validateAndInitializeConfig>;
  try {
    config = validateAndInitializeConfig();
    Logger.info("Configuration validated successfully");
  } catch (error) {
    console.error("Configuration error:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
    return;
  }

  const roleArg = process.argv.includes('--role=worker') ? 'worker'
    : process.argv.includes('--role=both') ? 'both'
    : null;
  const role = roleArg ?? config.MCP_ROLE;

  const httpArgIdx = process.argv.indexOf('--http');
  const httpPort = httpArgIdx !== -1
    ? (parseInt(process.argv[httpArgIdx + 1] ?? '', 10) || 3000)
    : (config.HTTP_PORT ?? null);
  const isHttpMode = httpPort != null;

  await initStores({
    backend: config.STORE_BACKEND as 'auto' | 'memory' | 'sqlite' | 'redis',
    isHttpMode,
    sqlitePath: config.STORE_SQLITE_PATH,
    redisUrl: config.STORE_REDIS_URL,
  });
  Logger.info(`Stores initialized (backend=${config.STORE_BACKEND}, http=${isHttpMode})`);

  // Wire rate limiter to shared store in HTTP mode
  if (isHttpMode && config.RATE_LIMIT_PER_HOST_RPS > 0) {
    const { httpClient: hc } = await import('./http/client.js');
    (hc as { setRateLimitStore?: (s: ReturnType<typeof getStores>['rateLimit']) => void })
      .setRateLimitStore?.(getStores().rateLimit);
    Logger.info('Rate limiter wired to shared store');
  }

  let workerAbort: AbortController | undefined;
  if (role === 'worker' || role === 'both') {
    workerAbort = await startWorker(
      config.CRAWL_WORKER_POLL_MS,
      config.CRAWL_QUEUE_LEASE_MS,
      config.CRAWL_MAX_CONCURRENCY,
    );
  }

  // Start SOCKS5 listener if configured
  let socks5Server: Socks5Server | undefined;
  if (config.SOCKS5_LISTEN_ENABLED) {
    if (config.SOCKS5_LISTEN_MODE === 'intercept') {
      Logger.error(
        '[socks5] SOCKS5_LISTEN_MODE=intercept is a TLS MITM appliance. ' +
        'It is not implemented — use tunnel mode or call the MCP tools directly.'
      );
      process.exit(1);
    }
    socks5Server = new Socks5Server({
      host: config.SOCKS5_LISTEN_HOST,
      port: config.SOCKS5_LISTEN_PORT,
      auth: config.SOCKS5_LISTEN_AUTH as 'none' | 'userpass',
      user: config.SOCKS5_LISTEN_USER,
      pass: config.SOCKS5_LISTEN_PASS,
      upstreamUrl: config.SOCKS5_UPSTREAM_URL,
      upstreamUser: config.SOCKS5_UPSTREAM_USER,
      upstreamPass: config.SOCKS5_UPSTREAM_PASS,
    });
    await socks5Server.listen();
  }

  let httpServer: ReturnType<typeof createServer> | undefined;
  let metricsServer: ReturnType<typeof createServer> | undefined;

  if (role !== 'worker') {
    const serverFactory = () => {
      const s = new McpServer({ name: "markdown-for-agents-mcp", version });
      registerAll(s, {}, TOOLS);
      return s;
    };

    if (isHttpMode) {
      httpServer = await startHttpServer(serverFactory, httpPort!, config.MCP_HTTP_MODE);

      if (config.METRICS_BIND_PORT) {
        metricsServer = await startMetricsServer(config.METRICS_BIND_PORT);
      }

      setReady(true);
      Logger.info('Server is ready');
    } else {
      const server = serverFactory();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("markdown-for-agents-mcp server running on stdio");
    }
  } else {
    Logger.info("Running in worker-only mode (no MCP server)");
    await new Promise<void>((_, reject) => {
      workerAbort!.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }

  // Register graceful drain (single handler — no more duplicate SIGTERM)
  const drainComponents = {
    httpServer,
    workerAbort,
    drainMs: config.SHUTDOWN_DRAIN_MS,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    closeStores: async () => {
      if (socks5Server) await socks5Server.close();
      await closeStores();
    },
    closeBrowserPool: async () => {
      const { browserPool } = await import('./render/browserPool.js').catch(() => ({ browserPool: null }));
      if (browserPool) await browserPool.drain(5000);
    },
    closeReranker: async () => {
      try {
        const { getReranker } = await import('./rank/index.js');
        const r = getReranker();
        await r.close();
      } catch {
        // rank module may not be initialised — safe to ignore
      }
    },
  };

  const onSignal = (sig: string) => gracefulDrain(sig, drainComponents).catch(err => {
    Logger.error(`Unhandled drain error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

  // Legacy browser close for non-HTTP mode
  if (!isHttpMode) {
    process.on('SIGTERM', () => {
      fetcher.close().finally(() => process.exit(0));
    });
    process.on('SIGINT', () => {
      fetcher.close().finally(() => process.exit(0));
    });
  } else {
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));
  }

  // Shut down metrics server alongside main server
  if (metricsServer) {
    process.on('exit', () => { metricsServer!.close(); });
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
