/**
 * Fixture for no-process-env-outside-config rule.
 * This file is outside src/config.ts — the rule should fire on positive cases.
 * Run semgrep --test security/semgrep/ to verify.
 */

// ruleid: no-process-env-outside-config
const tokenBad1 = process.env.MCP_AUTH_TOKEN;

// ruleid: no-process-env-outside-config
const tokenBad2 = process.env['MCP_AUTH_TOKEN'];

// ok: no-process-env-outside-config
// Correct — reading from the validated config object:
// const token = getConfig().MCP_AUTH_TOKEN;
const PLACEHOLDER = 'see-getConfig'; // not triggering the rule
