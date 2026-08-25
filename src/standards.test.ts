/**
 * Standards register verifier.
 *
 * Every Grade A row in docs/enterprise/STANDARDS.md names a test.
 * This test asserts:
 *   1. The source file in column 3 exists.
 *   2. The test file in column 4 exists.
 *   3. The test file contains the exact test name cited in column 5.
 *
 * If any assertion fails, the Grade A claim is no longer verifiable — either
 * the implementation was deleted or the test was renamed without updating the
 * register. In both cases the claim must not stand.
 *
 * To verify: delete or rename any cited test → this file goes RED.
 *
 * The Grade A table format (between the Grade A heading and the next --- rule):
 *   | description | `src/file.ts` | `src/file.test.ts` | `test description` |
 *
 * Parsing extracts the three backtick-quoted values from data rows (not header rows).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STANDARDS_PATH = join(ROOT, 'docs/enterprise/STANDARDS.md');

interface GradeARow {
  description: string;
  sourceFile: string;
  testFile: string;
  testName: string;
}

function parseGradeARows(): GradeARow[] {
  const text = readFileSync(STANDARDS_PATH, 'utf8');

  // Extract the Grade A section (between the Grade A heading and the next ---)
  const m = text.match(/## Grade A[^\n]*\n[\s\S]+?(?=\n---)/);
  if (!m) throw new Error('Could not find Grade A section in STANDARDS.md');

  const rows: GradeARow[] = [];
  for (const line of m[0].split('\n')) {
    // Match table data rows: | description | `src1` | `src2.test.ts` | `test name` |
    const backticked = [...line.matchAll(/`([^`]+)`/g)].map(b => b[1]);
    if (backticked.length < 3) continue;
    const [sourceFile, testFile, testName] = backticked;
    if (!testFile.endsWith('.test.ts') && !testFile.endsWith('.test.js')) continue;
    // First cell is the raw description text between the pipes
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    rows.push({ description: cells[0] ?? '', sourceFile, testFile, testName });
  }
  return rows;
}

const rows = parseGradeARows();

describe('STANDARDS.md Grade A — source files exist', () => {
  for (const row of rows) {
    it(`${row.sourceFile} exists`, () => {
      expect(existsSync(join(ROOT, row.sourceFile)),
        `Grade A claim "${row.description}": source file ${row.sourceFile} not found`
      ).toBe(true);
    });
  }
});

describe('STANDARDS.md Grade A — test files exist', () => {
  for (const row of rows) {
    it(`${row.testFile} exists`, () => {
      expect(existsSync(join(ROOT, row.testFile)),
        `Grade A claim "${row.description}": test file ${row.testFile} not found`
      ).toBe(true);
    });
  }
});

describe('STANDARDS.md Grade A — cited test names exist in test files', () => {
  for (const row of rows) {
    it(`"${row.testName}" exists in ${row.testFile}`, () => {
      const content = readFileSync(join(ROOT, row.testFile), 'utf8');
      expect(content).toContain(row.testName);
    });
  }
});
