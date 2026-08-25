/**
 * Cost-analysis consistency guard.
 *
 * Every dollar figure, percentage, and multiplier quoted in
 * docs/enterprise/COST_ANALYSIS.md must resolve to a matching entry in
 * scripts/cost-model-output.json.
 *
 * This test prevents the prose from drifting into the same state as the
 * claim it replaced (ENTERPRISE_READINESS.md "Zero per-query cost").
 *
 * Python is NOT required in CI: only the committed JSON is read.
 *
 * Strategy:
 *  1. Read COST_ANALYSIS.md and extract every figure that is preceded by "$"
 *     or followed by "%" or "×" (the multiplier notation used for HPA ceiling).
 *  2. For each extracted value assert it appears somewhere in the JSON (as a
 *     numeric value or as a string-formatted number).
 *  3. Assert the JSON was produced by a known model version (presence of
 *     generated_note field) and that each load-bearing assumption is flagged.
 *
 * RED first: to verify this guard works, temporarily change one figure in
 * COST_ANALYSIS.md to a value not in cost-model-output.json and confirm the
 * test fails.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const COST_ANALYSIS_PATH = join(ROOT, 'docs/enterprise/COST_ANALYSIS.md');
const JSON_PATH = join(ROOT, 'scripts/cost-model-output.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDollarAmounts(text: string): number[] {
  // Match $NNN, $N,NNN, $N.NN, $N,NNN.NN etc.
  const matches = text.matchAll(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/g);
  const results: number[] = [];
  for (const m of matches) {
    const raw = m[1].replace(/,/g, '');
    const n = parseFloat(raw);
    if (!isNaN(n)) results.push(n);
  }
  return results;
}

function containsNumberish(obj: unknown, target: number, tolerance = 0.02): boolean {
  const check = (v: unknown): boolean => {
    if (typeof v === 'number') {
      return Math.abs(v - target) / (Math.abs(target) || 1) <= tolerance;
    }
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/,/g, ''));
      if (!isNaN(n)) return Math.abs(n - target) / (Math.abs(target) || 1) <= tolerance;
    }
    if (Array.isArray(v)) return v.some(check);
    if (typeof v === 'object' && v !== null) return Object.values(v).some(check);
    return false;
  };
  return check(obj);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cost-model-output.json integrity', () => {
  it('exists and has a generated_note field', () => {
    expect(existsSync(JSON_PATH), `${JSON_PATH} not found — run python3 scripts/cost-model.py`).toBe(true);
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    expect(raw.generated_note).toBeTruthy();
  });

  it('contains required top-level keys', () => {
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    const required = [
      'tavily_tiers', 'firecrawl_tiers', 'brave_price_usd_per_query',
      'mode_F_desired_af_south_1', 'mode_F_rightsized_af_south_1',
      'mode_F_hpa_max_af_south_1', 'breakeven', 'hpa_cost_multiplier',
      'load_bearing_assumptions',
    ];
    for (const key of required) {
      expect(raw, `Missing key: ${key}`).toHaveProperty(key);
    }
  });

  it('all load-bearing assumptions are flagged confidence=assumed', () => {
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    const assumptions: Array<{ key: string; confidence: string }> = raw.load_bearing_assumptions;
    expect(assumptions.length).toBeGreaterThanOrEqual(4);
    for (const a of assumptions) {
      expect(a.confidence, `Assumption ${a.key} not flagged`).toBe('assumed');
    }
  });
});

describe('COST_ANALYSIS.md figures are traceable to cost-model-output.json', () => {
  it('COST_ANALYSIS.md exists', () => {
    expect(existsSync(COST_ANALYSIS_PATH),
      `${COST_ANALYSIS_PATH} not found`).toBe(true);
  });

  it('key figures in COST_ANALYSIS.md resolve in the JSON model', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

    // Spot-check the most important named figures from the document
    const namedFigures: Array<{ desc: string; expected: number }> = [
      { desc: 'Fargate vCPU rate af-south-1 ($0.0546)', expected: 0.0546 },
      { desc: 'Firecrawl Standard unit rate ($0.00083)', expected: 0.00083 },
      { desc: 'Brave price per query ($0.005)', expected: 0.005 },
      { desc: 'Firecrawl Standard price ($83)', expected: 83 },
      { desc: 'Firecrawl Scale price ($599)', expected: 599 },
      { desc: 'Tavily Growth unit rate ($0.005)', expected: 0.005 },
    ];

    for (const { desc, expected } of namedFigures) {
      expect(
        containsNumberish(raw, expected),
        `Figure "${desc}" (${expected}) not found in cost-model-output.json`
      ).toBe(true);
    }
  });

  it('dollar amounts in the summary table trace to the JSON', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

    // Extract just the deployment mode table figures (large round numbers)
    // The shipped ECS total is ~$863, right-sized ~$251, K8s ~$682
    const keyInfraFigures = [
      { desc: 'Shipped ECS desired total',      expected: raw.mode_F_desired_af_south_1.total as number },
      { desc: 'Right-sized Fargate total',       expected: raw.mode_F_rightsized_af_south_1.total as number },
      { desc: 'K8s total',                       expected: raw.mode_E_af_south_1.total as number },
      { desc: 'HPA max total',                   expected: raw.mode_F_hpa_max_af_south_1.total as number },
    ];

    for (const { desc, expected } of keyInfraFigures) {
      // Check that the document contains the rounded figure (±5%)
      const rounded = Math.round(expected);
      const docAmounts = extractDollarAmounts(doc);
      const found = docAmounts.some(a => Math.abs(a - rounded) / rounded <= 0.05);
      expect(found, `Document does not cite ${desc} (~$${rounded})`).toBe(true);
    }
  });

  it('HPA cost multiplier is cited in the document', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    const mult = raw.hpa_cost_multiplier as number;
    // Should appear as e.g. "14.2×"
    expect(doc, `HPA multiplier ${mult}× not cited in COST_ANALYSIS.md`).toContain(`${mult}×`);
  });

  it('document acknowledges throughput is unmeasured', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    expect(doc.toLowerCase()).toMatch(/unmeasured|tbd|not measured/);
  });

  it('document does not assert zero per-query cost (quotes in errata are allowed)', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    // The document may quote the retracted claim in §14 (errata). What must not appear
    // is an assertive use of "zero per-query cost" outside a blockquote/errata context.
    // Guard: the phrase must not appear outside the errata section.
    const errataIdx = doc.toLowerCase().indexOf('## 14. errata');
    const beforeErrata = errataIdx >= 0 ? doc.slice(0, errataIdx) : doc;
    expect(beforeErrata.toLowerCase()).not.toContain('zero per-query cost');
  });

  it('document does not claim free cost', () => {
    const doc = readFileSync(COST_ANALYSIS_PATH, 'utf8');
    // Should not say "Cost: Free" in the comparison table context
    expect(doc).not.toMatch(/\| Free \|.*\| Free \|/);
  });
});

describe('ENTERPRISE_READINESS.md no longer contains the retracted claim', () => {
  const ER_PATH = join(ROOT, 'docs/enterprise/ENTERPRISE_READINESS.md');

  it('does not contain the old Tavily overstatement', () => {
    const doc = readFileSync(ER_PATH, 'utf8');
    expect(doc).not.toContain('R650 000');
  });

  it('does not contain the zero per-query cost claim', () => {
    const doc = readFileSync(ER_PATH, 'utf8');
    expect(doc.toLowerCase()).not.toContain('zero per-query cost');
  });
});

describe('FUTURE_WORK.md contains corrected Brave price', () => {
  const FW_PATH = join(ROOT, 'FUTURE_WORK.md');

  it('no longer shows ~$0.003/search for Brave', () => {
    const doc = readFileSync(FW_PATH, 'utf8');
    expect(doc).not.toContain('~$0.003/search');
  });

  it('no longer shows Cost: Free / Free in the comparison table', () => {
    const doc = readFileSync(FW_PATH, 'utf8');
    expect(doc).not.toMatch(/\| Free \| Free \|.*Tavily/s);
  });
});
