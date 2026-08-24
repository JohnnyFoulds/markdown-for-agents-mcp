import type { Stores } from './types.js';

let _stores: Stores | null = null;

export function getStores(): Stores {
  if (!_stores) throw new Error('Stores not initialized. Call initStores() first.');
  return _stores;
}

export async function initStores(opts: {
  backend: 'auto' | 'memory' | 'sqlite' | 'redis';
  isHttpMode: boolean;
  sqlitePath?: string;
  redisUrl?: string;
}): Promise<Stores> {
  if (_stores) return _stores;

  const { backend, isHttpMode, sqlitePath = 'crawl.db', redisUrl } = opts;

  const resolved = backend === 'auto' ? (isHttpMode ? 'sqlite' : 'memory') : backend;

  if (resolved === 'redis') {
    if (!redisUrl) throw new Error('STORE_BACKEND=redis requires STORE_REDIS_URL');
    const { createRedisStores } = await import('./redis/index.js');
    _stores = await createRedisStores(redisUrl);
  } else if (resolved === 'sqlite') {
    const { createSqliteStores } = await import('./sqlite/index.js');
    _stores = createSqliteStores(sqlitePath);
  } else {
    const { createMemoryStores } = await import('./memory/index.js');
    _stores = createMemoryStores();
  }

  return _stores;
}

export async function closeStores(): Promise<void> {
  if (!_stores) return;
  await Promise.allSettled([
    _stores.kv.close(),
    _stores.rateLimit.close(),
    _stores.queue.close(),
  ]);
  _stores = null;
}

/** For tests — reset singleton. */
export function resetStores(): void {
  _stores = null;
}
