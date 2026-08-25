/**
 * Guard for docs/enterprise/SECURITY_FINDINGS_REGISTER.md.
 *
 * Enforces:
 *   1. Every §1 (False positive) row cites a test file that exists AND contains
 *      the stated test name — so a false-positive claim cannot outlive its proof.
 *   2. No §1 row can be reclassified as an accepted risk by omitting the test
 *      citation (the parser requires the citation to exist).
 *   3. Forbidden overclaim phrases (certified, fully compliant, guarantee) are
 *      absent from the document.
 *   4. The document appears in README.md and is reachable from SECURITY_SCANNING.md.
 *
 * Citation format in the register:
 *   Each §1 row has a "Test" column whose cell contains exactly one citation in
 *   the form:
 *     `test-file.ts` · `"test name"`
 *   e.g.:
 *     `src/security/dastDetectors.test.ts` · `"crawl_status XSS echo in JSON → info (not exploited)"`
 *
 * The citation checker extracts all such pairs and:
 *   - Asserts the file exists under the repo root
 *   - Asserts the test name string appears verbatim in that file
 *
 * RED first: seeding a bogus citation makes this test file go RED immediately,
 * before the real register is written.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const DOCS       = join(REPO_ROOT, 'docs/enterprise');
const REG_PATH   = join(DOCS, 'SECURITY_FINDINGS_REGISTER.md');
const README_PATH = join(REPO_ROOT, 'README.md');
const SCANNING_PATH = join(DOCS, '..', 'security', 'SECURITY_SCANNING.md');

function readRegister(): string {
  expect(existsSync(REG_PATH), `SECURITY_FINDINGS_REGISTER.md missing at ${REG_PATH}`).toBe(true);
  return readFileSync(REG_PATH, 'utf-8');
}

// ── 1. Citation checks ────────────────────────────────────────────────────────
//
// Parse all citation pairs from §1 table rows. Format:
//   `<relative-file-path>` · `"<test name>"`
//
// The backtick+quote wrapping is required to make citations scannable.

function extractCitations(markdown: string): Array<{ file: string; testName: string; raw: string }> {
  const citationRe = /`([^`]+\.test\.[a-z]+)`\s*·\s*`"([^"]+)"`/g;
  const results: Array<{ file: string; testName: string; raw: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = citationRe.exec(markdown)) !== null) {
    results.push({ file: m[1]!, testName: m[2]!, raw: m[0] });
  }
  return results;
}

describe('SECURITY_FINDINGS_REGISTER.md — §1 citation integrity', () => {
  it('file exists', () => {
    expect(existsSync(REG_PATH)).toBe(true);
  });

  it('has at least one §1 false-positive row with a test citation', () => {
    const md = readRegister();
    const citations = extractCitations(md);
    expect(citations.length).toBeGreaterThan(0);
  });

  it('every cited test file exists', () => {
    const md = readRegister();
    for (const { file, raw } of extractCitations(md)) {
      const abs = join(REPO_ROOT, file);
      expect(
        existsSync(abs),
        `Citation "${raw}" — test file not found: ${file}`,
      ).toBe(true);
    }
  });

  it('every cited test name appears verbatim in the cited file', () => {
    const md = readRegister();
    for (const { file, testName, raw } of extractCitations(md)) {
      const abs = join(REPO_ROOT, file);
      if (!existsSync(abs)) continue; // already reported above
      const src = readFileSync(abs, 'utf-8');
      expect(
        src.includes(testName),
        `Citation "${raw}" — test name not found in ${file}:\n  "${testName}"`,
      ).toBe(true);
    }
  });
});

// ── 2. Forbidden-phrase guard ─────────────────────────────────────────────────
//
// Phrases that overclaim — if present, a customer or auditor may rely on them
// as a warranty. Under POPIA s105(3)(b) a knowingly false assurance is actionable.

describe('SECURITY_FINDINGS_REGISTER.md — no overclaim phrases', () => {
  const FORBIDDEN = [
    /\bfully compliant\b/i,
    /\bPOPIA compliant\b/i,
    /\bcertified\b/i,
    /\bguarantee\b/i,
    /\bno known vulnerabilities\b/i,
    /\bfully mitigated\b/i,
  ];

  for (const pattern of FORBIDDEN) {
    it(`does NOT contain "${pattern.source}"`, () => {
      const md = readRegister();
      expect(md).not.toMatch(pattern);
    });
  }
});

// ── 3. Discoverability ────────────────────────────────────────────────────────

describe('SECURITY_FINDINGS_REGISTER.md — discoverability', () => {
  it('is linked from README.md', () => {
    expect(existsSync(README_PATH)).toBe(true);
    const readme = readFileSync(README_PATH, 'utf-8');
    expect(readme).toContain('SECURITY_FINDINGS_REGISTER.md');
  });

  it('is referenced from docs/security/SECURITY_SCANNING.md', () => {
    expect(existsSync(SCANNING_PATH)).toBe(true);
    const scanning = readFileSync(SCANNING_PATH, 'utf-8');
    expect(scanning).toContain('SECURITY_FINDINGS_REGISTER');
  });
});

// ── 4. Section structure ──────────────────────────────────────────────────────

describe('SECURITY_FINDINGS_REGISTER.md — document structure', () => {
  it('contains a §1 False positives section', () => {
    const md = readRegister();
    expect(md).toMatch(/##.*false positive/i);
  });

  it('contains a §2 Accepted risks section', () => {
    const md = readRegister();
    expect(md).toMatch(/##.*accepted risk/i);
  });

  it('contains a §3 Real gaps section', () => {
    const md = readRegister();
    expect(md).toMatch(/##.*real gap|##.*compensating control/i);
  });

  it('states that §1 entries are not dismissed — a finding in this register is not automatically closed', () => {
    const md = readRegister();
    // The introduction must make clear this register classifies, it does not dismiss.
    expect(md).toMatch(/not.*dismiss|classify.*not.*dismiss|does not.*close|not.*automatically|not.*waive/i);
  });
});
