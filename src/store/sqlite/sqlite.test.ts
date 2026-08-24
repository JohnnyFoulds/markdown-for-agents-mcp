/**
 * SQLite-specific contract tests — PRAGMA and schema properties that don't
 * apply to the memory or Redis backends.
 *
 * Phase 2 RED reason (before fix):
 *   PRAGMA secure_delete is 0 on all three DatabaseSync connections opened by
 *   createSqliteStores(). Without it, deleted page bytes remain readable in
 *   SQLite freelist pages, defeating POPIA s19 physical safeguards.
 */

import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKvStore, SqliteRateLimitStore, SqliteJobQueue } from './index.js';

describe('SQLite — PRAGMA secure_delete = ON (POPIA s19)', () => {
  it('SqliteKvStore connection has secure_delete = 1', () => {
    // The store constructor runs PRAGMA secure_delete = ON before SCHEMA
    const store = new SqliteKvStore(':memory:');
    // Access the private db via bracket notation for the test
    const db = (store as unknown as { db: DatabaseSync }).db;
    const result = db.prepare('PRAGMA secure_delete').get() as { secure_delete: number };
    expect(result.secure_delete).toBe(1);
    void store.close();
  });

  it('SqliteRateLimitStore connection has secure_delete = 1', () => {
    const store = new SqliteRateLimitStore(':memory:');
    const db = (store as unknown as { db: DatabaseSync }).db;
    const result = db.prepare('PRAGMA secure_delete').get() as { secure_delete: number };
    expect(result.secure_delete).toBe(1);
    void store.close();
  });

  it('SqliteJobQueue connection has secure_delete = 1', () => {
    const store = new SqliteJobQueue(':memory:');
    const db = (store as unknown as { db: DatabaseSync }).db;
    const result = db.prepare('PRAGMA secure_delete').get() as { secure_delete: number };
    expect(result.secure_delete).toBe(1);
    void store.close();
  });
});
