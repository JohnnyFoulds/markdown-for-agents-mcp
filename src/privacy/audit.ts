import { getConfig } from '../config.js';
import { auditEventsTotal } from '../obs/metrics.js';

/**
 * Fixed-shape audit event. Fields are deliberately minimal:
 * - piiClasses: names only (max 8), never values
 * - No query, url, headers, or body fields — invariant asserted in audit.test.ts
 */
export interface AuditEvent {
  requestId: string;
  tool: string;
  timestamp: number;
  outcome: 'success' | 'error' | 'blocked';
  piiClasses: string[];
  action: string;
}

/**
 * Emit one audit line to stderr, bypassing LOG_LEVEL and LOG_FORMAT.
 *
 * Node writes to stderr via a pipe; to avoid line tearing above PIPE_BUF
 * the serialized line is kept under 4 KB (enforced in audit.test.ts).
 *
 * An audit control defeasible by an unrelated log-verbosity setting is not
 * a control. Do not route this through Logger.
 */
export function emitAudit(event: AuditEvent): void {
  const popiaMode = (() => {
    try { return getConfig().POPIA_MODE; } catch { return 'enforce'; }
  })();

  const piiClasses = event.piiClasses.slice(0, 8);
  const piiDetected = piiClasses.length > 0;

  auditEventsTotal.inc({
    tool: event.tool,
    outcome: event.outcome,
    pii_detected: String(piiDetected),
    popia_mode: popiaMode,
  });

  process.stderr.write(
    JSON.stringify({
      audit: true,
      requestId: event.requestId,
      tool: event.tool,
      timestamp: event.timestamp,
      outcome: event.outcome,
      piiClasses,
      action: event.action,
      popiaMode,
    }) + '\n',
  );
}
