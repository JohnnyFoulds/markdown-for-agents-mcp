/**
 * Fixture for sensitive-var-in-console-log rule.
 * Run semgrep --test security/semgrep/ to verify.
 */
import { redactQuery } from '../../../src/utils/logger.js';

const query = 'find user emails';
const token = 'sk-some-api-key';

// ruleid: sensitive-var-in-console-log
console.log(`Search query: ${query}`);

// ok: sensitive-var-in-console-log
// Correct — query goes through redaction before logging:
console.log(`Search: ${redactQuery(query)}`);

// ok: sensitive-var-in-console-log
// Static strings are fine:
console.log('Processing request');
