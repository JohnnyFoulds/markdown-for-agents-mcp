/**
 * Audit event emitter — unit tests.
 *
 * Phase 4 RED (before creating src/privacy/audit.ts):
 *   "Cannot find module './audit.js'"
 *
 * The critical invariant: emitAudit writes to stderr regardless of
 * LOG_LEVEL and LOG_FORMAT, both of which suppress normal Logger output.
 */

import { vi, describe, it, expect, afterEach } from 'vitest';
import { emitAudit, type AuditEvent } from './audit.js';
import { initializeConfig } from '../config.js';

const BASE_EVENT: AuditEvent = {
  requestId: 'req-test-1',
  tool: 'fetch_url',
  timestamp: 1_700_000_000_000,
  outcome: 'success',
  piiClasses: [],
  action: 'logged',
};

const BASE_EVENT_WITH_CALLER: AuditEvent = {
  ...BASE_EVENT,
  callerHash: '0123456789abcdef',
};

describe('emitAudit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    initializeConfig({});
  });

  it('writes to stderr even when LOG_LEVEL=ERROR and LOG_FORMAT=text', () => {
    initializeConfig({ LOG_LEVEL: 'ERROR', LOG_FORMAT: 'text' });
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT);

    expect(spy).toHaveBeenCalledOnce();
    const written = spy.mock.calls[0]![0] as string;
    const parsed: Record<string, unknown> = JSON.parse(written);
    expect(parsed['audit']).toBe(true);
    expect(parsed['tool']).toBe('fetch_url');
    expect(parsed['outcome']).toBe('success');
    expect(parsed['requestId']).toBe('req-test-1');
  });

  it('output contains exactly the fixed schema keys — never query, url, or headers', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT);

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    const keys = Object.keys(parsed);
    // Assert allowed keys are present
    expect(keys).toContain('audit');
    expect(keys).toContain('requestId');
    expect(keys).toContain('callerHash');
    expect(keys).toContain('tool');
    expect(keys).toContain('timestamp');
    expect(keys).toContain('outcome');
    expect(keys).toContain('piiClasses');
    expect(keys).toContain('action');
    expect(keys).toContain('popiaMode');
    // Assert prohibited keys — 'caller' without the 'Hash' suffix must never appear
    // (it would be a raw-identity field, which is exactly what this feature must not do)
    expect(keys).not.toContain('caller');
    expect(keys).not.toContain('query');
    expect(keys).not.toContain('url');
    expect(keys).not.toContain('headers');
    expect(keys).not.toContain('body');
    // Exactly 9 allowed keys (callerHash added)
    expect(keys).toHaveLength(9);
  });

  // N4: callerHash placed immediately after requestId, value preserved
  it('N4 — callerHash appears immediately after requestId in key order', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT_WITH_CALLER);

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    const keys = Object.keys(parsed);
    const requestIdIdx = keys.indexOf('requestId');
    const callerHashIdx = keys.indexOf('callerHash');
    expect(callerHashIdx).toBe(requestIdIdx + 1);
    expect(parsed['callerHash']).toBe('0123456789abcdef');
  });

  // N4 (cont.): absent callerHash emits null (not undefined / missing key)
  it('N4 — callerHash emits null when not set on the event', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT);  // no callerHash field

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed['callerHash']).toBeNull();
  });

  it('caps piiClasses at 8 names', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const manyClasses = Array.from({ length: 12 }, (_, i) => `class_${i}`);
    emitAudit({ ...BASE_EVENT, piiClasses: manyClasses });

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    expect((parsed['piiClasses'] as string[]).length).toBeLessThanOrEqual(8);
  });

  // N20: PIPE_BUF structural guarantee (286 bytes worst-case << 4096)
  it('N20 — output is under 4 KB with worst-case callerHash and all 8 PII classes (structural PIPE_BUF guarantee)', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit({
      requestId: '12345678-1234-1234-1234-123456789012',  // 36-char UUID (worst-case)
      tool: 'fetch_url',
      timestamp: 1_700_000_000_000,
      outcome: 'success',
      piiClasses: ['sa_id', 'email', 'msisdn', 'pan', 'account', 'vat', 'employee_id', 'name'],
      action: 'logged',
      callerHash: '0123456789abcdef',  // 16-hex worst-case caller
    });

    const written = spy.mock.calls[0]![0] as string;
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThan(4096);

    // Structural guarantee: callerHash is either null or exactly 16 hex chars.
    // This converts the "it fits" observation into a fixed-width proof.
    const parsed: Record<string, unknown> = JSON.parse(written);
    const callerHash = parsed['callerHash'];
    if (callerHash !== null) {
      expect(callerHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('includes popiaMode from config', () => {
    initializeConfig({ POPIA_MODE: 'monitor' });
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT);

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed['popiaMode']).toBe('monitor');
  });
});
