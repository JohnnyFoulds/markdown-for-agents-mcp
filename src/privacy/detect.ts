/**
 * Heuristic structured-identifier PII detection for POPIA compliance.
 *
 * Detects: SA ID numbers (s105(5) unique identifier), MSISDNs, email addresses,
 * payment card numbers (PAN).
 *
 * LIMITATIONS (documented, not bugs):
 * - Does not detect free-text PII: names, addresses, employee numbers, or any
 *   unstructured personal information. The query "John Smith employee number 12345"
 *   returns an empty result.
 * - Does not detect non-SA phone number formats.
 * - PAN scan is capped at 4 KB to bound wall-clock time on adversarial input.
 */

export type PiiClass = 'sa_id' | 'msisdn' | 'email' | 'pan';

function luhn(digits: string): boolean {
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

function isSaId(s: string): boolean {
  if (s.length !== 13) return false;
  const mm = parseInt(s.slice(2, 4), 10);
  const dd = parseInt(s.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  return luhn(s);
}

export function detectPii(text: string): PiiClass[] {
  const found: PiiClass[] = [];

  // SA ID: exactly 13 digits at a word boundary, valid YYMMDD, Luhn valid
  const saIds = text.match(/\b\d{13}\b/g);
  if (saIds?.some(isSaId)) found.push('sa_id');

  // MSISDN: +27XXXXXXXXX (E.164) or 0[6-8]XXXXXXXX (local mobile)
  if (/(?:\+27\d{9}|0[6-8]\d{8})\b/.test(text)) found.push('msisdn');

  // Email: local-part@domain.tld
  if (/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(text)) found.push('email');

  // PAN: 13–19 digits with optional single space or hyphen separators, Luhn valid.
  // Cap at 4 KB before scanning — the quantifier {12,18} is O(n) but adversarial
  // inputs of repeated digit blocks benefit from the bound.
  const safe = text.length > 4096 ? text.slice(0, 4096) : text;
  const pans = safe.match(/\b\d(?:[ -]?\d){12,18}\b/g);
  if (pans?.some(m => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits);
  })) found.push('pan');

  return found;
}
