import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryKvStore } from '../memory/index.js';
import { SqliteKvStore } from '../sqlite/index.js';
import type { KeyValueStore } from '../types.js';

function runKvContract(name: string, factory: () => KeyValueStore) {
  describe(`KeyValueStore contract — ${name}`, () => {
    let store: KeyValueStore;
    beforeEach(() => { store = factory(); });
    afterEach(async () => { await store.close(); });

    it('get returns undefined for missing key', async () => {
      expect(await store.get('missing')).toBeUndefined();
    });

    it('set and get round-trips a buffer', async () => {
      const val = Buffer.from('hello');
      await store.set('k', val, 0);
      const result = await store.get('k');
      expect(result).toBeDefined();
      expect(result!.toString()).toBe('hello');
    });

    it('del removes a key', async () => {
      await store.set('k', Buffer.from('v'), 0);
      await store.del('k');
      expect(await store.get('k')).toBeUndefined();
    });

    it('TTL expires entries', async () => {
      await store.set('k', Buffer.from('v'), 1); // 1ms TTL
      await new Promise(r => setTimeout(r, 10));
      expect(await store.get('k')).toBeUndefined();
    });

    it('setNx succeeds when key absent', async () => {
      const set = await store.setNx('k', Buffer.from('v'), 0);
      expect(set).toBe(true);
      expect((await store.get('k'))?.toString()).toBe('v');
    });

    it('setNx fails when key exists', async () => {
      await store.set('k', Buffer.from('v1'), 0);
      const set = await store.setNx('k', Buffer.from('v2'), 0);
      expect(set).toBe(false);
      expect((await store.get('k'))?.toString()).toBe('v1');
    });

    it('stats returns backend name and entry count', async () => {
      await store.set('a', Buffer.from('1'), 0);
      await store.set('b', Buffer.from('2'), 0);
      const stats = await store.stats();
      expect(stats.backend).toBeTruthy();
      expect(stats.entries).toBe(2);
    });
  });
}

runKvContract('memory', () => new MemoryKvStore());
runKvContract('sqlite', () => new SqliteKvStore(':memory:'));
