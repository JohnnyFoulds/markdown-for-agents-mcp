/**
 * Config parity — bidirectional sync between configSchema and .env.example.
 *
 * Phase 7 RED (before fixes):
 *   Every key in .env.example must exist in configSchema.
 *   Fails on: ROBOTS_ON_ERROR, BROWSER_DISABLE_DEV_SHM, BROWSER_CHANNEL,
 *             RENDER_ESCALATE_THRESHOLD, RENDER_MIN_TEXT_CHARS,
 *             RENDER_TIER_MEMO_DECAY_PROB, OTEL_ENABLED
 *
 *   ROBOTS_ON_ERROR is the most important: robots.ts hardcodes 5xx → allow
 *   while RFC 9309 §2.3.1.4 says SHOULD assume complete disallow. Setting
 *   ROBOTS_ON_ERROR in the environment today does nothing — the var is silently
 *   ignored because it is absent from configSchema.
 *
 *   BROWSER_DISABLE_DEV_SHM is read directly from process.env in browserPool.ts,
 *   bypassing the Zod schema — same failure mode as the auth fail-open bug (Phase 2.1).
 *
 * Rule: adding a var to configSchema alone does not pass this test — it must
 * also appear in .env.example (and vice versa). A commit that adds one side
 * without the other will fail here before the author can push.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function envExampleKeys(): Set<string> {
  const text = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]+)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const schemaKeys = new Set(Object.keys(configSchema.shape));
const exampleKeys = envExampleKeys();

// ── .env.example → configSchema (catches documented-but-ignored vars) ─────────

describe('.env.example → configSchema (every .env.example var must be in schema)', () => {
  for (const key of exampleKeys) {
    it(`${key} is in configSchema`, () => {
      expect(schemaKeys.has(key),
        `${key} is in .env.example but missing from configSchema — setting it has no effect`
      ).toBe(true);
    });
  }
});

// ── configSchema → .env.example (catches schema-only undocumented vars) ───────

describe('configSchema → .env.example (every schema var must be in .env.example)', () => {
  for (const key of schemaKeys) {
    it(`${key} is in .env.example`, () => {
      expect(exampleKeys.has(key),
        `${key} is in configSchema but missing from .env.example — operators cannot discover or configure it`
      ).toBe(true);
    });
  }
});
