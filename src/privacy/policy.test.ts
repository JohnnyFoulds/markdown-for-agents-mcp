/**
 * POPIA enforcement policy tests — Phase 6.
 *
 * Phase 6 RED (before creating src/privacy/policy.ts):
 *   "Cannot find module './policy.js'"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluatePolicy } from './policy.js';
import { initializeConfig } from '../config.js';

afterEach(() => initializeConfig({}));

describe('evaluatePolicy — enforce mode (default)', () => {
  beforeEach(() => initializeConfig({ POPIA_MODE: 'enforce' }));

  it('returns block for sa_id', () => {
    expect(evaluatePolicy(['sa_id']).action).toBe('block');
  });

  it('returns block for msisdn', () => {
    expect(evaluatePolicy(['msisdn']).action).toBe('block');
  });

  it('returns block for pan', () => {
    expect(evaluatePolicy(['pan']).action).toBe('block');
  });

  it('returns audit for email (policy decision requiring legal sign-off, not auto-block)', () => {
    expect(evaluatePolicy(['email']).action).toBe('audit');
  });

  it('returns pass for empty class list', () => {
    expect(evaluatePolicy([]).action).toBe('pass');
  });

  it('returns block when sa_id appears alongside email', () => {
    expect(evaluatePolicy(['sa_id', 'email']).action).toBe('block');
  });

  it('preserves the detected classes in the result', () => {
    const result = evaluatePolicy(['sa_id', 'email']);
    expect(result.classes).toContain('sa_id');
    expect(result.classes).toContain('email');
  });
});

describe('evaluatePolicy — monitor mode', () => {
  beforeEach(() => initializeConfig({ POPIA_MODE: 'monitor' }));

  it('returns audit (not block) for sa_id', () => {
    expect(evaluatePolicy(['sa_id']).action).toBe('audit');
  });

  it('returns audit for msisdn', () => {
    expect(evaluatePolicy(['msisdn']).action).toBe('audit');
  });

  it('returns audit for pan', () => {
    expect(evaluatePolicy(['pan']).action).toBe('audit');
  });

  it('returns pass for empty class list', () => {
    expect(evaluatePolicy([]).action).toBe('pass');
  });
});

describe('evaluatePolicy — off mode', () => {
  beforeEach(() => initializeConfig({ POPIA_MODE: 'off' }));

  it('returns pass even for sa_id + msisdn + pan', () => {
    expect(evaluatePolicy(['sa_id', 'msisdn', 'pan', 'email']).action).toBe('pass');
  });

  it('returns pass for empty class list', () => {
    expect(evaluatePolicy([]).action).toBe('pass');
  });
});
