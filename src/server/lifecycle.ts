import type { Server as HttpServer } from 'node:http';
import { Logger } from '../utils/logger.js';

export interface LifecycleComponents {
  httpServer?: HttpServer;
  workerAbort?: AbortController;
  drainMs: number;
  timeoutMs: number;
  closeReranker?: () => Promise<void>;
  closeBrowserPool?: () => Promise<void>;
  closeStores?: () => Promise<void>;
}

let readyzReady = false;

export function setReady(ready: boolean): void {
  readyzReady = ready;
}

export function isReady(): boolean {
  return readyzReady;
}

/**
 * Ordered graceful drain. Must be called at most once.
 *
 * Order:
 *   1. Flip readyz → false (stop new requests from reaching pods during Endpoints propagation)
 *   2. Wait drainMs for load-balancer to drain existing connections
 *   3. Stop HTTP server from accepting new connections
 *   4. Abort worker (releases held leases so another worker reclaims immediately)
 *   5. Wait for in-flight tool calls to finish, up to timeoutMs
 *   6. Drain browser pool (waits for active page leases)
 *   7. Close reranker worker thread
 *   8. Close stores
 *   9. Exit
 *
 * A hard-kill timer fires after drainMs + timeoutMs + 10s regardless.
 */
export async function gracefulDrain(
  signal: string,
  components: LifecycleComponents,
): Promise<void> {
  Logger.info(`[lifecycle] ${signal} — starting ordered drain`);

  // Hard-kill backstop
  const hardKill = setTimeout(() => {
    Logger.error('[lifecycle] Drain timed out — force exit');
    process.exit(1);
  }, components.drainMs + components.timeoutMs + 10_000).unref();

  try {
    // 1. Flip readyz
    setReady(false);

    // 2. Wait for LB Endpoints propagation
    if (components.drainMs > 0) {
      Logger.info(`[lifecycle] Waiting ${components.drainMs}ms for LB drain`);
      await sleep(components.drainMs);
    }

    // 3. Stop HTTP server
    if (components.httpServer) {
      await new Promise<void>((resolve) => {
        components.httpServer!.close(() => resolve());
      });
      Logger.info('[lifecycle] HTTP server closed');
    }

    // 4. Abort worker (leases released by worker loop on abort)
    components.workerAbort?.abort();

    // 5. Wait for in-flight requests (coarse — drainMs already covers most of it)
    if (components.timeoutMs > 0) {
      await sleep(Math.min(components.timeoutMs, 5_000));
    }

    // 6. Drain browser pool
    if (components.closeBrowserPool) {
      await components.closeBrowserPool();
      Logger.info('[lifecycle] Browser pool drained');
    }

    // 7. Close reranker
    if (components.closeReranker) {
      await components.closeReranker();
      Logger.info('[lifecycle] Reranker closed');
    }

    // 8. Close stores
    if (components.closeStores) {
      await components.closeStores();
      Logger.info('[lifecycle] Stores closed');
    }

    Logger.info('[lifecycle] Drain complete — exiting');
  } finally {
    clearTimeout(hardKill);
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
