/**
 * PII detection unit tests — Phase 6.
 *
 * Phase 6 RED (before creating src/privacy/detect.ts):
 *   "Cannot find module './detect.js'"
 *
 * Key invariants:
 * - SA ID: 13 digits, valid YYMMDD, Luhn-valid
 * - MSISDN: +27XXXXXXXXX or 0[6-8]XXXXXXXX
 * - Email: standard RFC 5321 local-part@domain
 * - PAN: 13–19 digits (spaced or hyphenated), Luhn-valid; scan capped at 4 KB
 * - Documented false negative: free-text names + employee numbers are NOT detected
 */

import { describe, it, expect } from 'vitest';
import { detectPii } from './detect.js';

// ── SA ID ─────────────────────────────────────────────────────────────────────

describe('SA ID detection', () => {
  it('detects a valid SA ID', () => {
    // 8001015009087: DOB 1980-01-01, male, SA citizen, Luhn valid
    expect(detectPii('8001015009087')).toContain('sa_id');
  });

  it('does not detect an invalid SA ID (Luhn fail)', () => {
    expect(detectPii('8001015009088')).not.toContain('sa_id');
  });

  it('does not detect an invalid date (month 13)', () => {
    expect(detectPii('8013015009081')).not.toContain('sa_id');
  });

  it('does not detect an invalid date (day 32)', () => {
    expect(detectPii('8001325009080')).not.toContain('sa_id');
  });

  it('detects SA ID embedded in prose', () => {
    expect(detectPii('ID number: 8001015009087, please process')).toContain('sa_id');
  });

  it('does not detect a 12-digit number', () => {
    expect(detectPii('800101500908')).not.toContain('sa_id');
  });
});

// ── MSISDN ────────────────────────────────────────────────────────────────────

describe('MSISDN detection', () => {
  it('detects +27 E.164 format', () => {
    expect(detectPii('+27821234567')).toContain('msisdn');
  });

  it('detects 0[6-8] local format', () => {
    expect(detectPii('0821234567')).toContain('msisdn');
  });

  it('detects 07x prefix', () => {
    expect(detectPii('0711234567')).toContain('msisdn');
  });

  it('detects 06x prefix', () => {
    expect(detectPii('0631234567')).toContain('msisdn');
  });

  it('does not detect a SA landline (01x)', () => {
    expect(detectPii('0121234567')).not.toContain('msisdn');
  });

  it('detects MSISDN embedded in prose', () => {
    expect(detectPii('please call me on 0821234567 thanks')).toContain('msisdn');
  });
});

// ── Email ─────────────────────────────────────────────────────────────────────

describe('email detection', () => {
  it('detects a plain email address', () => {
    expect(detectPii('user@example.com')).toContain('email');
  });

  it('detects email with plus tag and subdomain', () => {
    expect(detectPii('test.user+tag@sub.example.co.za')).toContain('email');
  });

  it('detects email embedded in prose', () => {
    expect(detectPii('send invoice to billing@company.co.za please')).toContain('email');
  });

  it('does not detect a bare domain name', () => {
    expect(detectPii('example.com')).not.toContain('email');
  });

  it('does not detect a plain word', () => {
    expect(detectPii('hello world')).not.toContain('email');
  });
});

// ── PAN ───────────────────────────────────────────────────────────────────────

describe('PAN detection', () => {
  it('detects a valid 16-digit Luhn-valid card number', () => {
    // 4111111111111111 is a standard Visa test number, Luhn valid
    expect(detectPii('4111111111111111')).toContain('pan');
  });

  it('detects with spaces between groups', () => {
    expect(detectPii('4111 1111 1111 1111')).toContain('pan');
  });

  it('detects with hyphens between groups', () => {
    expect(detectPii('4111-1111-1111-1111')).toContain('pan');
  });

  it('does not detect a Luhn-invalid number', () => {
    // 4111111111111112 — last digit changed, fails Luhn
    expect(detectPii('4111111111111112')).not.toContain('pan');
  });

  it('does not detect a 12-digit number (below minimum)', () => {
    expect(detectPii('411111111111')).not.toContain('pan');
  });

  it('detects PAN embedded in prose', () => {
    expect(detectPii('card 4111111111111111 expires 12/26')).toContain('pan');
  });
});

// ── ReDoS wall-clock guard ────────────────────────────────────────────────────

describe('ReDoS wall-clock guard', () => {
  it('completes adversarial PAN input (repeated digit blocks) within 50ms', () => {
    // 5100-char string of 50-digit groups separated by spaces
    const adversarial = ('1'.repeat(50) + ' ').repeat(100);
    const start = performance.now();
    detectPii(adversarial);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

// ── Documented false negatives ────────────────────────────────────────────────

describe('documented false negatives (stated limitations)', () => {
  it('does NOT detect a name + employee number (free-text PII is out of scope)', () => {
    // Heuristic matching covers structured identifiers only.
    // Free-text names, addresses, and employee numbers are NOT detected.
    const result = detectPii('John Smith employee number 12345');
    expect(result).not.toContain('sa_id');
    expect(result).not.toContain('msisdn');
    expect(result).not.toContain('pan');
  });
});
