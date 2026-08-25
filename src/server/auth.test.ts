/**
 * HTTP authentication policy — unit tests.
 *
 * Phase 2.1 RED-first: these tests were written before assertHttpAuthPolicy
 * existed and failed with "Cannot find module ./auth.js".
 *
 * After adding src/server/auth.ts, config.ts entries, and updating index.ts,
 * all four cases must be GREEN.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { assertHttpAuthPolicy, assertPrivacyPolicy } from './auth.js';
import { initializeConfig, getConfig } from '../config.js';

describe('assertHttpAuthPolicy', () => {
  it('throws in HTTP mode with no token and no anonymous opt-out', () => {
    expect(() => assertHttpAuthPolicy(undefined, false, true)).toThrow(
      /MCP_AUTH_TOKEN.*MCP_AUTH_ALLOW_ANONYMOUS/s,
    );
  });

  it('throws for empty-string token in HTTP mode without opt-out', () => {
    // An empty env var is the same as unset — fail-closed applies
    expect(() => assertHttpAuthPolicy('', false, true)).toThrow(
      /MCP_AUTH_TOKEN.*MCP_AUTH_ALLOW_ANONYMOUS/s,
    );
  });

  it('does not throw in HTTP mode when a non-empty token is set', () => {
    expect(() => assertHttpAuthPolicy('s3cr3t', false, true)).not.toThrow();
  });

  it('does not throw in HTTP mode when MCP_AUTH_ALLOW_ANONYMOUS is true', () => {
    expect(() => assertHttpAuthPolicy(undefined, true, true)).not.toThrow();
  });

  it('does not throw in stdio mode with no token and no opt-out', () => {
    // stdio has no HTTP surface to protect — auth requirements do not apply
    expect(() => assertHttpAuthPolicy(undefined, false, false)).not.toThrow();
  });
});

// Phase 3 RED (before adding assertPrivacyPolicy to auth.ts)
describe('assertPrivacyPolicy', () => {
  afterEach(() => {
    // Restore defaults after each test
    initializeConfig({});
  });

  it('returns no warnings for a well-configured instance', () => {
    initializeConfig({ LOG_REDACT_QUERIES: 'true', SOCKS5_LISTEN_MODE: 'tunnel' });
    expect(assertPrivacyPolicy(getConfig())).toHaveLength(0);
  });

  it('warns when LOG_REDACT_QUERIES=false', () => {
    initializeConfig({ LOG_REDACT_QUERIES: 'false' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /LOG_REDACT_QUERIES/i.test(w))).toBe(true);
  });

  it('warns when SOCKS5_LISTEN_MODE=intercept', () => {
    initializeConfig({ SOCKS5_LISTEN_MODE: 'intercept' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /intercept/i.test(w))).toBe(true);
  });

  it('warns when RERANK_TEI_URL looks external', () => {
    initializeConfig({ RERANK_TEI_URL: 'http://tei.vendor.example.com:8080' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /RERANK_TEI_URL/i.test(w))).toBe(true);
  });

  it('does not warn when RERANK_TEI_URL is a cluster-local service name', () => {
    initializeConfig({ RERANK_TEI_URL: 'http://tei-service:8080' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /RERANK_TEI_URL/i.test(w))).toBe(false);
  });

  it('warns when SEARXNG_URL looks external', () => {
    initializeConfig({ SEARXNG_URL: 'https://searxng.example.com' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /SEARXNG_URL/i.test(w))).toBe(true);
  });

  it('does not warn when SEARXNG_URL is an RFC 1918 address', () => {
    initializeConfig({ SEARXNG_URL: 'http://10.0.1.5:8888' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /SEARXNG_URL/i.test(w))).toBe(false);
  });

  it('warns when PROXY_PINS is set', () => {
    initializeConfig({ PROXY_PINS: '["http://proxy.example.com:3128"]' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /PROXY_PINS/i.test(w))).toBe(true);
  });

  it('warns when SOCKS5_UPSTREAM_URL is set', () => {
    initializeConfig({ SOCKS5_UPSTREAM_URL: 'socks5://proxy.corp.example:1080' });
    expect(assertPrivacyPolicy(getConfig()).some(w => /SOCKS5_UPSTREAM_URL/i.test(w))).toBe(true);
  });
});
