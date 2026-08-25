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
    expect(keys).toContain('tool');
    expect(keys).toContain('timestamp');
    expect(keys).toContain('outcome');
    expect(keys).toContain('piiClasses');
    expect(keys).toContain('action');
    expect(keys).toContain('popiaMode');
    // Assert prohibited keys are absent
    expect(keys).not.toContain('query');
    expect(keys).not.toContain('url');
    expect(keys).not.toContain('headers');
    expect(keys).not.toContain('body');
    // Exactly 8 allowed keys
    expect(keys).toHaveLength(8);
  });

  it('caps piiClasses at 8 names', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const manyClasses = Array.from({ length: 12 }, (_, i) => `class_${i}`);
    emitAudit({ ...BASE_EVENT, piiClasses: manyClasses });

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    expect((parsed['piiClasses'] as string[]).length).toBeLessThanOrEqual(8);
  });

  it('output is under 4 KB (safe for pipe atomicity)', () => {
    initializeConfig({});
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit({
      ...BASE_EVENT,
      piiClasses: ['sa_id', 'email', 'msisdn', 'pan', 'account', 'vat', 'employee_id', 'name'],
    });

    const written = spy.mock.calls[0]![0] as string;
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThan(4096);
  });

  it('includes popiaMode from config', () => {
    initializeConfig({ POPIA_MODE: 'monitor' });
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitAudit(BASE_EVENT);

    const parsed: Record<string, unknown> = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed['popiaMode']).toBe('monitor');
  });
});
