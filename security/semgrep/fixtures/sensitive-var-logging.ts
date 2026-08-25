/**
 * Fixture for sensitive-var-in-console-log rule.
 * Run semgrep --test security/semgrep/ to verify.
 *
 * Phase 5 expanded: rule now catches console.error, property accesses,
 * and single-interpolation template literals.
 */
import { redactQuery } from '../../../src/utils/logger.js';
import { redactUrl, redactHeaders } from '../../../src/privacy/redact.js';

const query = 'find user emails';
const token = 'sk-some-api-key';

interface Opts { query: string; url: string; }
declare const opts: Opts;

// ── Bare identifier (original rule) ──────────────────────────────────────────

// ruleid: sensitive-var-in-console-log
console.log(query);

// ruleid: sensitive-var-in-console-log
console.error(token);

// ok: sensitive-var-in-console-log
console.log(redactQuery(query));

// ok: sensitive-var-in-console-log
console.log('Processing request');

// ── Property access ───────────────────────────────────────────────────────────

// ruleid: sensitive-var-in-console-log
console.log(opts.query);

// ruleid: sensitive-var-in-console-log
console.error(opts.url);

// ok: sensitive-var-in-console-log
console.log(redactQuery(opts.query));

// ok: sensitive-var-in-console-log
console.log(redactUrl(opts.url));

// ── Single-interpolation template literal ────────────────────────────────────

// ruleid: sensitive-var-in-console-log
console.error(`${opts.query}`);

// ruleid: sensitive-var-in-console-log
console.log(`${opts.url}`);

// ok: sensitive-var-in-console-log
console.error(`Redacted: ${redactQuery(opts.query)}`);

// ok: sensitive-var-in-console-log
// Static strings with no sensitive interpolation are fine:
console.log(`Request processed successfully`);
