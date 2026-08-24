/**
 * POPIA s14 retention sweep — unconditional, not under POPIA_MODE.
 *
 * Runs on a periodic timer started by the server/worker process.
 * Multi-replica safety: `kv.setNx('retention:lease', ...)` is an efficiency
 * measure (at most one pod does the sweep at a time), not a correctness
 * requirement — deletes are idempotent and batch-bounded by `limit`.
 *
 * The `retention_last_sweep_timestamp_seconds` Gauge is the artefact cited by
 * the compliance assessment: it demonstrates that sweeping runs and is
 * alertable as "no sweep in 2h".
 */

import type { Stores } from './types.js';
import { getConfig } from '../config.js';
import { retentionPurgedTotal, retentionLastSweepTimestamp } from '../obs/metrics.js';
import { Logger } from '../utils/logger.js';

const LEASE_KEY = 'retention:lease';
const SWEEP_LIMIT = 100; // max jobs per sweep pass — keeps each run bounded

export async function runRetentionSweep(stores: Stores): Promise<void> {
  let cfg: ReturnType<typeof getConfig>;
  try { cfg = getConfig(); } catch { return; }

  const cutoffMs = Date.now() - cfg.CRAWL_RETENTION_MS;

  // Efficiency lease: skip if another replica is already sweeping.
  // Lease TTL = sweep interval so it expires before the next sweep cycle.
  const leaseAcquired = await stores.kv.setNx(
    LEASE_KEY,
    Buffer.from('1'),
    cfg.RETENTION_SWEEP_INTERVAL_MS,
  );
  if (!leaseAcquired) return;

  try {
    // Purge old jobs from the queue/page store
    const purgedIds = await stores.queue.purgeOlderThan(cutoffMs, SWEEP_LIMIT);

    // Delete out-of-keyspace KV spec copies written by engine.ts
    for (const id of purgedIds) {
      await stores.kv.del(`job:${id}:spec`);
    }

    // Physically delete expired KV entries (SQLite lazy-expire only covers reads)
    const purgedKv = await stores.kv.purgeExpired();

    if (purgedIds.length > 0) {
      retentionPurgedTotal.inc({ backend: 'queue', entity: 'job' }, purgedIds.length);
    }
    if (purgedKv > 0) {
      retentionPurgedTotal.inc({ backend: 'kv', entity: 'entry' }, purgedKv);
    }

    retentionLastSweepTimestamp.set(Date.now() / 1000);
    Logger.info(`[retention] Sweep complete: ${purgedIds.length} jobs, ${purgedKv} KV entries purged`);
  } catch (err) {
    Logger.error(`[retention] Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function startRetentionTimer(stores: Stores): ReturnType<typeof setInterval> {
  const cfg = getConfig();
  // Unref so the timer does not keep the process alive on graceful drain
  const timer = setInterval(() => { void runRetentionSweep(stores); }, cfg.RETENTION_SWEEP_INTERVAL_MS).unref();
  return timer;
}
