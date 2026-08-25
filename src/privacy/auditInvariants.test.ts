/**
 * N9 — Source-inspection guard for src/privacy/audit.ts.
 *
 * Because `hashCallerIdentity` is a per-callsite pull (registry.ts reads from
 * extra.requestInfo and attaches the hash), a future audit callsite could forget
 * it.  This test cannot prevent that, but it prevents the worse failure: someone
 * attaching the *raw* identity string to the audit event.
 *
 * Mirrors the house style of src/index.test.ts source-inspection tests.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIT_SRC = readFileSync(
  resolve(import.meta.dirname, 'audit.ts'),
  'utf-8',
);

describe('audit.ts source invariants', () => {
  it('does not import AsyncLocalStorage (identity must come from extra, not ambient state)', () => {
    expect(AUDIT_SRC).not.toContain('AsyncLocalStorage');
  });

  it('does not write a raw-identity field name to stderr (callerId / rawCaller / callerIdentity)', () => {
    // These identifiers would signal that the raw header value is being stored
    // rather than the hash.  'callerIdentityHeader' is an allowed config-name
    // reference (see negative lookahead comment), but is not currently used either.
    expect(AUDIT_SRC).not.toMatch(/["']callerId["']/);
    expect(AUDIT_SRC).not.toMatch(/["']rawCaller["']/);
    // callerIdentity without 'Header' suffix — the hash field is 'callerHash'
    expect(AUDIT_SRC).not.toMatch(/["']callerIdentity(?!Header)["']/);
  });

  it('emits callerHash (not caller) — guards against the raw-value field name appearing', () => {
    // The emitted JSON must name the field 'callerHash'.
    expect(AUDIT_SRC).toContain('callerHash');
    // 'caller' as a standalone key (without 'Hash') must not appear in the write() call.
    // We check by asserting the pattern "caller:" is absent — JSON.stringify with callerHash
    // would produce "callerHash:", never "caller:".
    const writeCalls = AUDIT_SRC.match(/process\.stderr\.write\([^)]+\)/gs) ?? [];
    for (const call of writeCalls) {
      expect(call).not.toMatch(/"caller"(?!Hash)/);
    }
  });
});
