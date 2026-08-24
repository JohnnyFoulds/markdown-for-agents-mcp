/**
 * Phase 1 — Observability truth (metrics coverage enforcement).
 *
 * This test greps the non-metrics production source for references to every
 * exported name from metrics.ts.  If any metric is exported but never
 * referenced (i.e. it is declared but never incremented/observed/set), this
 * test fails — preventing the class of defect where a metric is shipped but
 * silently never moves.
 *
 * RED before the fix: browserPoolContexts, searchProviderRequestsTotal,
 * rerankDurationSeconds, storeOperationsTotal, rateLimitWaitsSeconds,
 * crawlQueueDepth, crawlPagesTotal, robotsDeniedTotal, toolCallsTotal,
 * toolDurationSeconds, inflightRequests all have 0 production references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const METRICS_PATH = resolve(ROOT, 'src/obs/metrics.ts');

// Files / directories that should NOT count as "production use":
// test files and the metrics declaration file itself.
const EXCLUDE_PATTERNS = [
  /\.test\.ts$/,
  /metrics\.ts$/,
  /node_modules/,
  /dist\//,
];

function collectSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      result.push(...collectSourceFiles(full));
    } else if (full.endsWith('.ts') && !EXCLUDE_PATTERNS.some(p => p.test(full))) {
      result.push(full);
    }
  }
  return result;
}

function extractExportNames(source: string): string[] {
  // Match: export const <name> = ...
  const matches = [...source.matchAll(/^export const (\w+)\s*=/gm)];
  return matches.map(m => m[1]!);
}

// Metrics that are intentionally excluded because they are used only through
// the `registry` object (e.g. collectDefaultMetrics) or are the registry itself.
const ALLOWED_UNEXPORTED = new Set(['registry']);

describe('metrics.ts — all exported metrics must be referenced in production code', () => {
  const metricsSource = readFileSync(METRICS_PATH, 'utf-8');
  const exportedNames = extractExportNames(metricsSource).filter(
    n => !ALLOWED_UNEXPORTED.has(n),
  );

  const sourceFiles = collectSourceFiles(resolve(ROOT, 'src'));
  const allSource = sourceFiles.map(f => readFileSync(f, 'utf-8')).join('\n');

  it('has at least one exported metric name', () => {
    expect(exportedNames.length).toBeGreaterThan(0);
  });

  // One test per metric so failures clearly name the unrwired metric.
  for (const name of exportedNames) {
    it(`${name} is referenced in at least one production source file`, () => {
      // The name must appear at least once in production code (not just in metrics.ts).
      const usedInProduction = sourceFiles.some(filePath => {
        const content = readFileSync(filePath, 'utf-8');
        return content.includes(name);
      });
      expect(usedInProduction, `${name} is declared in metrics.ts but never referenced in production code`).toBe(true);
    });
  }
});
