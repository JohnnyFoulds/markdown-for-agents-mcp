import { describe, it, expect } from 'vitest';
import { checkPolicy } from './policy.js';

describe('checkPolicy — allowed ports', () => {
  it('allows port 80', () => {
    expect(checkPolicy('example.com', 80).verdict).toBe('allow');
  });
  it('allows port 443', () => {
    expect(checkPolicy('example.com', 443).verdict).toBe('allow');
  });
  it('denies port 22', () => {
    const r = checkPolicy('example.com', 22);
    expect(r.verdict).toBe('deny');
    expect(r.reason).toContain('port 22');
  });
  it('denies port 3306 (MySQL)', () => {
    expect(checkPolicy('example.com', 3306).verdict).toBe('deny');
  });
});

describe('checkPolicy — private/local addresses (SSRF)', () => {
  it('denies 127.0.0.1', () => {
    const r = checkPolicy('127.0.0.1', 443);
    expect(r.verdict).toBe('deny');
    expect(r.reason).toContain('SSRF');
  });
  it('denies 169.254.169.254 (metadata)', () => {
    const r = checkPolicy('169.254.169.254', 80);
    expect(r.verdict).toBe('deny');
    expect(r.reason).toContain('SSRF');
  });
  it('denies localhost', () => {
    expect(checkPolicy('localhost', 80).verdict).toBe('deny');
  });
});

describe('checkPolicy — domain blocklist', () => {
  it('allows a plain public domain', () => {
    expect(checkPolicy('example.com', 443).verdict).toBe('allow');
  });
});
