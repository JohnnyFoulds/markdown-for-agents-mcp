/**
 * HTTP authentication policy — unit tests.
 *
 * Phase 2.1 RED-first: these tests were written before assertHttpAuthPolicy
 * existed and failed with "Cannot find module ./auth.js".
 *
 * After adding src/server/auth.ts, config.ts entries, and updating index.ts,
 * all four cases must be GREEN.
 */

import { describe, it, expect } from 'vitest';
import { assertHttpAuthPolicy } from './auth.js';

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
