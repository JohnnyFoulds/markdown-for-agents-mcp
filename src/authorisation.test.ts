/**
 * Governance gate — PRODUCTION_AUTHORISATION.md and TRUST_OVERVIEW.md.
 *
 * This test makes PRODUCTION_AUTHORISATION.md a hard gate:
 *   - Status cannot read AUTHORISED while any §3 condition checkbox is unchecked.
 *   - Every cited config var must exist in configSchema.
 *   - Every cited metric name must exist in src/obs/metrics.ts.
 *   - Every cited test name must exist in the referenced test file.
 *   - No placeholder [NAME]/[DATE] may remain once status is AUTHORISED.
 *   - The "not legal advice" disclaimer must be present.
 *
 * TRUST_OVERVIEW.md:
 *   - Forbidden phrases that would overclaim compliance are blocked.
 *   - Every docs/enterprise/ document is reachable from README.md.
 *
 * Precedents:
 *   - src/standards.test.ts      — table-driven existence check, dynamic it()
 *   - src/server/popiaPhase0.test.ts — negative-grep doc guard
 *   - src/config.parity.test.ts  — configSchema import + shape key check
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DOCS = join(REPO_ROOT, 'docs/enterprise');
const ATO_PATH = join(DOCS, 'PRODUCTION_AUTHORISATION.md');
const TRUST_PATH = join(DOCS, 'TRUST_OVERVIEW.md');
const FSP_PATH = join(DOCS, 'FSP_DEPLOYMENT.md');
const DEP_PATH = join(DOCS, 'DEPENDENCY_MANAGEMENT.md');
const README_PATH = join(REPO_ROOT, 'README.md');

const ato = readFileSync(ATO_PATH, 'utf8');
const trust = readFileSync(TRUST_PATH, 'utf8');
const fsp = existsSync(FSP_PATH) ? readFileSync(FSP_PATH, 'utf8') : '';
const dep = existsSync(DEP_PATH) ? readFileSync(DEP_PATH, 'utf8') : '';
const readme = readFileSync(README_PATH, 'utf8');

// ── Helper: extract status line ───────────────────────────────────────────────

function getStatus(): string {
  const m = ato.match(/^Status:\s*(.+)$/m);
  return m?.[1]?.trim() ?? '';
}

// ── Helper: count unchecked condition checkboxes in §3 ───────────────────────

function countUncheckedConditions(): number {
  const section3Match = ato.match(/## §3 — Conditions register([\s\S]+?)(?=\n## §4)/);
  if (!section3Match) return 0;
  return (section3Match[1].match(/^\s*-\s*\[ \]/gm) ?? []).length;
}

// ── Helper: extract allowed signatory roles from §3 headings ─────────────────

const ALLOWED_ROLES = [
  'Information Officer',
  'Legal Counsel',
  'Engineering Owner',
  'Platform Owner',
  'Security Operations',
];

// ── Helper: extract backtick-quoted values from a line ───────────────────────

function backticks(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// ── 1. Status coherence ───────────────────────────────────────────────────────

describe('PRODUCTION_AUTHORISATION.md — status coherence', () => {
  it('has a parseable Status line', () => {
    expect(getStatus()).not.toBe('');
  });

  it('status is NOT AUTHORISED while any condition checkbox is unchecked', () => {
    const unchecked = countUncheckedConditions();
    const status = getStatus();
    if (unchecked > 0) {
      expect(status).not.toMatch(/^AUTHORISED$/i);
    }
    // If all conditions are checked: AUTHORISED is permitted — no assertion needed.
  });

  it('§4 Authorisation status section contains the Status line', () => {
    const section4Match = ato.match(/## §4 — Authorisation status[\s\S]+?```\n([\s\S]+?)```/);
    expect(section4Match, '§4 must contain a fenced code block with the Status line').not.toBeNull();
    const statusInFence = section4Match![1];
    expect(statusInFence).toMatch(/^Status:\s*(NOT AUTHORISED|AUTHORISED)/m);
  });
});

// ── 2. Disclaimer ─────────────────────────────────────────────────────────────

describe('PRODUCTION_AUTHORISATION.md — disclaimer', () => {
  it('contains the "not legal advice" disclaimer', () => {
    expect(ato).toMatch(/not legal advice/i);
  });

  it('contains the "not a compliance certificate" disclaimer', () => {
    expect(ato).toMatch(/not a compliance certificate/i);
  });

  it('states that legal determinations are inputs, not conclusions', () => {
    // The text "The determinations in §3 are *inputs*\n> to this document, not conclusions"
    // spans a line break in the blockquote. Check the two key claims separately.
    expect(ato).toMatch(/determinations? in §3 are/i);
    expect(ato).toMatch(/not conclusions reached by it/i);
  });
});

// ── 3. No placeholders once authorised ───────────────────────────────────────

describe('PRODUCTION_AUTHORISATION.md — placeholder guard (dormant until signed)', () => {
  it('if AUTHORISED, no [NAME] placeholder remains', () => {
    if (getStatus() === 'AUTHORISED') {
      expect(ato).not.toMatch(/\[NAME\]/);
    }
  });

  it('if AUTHORISED, no [DATE] placeholder remains', () => {
    if (getStatus() === 'AUTHORISED') {
      expect(ato).not.toMatch(/\[DATE\]/);
    }
  });

  it('if AUTHORISED, no [SIGNATURE] placeholder remains', () => {
    if (getStatus() === 'AUTHORISED') {
      expect(ato).not.toMatch(/\[SIGNATURE\]/);
    }
  });
});

// ── 4. Expiry line present and parseable ──────────────────────────────────────

describe('PRODUCTION_AUTHORISATION.md — expiry', () => {
  it('has an Expires line', () => {
    expect(ato).toMatch(/^\*\*Expires:\*\*/m);
  });

  it('if AUTHORISED, Expires is not a past date', () => {
    if (getStatus() !== 'AUTHORISED') return;
    const m = ato.match(/^\*\*Expires:\*\*\s*(\d{4}-\d{2}-\d{2})/m);
    expect(m, 'AUTHORISED status requires a parseable ISO-8601 expiry date').not.toBeNull();
    const expiry = new Date(m![1]);
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── 5. Machine-enforced conditions cite real config vars ──────────────────────

describe('PRODUCTION_AUTHORISATION.md — machine-enforced conditions cite real config vars', () => {
  const schemaKeys = new Set(Object.keys(configSchema.shape));

  // Extract the Tier 1 config table rows that are "Machine-enforced"
  const tier1TableMatch = ato.match(
    /### Tier 1 — Restricted[\s\S]+?\| Setting \| Value \| Enforcement \|([\s\S]+?)(?=\n### Tier 2|\n---)/
  );

  const enforcedVars: string[] = [];
  if (tier1TableMatch) {
    for (const line of tier1TableMatch[1].split('\n')) {
      if (!line.includes('Machine-enforced')) continue;
      const keys = backticks(line);
      if (keys.length > 0) enforcedVars.push(keys[0]);
    }
  }

  for (const varName of enforcedVars) {
    it(`machine-enforced var \`${varName}\` exists in configSchema`, () => {
      expect(schemaKeys.has(varName), `${varName} is cited as machine-enforced but not in configSchema`).toBe(true);
    });
  }
});

// ── 6. Cited metrics exist in src/obs/metrics.ts ─────────────────────────────

describe('PRODUCTION_AUTHORISATION.md — cited metrics exist in metrics.ts', () => {
  const metricsSource = readFileSync(join(__dirname, 'obs/metrics.ts'), 'utf8');

  // Extract metric names from backtick spans. Prometheus metric names end with
  // _total, _seconds, or _timestamp_seconds to distinguish them from tool names,
  // config vars, and path segments that start with the same prefixes.
  const metricRe = /`((?:mcp|fetch|browser|search|rerank|store|rate|crawl|ssrf|robots|cache|audit|pii|retention)[_a-z]+(?:_total|_seconds|_timestamp_seconds))`/g;
  const citedMetrics = [...ato.matchAll(metricRe)].map((m) => m[1]);
  const unique = [...new Set(citedMetrics)];

  for (const name of unique) {
    it(`cited metric \`${name}\` is defined in metrics.ts`, () => {
      // The metric name appears as a string literal in the Counter/Gauge/Histogram declaration
      expect(metricsSource).toContain(`'${name}'`);
    });
  }
});

// ── 7. Cited test names in §2 resolve to real tests ──────────────────────────

describe('PRODUCTION_AUTHORISATION.md — cited test names resolve', () => {
  // §2 Technical state table: | Control | … | Evidence |
  // Evidence cells contain patterns like `src/path/to.test.ts` — `test name here`
  const section2Match = ato.match(/## §2 — Technical state summary([\s\S]+?)(?=\n## §3)/);
  type TestRow = { testFile: string; testName: string };
  const rows: TestRow[] = [];

  if (section2Match) {
    for (const line of section2Match[1].split('\n')) {
      const vals = backticks(line);
      // Look for a .test.ts value followed by a non-.test.ts value (the test name).
      // Skip rows where two consecutive .test.ts values appear (two file citations).
      const testFileIdx = vals.findIndex((v) => v.endsWith('.test.ts'));
      if (testFileIdx >= 0) {
        const next = vals[testFileIdx + 1];
        if (next && !next.endsWith('.test.ts') && !next.endsWith('.ts')) {
          rows.push({ testFile: vals[testFileIdx], testName: next });
        }
      }
    }
  }

  for (const { testFile, testName } of rows) {
    describe(`${testFile}`, () => {
      it(`source file exists`, () => {
        expect(existsSync(join(REPO_ROOT, testFile))).toBe(true);
      });

      it(`contains the cited test name "${testName}"`, () => {
        const src = readFileSync(join(REPO_ROOT, testFile), 'utf8');
        expect(src).toContain(testName);
      });
    });
  }
});

// ── 8. TRUST_OVERVIEW.md — forbidden overclaim phrases ───────────────────────

describe('TRUST_OVERVIEW.md — no overclaim phrases', () => {
  const FORBIDDEN = [
    /\bPOPIA compliant\b/i,
    /\bfully compliant\b/i,
    /RFC 9309 compliant/i,
    /\bcertified\b/i,
    /\bguarantee\b/i,
    // The specific overclaim deleted from ENTERPRISE_READINESS.md in Phase A
    /No query text reaches a US SaaS/i,
  ];

  for (const pattern of FORBIDDEN) {
    it(`does NOT contain "${pattern.source}"`, () => {
      expect(trust).not.toMatch(pattern);
    });
  }

  it('states that the detector does NOT find free-text names', () => {
    expect(trust).toMatch(/false negative/i);
  });

  it('lists DuckDuckGo in the sub-processors table (including the no-DPA provider)', () => {
    // A sub-processor table that omits the one provider with no DPA is worse than no table.
    expect(trust).toMatch(/DuckDuckGo/i);
  });

  it('states that no data-subject rights tooling exists', () => {
    expect(trust).toMatch(/no.*data.subject.rights|data.subject.*rights.*no/i);
  });
});

// ── 8b. FSP_DEPLOYMENT.md and DEPENDENCY_MANAGEMENT.md — no overclaim phrases ──

describe('FSP_DEPLOYMENT.md — no overclaim phrases', () => {
  const FORBIDDEN = [
    /\bPOPIA compliant\b/i,
    /\bfully compliant\b/i,
    /\bcertified\b/i,
    /\bguarantee\b/i,
  ];

  for (const pattern of FORBIDDEN) {
    it(`does NOT contain "${pattern.source}"`, () => {
      expect(fsp).not.toMatch(pattern);
    });
  }
});

describe('DEPENDENCY_MANAGEMENT.md — no overclaim phrases', () => {
  const FORBIDDEN = [
    /\bPOPIA compliant\b/i,
    /\bfully compliant\b/i,
    /\bcertified\b/i,
    /\bguarantee\b/i,
  ];

  for (const pattern of FORBIDDEN) {
    it(`does NOT contain "${pattern.source}"`, () => {
      expect(dep).not.toMatch(pattern);
    });
  }
});

// ── 9. Discoverability — every docs/enterprise/ file linked from README.md ────

describe('README.md — enterprise docs discoverability', () => {
  const enterpriseDocs = [
    'PRODUCTION_AUTHORISATION.md',
    'TRUST_OVERVIEW.md',
    'POPIA_ASSESSMENT.md',
    'STANDARDS.md',
    'THREAT_MODEL.md',
    'DATA_FLOW.md',
    'RUNBOOK.md',
    'SLO.md',
    'ENTERPRISE_READINESS.md',
    'OWNERSHIP.md',
    'TERMS_OF_SERVICE.md',
    'DEPENDENCY_MANAGEMENT.md',
    'FSP_DEPLOYMENT.md',
  ];

  for (const doc of enterpriseDocs) {
    it(`README.md links to ${doc}`, () => {
      expect(readme).toContain(doc);
    });
  }
});
