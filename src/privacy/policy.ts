/**
 * POPIA enforcement policy — maps detected PII classes to an action.
 *
 * The class→action table is a POLICY DECISION, not a legal conclusion.
 * In particular, the treatment of email addresses as 'audit' rather than
 * 'block' in enforce mode requires legal sign-off before changing. An email
 * address is arguably a s105(5) unique identifier (it uniquely identifies
 * one data subject). The current default is 'audit' because auto-blocking
 * on email would prevent legitimate search and fetch tool use.
 *
 * See Phase 6 note in docs/enterprise/POPIA_ASSESSMENT.md §9 sign-off checklist.
 */

import { getConfig } from '../config.js';
import type { PiiClass } from './detect.js';

export interface PolicyResult {
  action: 'block' | 'audit' | 'pass';
  classes: PiiClass[];
}

// Classes that trigger a block in enforce mode.
// EMAIL is intentionally absent — see module docstring.
const BLOCK_CLASSES = new Set<PiiClass>(['sa_id', 'msisdn', 'pan']);

export function evaluatePolicy(classes: PiiClass[]): PolicyResult {
  if (classes.length === 0) return { action: 'pass', classes: [] };

  let mode: string;
  try {
    mode = getConfig().POPIA_MODE;
  } catch {
    mode = 'enforce';
  }

  if (mode === 'off') return { action: 'pass', classes };

  if (mode === 'enforce' && classes.some(c => BLOCK_CLASSES.has(c))) {
    return { action: 'block', classes };
  }

  return { action: 'audit', classes };
}
