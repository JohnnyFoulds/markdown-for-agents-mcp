import { getConfig } from '../config.js';
import { auditEventsTotal } from '../obs/metrics.js';

/**
 * Fixed-shape audit event. Fields are deliberately minimal:
 * - piiClasses: names only (max 8), never values
 * - No query, url, headers, or body fields — invariant asserted in audit.test.ts
 * - callerHash: 16-hex HMAC of the x-mcp-caller-id header value, or null.
 *   Optional so crawl-worker callsites (no HTTP context) compile without change.
 *   Named 'callerHash' to prevent any future contributor from assigning the raw
 *   value — the name itself signals that only the hash is acceptable.
 */
export interface AuditEvent {
  requestId: string;
  callerHash?: string | null;
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
  const { popiaMode, auditEnabled } = (() => {
    try {
      const c = getConfig();
      return { popiaMode: c.POPIA_MODE, auditEnabled: c.POPIA_AUDIT_ENABLED };
    } catch {
      return { popiaMode: 'enforce', auditEnabled: true };
    }
  })();

  const piiClasses = event.piiClasses.slice(0, 8);
  const piiDetected = piiClasses.length > 0;

  auditEventsTotal.inc({
    tool: event.tool,
    outcome: event.outcome,
    pii_detected: String(piiDetected),
    popia_mode: popiaMode,
  });

  if (!auditEnabled) return;

  process.stderr.write(
    JSON.stringify({
      audit: true,
      requestId: event.requestId,
      callerHash: event.callerHash ?? null,
      tool: event.tool,
      timestamp: event.timestamp,
      outcome: event.outcome,
      piiClasses,
      action: event.action,
      popiaMode,
    }) + '\n',
  );
}
