#!/usr/bin/env node
import { createRequire } from "module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateAndInitializeConfig } from "./config.js";
import { fetcher } from "./fetcher.js";
import { Logger } from "./utils/logger.js";
import { registerAll } from "./server/registry.js";
import { TOOLS } from "./tools/definitions.js";
import { initStores, closeStores } from "./store/factory.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

let isShuttingDown = false;
let workerAbort: AbortController | null = null;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  Logger.info(`Received ${signal}, initiating graceful shutdown...`);
  try {
    workerAbort?.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    await fetcher.close();
    await closeStores();
    Logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    Logger.error(`Error during shutdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM').catch(err => {
  Logger.error(`Unhandled shutdown error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}));
process.on('SIGINT', () => gracefulShutdown('SIGINT').catch(err => {
  Logger.error(`Unhandled shutdown error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}));

async function startHttpServer(mcpServer: McpServer, port: number): Promise<void> {
  const authToken = process.env['MCP_AUTH_TOKEN'];
  // TODO(Phase 7): switch to MCP_HTTP_MODE=stateless — current single shared transport
  // breaks N-replica deployments (session IDs bound to one instance).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

  const httpServer = createServer(async (req, res) => {
    if (authToken) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await mcpServer.connect(transport);
  httpServer.listen(port, () => {
    Logger.info(`markdown-for-agents-mcp HTTP server listening on port ${port}`);
    console.error(`markdown-for-agents-mcp server running on HTTP port ${port}`);
  });

  // TODO(Phase 7): replace with lifecycle.ts drain sequence — this handler races
  // the top-level SIGTERM handler registered above.
  process.on('SIGTERM', () => { httpServer.close(); });
}

async function startWorker(config: ReturnType<typeof validateAndInitializeConfig>): Promise<void> {
  const { runWorkerLoop } = await import('./crawl/engine.js');
  workerAbort = new AbortController();
  const workerId = randomUUID();

  // Run in background — don't await (main loop continues)
  runWorkerLoop({
    workerId,
    pollMs: config.CRAWL_WORKER_POLL_MS,
    leaseMs: config.CRAWL_QUEUE_LEASE_MS,
    batchSize: config.CRAWL_MAX_CONCURRENCY,
    signal: workerAbort.signal,
  }).catch(err => {
    Logger.error(`[worker] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function main() {
  let config: ReturnType<typeof validateAndInitializeConfig>;
  try {
    config = validateAndInitializeConfig();
    Logger.info("Configuration validated successfully");
  } catch (error) {
    console.error("Configuration error:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  // Determine run mode
  const roleArg = process.argv.includes('--role=worker') ? 'worker'
    : process.argv.includes('--role=both') ? 'both'
    : null;
  const role = roleArg ?? config.MCP_ROLE;

  const httpArgIdx = process.argv.indexOf('--http');
  const httpPort = httpArgIdx !== -1
    ? (parseInt(process.argv[httpArgIdx + 1] ?? '', 10) || 3000)
    : (process.env['HTTP_PORT'] ? Number(process.env['HTTP_PORT']) : null);
  const isHttpMode = httpPort != null;

  // Initialize stores
  await initStores({
    backend: config.STORE_BACKEND as 'auto' | 'memory' | 'sqlite' | 'redis',
    isHttpMode,
    sqlitePath: config.STORE_SQLITE_PATH,
    redisUrl: config.STORE_REDIS_URL,
  });
  Logger.info(`Stores initialized (backend=${config.STORE_BACKEND}, http=${isHttpMode})`);

  // Start worker loop if role includes worker
  if (role === 'worker' || role === 'both') {
    await startWorker(config);
  }

  // Start MCP server if role includes server
  if (role !== 'worker') {
    const server = new McpServer({ name: "markdown-for-agents-mcp", version });
    registerAll(server, {}, TOOLS);

    if (isHttpMode) {
      await startHttpServer(server, httpPort!);
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("markdown-for-agents-mcp server running on stdio");
    }
  } else {
    Logger.info("Running in worker-only mode (no MCP server)");
    // Keep process alive
    await new Promise<void>((_, reject) => {
      workerAbort!.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
